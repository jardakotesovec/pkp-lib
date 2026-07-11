// @ts-check
const {test, expect} = require('../support/base-test.js');
const {DashboardPage} = require('../pages/DashboardPage.js');
const {LoginPage} = require('../pages/LoginPage.js');
const {ReviewRoundPanel} = require('../pages/ReviewRoundPanel.js');
const {FileStagePanel, fixtureFilePath} = require('../pages/FileStagePanel.js');

/**
 * Author dashboard (My Submissions & the author's tracking view) — one
 * test per canonical scenario of docs/product/specs/author-dashboard.md
 * (6 scenarios → 6 tests). The feature is shared pkp-lib (the
 * mySubmissions dashboard page, the author workflow config, the legacy
 * authorDashboard redirect + read-email popup), so the spec lives here —
 * mirroring submission-drafts.spec.js; the scenario payloads necessarily
 * use OJS vocabulary (publicknowledge / ART), matching the bootstrap
 * context the suite runs against.
 *
 * Coverage per scenario:
 *   s1  fresh submission: the seven views in order with count badges,
 *       "Active submissions (1)" heading, row anatomy (ID, authors +
 *       title, "Submission" badge, EMPTY activity cell, View; the five
 *       columns with no Days), the tracking view's menu shape (Workflow
 *       stages + one version expanding to Title & Abstract /
 *       Contributors / Metadata / Galleys / Media, never the
 *       editor-only pages), Submission Files (Download All Files,
 *       "Update File Details" as the ONLY per-file action), Tasks &
 *       Discussions, an unstarted Copyediting stage, close → unchanged
 *   s2  revisions round-trip: "Revisions requested" counts 1, the row's
 *       "Revision requested" alert + "Submit revisions" → the 3-step
 *       legacy wizard over the list; the round view's Notifications
 *       listing / Revisions Uploaded / Upload revisions; after Complete
 *       the list refreshes without reload — the row moves to "Revisions
 *       submitted" showing "Review update 0/0" (⚠ NO "Revisions
 *       submitted" alert, AD-F) and Upload revisions persists
 *   s3  can/can't touch: no grant → typeable fields with a disabled
 *       Save on Title & Abstract and Metadata; Contributors is
 *       Preview-only (⚠ AD-A — grant or not), Galleys/Media are bare
 *       lists; language line with no change control; header offers only
 *       Library; a granted co-author's Save is enabled and a saved
 *       change survives a reload
 *   s4  multi-role navigation: manager+reviewer+author lands on the
 *       editorial dashboard after login; three nav sections in order;
 *       "Start A New Submission" exactly once, as the last entry of
 *       Editor Dashboard's submenu; their own submission opened from My
 *       Submissions gets the AUTHOR variant (no decision buttons, no
 *       Participants panel, header = Library)
 *   s5  legacy bookmark + read-email popup: /authorDashboard/submission
 *       lands on My Submissions with the tracking view open; the review
 *       round's Notifications entry opens the "Notifications" popup
 *       with subject, sent date and full body; closing and reopening
 *       looks the same — nothing is marked read
 *   s6  end states: Published 1 / Declined 1 / Active 0 ("No Items");
 *       published row (badge, EMPTY activity) opens on the latest
 *       version's Title & Abstract with the published banner; declined
 *       row (badge, "Review update 0/0" indicator) opens on its last
 *       review round reading "Submission declined." with nothing to act
 *       on
 *
 * As-built deviations the suite records but does NOT walk here (no
 * canonical scenario reaches them — see the spec's Known deviations):
 *  - AD-B ("Assigned To Editor" filter leak/no-op for author+manager
 *    users) and AD-G (view switches keep filters) are filter-panel
 *    surfaces owned by the spec's rules 3/Fields tables;
 *  - AD-D (published version: Save stays enabled after a re-grant) needs
 *    an editor RE-granting metadata edits post-publish;
 *  - AD-E (Upload revisions vanishes on the resubmit path) is the
 *    resubmit-for-review decision path — s2 walks the same-round path;
 *  - AD-C (dead legacy reviewRoundInfo op) is a 404 with no UI.
 *
 * Parallel-safety: every submission is per-test; tags are single
 * hyphenless alphanumeric tokens riding in submission titles;
 * publicknowledge is used read-only + additively (s3, s5);
 * count-sensitive assertions (s1, s2, s4, s6) run as throwaway authors
 * on per-test scratch journals; no seeded user gains a role anywhere
 * (scratch journals carry their own throwaway editors/managers; the s3
 * co-author grant is a per-submission stage assignment, not a role
 * change); no Mailpit reads (decision emails are seeding-side and
 * asserted through the UI's Notifications listing instead).
 */

