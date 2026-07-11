// @ts-check
const {test, expect} = require('../support/base-test.js');
const {SubmissionWizardPage} = require('../pages/SubmissionWizardPage.js');
const {DashboardPage} = require('../pages/DashboardPage.js');

/**
 * Submission drafts (save for later, resume, delete) — one test per
 * canonical scenario of docs/product/specs/submission-drafts.md
 * (6 scenarios → 6 tests). The feature is shared pkp-lib (wizard
 * Save for Later / Cancel semantics, the "Saved for Later" page, the
 * dashboard incomplete views and the bulk-delete tool), so the spec
 * lives here — mirroring reviewer-suggestions.spec.js; the scenario
 * payloads necessarily use OJS vocabulary (publicknowledge / ART),
 * matching the bootstrap context the suite runs against.
 *
 * Coverage per scenario:
 *   s1  Save for Later from Details: the button's two placements,
 *       the "Saved for Later" page verbatim copy + resume link +
 *       "We have emailed …" note, the resume email (subject, From =
 *       principal contact, body) and its link reopening the wizard
 *       at the last-saved step
 *   s2  My Submissions: "Incomplete submissions" view (count 1) +
 *       the same draft under "Active submissions" (double-listing),
 *       draft-row anatomy (Incomplete badge, empty Actions, Complete
 *       submission), resume at the last-saved step with earlier
 *       steps completed
 *   s3  wizard Cancel: footer-only placement (leftmost of Cancel ·
 *       Save for Later · Continue; none in the page heading), the
 *       "Cancel submission" dialog verbatim, the "Submission
 *       cancelled" landing page, the draft gone from both views
 *   s4  author bulk delete: More Actions → Delete Incomplete
 *       Submissions, selection mode (sr column header, checkboxes on
 *       draft rows ONLY), disabled-until-checked delete button, the
 *       confirm dialog verbatim, live count updates (Active 3→1,
 *       Incomplete 2→0), the submitted sibling untouched
 *   s5  Journal Manager cleans up a foreign, unassigned draft from
 *       the editorial dashboard (visible in Active submissions AND
 *       Needs editor, each row with Complete submission); a Section
 *       Editor has no "More Actions" control at all. The draft is
 *       begun through the REAL wizard start form — scenario-seeded
 *       submitted:false drafts carry NULL date_submitted and are
 *       excluded from any isUnassigned query (seeding fidelity gap;
 *       see the inline comment)
 *   s6  ⚠ the stale "Saved for Later" page after submit (ledger row
 *       178): the kept address still renders the not-yet-submitted
 *       copy and the emailed-a-link claim (no second email is sent);
 *       only the embedded link reveals "Submission complete"
 *
 * As-built deviations the suite records but does NOT walk here (no
 * canonical scenario reaches them — see the spec's Known deviations):
 *  - the save-for-later email goes to the ACTING user (proposed
 *    ledger L-A) — s1's author-saves-own-draft path is deviation-
 *    neutral (acting user == author);
 *  - junk step tokens accepted/persisted (proposed L-B, extends 174)
 *    and the missing already-submitted guard (176) are API-only;
 *  - DELETE /api/v1/submissions/{id} 500-but-deletes (183) is an
 *    API-only surface owned by the ledger row.
 *
 * Parallel-safety: every submission is per-test; tags are single
 * hyphenless alphanumeric tokens riding in submission titles;
 * publicknowledge is used read-only + additively; count-sensitive
 * assertions (s2, s4) run as throwaway authors on per-test scratch
 * journals (the shared authors' lists carry heavy residue); Mailpit
 * reads are scoped by recipient + tag (principle 8); both UI delete
 * paths send POST + X-Http-Method-Override: DELETE — no literal
 * DELETE is ever intercepted (nothing is intercepted at all).
 */

test.use({user: 'author.alex'}); // the default actor: a pure-author account

const JOURNAL = 'publicknowledge';
const ALEX_EMAIL = 'author.alex@mailinator.com';

/** A unique, hyphenless, alphanumeric tag (parallel isolation). */
function uniqueTag(prefix = 'sd') {
	const workerLetter = String.fromCharCode(
		97 + (test.info().parallelIndex % 26),
	);
	let suffix = '';
	while (suffix.length < 6) {
		suffix += Math.random().toString(36).replace(/[^a-z0-9]/g, '');
	}
	return `${prefix}${workerLetter}${suffix.slice(0, 6)}`;
}

/** The wizard address for a given submission. */
function wizardUrl(submissionId, journalPath = JOURNAL) {
	return `/index.php/${journalPath}/submission?id=${submissionId}`;
}

/** Scenario spec for a wizard-resumable draft (submitted: false). */
function draftSpec({
	tag,
	title,
	journal = JOURNAL,
	submitter = 'author.alex',
	abstract,
	submitted = false,
}) {
	return {
		tag,
		journal,
		submitter,
		section: 'ART',
		locale: 'en',
		submitted,
		publications: [
			{
				metadata: {
					title: {en: title},
					...(abstract ? {abstract: {en: abstract}} : {}),
				},
			},
		],
	};
}

/**
 * Walk the wizard forward with Continue until `stepName` is the current
 * step. Step counts differ per journal (Reviewer Suggestions is
 * conditional), so walk by name, not by count.
 */
async function walkTo(wizard, stepName, max = 7) {
	const current = wizard.page.locator('.pkpSteps__step__label--current');
	const done = new RegExp(
		stepName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$',
	);
	for (let i = 0; i < max; i++) {
		const label = ((await current.textContent()) ?? '').trim();
		if (done.test(label)) {
			return;
		}
		await wizard.continueStep();
	}
	await wizard.expectStep(stepName);
}

/**
 * Wait out the Review step's transient "Checking your submission"
 * state (the entry validation call).
 */
async function awaitReviewCheck(page) {
	await expect(page.getByText('Checking your submission')).toBeHidden({
		timeout: 30_000,
	});
}

/** Open a wizard URL and wait for the Vue wizard to mount. */
async function openWizard(page, submissionId, journalPath = JOURNAL) {
	await page.goto(wizardUrl(submissionId, journalPath));
	await expect(page.locator('.submissionWizard')).toBeVisible({
		timeout: 20_000,
	});
}

/**
 * Server-side search of a dashboard list by the test's unique tag,
 * waiting for the filtered fetch to land before asserting on rows.
 */
async function searchList(page, dash, tag) {
	const searched = page.waitForResponse(
		(res) => res.url().includes(`searchPhrase=${tag}`) && res.ok(),
		{timeout: 20_000},
	);
	await dash.search(tag);
	await searched;
}

/**
 * A per-test scratch journal with one throwaway pure-author account —
 * the clean-slate actor every count-sensitive My Submissions assertion
 * needs (the shared publicknowledge authors carry heavy residue).
 */
async function scratchJournalWithAuthor(pkpApi, tag) {
	const username = `au${tag}`;
	const {context} = await pkpApi.createJournal({
		tag,
		users: [
			{
				username,
				password: username + username,
				email: `${username}@mailinator.com`,
				givenName: 'Dora',
				familyName: 'Drafts',
				roles: ['author'],
			},
		],
	});
	return {journalPath: context.path, username};
}