test.use({user: 'author.alex'}); // the default actor: a pure-author account

const JOURNAL = 'publicknowledge';

/** A unique, hyphenless, alphanumeric tag (parallel isolation). */
function uniqueTag(prefix = 'ad') {
	const workerLetter = String.fromCharCode(
		97 + (test.info().parallelIndex % 26),
	);
	let suffix = '';
	while (suffix.length < 6) {
		suffix += Math.random().toString(36).replace(/[^a-z0-9]/g, '');
	}
	return `${prefix}${workerLetter}${suffix.slice(0, 6)}`;
}

/** The author's tracking-view address for a submission. */
function trackingUrl(submissionId, journalPath = JOURNAL) {
	return `/index.php/${journalPath}/en/dashboard/mySubmissions?workflowSubmissionId=${submissionId}`;
}

/**
 * Scenario spec for a SUBMITTED submission. `publication` merges over
 * the default AO/unpublished publication (pass full metadata when
 * overriding it).
 */
function submittedSpec({
	tag,
	title,
	journal = JOURNAL,
	submitter = 'author.alex',
	participants,
	decisions,
	reviewRounds,
	publication,
}) {
	return {
		tag,
		journal,
		submitter,
		section: 'ART',
		locale: 'en',
		submitted: true,
		...(participants ? {participants} : {}),
		...(decisions ? {decisions} : {}),
		...(reviewRounds ? {reviewRounds} : {}),
		publications: [
			{
				versionStage: 'AO',
				published: false,
				metadata: {
					title: {en: title},
					abstract: {en: `<p>Abstract for ${tag}.</p>`},
				},
				...(publication ?? {}),
			},
		],
	};
}

/** A throwaway scratch-journal user spec (password rule: username×2). */
function throwawayUser(username, givenName, familyName, roles) {
	return {
		username,
		password: username + username,
		email: `${username}@mailinator.com`,
		givenName,
		familyName,
		roles,
	};
}

/** The workflow side modal the tracking view renders inside. */
function workflowModal(page) {
	return page.locator('[data-cy="active-modal"]').first();
}

/** Click an entry in the tracking view's left menu. */
async function clickMenu(page, label) {
	await workflowModal(page)
		.locator('nav')
		.getByText(label, {exact: true})
		.first()
		.click();
}

/** The tracking view's left menu. */
function menuNav(page) {
	return workflowModal(page).locator('nav').first();
}

/**
 * Open a publication page from the tracking view's left menu. The
 * per-version section is an accordion that can fold back after a
 * selection, so re-expand it whenever the target item is hidden.
 */
async function openPublicationPage(page, label) {
	const nav = menuNav(page);
	const item = nav.getByText(label, {exact: true}).first();
	if (!(await item.isVisible().catch(() => false))) {
		await nav.getByText(/1\.0/).first().click();
	}
	await expect(item).toBeVisible({timeout: 15_000});
	await item.click();
}

/**
 * A row's Editorial Activity cell. The ID column renders as the row
 * header, so the <td> cells are Submissions / Stage / Editorial
 * Activity / Actions — activity is the third.
 */
function activityCell(row) {
	return row.getByRole('cell').nth(2);
}

/** Close the tracking view (side modal header close button). */
async function closeTracking(page) {
	await workflowModal(page)
		.getByRole('button', {name: 'Close', exact: true})
		.first()
		.click();
}

/** Open a row's tracking view via its Actions "View" button. */
async function openRowView(dash, tag) {
	await dash
		.row(tag)
		.getByRole('button', {name: 'View', exact: true})
		.click();
	await expect(workflowModal(dash.page)).toContainText(tag, {
		timeout: 20_000,
	});
}