test.describe('Submission drafts', () => {
	test('s1: the author saves a half-finished submission for later — saved page, resume email, emailed link resumes at the saved step', async ({
		page,
		pkpApi,
		pkpMail,
	}) => {
		test.slow(); // wizard walk + saved page + Mailpit round-trip
		const tag = uniqueTag('sda');
		const title = `Draft parked ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			draftSpec({tag, title}),
		);

		const wizard = new SubmissionWizardPage(page);
		await openWizard(page, submission.id);

		// The action is offered twice: in the page heading after the
		// title and in the step footer (rule: permissions table row 1;
		// placement live-probed).
		const saveButtons = page.getByRole('button', {
			name: 'Save for Later',
			exact: true,
		});
		await expect(saveButtons).toHaveCount(2);
		await expect(
			page.locator('h1.app__pageHeading').getByRole('button', {
				name: 'Save for Later',
			}),
		).toBeVisible();
		await expect(
			page
				.locator('.submissionWizard__footer')
				.getByRole('button', {name: 'Save for Later'}),
		).toBeVisible();

		// Partway through — on Details — the author parks the draft.
		await wizard.continueStep();
		await wizard.expectStep('Details');
		await wizard.saveForLater(); // footer button; asserts the "Saved for Later" heading

		// The "Saved for Later" page (rule 4). publicknowledge is
		// multi-locale, so the address carries the locale segment.
		await expect(page).toHaveURL(
			new RegExp(`/${JOURNAL}/en/submission/saved\\?id=${submission.id}`),
		);
		await expect(
			page.getByText(
				'Your submission details have been saved in our system, but it has not yet been submitted for consideration. You can return to complete your submission at any time by following the link below.',
			),
		).toBeVisible();
		const savedLink = page.locator('a[href*="submission?id="]').first();
		await expect(savedLink).toContainText(title); // Authors — "Title"
		await expect(savedLink).toContainText('Author'); // authorsShort
		await expect(savedLink).toHaveAttribute(
			'href',
			new RegExp(`submission\\?id=${submission.id}`),
		);
		// The visitor's OWN address (the author pressed the button —
		// deviation-neutral here; the acting-user twist is L-A).
		await expect(
			page.getByText(
				`We have emailed a copy of this link to you at ${ALEX_EMAIL}`,
			),
		).toBeVisible();

		// The resume email: from the journal's principal contact, the
		// default subject, the body copy, and the wizard link labelled
		// Authors — "Title" (Side effects).
		const [message] = await pkpMail.find({to: ALEX_EMAIL, contains: tag});
		expect(message.Subject).toBe(
			'Resume your submission to Journal of Public Knowledge',
		);
		expect(message.From.Address).toBe('manager.maya@mailinator.com');
		const full = await pkpMail.fullMessage(message.ID);
		expect(full.HTML).toContain('Alex Author'); // greets the recipient
		expect(full.HTML).toContain(
			'details have been saved in our system',
		);
		expect(full.HTML).toContain('This is an automated email');

		// Following the emailed link reopens the wizard where they left
		// off (rule 8). Navigate by path so the link's absolute host
		// can't clash with the per-worker server ports.
		const link = pkpMail.extractLink(full.HTML, title);
		const linkUrl = new URL(link);
		await page.goto(linkUrl.pathname + linkUrl.search);
		await expect(page.locator('.submissionWizard')).toBeVisible({
			timeout: 20_000,
		});
		await wizard.expectStep('Details');
	});

	test('s2: the author resumes a draft from My Submissions — Incomplete view count, double-listing under Active, draft-row anatomy, resume at the saved step', async ({
		asUser,
		pkpApi,
	}) => {
		test.slow(); // scratch journal + throwaway-author login + wizard walk
		const tag = uniqueTag('sdb');
		// A fresh author on a scratch journal: the view counts asserted
		// below (Incomplete 1 / Active 1) demand a clean slate.
		const {journalPath, username} = await scratchJournalWithAuthor(
			pkpApi,
			tag,
		);
		const title = `Resumable draft ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			draftSpec({tag, title, journal: journalPath, submitter: username}),
		);

		const auCtx = await asUser(username);
		const auPage = await auCtx.newPage();

		// Park the draft on Details so the resume has a step to return
		// to (seeded drafts start at step 1).
		const wizard = new SubmissionWizardPage(auPage, journalPath);
		await openWizard(auPage, submission.id, journalPath);
		await wizard.continueStep();
		await wizard.expectStep('Details');
		await wizard.saveForLater();

		const dash = new DashboardPage(auPage, {journal: journalPath});
		await dash.gotoMySubmissions();
		await expect(auPage.getByText('My Submissions as Author')).toBeVisible({
			timeout: 20_000,
		});

		// The dedicated view counts the draft — and the same draft is
		// ALSO counted under Active submissions (rule 6, the
		// double-listing; Open question 4 records the ambiguity).
		await expect(dash.navItem('Incomplete submissions')).toHaveText(
			/^\s*1\s*Incomplete submissions/,
		);
		await expect(dash.navItem('Active submissions')).toHaveText(
			/^\s*1\s*Active submissions/,
		);

		// Landing view is Active submissions; the draft's row is there…
		await expect(dash.viewHeading(/Active submissions/)).toBeVisible();
		await expect(dash.row(tag)).toBeVisible();

		// …and in the Incomplete view, where the row anatomy is checked
		// (rule 7): "Incomplete" stage badge, empty Actions cell (no
		// View), "Complete submission" in Editorial Activity.
		await dash.navItem('Incomplete submissions').click();
		await expect(dash.viewHeading(/Incomplete submissions/)).toBeVisible();
		const row = dash.row(tag);
		await expect(row).toBeVisible();
		await expect(row.getByText('Incomplete', {exact: true})).toBeVisible();
		await expect(row.getByText('View', {exact: true})).toHaveCount(0);
		const resume = row.getByRole('button', {
			name: 'Complete submission',
			exact: true,
		});
		await expect(resume).toBeVisible();

		// Resuming reopens the wizard at the last-saved step, earlier
		// steps already completed (rule 8; live-probed → #details).
		await resume.click();
		await expect(auPage.locator('.submissionWizard')).toBeVisible({
			timeout: 20_000,
		});
		await wizard.expectStep('Details');
		await expect(
			auPage
				.locator('.pkpSteps__step__label--completed')
				.filter({hasText: 'Upload Files'}),
		).toBeVisible();
	});

	test('s3: the author cancels a draft from inside the wizard — footer-only Cancel, the warning dialog, the cancelled page, gone from both views', async ({
		page,
		pkpApi,
	}) => {
		test.slow(); // wizard + dialog + two searched dashboard views
		const tag = uniqueTag('sdc');
		const title = `Cancel me ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			draftSpec({tag, title}),
		);

		await openWizard(page, submission.id);

		// Cancel lives ONLY in the step footer — the page heading offers
		// just Save for Later — and it is the leftmost of the footer trio
		// Cancel · Save for Later · Continue (rule 10's wizard half).
		await expect(
			page.locator('h1.app__pageHeading').getByRole('button', {
				name: 'Cancel',
			}),
		).toHaveCount(0);
		const footer = page.locator('.submissionWizard__footer');
		await expect(footer.locator('#cancelSubmission')).toBeVisible();
		const footerLabels = await footer.locator('button').allTextContents();
		const order = footerLabels.map((t) => t.trim());
		expect(order.indexOf('Cancel')).toBeGreaterThanOrEqual(0);
		expect(order.indexOf('Cancel')).toBeLessThan(
			order.indexOf('Save for Later'),
		);
		expect(order.indexOf('Save for Later')).toBeLessThan(
			order.indexOf('Continue'),
		);

		// The "Cancel submission" dialog, verbatim (rule 9; deletion is
		// permanent and total), with OK/Cancel buttons.
		await footer.locator('#cancelSubmission').click();
		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible({timeout: 10_000});
		await expect(
			dialog.getByRole('heading', {name: 'Cancel submission'}),
		).toBeVisible();
		await expect(dialog).toContainText(
			'Are you sure you wish to cancel this submission? This will delete the submission and all associated data. This action cannot be undone.',
		);
		await expect(dialog.getByRole('button', {name: 'OK'})).toBeVisible();
		await expect(
			dialog.getByRole('button', {name: 'Cancel', exact: true}),
		).toBeVisible();
		await dialog.getByRole('button', {name: 'OK'}).click();

		// The "Submission cancelled" landing page with its two links.
		await expect(
			page.getByRole('heading', {name: 'Submission cancelled'}),
		).toBeVisible({timeout: 20_000});
		await expect(
			page.getByText(
				'Submission has been cancelled, and all associated data has been deleted.',
			),
		).toBeVisible();
		await expect(
			page.getByRole('link', {name: 'Create a new submission'}),
		).toBeVisible();
		await expect(
			page.getByRole('link', {name: 'Return to your dashboard'}),
		).toBeVisible();

		// Gone from BOTH My Submissions views (search-scoped — the
		// shared author's lists carry residue, counts are not clean).
		const dash = new DashboardPage(page);
		await dash.gotoMySubmissions();
		await expect(dash.viewHeading(/Active submissions/)).toBeVisible({
			timeout: 20_000,
		});
		await searchList(page, dash, tag);
		await expect(dash.row(tag)).toHaveCount(0);
		await dash.navItem('Incomplete submissions').click();
		await expect(dash.viewHeading(/Incomplete submissions/)).toBeVisible();
		await searchList(page, dash, tag);
		await expect(dash.row(tag)).toHaveCount(0);
	});

	test('s4: the author bulk-deletes their drafts — selection mode, draft-only checkboxes, verbatim confirm, live counts, submitted sibling untouched', async ({
		asUser,
		pkpApi,
	}) => {
		test.slow(); // scratch journal + three seeded submissions
		const tag = uniqueTag('sdd');
		const {journalPath, username} = await scratchJournalWithAuthor(
			pkpApi,
			tag,
		);
		const draftOne = `Draft one ${tag}`;
		const draftTwo = `Draft two ${tag}`;
		const submittedTitle = `Submitted ${tag}`;
		await pkpApi.createSubmission(
			draftSpec({
				tag: `${tag}a`,
				title: draftOne,
				journal: journalPath,
				submitter: username,
			}),
		);
		await pkpApi.createSubmission(
			draftSpec({
				tag: `${tag}b`,
				title: draftTwo,
				journal: journalPath,
				submitter: username,
			}),
		);
		await pkpApi.createSubmission(
			draftSpec({
				tag: `${tag}c`,
				title: submittedTitle,
				journal: journalPath,
				submitter: username,
				submitted: true,
			}),
		);

		const auCtx = await asUser(username);
		const auPage = await auCtx.newPage();
		const dash = new DashboardPage(auPage, {journal: journalPath});
		await dash.gotoMySubmissions();
		await expect(dash.viewHeading(/Active submissions/)).toBeVisible({
			timeout: 20_000,
		});

		// Clean-slate counts: 2 drafts + 1 submitted.
		await expect(dash.navItem('Active submissions')).toHaveText(
			/^\s*3\s*Active submissions/,
		);
		await expect(dash.navItem('Incomplete submissions')).toHaveText(
			/^\s*2\s*Incomplete submissions/,
		);

		// The "…" More Actions menu offers the one red bulk action
		// (rule 10) — enabled, since deletable drafts are on the list.
		await auPage
			.getByRole('button', {name: 'More Actions', exact: true})
			.click();
		const menuItem = auPage.getByRole('menuitem', {
			name: 'Delete Incomplete Submissions',
		});
		await expect(menuItem).toBeVisible();
		await menuItem.click();

		// Selection mode: the checkbox column (sr-only header) appears,
		// with a checkbox ONLY on the two draft rows — the submitted row
		// gets none (rule 10).
		await expect(
			auPage.getByRole('columnheader', {
				name: 'Select incomplete submissions to be deleted.',
			}),
		).toBeVisible();
		await expect(dash.row(draftOne).getByRole('checkbox')).toBeVisible();
		await expect(dash.row(draftTwo).getByRole('checkbox')).toBeVisible();
		await expect(
			dash.row(submittedTitle).getByRole('checkbox'),
		).toHaveCount(0);
		// The submitted row is the mirror image: "View" in Actions,
		// no "Complete submission" (rule 7).
		await expect(
			dash.row(submittedTitle).getByText('View', {exact: true}),
		).toBeVisible();
		await expect(
			dash
				.row(submittedTitle)
				.getByText('Complete submission', {exact: true}),
		).toHaveCount(0);

		// The red delete button stays disabled until something is
		// checked; a Cancel button sits beside it.
		const deleteButton = auPage.getByRole('button', {
			name: 'Delete Incomplete Submissions',
		});
		await expect(deleteButton).toBeDisabled();
		await expect(
			auPage.getByRole('button', {name: 'Cancel', exact: true}),
		).toBeVisible();
		// The real <input> is sr-only under a styled span that intercepts
		// pointer events — force the check onto the input itself.
		await dash.row(draftOne).getByRole('checkbox').check({force: true});
		await dash.row(draftTwo).getByRole('checkbox').check({force: true});
		await expect(deleteButton).toBeEnabled();

		// The confirmation dialog, verbatim (rule 10).
		await deleteButton.click();
		const dialog = auPage
			.locator('[data-cy="dialog"]')
			.filter({hasText: 'Confirm Delete of Incomplete Submissions'});
		await expect(dialog).toBeVisible({timeout: 10_000});
		await expect(dialog).toContainText(
			'Are you sure you want to delete the selected items? This action cannot be undone. Please confirm to proceed.',
		);
		// The UI fires this as POST + X-Http-Method-Override: DELETE to
		// api/v1/_submissions (ids[] array) — nothing is intercepted.
		await dialog.getByRole('button', {name: 'Confirm'}).click();

		// Both drafts vanish, counts drop at once, selection mode ends,
		// and the submitted submission is untouched.
		await expect(dash.row(draftOne)).toHaveCount(0, {timeout: 20_000});
		await expect(dash.row(draftTwo)).toHaveCount(0);
		await expect(dash.row(submittedTitle)).toBeVisible();
		await expect(dash.navItem('Active submissions')).toHaveText(
			/^\s*1\s*Active submissions/,
		);
		await expect(dash.navItem('Incomplete submissions')).toHaveText(
			/^\s*0\s*Incomplete submissions/,
		);
		await expect(
			auPage.getByRole('columnheader', {
				name: 'Select incomplete submissions to be deleted.',
			}),
		).toHaveCount(0);
	});

	test('s5: a Journal Manager cleans up another author\'s unassigned draft; a Section Editor has no More Actions control at all', async ({
		asUser,
	}) => {
		test.slow(); // three actors + three searched dashboard views
		const tag = uniqueTag('sde');
		const title = `Abandoned draft ${tag}`;
		// author.bea begins the draft through the REAL wizard start form
		// — unassigned (drafts assign no editors) and foreign to the
		// manager. Deliberately NOT scenario-seeded: the Begin Submission
		// form posts to the plain POST api/v1/submissions, which stamps
		// date_submitted at creation (ledger row 167), and the Needs
		// editor collector requires it (`whereNotNull(s.date_submitted)`
		// in Collector's isUnassigned SQL). A _test scenario draft
		// (submitted: false) carries NULL date_submitted and is excluded
		// from any isUnassigned query — a scenario-seeding fidelity gap
		// (ledger note pending), so it must not back a needs-editor
		// membership assertion. Arbitrated live 2026-07-11 (chunk D).
		const beaCtx = await asUser('author.bea');
		const beaPage = await beaCtx.newPage();
		const beaWizard = new SubmissionWizardPage(beaPage);
		await beaWizard.goto();
		await beaWizard.start({title, section: 'Articles'});
		expect(beaWizard.currentSubmissionId()).toBeTruthy();

		const mgrCtx = await asUser('manager.maya');
		const mgrPage = await mgrCtx.newPage();
		const dash = new DashboardPage(mgrPage);

		// Active submissions: the foreign draft shows with the Incomplete
		// badge and the manager's own Complete submission resume button
		// (rule 6 — there is no editor-side incomplete view).
		await dash.gotoEditorial();
		await dash.navItem('Active submissions').click();
		await expect(dash.viewHeading(/Active submissions/)).toBeVisible({
			timeout: 20_000,
		});
		await searchList(mgrPage, dash, tag);
		const activeRow = dash.row(tag);
		await expect(activeRow).toBeVisible();
		await expect(
			activeRow.getByText('Incomplete', {exact: true}),
		).toBeVisible();
		await expect(
			activeRow.getByRole('button', {
				name: 'Complete submission',
				exact: true,
			}),
		).toBeVisible();

		// The same unassigned draft also surfaces under "Needs editor",
		// its row carrying the same resume button (rule 6 — verified at
		// arbitration on a real wizard-begun draft; see the seeding note
		// above).
		await dash.navItem('Needs editor').click();
		await expect(dash.viewHeading(/Needs editor/)).toBeVisible();
		await searchList(mgrPage, dash, tag);
		await expect(dash.row(tag)).toBeVisible();
		await expect(
			dash.row(tag).getByRole('button', {
				name: 'Complete submission',
				exact: true,
			}),
		).toBeVisible();

		// Back in Active submissions, the manager bulk-deletes the draft
		// they were never assigned to (permissions table row 6).
		await dash.navItem('Active submissions').click();
		await expect(dash.viewHeading(/Active submissions/)).toBeVisible();
		await searchList(mgrPage, dash, tag);
		await expect(dash.row(tag)).toBeVisible();
		await mgrPage
			.getByRole('button', {name: 'More Actions', exact: true})
			.click();
		await mgrPage
			.getByRole('menuitem', {name: 'Delete Incomplete Submissions'})
			.click();
		await expect(dash.row(tag).getByRole('checkbox')).toBeVisible();
		// sr-only input under a styled span — force the check.
		await dash.row(tag).getByRole('checkbox').check({force: true});
		const deleteButton = mgrPage.getByRole('button', {
			name: 'Delete Incomplete Submissions',
		});
		await expect(deleteButton).toBeEnabled();
		await deleteButton.click();
		const dialog = mgrPage
			.locator('[data-cy="dialog"]')
			.filter({hasText: 'Confirm Delete of Incomplete Submissions'});
		await expect(dialog).toBeVisible({timeout: 10_000});
		await dialog.getByRole('button', {name: 'Confirm'}).click();
		await expect(dash.row(tag)).toHaveCount(0, {timeout: 20_000});

		// A Section Editor's dashboard renders no "…" More Actions
		// control anywhere — the button only exists when the user has
		// ≥1 bulk action (permissions table row 6; live-probed).
		const seCtx = await asUser('sectioneditor.ana');
		const sePage = await seCtx.newPage();
		const seDash = new DashboardPage(sePage);
		await seDash.gotoEditorial();
		await expect(seDash.filterButton).toBeVisible({timeout: 20_000});
		await expect(
			sePage.getByRole('button', {name: 'More Actions', exact: true}),
		).toHaveCount(0);
	});

	test('s6: the Saved for Later page goes stale after submitting — ⚠ ledger row 178, asserted as-built', async ({
		page,
		pkpApi,
		pkpMail,
	}) => {
		test.slow(); // full wizard walk to Review + submit
		const tag = uniqueTag('sdf');
		const title = `Stale saved ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			draftSpec({
				tag,
				title,
				abstract: `<p>Abstract for ${tag}.</p>`, // ART requires one to submit
			}),
		);

		// Save for later and keep the page's address.
		const wizard = new SubmissionWizardPage(page);
		await openWizard(page, submission.id);
		await wizard.saveForLater();
		const savedUrl = page.url();
		await expect(
			page.getByText('not yet been submitted for consideration'),
		).toBeVisible();

		// Finish and submit (the seeded draft already carries an Article
		// Text file; the abstract was seeded above).
		await openWizard(page, submission.id);
		await walkTo(wizard, 'Review');
		await awaitReviewCheck(page);
		const submitDialog = await wizard.openSubmitDialog();
		await submitDialog.getByRole('button', {name: 'Submit'}).click();
		await expect(
			page.getByRole('heading', {name: 'Submission complete'}),
		).toBeVisible({timeout: 20_000});

		// ⚠ As-built (ledger row 178, spec Known deviations — do NOT
		// "fix" to intent): the kept address still renders the full
		// not-yet-submitted copy and the emailed-a-link claim for a
		// submission that HAS been submitted.
		await page.goto(savedUrl);
		await expect(
			page.getByRole('heading', {name: 'Saved for Later'}),
		).toBeVisible({timeout: 20_000});
		await expect(
			page.getByText(
				'Your submission details have been saved in our system, but it has not yet been submitted for consideration.',
			),
		).toBeVisible();
		await expect(
			page.getByText(
				`We have emailed a copy of this link to you at ${ALEX_EMAIL}`,
			),
		).toBeVisible();

		// Only following the embedded link reveals the truth: the wizard
		// address of a submitted submission renders "Submission
		// complete" (the wizard spec's "submitted means submitted").
		await page.locator('a[href*="submission?id="]').first().click();
		await expect(
			page.getByRole('heading', {name: 'Submission complete'}),
		).toBeVisible({timeout: 20_000});

		// No second resume email accompanied the stale revisit — the one
		// from the original Save for Later stays the only one (scoped by
		// recipient + tag + subject; the submit's acknowledgement email
		// has a different subject and doesn't match).
		const resumeMails = await pkpMail.find({
			to: ALEX_EMAIL,
			contains: tag,
			subject: 'Resume your submission',
		});
		expect(resumeMails.length).toBe(1);
	});
});