test.describe('Author dashboard', () => {
	test('s1: an author tracks a fresh submission — views/badges, row anatomy, the tracking view menu shape, submission files, an unstarted stage', async ({
		asUser,
		pkpApi,
	}) => {
		test.slow(); // scratch journal + full tracking-view walk
		const tag = uniqueTag('ada');
		const au = `au${tag}`;
		const {context} = await pkpApi.createJournal({
			tag,
			// References/Data join the author menu only when the journal
			// collects them (Settings that modify behavior) — keep both
			// dials off so scenario 1's five-page menu is exact.
			citations: 0,
			users: [throwawayUser(au, 'Tessa', 'Tracker', ['author'])],
		});
		const journalPath = context.path;
		const title = `Fresh submission ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({tag, title, journal: journalPath, submitter: au}),
		);

		const auCtx = await asUser(au);
		const page = await auCtx.newPage();
		const dash = new DashboardPage(page, {journal: journalPath});
		await dash.gotoMySubmissions();

		// The seven views, in order, each with a count badge (rule 1) —
		// clean-slate counts on the scratch journal: only Active counts
		// the one fresh submission.
		await expect(dash.viewLinks('mySubmissions')).toHaveText(
			[
				/^\s*1\s*Active submissions/,
				/^\s*0\s*Revisions requested/,
				/^\s*0\s*Revisions submitted/,
				/^\s*0\s*Incomplete submissions/,
				/^\s*0\s*Scheduled for publication/,
				/^\s*0\s*Published/,
				/^\s*0\s*Declined/,
			],
			{timeout: 20_000},
		);

		// Landing view + heading format (rule 2).
		await expect(
			dash.viewHeading('Active submissions (1)'),
		).toBeVisible();

		// Five columns, ID sortable, and NO Days column (rule 4).
		await expect(page.getByRole('columnheader')).toHaveText([
			/ID/,
			/Submissions/,
			/Stage/,
			/Editorial Activity/,
			/Actions/,
		]);
		await expect(
			page.getByRole('columnheader', {name: /Days/}),
		).toHaveCount(0);
		await expect(dash.sortButton('ID')).toBeVisible();

		// Row anatomy (rules 4–6): ID, authors + title, "Submission"
		// badge, an EMPTY Editorial Activity cell, View under Actions.
		const row = dash.row(tag);
		await expect(row).toBeVisible();
		await expect(row).toContainText(String(submission.id));
		await expect(row).toContainText('Tracker'); // the author's name
		await expect(row.getByText('Submission', {exact: true})).toBeVisible();
		await expect(activityCell(row)).toHaveText('');
		await expect(
			row.getByRole('button', {name: 'View', exact: true}),
		).toBeVisible();

		// View opens the tracking view as a panel over the list (rule 7).
		await openRowView(dash, tag);
		const nav = menuNav(page);
		for (const stage of [
			'Submission',
			'Review',
			'Copyediting',
			'Production',
		]) {
			await expect(nav.getByText(stage, {exact: true})).toBeVisible();
		}

		// One version section; expanding it shows the author's five
		// publication pages — never the editor-only ones, and no
		// References/Data on a journal without those dials (rule 7).
		await nav.getByText(/1\.0/).first().click();
		for (const item of [
			'Title & Abstract',
			'Contributors',
			'Metadata',
			'Galleys',
			'Media',
		]) {
			await expect(nav.getByText(item, {exact: true})).toBeVisible();
		}
		for (const never of [
			'References',
			'Data',
			'Identifiers',
			'JATS XML',
			'Body Text',
			'Permissions & Disclosure',
			'Publication Settings',
			'Create New Version',
		]) {
			await expect(nav.getByText(never, {exact: true})).toHaveCount(0);
		}

		// The Submission stage: "Submission Files" with the description,
		// Download All Files, and "Update File Details" as the ONLY
		// per-file action (rule 9) — plus Tasks & Discussions.
		const files = new FileStagePanel(page, 'Submission Files');
		await files.expectVisible();
		await expect(
			page.getByText('Files uploaded at the time of submission'),
		).toBeVisible();
		await expect(
			files.root().getByRole('button', {name: 'Download All Files'}),
		).toBeVisible();
		await files.table
			.getByRole('button', {name: /More Actions/i})
			.first()
			.click();
		await expect(page.getByRole('menuitem')).toHaveText([
			'Update File Details',
		]);
		await page.keyboard.press('Escape');
		await expect(
			workflowModal(page).getByText(/Tasks & Discussions/).first(),
		).toBeVisible();

		// An unstarted stage shows only the not-initiated sentence under
		// Status, after the language line (rule 8).
		await clickMenu(page, 'Copyediting');
		await expect(
			workflowModal(page).getByText(
				'The Copyediting stage has not yet been initiated.',
			),
		).toBeVisible();
		await expect(
			workflowModal(page).getByText(/Current Submission Language:/),
		).toBeVisible();

		// Closing the panel returns to the unchanged list (rule 7).
		await closeTracking(page);
		await expect(
			dash.viewHeading('Active submissions (1)'),
		).toBeVisible({timeout: 20_000});
		await expect(dash.row(tag)).toBeVisible();
	});

	test('s2: revisions round-trip — Revision requested alert, the 3-step wizard over the list, the move to Revisions submitted with the review-update indicator', async ({
		asUser,
		pkpApi,
	}) => {
		test.slow(); // scratch journal + tracking view + legacy wizard
		const tag = uniqueTag('adb');
		const au = `au${tag}`;
		const ed = `ed${tag}`;
		const {context} = await pkpApi.createJournal({
			tag,
			users: [
				throwawayUser(au, 'Rita', 'Reviser', ['author']),
				throwawayUser(ed, 'Edda', 'Editor', ['editor']),
			],
		});
		const journalPath = context.path;
		const title = `Revise me ${tag}`;
		await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				journal: journalPath,
				submitter: au,
				participants: [{user: ed, role: 'editor'}],
				decisions: [
					{type: 'sendExternalReview', by: ed},
					{
						type: 'requestRevisions',
						by: ed,
						toAuthor: `<p>Please revise your submission — ${tag}.</p>`,
					},
				],
				reviewRounds: [{reviewers: []}],
			}),
		);

		const auCtx = await asUser(au);
		const page = await auCtx.newPage();
		const dash = new DashboardPage(page, {journal: journalPath});
		await dash.gotoMySubmissions();

		// The "Revisions requested" view now counts 1 (the submission is
		// also still Active — rule 1's multi-membership).
		await expect(dash.navItem('Revisions requested')).toHaveText(
			/^\s*1\s*Revisions requested/,
			{timeout: 20_000},
		);
		await expect(dash.navItem('Active submissions')).toHaveText(
			/^\s*1\s*Active submissions/,
		);
		await dash.navItem('Revisions requested').click();
		await expect(
			dash.viewHeading('Revisions requested (1)'),
		).toBeVisible();

		// Row: latest-round stage badge, the alert + action (rule 5).
		const row = dash.row(tag);
		await expect(row.getByText('Review (Round 1)')).toBeVisible();
		await expect(
			row.getByText('Revision requested', {exact: true}),
		).toBeVisible();
		const submitRevisions = row.getByRole('button', {
			name: 'Submit revisions',
			exact: true,
		});
		await expect(submitRevisions).toBeVisible();

		// Inside the tracking view's Review Round 1: the Notifications
		// listing with the editor's decision email, the Revisions
		// Uploaded area, and the Upload revisions button (rule 9).
		await openRowView(dash, tag);
		await expect(
			workflowModal(page).getByRole('heading', {name: 'Notifications'}),
		).toBeVisible({timeout: 20_000});
		// The seeded decision email's subject (the scenario layer stamps
		// its own subject line for the notifyAuthors action).
		await expect(
			workflowModal(page).getByText(
				'[scenario] requestRevisions — notify author',
			),
		).toBeVisible();
		await expect(
			page.getByRole('table', {name: 'Revisions Uploaded'}),
		).toBeVisible();
		await expect(
			workflowModal(page).getByRole('button', {
				name: 'Upload revisions',
				exact: true,
			}),
		).toBeVisible();
		await closeTracking(page);
		await expect(
			dash.viewHeading('Revisions requested (1)'),
		).toBeVisible({timeout: 20_000});

		// "Submit revisions" opens the legacy 3-step wizard right over
		// the list (Upload File / Review Details / Confirm).
		await submitRevisions.click();
		// The wizard dialog's title is EMPTY on this path (the dashboard
		// config pre-translates wizardTitleKey and the file-manager action
		// translates it again — proposed ledger row; the workflow-side
		// button passes the raw key and titles the same dialog "Upload
		// Review File"), so locate the dialog by its step tabs.
		const wizard = page
			.getByRole('dialog')
			.filter({has: page.getByRole('tab', {name: '1. Upload File'})})
			.first();
		await expect(wizard).toBeVisible({timeout: 15_000});
		await expect(wizard.getByText('1. Upload File')).toBeVisible();
		await expect(wizard.getByText('2. Review Details')).toBeVisible();
		await expect(wizard.getByText('3. Confirm')).toBeVisible();
		const revisionName = `Revision ${tag}.pdf`;
		const fsp = new FileStagePanel(page, 'Revisions Uploaded');
		await fsp.driveUploadWizard(wizard, {
			filePath: fixtureFilePath(),
			displayName: revisionName,
		});

		// The list refreshes WITHOUT a reload: the row leaves "Revisions
		// requested" and the badges follow (Side effects: poll, don't
		// single-read).
		await expect(dash.row(tag)).toHaveCount(0, {timeout: 20_000});
		await expect(dash.navItem('Revisions requested')).toHaveText(
			/^\s*0\s*Revisions requested/,
			{timeout: 20_000},
		);
		await expect(dash.navItem('Revisions submitted')).toHaveText(
			/^\s*1\s*Revisions submitted/,
		);

		// The row is now under "Revisions submitted" (the author-facing
		// label — rule 1) with the compact review-progress indicator.
		// ⚠ As-built (spec Known deviations, AD-F): there is NO
		// "Revisions submitted" text alert — the cell shows only the
		// "Review update N/M" indicator.
		await dash.navItem('Revisions submitted').click();
		await expect(
			dash.viewHeading('Revisions submitted (1)'),
		).toBeVisible();
		const movedRow = dash.row(tag);
		await expect(movedRow).toBeVisible();
		await expect(movedRow.getByText('Review update 0/0')).toBeVisible();
		await expect(
			movedRow.getByText('Revision requested', {exact: true}),
		).toHaveCount(0);
		await expect(
			movedRow.getByRole('button', {name: 'Submit revisions'}),
		).toHaveCount(0);

		// Back inside the round: the uploaded file is listed and "Upload
		// revisions" is still there for further same-round files
		// (rule 9's same-round persistence — the resubmit-path vanish is
		// AD-E, not walked here).
		await openRowView(dash, tag);
		await expect(
			page.getByRole('table', {name: 'Revisions Uploaded'}),
		).toBeVisible({timeout: 20_000});
		await expect(
			page
				.getByRole('table', {name: 'Revisions Uploaded'})
				.getByRole('row')
				.filter({hasText: revisionName}),
		).toBeVisible();
		await expect(
			workflowModal(page).getByRole('button', {
				name: 'Upload revisions',
				exact: true,
			}),
		).toBeVisible();
	});

	test('s3: what an author can and can\'t touch — disabled Save without the grant, Preview-only Contributors (⚠ AD-A), bare Galleys/Media, and a granted co-author\'s save persists', async ({
		page,
		asUser,
		pkpApi,
	}) => {
		test.slow(); // two actors + several publication pages
		const tag = uniqueTag('adc');
		const title = `Touch test ${tag}`;
		// author.alex submits; author.bea holds a co-author stage
		// assignment WITH the metadata-edit grant. (The grant must ride a
		// participant who is not the submitter: re-building the
		// submitter's auto-assignment drops flags silently — scenario
		// seeding note. Stage assignments are per-submission and do not
		// enrol anyone in new journal roles.)
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				participants: [
					{user: 'editor.diana', role: 'editor'},
					{user: 'author.bea', role: 'author', canChangeMetadata: true},
				],
				publication: {
					versionStage: 'AO',
					published: false,
					metadata: {
						title: {en: title},
						abstract: {en: `<p>Abstract for ${tag}.</p>`},
					},
					galleys: [{label: 'PDF', locale: 'en'}],
					mediaFiles: [{variantType: 'web'}],
				},
			}),
		);

		// --- The ungranted author (alex, the submitter). ---
		await page.goto(trackingUrl(submission.id), {waitUntil: 'commit'});
		await expect(workflowModal(page)).toContainText(title, {
			timeout: 20_000,
		});

		// Stage views: the language line with no change control; the
		// header offers only "Library" (permissions table; rule 8).
		await expect(
			workflowModal(page).getByText(/Current Submission Language:/),
		).toBeVisible();
		await expect(
			workflowModal(page).getByRole('button', {
				name: /Change Submission Language/i,
			}),
		).toHaveCount(0);
		await expect(
			workflowModal(page).getByRole('button', {
				name: 'Library',
				exact: true,
			}),
		).toBeVisible();

		// Title & Abstract: fields accept typing, Save stays disabled
		// (rule 10; the prefix field is the form's plain-text input).
		await openPublicationPage(page, 'Title & Abstract');
		const prefix = workflowModal(page)
			.locator('input[id^="titleAbstract-prefix-control"]')
			.first();
		await expect(prefix).toBeVisible({timeout: 20_000});
		await prefix.fill('Typed but unsaved');
		await expect(prefix).toHaveValue('Typed but unsaved');
		await expect(
			workflowModal(page).getByRole('button', {name: 'Save', exact: true}),
		).toBeDisabled();

		// Metadata: the same — a real form with a disabled Save.
		await openPublicationPage(page, 'Metadata');
		await expect(
			workflowModal(page).getByRole('button', {name: 'Save', exact: true}),
		).toBeDisabled({timeout: 20_000});

		// Contributors: each row offers only "Preview" — no add, edit,
		// delete, reorder or set-primary anywhere.
		await openPublicationPage(page, 'Contributors');
		await expect(
			workflowModal(page)
				.getByRole('button', {name: 'Preview', exact: true})
				.first(),
		).toBeVisible({timeout: 20_000});
		await expect(
			workflowModal(page).getByText('Add Contributor'),
		).toHaveCount(0);
		await expect(
			workflowModal(page).getByRole('button', {name: 'Edit', exact: true}),
		).toHaveCount(0);
		await expect(
			workflowModal(page).getByRole('button', {
				name: 'Delete',
				exact: true,
			}),
		).toHaveCount(0);

		// Galleys and Media are bare lists: the rows render with zero
		// action controls and there is no add button (rule 10).
		await openPublicationPage(page, 'Galleys');
		const galleyRow = workflowModal(page)
			.getByRole('row')
			.filter({hasText: 'PDF'})
			.first();
		await expect(galleyRow).toBeVisible({timeout: 20_000});
		await expect(galleyRow.getByRole('button')).toHaveCount(0);
		await expect(
			workflowModal(page).getByRole('button', {name: /Add galley/i}),
		).toHaveCount(0);
		await openPublicationPage(page, 'Media');
		const mediaRow = workflowModal(page)
			.getByRole('row')
			.filter({hasText: 'dependent-image'})
			.first();
		await expect(mediaRow).toBeVisible({timeout: 20_000});
		await expect(mediaRow.getByRole('button')).toHaveCount(0);

		// --- The granted co-author (bea): Save comes alive and a saved
		//     change survives a reload (rule 10). ---
		const beaCtx = await asUser('author.bea');
		const beaPage = await beaCtx.newPage();
		await beaPage.goto(trackingUrl(submission.id), {waitUntil: 'commit'});
		await expect(workflowModal(beaPage)).toContainText(title, {
			timeout: 20_000,
		});
		await openPublicationPage(beaPage, 'Title & Abstract');
		const beaPrefix = workflowModal(beaPage)
			.locator('input[id^="titleAbstract-prefix-control"]')
			.first();
		await expect(beaPrefix).toBeVisible({timeout: 20_000});
		const beaSave = workflowModal(beaPage).getByRole('button', {
			name: 'Save',
			exact: true,
		});
		await expect(beaSave).toBeEnabled();
		await beaPrefix.fill(`Granted${tag}`);
		// The Vue form fires the save as a non-GET publications call (the
		// client may tunnel PUT through POST + X-Http-Method-Override).
		const saved = beaPage.waitForResponse(
			(res) =>
				res.url().includes('/publications/') &&
				res.request().method() !== 'GET' &&
				res.ok(),
			{timeout: 20_000},
		);
		await beaSave.click();
		await saved;

		await beaPage.goto(trackingUrl(submission.id), {waitUntil: 'commit'});
		await expect(workflowModal(beaPage)).toContainText(title, {
			timeout: 20_000,
		});
		await openPublicationPage(beaPage, 'Title & Abstract');
		await expect(
			workflowModal(beaPage)
				.locator('input[id^="titleAbstract-prefix-control"]')
				.first(),
		).toHaveValue(`Granted${tag}`, {timeout: 20_000});

		// ⚠ As-built (spec Known deviations, AD-A — do NOT "fix" to
		// intent): even WITH the metadata-edit grant, Contributors stays
		// Preview-only — the grant unlocks Title & Abstract and Metadata,
		// never the contributor list.
		await openPublicationPage(beaPage, 'Contributors');
		await expect(
			workflowModal(beaPage)
				.getByRole('button', {name: 'Preview', exact: true})
				.first(),
		).toBeVisible({timeout: 20_000});
		await expect(
			workflowModal(beaPage).getByText('Add Contributor'),
		).toHaveCount(0);
	});

	test('s4: multi-role navigation — editorial landing, three nav sections in order, one Start entry, and the author-variant tracking view', async ({
		browser,
		baseURL,
		pkpApi,
	}) => {
		test.slow(); // scratch journal + fresh UI login + tracking view
		const tag = uniqueTag('add');
		const mr = `mr${tag}`;
		const {context} = await pkpApi.createJournal({
			tag,
			users: [
				throwawayUser(mr, 'Mira', 'Multirole', [
					'manager',
					'reviewer',
					'author',
				]),
			],
		});
		const journalPath = context.path;
		const title = `Own submission ${tag}`;
		await pkpApi.createSubmission(
			submittedSpec({tag, title, journal: journalPath, submitter: mr}),
		);

		// A REAL login (not a cached storage state): the landing page is
		// role-priority — editorial roles win (rule 14).
		const ctx = await browser.newContext({
			baseURL,
			storageState: {cookies: [], origins: []},
		});
		const page = await ctx.newPage();
		const login = new LoginPage(page);
		await login.login(mr, mr + mr, journalPath);
		await page.waitForURL(/dashboard\/editorial/, {
			timeout: 20_000,
			waitUntil: 'commit',
		});

		// Three nav sections, in role-family order, and "Start A New
		// Submission" exactly once — the last entry of Editor Dashboard's
		// submenu, NOT under My Submissions (rule 14).
		const dash = new DashboardPage(page, {journal: journalPath});
		await expect(
			dash.nav.getByText('Editor Dashboard', {exact: true}),
		).toBeVisible({timeout: 20_000});
		await expect(
			dash.nav
				.locator('a')
				.filter({hasText: 'Start A New Submission'}),
		).toHaveCount(1);
		const entries = await dash.nav.locator('a, button').allTextContents();
		const idxOf = (needle) =>
			entries.findIndex((t) => t.includes(needle));
		expect(idxOf('Editor Dashboard')).toBeGreaterThanOrEqual(0);
		expect(idxOf('Start A New Submission')).toBeGreaterThan(
			idxOf('Editor Dashboard'),
		);
		expect(idxOf('My Assignments as Reviewer')).toBeGreaterThan(
			idxOf('Start A New Submission'),
		);
		expect(idxOf('My Submissions as Author')).toBeGreaterThan(
			idxOf('My Assignments as Reviewer'),
		);
		// Nothing sits between the Start entry and the reviewer section:
		// it IS the editor section's last entry.
		expect(idxOf('My Assignments as Reviewer')).toBe(
			idxOf('Start A New Submission') + 1,
		);

		// Their own submission opened from My Submissions is ALWAYS the
		// author's view — manager or not (rule 15): no decision buttons,
		// no Participants panel, header = Library.
		await dash.gotoMySubmissions();
		await expect(dash.row(tag)).toBeVisible({timeout: 20_000});
		await openRowView(dash, tag);
		const modal = workflowModal(page);
		await expect(
			modal.getByRole('button', {name: 'Library', exact: true}),
		).toBeVisible({timeout: 20_000});
		await expect(
			modal.locator('[data-cy="participant-manager"]'),
		).toHaveCount(0);
		for (const decision of [
			'Send for Review',
			'Accept and Skip Review',
			'Decline Submission',
		]) {
			await expect(
				modal.getByRole('button', {name: decision}),
			).toHaveCount(0);
		}
		await ctx.close();
	});

	test('s5: an old bookmark and an editor\'s email — legacy redirect opens the tracking view; the Notifications popup renders the email and marks nothing read', async ({
		page,
		pkpApi,
	}) => {
		const tag = uniqueTag('ade');
		const title = `Old bookmark ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				participants: [{user: 'editor.diana', role: 'editor'}],
				decisions: [
					{type: 'sendExternalReview', by: 'editor.diana'},
					{
						type: 'requestRevisions',
						by: 'editor.diana',
						toAuthor: `<p>Decision details for ${tag}.</p>`,
					},
				],
				reviewRounds: [{reviewers: []}],
			}),
		);

		// The years-old authorDashboard link lands on My Submissions with
		// the tracking view already open (rule 12).
		await page.goto(
			`/index.php/${JOURNAL}/authorDashboard/submission/${submission.id}`,
		);
		await expect(page).toHaveURL(
			/dashboard\/mySubmissions\?.*workflowSubmissionId=\d+/,
			{timeout: 20_000},
		);
		await expect(page).toHaveURL(/currentViewId=active/);
		const modal = workflowModal(page);
		await expect(modal).toContainText(title, {timeout: 20_000});

		// The review round's Notifications listing: one entry — the
		// decision email's subject and sent date (rule 11).
		await expect(
			modal.getByRole('heading', {name: 'Notifications'}),
		).toBeVisible({timeout: 20_000});
		// The seeded decision email's subject (the scenario layer stamps
		// its own subject line for the notifyAuthors action).
		const subject = '[scenario] requestRevisions — notify author';
		const listing = modal
			.locator('div')
			.filter({has: page.getByRole('heading', {name: 'Notifications'})})
			.last();
		await expect(listing.getByText(subject)).toBeVisible();
		await expect(listing.locator('li')).toHaveCount(1);

		// Clicking the subject opens the "Notifications" popup with the
		// email's subject, sent date and full body.
		await listing.getByText(subject).click();
		const popup = page.getByRole('dialog', {name: 'Notifications'}).first();
		await expect(popup).toBeVisible({timeout: 20_000});
		await expect(popup.getByText(subject).first()).toBeVisible();
		await expect(popup.getByText(/2\d{3}-\d{2}-\d{2}/)).toBeVisible(); // sent date
		await expect(
			popup.getByText(`Decision details for ${tag}.`),
		).toBeVisible(); // full body
		await popup
			.getByRole('button', {name: 'Close', exact: true})
			.first()
			.click();
		await expect(popup).toBeHidden({timeout: 15_000});

		// Nothing is marked read: the listing looks exactly the same and
		// reopening shows the same email (rule 11 / Side effects).
		await expect(listing.locator('li')).toHaveCount(1);
		await expect(listing.getByText(subject)).toBeVisible();
		await listing.getByText(subject).click();
		const reopened = page
			.getByRole('dialog', {name: 'Notifications'})
			.first();
		await expect(reopened).toBeVisible({timeout: 20_000});
		await expect(
			reopened.getByText(`Decision details for ${tag}.`),
		).toBeVisible();
	});

	test('s6: end states — Published and Declined views/badges, the published banner, and the declined round reading "Submission declined."', async ({
		asUser,
		pkpApi,
	}) => {
		test.slow(); // scratch journal + two seeded chains + two tracking views
		const tag = uniqueTag('adf');
		const au = `au${tag}`;
		const ed = `ed${tag}`;
		const {context} = await pkpApi.createJournal({
			tag,
			issues: [{volume: 1, number: 1, year: 2026, published: true}],
			users: [
				throwawayUser(au, 'Enda', 'Endstate', ['author']),
				throwawayUser(ed, 'Edna', 'Editor', ['editor']),
			],
		});
		const journalPath = context.path;
		const publishedTitle = `Published one ${tag}`;
		const declinedTitle = `Declined one ${tag}`;
		await pkpApi.createSubmission(
			submittedSpec({
				tag: `${tag}p`,
				title: publishedTitle,
				journal: journalPath,
				submitter: au,
				participants: [{user: ed, role: 'editor'}],
				decisions: [
					{type: 'sendExternalReview', by: ed},
					{type: 'accept', by: ed},
					{type: 'sendToProduction', by: ed},
				],
				reviewRounds: [{reviewers: []}],
				publication: {
					versionStage: 'VoR',
					metadata: {
						title: {en: publishedTitle},
						abstract: {en: `<p>Published abstract ${tag}.</p>`},
					},
					issue: 'latest',
					published: true,
				},
			}),
		);
		await pkpApi.createSubmission(
			submittedSpec({
				tag: `${tag}d`,
				title: declinedTitle,
				journal: journalPath,
				submitter: au,
				participants: [{user: ed, role: 'editor'}],
				decisions: [
					{type: 'sendExternalReview', by: ed},
					{type: 'decline', by: ed},
				],
				reviewRounds: [{reviewers: []}],
			}),
		);

		const auCtx = await asUser(au);
		const page = await auCtx.newPage();
		const dash = new DashboardPage(page, {journal: journalPath});
		await dash.gotoMySubmissions();

		// Published 1, Declined 1 — and Active contains neither (rule 1).
		await expect(dash.navItem('Published')).toHaveText(
			/^\s*1\s*Published/,
			{timeout: 20_000},
		);
		await expect(dash.navItem('Declined')).toHaveText(/^\s*1\s*Declined/);
		await expect(dash.navItem('Active submissions')).toHaveText(
			/^\s*0\s*Active submissions/,
		);
		await expect(
			dash.viewHeading('Active submissions (0)'),
		).toBeVisible();
		await expect(page.getByText('No Items')).toBeVisible();

		// The published row: "Published" badge, EMPTY activity cell,
		// View still offered (rules 4–6).
		await dash.navItem('Published').click();
		await expect(dash.viewHeading('Published (1)')).toBeVisible();
		const pubRow = dash.row(publishedTitle);
		await expect(pubRow).toBeVisible();
		await expect(
			pubRow.getByText('Published', {exact: true}),
		).toBeVisible();
		await expect(activityCell(pubRow)).toHaveText('');

		// It opens on the latest version's Title & Abstract carrying the
		// published banner (rules 7 and 10).
		await openRowView(dash, publishedTitle);
		await expect(
			workflowModal(page).getByText(
				'This version has been published and can not be edited.',
			),
		).toBeVisible({timeout: 20_000});
		await expect(
			workflowModal(page).getByText('Title & Abstract').first(),
		).toBeVisible();
		await closeTracking(page);

		// The declined row: "Declined" badge and — declined AFTER review —
		// the compact review-progress indicator, not an empty cell
		// (rule 5; the spec's Known-deviations note on declined rows).
		await dash.navItem('Declined').click();
		await expect(dash.viewHeading('Declined (1)')).toBeVisible({
			timeout: 20_000,
		});
		const decRow = dash.row(declinedTitle);
		await expect(decRow).toBeVisible();
		await expect(
			decRow.getByText('Declined', {exact: true}),
		).toBeVisible();
		await expect(decRow.getByText('Review update 0/0')).toBeVisible();

		// It opens on its last review round, whose status reads
		// "Submission declined." — history readable, nothing to act on
		// (rule 7).
		await openRowView(dash, declinedTitle);
		const rrp = new ReviewRoundPanel(page, {journalPath});
		await rrp.expectRoundStatus(1, 'Submission declined.');
		await expect(
			workflowModal(page).getByRole('button', {
				name: 'Upload revisions',
				exact: true,
			}),
		).toHaveCount(0);
		await expect(
			workflowModal(page).getByRole('button', {
				name: 'Submit revisions',
				exact: true,
			}),
		).toHaveCount(0);
	});
});
