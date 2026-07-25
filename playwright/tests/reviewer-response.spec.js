// @ts-check
const {test, expect} = require('../support/base-test.js');
const path = require('path');
const {DashboardPage} = require('../pages/DashboardPage.js');
const {DecisionWizardPage} = require('../pages/DecisionWizardPage.js');
const {LoginPage} = require('../pages/LoginPage.js');
const {ReviewerManagerPage} = require('../pages/ReviewerManagerPage.js');
const {ReviewerSubmissionPage} = require('../pages/ReviewerSubmissionPage.js');
const {WorkflowShellPage} = require('../pages/WorkflowShellPage.js');
const {getPassword} = require('../data/users.js');
const {
	getTinyMceContent,
	setTinyMceContent,
} = require('../support/tinymce.js');

/**
 * Reviewer response & completed review — one test per canonical scenario
 * of docs/product/specs/reviewer-response.md (12 scenarios → 12 tests).
 * The whole workspace ships from pkp-lib (PKPReviewerHandler +
 * lib/pkp/templates/reviewer/review/* + lib/ui-library
 * reviewerSubmission/*), so the spec lives in the shared folder; the
 * scenario payloads necessarily speak OJS (publicknowledge / ART /
 * sendExternalReview), matching the bootstrap the suite runs against.
 *
 * Coverage per scenario:
 *   s1  invited → accept → Continue to Step #3: locked tabs really lock,
 *       tab-1 request detail + Review Schedule, guidelines on tab 2,
 *       the full tab-3 furniture
 *   s2  decline with the reviewer's own reason: journal home page, the
 *       editors' "Unable to Review" mail, the actionless Declined row,
 *       and the workspace closing behind them
 *   s3  free-text review submitted: confirmation → tab 4, one Review
 *       complete mail per assigned section editor, the editor's
 *       "Review completed on <date>" dashboard line
 *   s4  Save for Later: stays on tab 3, tab 4 stays locked, values
 *       survive a genuine fresh sign-in, and nothing is mailed until the
 *       review is actually submitted (bounding control)
 *   s5  review form: title/description/questions replace the comment
 *       boxes, the required one is starred, a blocked submit still
 *       confirms first and then surfaces #reviewStep3MessageBox
 *   s6  ledger 16: the press after two refused confirmations is
 *       swallowed — nothing is submitted, and because nothing was saved
 *       the reloaded page needs the recommendation and the answer again
 *       (rule 11; two cycles is the deterministic form of the arming
 *       condition, one usually suffices)
 *   s7  submitted review is read-only — plus the three controls that are
 *       not (recommendation, comment boxes, attachment rename: rows
 *       76 / D / E)
 *   s8  competing interests declared on tab 1 ride into the decline and
 *       surface on the editor's reviewer row
 *   s9  Previous Reviews for a completed round 1 (with a real
 *       attachment) — and no Files For Review section (row H)
 *   s10 Previous Reviews for a declined round 1: "Submitted on" wording
 *       (rule 15) over a Declined Date + the emailed reason
 *   s11 only the reviewer's own current assignment opens the workspace
 *   s12 one-click access + Restrict File Access: signed-out link lands
 *       on tab 1 with no file list, files appear on tab 3; the same kind
 *       of link opened as another user shows a blank page (row I)
 *
 * Parallel-safety: every submission (and every scratch journal) is
 * per-test; tags are single hyphenless alphanumeric tokens carried in
 * the submission title, which every reviewer/editor mail interpolates;
 * Mailpit reads are recipient+tag scoped and the one absence assertion
 * is bounded by a positive control; no seeded user gains a role
 * anywhere (scratch-journal roles belong to throwaway accounts).
 */

const JOURNAL = 'publicknowledge';
const DUMMY_PDF = path.join(__dirname, '..', 'fixtures', 'files', 'dummy.pdf');
const SEEDED_FILE = 'default-article.pdf';

/** Seeded users this spec touches: display name + Mailpit address. */
const USER = {
	julia: {name: 'Julia Reviewer', email: 'reviewer.julia@mailinator.com'},
	paul: {name: 'Paul Reviewer', email: 'reviewer.paul@mailinator.com'},
	amara: {name: 'Amara Reviewer', email: 'reviewer.amara@mailinator.com'},
	ana: {name: 'Ana SectionEditor', email: 'sectioneditor.ana@mailinator.com'},
	ravi: {name: 'Ravi SectionEditor', email: 'sectioneditor.ravi@mailinator.com'},
};

/** A unique, hyphenless, alphanumeric tag (parallel isolation + mail scoping). */
function uniqueTag(prefix = 'rr') {
	const workerLetter = String.fromCharCode(
		97 + (test.info().parallelIndex % 26),
	);
	let suffix = '';
	while (suffix.length < 6) {
		suffix += Math.random().toString(36).replace(/[^a-z0-9]/g, '');
	}
	return `${prefix}${workerLetter}${suffix.slice(0, 6)}`;
}

/** Today as the app prints it in dashboards and history lines (Y-m-d, local). */
function today() {
	const d = new Date();
	const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

/**
 * Scenario payload for a submission already in external review round 1.
 *
 * @param {object} opts
 * @param {string} opts.tag
 * @param {Array}  [opts.reviewers]
 * @param {string} [opts.submitter]
 * @param {string} [opts.journal]
 * @param {Array}  [opts.participants]
 * @param {Array}  [opts.decisions]
 * @param {boolean} [opts.stage1]  omit the decisions so the submission
 *   sits on stage 1 (for tests that drive Send for Review themselves)
 */
function reviewSpec({
	tag,
	reviewers = [],
	submitter = 'author.alex',
	journal = JOURNAL,
	participants,
	decisions,
	stage1 = false,
}) {
	const editorBy = participants?.[0]?.user ?? 'editor.diana';
	return {
		tag,
		journal,
		submitter,
		section: 'ART',
		locale: 'en',
		participants: participants ?? [{user: 'editor.diana', role: 'editor'}],
		...(stage1
			? {submitted: true}
			: {
					decisions: decisions ?? [
						{type: 'sendExternalReview', by: editorBy},
					],
					reviewRounds: [{reviewers}],
				}),
		publications: [
			{
				versionStage: 'AO',
				metadata: {
					title: {en: `Reviewer response ${tag}`},
					abstract: {en: `<p>Reviewer-response fixture ${tag}.</p>`},
				},
				published: false,
			},
		],
	};
}

/**
 * Open a page as `username`. Every actor in this spec is explicit —
 * the file sets no default `test.use({user})` so that the `page`
 * fixture stays genuinely anonymous for s12's signed-out link.
 *
 * @param {(u: string) => Promise<import('@playwright/test').BrowserContext>} asUser
 * @param {string} username
 */
async function pageAs(asUser, username) {
	const ctx = await asUser(username);
	return ctx.newPage();
}

/** Read the logged-in page's CSRF token (exposed on any backend page). */
async function readCsrf(page) {
	await page.waitForFunction(() => !!window.pkp?.currentUser?.csrfToken, null, {
		timeout: 15_000,
	});
	return page.evaluate(() => window.pkp.currentUser.csrfToken);
}

/**
 * Apply journal settings the context scenario schema does not carry
 * (competing-interests policy, Restrict File Access) through the same
 * contexts PUT the settings forms make.
 *
 * @param {import('@playwright/test').Page} managerPage  signed in as a
 *   manager of `journalPath`, already on a backend page of it
 * @param {string} journalPath
 * @param {number} contextId
 * @param {object} data
 */
async function putContextSettings(managerPage, journalPath, contextId, data) {
	const csrf = await readCsrf(managerPage);
	const res = await managerPage.request.put(
		`/index.php/${journalPath}/api/v1/contexts/${contextId}`,
		{headers: {'X-Csrf-Token': csrf}, data},
	);
	if (!res.ok()) {
		throw new Error(
			`contexts PUT failed: ${res.status()} ${await res.text()}`,
		);
	}
}

/**
 * Drive the Add Reviewer picker for one candidate. Round ≥ 2 pins a
 * previous-round reviewer behind "Reassign {name}" instead of
 * "Select {name}", so accept either.
 *
 * @param {InstanceType<typeof ReviewerManagerPage>} rm
 * @param {{searchToken: string, fullName: string, tag: string}} opts
 */
async function addReviewer(rm, {searchToken, fullName, tag}) {
	const modal = await rm.openAddReviewerModal();
	await rm.searchSelectPanel(modal, searchToken);
	const select = modal.getByRole('button', {
		name: `Select ${fullName}`,
		exact: true,
	});
	const reassign = modal.getByRole('button', {
		name: `Reassign ${fullName}`,
		exact: true,
	});
	await select.or(reassign).first().waitFor({state: 'visible', timeout: 20_000});
	const form = (await reassign.isVisible().catch(() => false))
		? await rm.reassignReviewer(modal, fullName)
		: await rm.selectReviewer(modal, fullName);
	await rm.ensureDueDatesOrdered(form);
	await rm.awaitRichTextContains(form, 'personalMessage', tag);
	await rm.submitLegacyForm(form, 'Add Reviewer', modal);
}

/**
 * Seed a scratch journal carrying an active review form with one
 * required and one optional free-text question, plus a submission in
 * review whose accepted reviewer has that form attached. Journal-level
 * review forms cannot go on the shared bootstrap journal (principle 1).
 *
 * @param {{createJournal: Function, createSubmission: Function}} pkpApi
 * @param {string} tag
 */
async function seedReviewFormJournal(pkpApi, tag) {
	const editor = `ed${tag}`;
	const author = `au${tag}`;
	const reviewer = `rv${tag}`;
	const formTitle = `Review form ${tag}`;
	const requiredQuestion = `Required question ${tag}`;
	const optionalQuestion = `Optional question ${tag}`;

	const {context, reviewForms} = await pkpApi.createJournal({
		tag,
		users: [
			throwawayUser(editor, 'Edna', 'Editor', ['editor']),
			throwawayUser(author, 'Ada', 'Author', ['author']),
			throwawayUser(reviewer, 'Riva', 'Reviewer', ['reviewer']),
		],
		reviewForms: [
			{
				title: {en: formTitle},
				description: {en: `Review form description ${tag}`},
				elements: [
					{type: 'textarea', question: {en: requiredQuestion}, required: true},
					{type: 'textarea', question: {en: optionalQuestion}, required: false},
				],
			},
		],
	});
	const [requiredElementId, optionalElementId] = reviewForms[0].elementIds;

	const {submission} = await pkpApi.createSubmission(
		reviewSpec({
			tag,
			journal: context.path,
			submitter: author,
			participants: [{user: editor, role: 'editor'}],
			decisions: [{type: 'sendExternalReview', by: editor}],
			reviewers: [
				{user: reviewer, status: 'accepted', reviewForm: formTitle},
			],
		}),
	);

	return {
		journalPath: context.path,
		contextId: context.id,
		submissionId: submission.id,
		editor,
		author,
		reviewer,
		formTitle,
		requiredQuestion,
		optionalQuestion,
		requiredElementId,
		optionalElementId,
	};
}

/**
 * Record a rail decision through the wizard, keeping every prefilled
 * email as-is. Used only to get this feature's preconditions in place —
 * the decisions themselves belong to `editorial-decisions`.
 *
 * @param {import('@playwright/test').Page} page
 * @param {InstanceType<typeof WorkflowShellPage>} shell
 * @param {string} decisionLabel  the rail button's label
 * @param {string} completedLabel the completion dialog's heading
 * @param {string} [headingLabel] the wizard heading, when it differs from
 *   the rail button ("Create New Review Round" → "New Review Round")
 */
async function recordDecision(
	page,
	shell,
	decisionLabel,
	completedLabel,
	headingLabel = decisionLabel,
) {
	await shell
		.actionItems()
		.getByRole('button', {name: decisionLabel, exact: true})
		.click();
	await page.waitForURL(/\/decision\/record\//, {
		timeout: 20_000,
		waitUntil: 'commit',
	});
	const wizard = new DecisionWizardPage(page);
	await expect(wizard.heading()).toContainText(headingLabel, {
		timeout: 20_000,
	});
	await wizard.recordThrough(completedLabel);
	return wizard;
}

test.describe('reviewer response', () => {
	test('s1: an invited reviewer accepts and reaches the review form — locked tabs stay locked, guidelines, then the full tab 3', async ({
		asUser,
		pkpApi,
	}) => {
		const tag = uniqueTag('rra');
		// The workspace is reached from the dashboard row, so the test never
		// needs the seeded submission's id.
		await pkpApi.createSubmission(
			reviewSpec({
				tag,
				reviewers: [{user: 'reviewer.julia', status: 'invited'}],
			}),
		);

		const revPage = await pageAs(asUser, 'reviewer.julia');
		const dashboard = new DashboardPage(revPage);
		await dashboard.gotoReviewAssignments();
		await expect(
			dashboard.viewHeading(/Action Required by me/),
		).toBeVisible({timeout: 25_000});

		// The reviewer's own list is the entry point (editorial-dashboards
		// owns the list itself); its fresh-request row offers "Respond to
		// request", which opens the workspace.
		const row = dashboard.row(tag);
		await expect(row).toBeVisible({timeout: 25_000});
		await Promise.all([
			revPage.waitForURL(/\/reviewer\/submission\//, {
				timeout: 25_000,
				waitUntil: 'commit',
			}),
			row
				.getByRole('button', {name: 'Respond to request', exact: true})
				.click(),
		]);

		const wizard = new ReviewerSubmissionPage(revPage);
		await expect(wizard.step1Form).toBeVisible({timeout: 25_000});
		await wizard.expectTabActive('1. Request');

		// Rule 1: tabs beyond the furthest step reached are switched off,
		// not merely styled — force-clicking each changes neither the URL
		// nor the visible panel.
		const urlBefore = revPage.url();
		for (const label of [
			'2. Guidelines',
			'3. Download & Review',
			'4. Completion',
		]) {
			await wizard.expectTabLocked(label);
			await wizard.forceClickTab(label);
			expect(revPage.url()).toBe(urlBefore);
			await wizard.expectTabActive('1. Request');
			await expect(wizard.step1Form).toBeVisible();
		}

		// Tab 1's invitation detail: title, abstract, review type and the
		// three-date Review Schedule block.
		await expect(wizard.step1Form).toContainText(`Reviewer response ${tag}`);
		await expect(wizard.step1Form).toContainText(
			`Reviewer-response fixture ${tag}.`,
		);
		await expect(wizard.step1Form).toContainText('Review Type');
		await expect(wizard.step1Form).toContainText('Review Schedule');
		for (const field of ['dateNotified', 'responseDue', 'dateDue']) {
			await expect(wizard.scheduleField(field)).not.toHaveValue('');
		}

		// Accept → tab 2 (NOT tab 3), which carries the journal's
		// guidelines fallback; tab 3 is still locked.
		await wizard.acceptInvitation();
		await wizard.expectTabActive('2. Guidelines');
		await expect(wizard.step2Form).toContainText('Reviewer Guidelines');
		await expect(wizard.step2Form).toContainText(
			'This publisher has not set any reviewer guidelines.',
		);
		await wizard.expectTabLocked('3. Download & Review');

		// One press of Continue to Step #3 opens tab 3 with all of its
		// furniture.
		await wizard.continueToStep3();
		await wizard.expectTabActive('3. Download & Review');
		await expect(wizard.reviewFilesStep3).toContainText('Review Files', {
			timeout: 20_000,
		});
		await expect(
			wizard.step3Form.locator('textarea[name="comments"]'),
		).toHaveCount(1);
		await expect(
			wizard.step3Form.locator('textarea[name="commentsPrivate"]'),
		).toHaveCount(1);
		await expect(wizard.step3Form).toContainText('For author and editor');
		await expect(wizard.step3Form).toContainText('For editor');
		await expect(wizard.attachmentsGrid).toContainText('Reviewer Files', {
			timeout: 20_000,
		});
		await expect(
			wizard.attachmentsGrid.getByText('Upload File', {exact: true}),
		).toBeVisible();
		await expect(wizard.recommendationSelect).toBeVisible();
	});

	test('s2: the reviewer declines with their own reason — journal home page, the editors’ mail, an actionless Declined row, and no way back in', async ({
		asUser,
		pkpApi,
		pkpMail,
	}) => {
		const tag = uniqueTag('rrb');
		const {submission} = await pkpApi.createSubmission(
			reviewSpec({
				tag,
				participants: [{user: 'sectioneditor.ana', role: 'sectionEditor'}],
				reviewers: [{user: 'reviewer.paul', status: 'invited'}],
			}),
		);

		const revPage = await pageAs(asUser, 'reviewer.paul');
		const wizard = new ReviewerSubmissionPage(revPage);
		await wizard.goto(submission.id);
		await expect(wizard.step1Form).toBeVisible({timeout: 25_000});

		// The panel arrives with the journal's decline wording already
		// written into its single field, ready to be replaced.
		const {form, textareaId} = await wizard.openDeclineForm();
		await expect(form).toContainText(
			'You may provide the editor with any reasons why you are declining this review in the field below.',
		);
		expect(
			await getTinyMceContent(revPage, textareaId),
		).toContain('I am afraid that at this time I am unable to review');

		const reason = `Out of my field this time. ${tag}`;
		await setTinyMceContent(revPage, textareaId, `<p>${reason}</p>`);
		await wizard.submitDeclineForm(form);

		// Rule 7: back on the journal's reader-facing home page.
		await expect(revPage).toHaveURL(
			new RegExp(`/${JOURNAL}(/[a-z_A-Z]+)?/index`),
		);

		// The editors get the reviewer's reason as the body of the mail.
		const [declineMail] = await pkpMail.find({
			to: USER.ana.email,
			contains: tag,
			timeoutMs: 30_000,
		});
		expect(declineMail.Subject).toContain('Unable to Review');
		const body = await pkpMail.fullMessage(declineMail.ID);
		expect(`${body.HTML ?? ''}${body.Text ?? ''}`).toContain(reason);

		// The assignment leaves the default view and turns up under
		// Declined as a row with nothing to press.
		const dashboard = new DashboardPage(revPage);
		await dashboard.gotoReviewAssignments();
		await dashboard.navItem('Declined').click();
		await expect(dashboard.viewHeading(/Declined/)).toBeVisible({
			timeout: 25_000,
		});
		const declinedRow = dashboard.row(tag);
		await expect(declinedRow).toBeVisible({timeout: 25_000});
		await expect(declinedRow).toContainText(`Request declined on ${today()}`);
		await expect(declinedRow.getByRole('button')).toHaveCount(0);
		await expect(declinedRow.getByRole('link')).toHaveCount(0);

		// Gone from the default view. The Declined assertions above prove
		// the list renders, so the absence below cannot pass vacuously on
		// an unmounted table.
		await dashboard.navItem('Action Required by me').click();
		await expect(
			dashboard.viewHeading(/Action Required by me/),
		).toBeVisible({timeout: 25_000});
		await expect(revPage.getByRole('table').first()).toBeVisible({
			timeout: 25_000,
		});
		await expect(dashboard.row(tag)).toHaveCount(0);

		// And the workspace itself is closed to them.
		await wizard.goto(submission.id);
		await expect(revPage).toHaveURL(
			/user\/authorizationDenied\?message=user\.authorization\.submissionReviewer/,
		);
		await expect(
			revPage.getByText(
				'The current user is not assigned as a reviewer for the requested document.',
			),
		).toBeVisible({timeout: 20_000});
	});

	test('s3: a free-text review is submitted — confirmation, tab 4, one Review complete mail per assigned section editor, the editor’s dashboard line', async ({
		asUser,
		pkpApi,
		pkpMail,
	}) => {
		const tag = uniqueTag('rrc');
		const {submission} = await pkpApi.createSubmission(
			reviewSpec({
				tag,
				participants: [
					{user: 'sectioneditor.ana', role: 'sectionEditor'},
					{user: 'sectioneditor.ravi', role: 'sectionEditor'},
				],
				decisions: [{type: 'sendExternalReview', by: 'sectioneditor.ana'}],
				reviewers: [{user: 'reviewer.julia', status: 'accepted'}],
			}),
		);

		const revPage = await pageAs(asUser, 'reviewer.julia');
		const wizard = new ReviewerSubmissionPage(revPage);
		await wizard.goto(submission.id);
		// An accepted assignment opens on tab 2 — reaching tab 3 costs one
		// press of Continue to Step #3 (rule 1).
		await expect(wizard.step2Form).toBeVisible({timeout: 25_000});
		await wizard.expectTabActive('2. Guidelines');
		await wizard.continueToStep3();

		await wizard.fillStep3Comments({
			toAuthor: `<p>Shared review comment ${tag}</p>`,
			toEditor: `<p>Private note for the editors ${tag}</p>`,
		});
		await wizard.uploadAttachment(DUMMY_PDF, 'dummy.pdf');
		await wizard.selectRecommendation('Revisions Required');

		// Submit Review → "Are you sure…" → OK → tab 4.
		await wizard.submitReview();
		await wizard.expectTabActive('4. Completion');
		await expect(
			revPage.getByText(
				'Thank you for completing the review of this submission.',
			),
		).toBeVisible({timeout: 20_000});

		// One Review complete message each, to both assigned section
		// editors, naming the recommendation.
		for (const editor of [USER.ana, USER.ravi]) {
			const messages = await pkpMail.find({
				to: editor.email,
				contains: tag,
				timeoutMs: 30_000,
			});
			expect(
				messages.filter((m) => /Review complete/.test(m.Subject)),
			).toHaveLength(1);
			expect(messages[0].Subject).toContain('Revisions Required');
		}

		// What the editor sees on their dashboard row.
		const edPage = await pageAs(asUser, 'sectioneditor.ana');
		const edDashboard = new DashboardPage(edPage);
		await edDashboard.gotoEditorial();
		await edDashboard.search(tag);
		await expect(edDashboard.row(tag)).toContainText(
			`Review completed on ${today()}`,
			{timeout: 25_000},
		);
	});

	test('s4: Save for Later parks the review — tab 3, tab 4 still locked, values survive a fresh sign-in, and nothing is mailed until it is submitted', async ({
		asUser,
		browser,
		baseURL,
		pkpApi,
		pkpMail,
	}) => {
		const tag = uniqueTag('rrd');
		const {submission} = await pkpApi.createSubmission(
			reviewSpec({
				tag,
				participants: [{user: 'sectioneditor.ana', role: 'sectionEditor'}],
				decisions: [{type: 'sendExternalReview', by: 'sectioneditor.ana'}],
				reviewers: [{user: 'reviewer.amara', status: 'accepted'}],
			}),
		);

		const revPage = await pageAs(asUser, 'reviewer.amara');
		const wizard = new ReviewerSubmissionPage(revPage);
		await wizard.goto(submission.id);
		await expect(wizard.step2Form).toBeVisible({timeout: 25_000});
		await wizard.continueToStep3();

		const draft = `Half-written assessment ${tag}`;
		await wizard.fillStep3Comments({toAuthor: `<p>${draft}</p>`});
		await wizard.selectRecommendation('Revisions Required');

		const urlBefore = revPage.url();
		await wizard.saveForLater();
		// The "Your changes have been saved." toast is transient — the
		// saveStep response (awaited inside saveForLater) is the signal.
		expect(revPage.url()).toBe(urlBefore);
		await expect(wizard.step3Form).toBeVisible();
		await wizard.expectTabActive('3. Download & Review');
		await wizard.expectTabLocked('4. Completion');

		// A genuine fresh sign-in in a clean browser context.
		const freshCtx = await browser.newContext({
			storageState: {cookies: [], origins: []},
			baseURL,
		});
		const freshPage = await freshCtx.newPage();
		const login = new LoginPage(freshPage);
		await login.login('reviewer.amara', getPassword('reviewer.amara'));
		await freshPage.waitForURL((url) => !url.pathname.includes('/login'), {
			timeout: 25_000,
			waitUntil: 'commit',
		});

		const freshWizard = new ReviewerSubmissionPage(freshPage);
		await freshWizard.goto(submission.id);
		// The workspace re-opens on tab 3 with the parked values.
		await expect(freshWizard.step3Form).toBeVisible({timeout: 25_000});
		await freshWizard.expectTabActive('3. Download & Review');
		const commentsId = await freshWizard.step3Form
			.locator('textarea[id^="comments-"]')
			.first()
			.getAttribute('id');
		expect(await getTinyMceContent(freshPage, String(commentsId))).toContain(
			draft,
		);
		await expect(
			freshWizard.recommendationSelect.locator('option:checked'),
		).toHaveText('Revisions Required');

		// Nothing was sent on the save. Bounded by a positive control:
		// submitting the same review now DOES mail the editor, so the
		// editor's tagged inbox must hold exactly that one message.
		await freshWizard.submitReview();
		const messages = await pkpMail.find({
			to: USER.ana.email,
			contains: tag,
			timeoutMs: 30_000,
		});
		expect(messages).toHaveLength(1);
		expect(messages[0].Subject).toContain('Review complete');

		// Manually created contexts are not torn down per test.
		await freshCtx.close();
	});

	test('s5: a review form replaces the comment boxes — the required question is starred, a blocked submit confirms first and then complains', async ({
		asUser,
		pkpApi,
	}) => {
		const tag = uniqueTag('rre');
		const form = await seedReviewFormJournal(pkpApi, tag);

		const revPage = await pageAs(asUser, form.reviewer);
		const wizard = new ReviewerSubmissionPage(revPage);
		await wizard.goto(form.submissionId, {journalPath: form.journalPath});
		await expect(wizard.step2Form).toBeVisible({timeout: 25_000});
		await wizard.continueToStep3();

		// The journal's form renders in place of the two comment boxes.
		await expect(
			wizard.step3Form.locator('textarea[name="comments"]'),
		).toHaveCount(0);
		await expect(
			wizard.step3Form.locator('textarea[name="commentsPrivate"]'),
		).toHaveCount(0);
		await expect(
			wizard.step3Form.getByRole('heading', {name: form.formTitle}),
		).toBeVisible();
		await expect(wizard.step3Form).toContainText(
			`Review form description ${tag}`,
		);

		// The required question is marked with an asterisk; the optional
		// one is not.
		const requiredLabel = wizard.step3Form
			.locator('label')
			.filter({hasText: form.requiredQuestion})
			.first();
		await expect(requiredLabel).toHaveText(
			new RegExp(`${form.requiredQuestion}\\*$`),
		);
		await expect(
			wizard.step3Form
				.locator('label')
				.filter({hasText: form.optionalQuestion})
				.first()
				.locator('span.req'),
		).toHaveCount(0);
		const requiredField = wizard.reviewFormTextResponse(form.requiredElementId);
		await expect(requiredField).toHaveAttribute('aria-required', 'true');
		await expect(
			wizard.reviewFormTextResponse(form.optionalElementId),
		).toHaveAttribute('aria-required', 'false');

		// A recommendation is chosen up front so the unanswered question is
		// the only thing missing.
		await wizard.selectRecommendation('Revisions Required');

		// The confirmation is asked BEFORE the form is checked (rule 10);
		// the complaint follows the OK.
		await wizard.attemptSubmitReview();
		await wizard.expectTabActive('3. Download & Review');
		await expect(
			wizard.step3Form.getByText('This field is required.'),
		).toBeVisible({timeout: 20_000});
		await expect(wizard.messageBox).toBeVisible();
		await expect(wizard.messageBox).toContainText(
			'Please fill in required fields.',
		);
		await expect(wizard.messageBox).toContainText(
			'Some required fields are not filled in. Please complete them before submitting your review.',
		);
		await expect(wizard.completedHeading).toBeHidden();

		// Answering the question and pressing Submit Review again completes
		// the review. ⚠ The press that follows a confirmed-then-refused cycle is
		// often swallowed outright (no dialog, no step save) — rule 11 /
		// ledger 16, which s6 pins down deliberately — so it may have to be
		// made twice; the press here is retried while no confirmation has
		// opened rather than assumed to land first time.
		await requiredField.fill(`Answered at last ${tag}`);
		await wizard.submitReview();
		await wizard.expectTabActive('4. Completion');
	});

	test('s6: the press after two refused confirmations is swallowed — nothing is submitted, and the reloaded page needs the answers again (rule 11 / ledger 16)', async ({
		asUser,
		pkpApi,
	}) => {
		const tag = uniqueTag('rrf');
		const form = await seedReviewFormJournal(pkpApi, tag);

		const revPage = await pageAs(asUser, form.reviewer);
		const wizard = new ReviewerSubmissionPage(revPage);
		await wizard.goto(form.submissionId, {journalPath: form.journalPath});
		await expect(wizard.step2Form).toBeVisible({timeout: 25_000});
		await wizard.continueToStep3();
		await wizard.selectRecommendation('Accept Submission');

		const requiredField = wizard.reviewFormTextResponse(form.requiredElementId);

		// Two confirmed-then-refused cycles: the deterministic form of
		// the arming condition (one usually suffices — rule 11).
		for (let cycle = 1; cycle <= 2; cycle++) {
			await wizard.attemptSubmitReview();
			await expect(wizard.messageBox).toBeVisible({timeout: 20_000});
			await expect(wizard.messageBox).toContainText(
				'Please fill in required fields.',
			);
		}

		// With the question answered, the next press — the first one that
		// would have gone through — does nothing at all: no confirmation, no
		// step save, though the button still looks usable.
		await requiredField.fill(`Answer after two rejections ${tag}`);
		await wizard.submitExpectingNoResponse();
		await wizard.expectTabLocked('4. Completion');
		await expect(wizard.completedHeading).toBeHidden();

		// A reload restores it. Nothing was ever saved, so the answer and
		// the recommendation have to be re-entered on the fresh page.
		await revPage.reload();
		await expect(wizard.step3Form).toBeVisible({timeout: 25_000});
		await wizard.selectRecommendation('Accept Submission');
		await wizard
			.reviewFormTextResponse(form.requiredElementId)
			.fill(`Answer after reload ${tag}`);
		await wizard.submitReview();
		await wizard.expectTabActive('4. Completion');
	});

	test('s7: a submitted review is read-only — except the recommendation list, the comment boxes and the attachment rename (rows 76 / D / E)', async ({
		asUser,
		pkpApi,
	}) => {
		test.slow(); // writes + submits a full review before asserting
		const tag = uniqueTag('rrg');
		const {submission} = await pkpApi.createSubmission(
			reviewSpec({
				tag,
				participants: [{user: 'sectioneditor.ana', role: 'sectionEditor'}],
				decisions: [{type: 'sendExternalReview', by: 'sectioneditor.ana'}],
				reviewers: [{user: 'reviewer.julia', status: 'accepted'}],
			}),
		);

		const revPage = await pageAs(asUser, 'reviewer.julia');
		const wizard = new ReviewerSubmissionPage(revPage);
		await wizard.goto(submission.id);
		await expect(wizard.step2Form).toBeVisible({timeout: 25_000});
		await wizard.continueToStep3();

		const sharedComment = `Shared comment as submitted ${tag}`;
		await wizard.fillStep3Comments({
			toAuthor: `<p>${sharedComment}</p>`,
			toEditor: `<p>Private comment as submitted ${tag}</p>`,
		});
		await wizard.uploadAttachment(DUMMY_PDF, 'dummy.pdf');
		await wizard.selectRecommendation('Accept Submission');
		await wizard.submitReview();

		// Re-open: the workspace lands on tab 4 and every tab opens.
		await wizard.goto(submission.id);
		await expect(wizard.completedHeading).toBeVisible({timeout: 25_000});
		await wizard.expectTabActive('4. Completion');
		for (const label of [
			'1. Request',
			'2. Guidelines',
			'3. Download & Review',
			'4. Completion',
		]) {
			await wizard.expectTabUnlocked(label);
		}

		// Tab 1 and tab 2's step buttons are switched off.
		await wizard.openTab(1);
		await expect(wizard.saveAndContinueButton).toBeDisabled();
		await wizard.openTab(2);
		await expect(wizard.continueToStep3Button).toBeDisabled();

		// Tab 3: both action buttons off, no Upload File, no Delete.
		await wizard.openTab(3);
		await expect(wizard.submitReviewButton).toBeDisabled();
		await expect(wizard.saveForLaterButton).toBeDisabled();
		await expect(
			wizard.attachmentsGrid.getByText('Upload File', {exact: true}),
		).toHaveCount(0);
		const {controls} = await wizard.expandAttachmentRow('dummy.pdf');
		await expect(controls.locator('a.pkp_linkaction_deleteFile')).toHaveCount(0);
		await expect(
			controls.getByRole('link', {name: 'Edit', exact: true}),
		).toBeVisible();

		// ⚠ The three controls that do not follow the rule. The
		// recommendation list is not switched off and a different option
		// can be chosen; the rich-text comment boxes still accept typing —
		// and neither survives a reload, because nothing on the page can
		// save (rows 76 and D).
		await expect(wizard.recommendationSelect).toBeEnabled();
		await wizard.selectRecommendation('Decline Submission');
		await expect(
			wizard.recommendationSelect.locator('option:checked'),
		).toHaveText('Decline Submission');
		const commentsId = String(
			await wizard.step3Form
				.locator('textarea[id^="comments-"]')
				.first()
				.getAttribute('id'),
		);
		await setTinyMceContent(revPage, commentsId, `<p>Typed after submitting ${tag}</p>`);
		expect(await getTinyMceContent(revPage, commentsId)).toContain(
			'Typed after submitting',
		);

		await revPage.reload();
		await expect(wizard.completedHeading).toBeVisible({timeout: 25_000});
		await wizard.openTab(3);
		await expect(
			wizard.recommendationSelect.locator('option:checked'),
		).toHaveText('Accept Submission');
		const reloadedId = String(
			await wizard.step3Form
				.locator('textarea[id^="comments-"]')
				.first()
				.getAttribute('id'),
		);
		const restored = await getTinyMceContent(revPage, reloadedId);
		expect(restored).toContain(sharedComment);
		expect(restored).not.toContain('Typed after submitting');

		// ⚠ Row E: the rename behind the row's Settings expander still works.
		await wizard.renameAttachment('dummy.pdf', `renamed-${tag}.pdf`);
		await expect(wizard.attachmentsGrid).toContainText(`renamed-${tag}.pdf`);
	});

	test('s8: competing interests declared on tab 1 ride into the decline and show up on the editor’s reviewer row', async ({
		asUser,
		pkpApi,
		pkpMail,
	}) => {
		test.slow(); // scratch journal + a journal-level policy + two actors
		const tag = uniqueTag('rrh');
		const editor = `ed${tag}`;
		const author = `au${tag}`;
		const reviewer = `rv${tag}`;
		const {context} = await pkpApi.createJournal({
			tag,
			users: [
				throwawayUser(editor, 'Edna', 'Editor', ['editor']),
				throwawayUser(author, 'Ada', 'Author', ['author']),
				throwawayUser(reviewer, 'Riva', 'Reviewer', ['reviewer']),
			],
		});
		const journalPath = context.path;

		// The competing-interests policy is not in the context scenario
		// schema — set it with the same contexts PUT the settings form
		// makes. (A journal without one shows none of these controls.)
		const edPage = await pageAs(asUser, editor);
		await edPage.goto(`/index.php/${journalPath}/en/dashboard/editorial`, {
			waitUntil: 'commit',
		});
		await putContextSettings(edPage, journalPath, context.id, {
			competingInterests: {
				en: `<p>Declare anything that could bias your review. ${tag}</p>`,
			},
		});

		const {submission} = await pkpApi.createSubmission(
			reviewSpec({
				tag,
				journal: journalPath,
				submitter: author,
				participants: [{user: editor, role: 'editor'}],
				decisions: [{type: 'sendExternalReview', by: editor}],
				reviewers: [{user: reviewer, status: 'invited'}],
			}),
		);

		const revPage = await pageAs(asUser, reviewer);
		const wizard = new ReviewerSubmissionPage(revPage);
		await wizard.goto(submission.id, {journalPath});
		await expect(wizard.step1Form).toBeVisible({timeout: 25_000});

		// Both options render, the first is chosen on arrival, and the box
		// appears only for the second.
		await expect(
			wizard.step1Form.getByText('I do not have any competing interests', {
				exact: true,
			}),
		).toBeVisible();
		await expect(
			wizard.step1Form.getByText(
				'I may have competing interests (Specify below)',
				{exact: true},
			),
		).toBeVisible();
		await expect(wizard.competingInterestsRadio('no')).toBeChecked();
		await expect(wizard.competingInterestsBox()).toBeHidden();
		await wizard.competingInterestsRadio('has').check();
		await expect(wizard.competingInterestsBox()).toBeVisible();
		await wizard.competingInterestsRadio('no').check();
		await expect(wizard.competingInterestsBox()).toBeHidden();

		await wizard.competingInterestsRadio('has').check();
		await expect(wizard.competingInterestsBox()).toBeVisible();
		await wizard.fillCompetingInterests(
			`<p>I co-authored with this author last year. ${tag}</p>`,
		);

		// Decline without saving tab 1 — the answer travels with the
		// decline.
		const reason = `Declining because of that overlap. ${tag}`;
		const {form, textareaId} = await wizard.openDeclineForm();
		await setTinyMceContent(revPage, textareaId, `<p>${reason}</p>`);
		await wizard.submitDeclineForm(form);

		const [mail] = await pkpMail.find({
			to: `${editor}@mailinator.com`,
			contains: tag,
			timeoutMs: 30_000,
		});
		expect(mail.Subject).toContain('Unable to Review');

		// The editor's Reviewers panel row carries both facts.
		const rm = new ReviewerManagerPage(edPage);
		await rm.gotoWorkflow(submission.id, {journalPath});
		const row = rm.row('Riva Reviewer');
		await expect(row).toContainText('Request Declined', {timeout: 25_000});
		await expect(row).toContainText('Competing Interests');
	});

	test('s11: only the reviewer’s own current assignment opens the workspace', async ({
		asUser,
		pkpApi,
	}) => {
		const tag = uniqueTag('rrk');
		const {submission} = await pkpApi.createSubmission(
			reviewSpec({
				tag,
				participants: [{user: 'sectioneditor.ana', role: 'sectionEditor'}],
				decisions: [{type: 'sendExternalReview', by: 'sectioneditor.ana'}],
				reviewers: [
					{user: 'reviewer.julia', status: 'accepted'},
					{user: 'reviewer.amara', status: 'cancelled'},
				],
			}),
		);
		// A second submission carrying the cancelled reviewer's other,
		// still-current assignment — the positive control for the denial.
		const otherTag = `${tag}b`;
		const {submission: other} = await pkpApi.createSubmission(
			reviewSpec({
				tag: otherTag,
				participants: [{user: 'sectioneditor.ana', role: 'sectionEditor'}],
				decisions: [{type: 'sendExternalReview', by: 'sectioneditor.ana'}],
				reviewers: [{user: 'reviewer.amara', status: 'accepted'}],
			}),
		);

		const notAssignedMessage =
			'The current user is not assigned as a reviewer for the requested document.';

		// (a) A Reviewer of the journal with no assignment on this
		// submission.
		const paulPage = await pageAs(asUser, 'reviewer.paul');
		const paulWizard = new ReviewerSubmissionPage(paulPage);
		await paulWizard.goto(submission.id);
		await expect(paulPage).toHaveURL(
			/user\/authorizationDenied\?message=user\.authorization\.submissionReviewer/,
		);
		await expect(paulPage.getByText(notAssignedMessage)).toBeVisible({
			timeout: 20_000,
		});

		// (b) A Journal Manager — a different denial — even though the same
		// submission's editorial workflow opens for them.
		const mgrPage = await pageAs(asUser, 'manager.maya');
		const mgrWizard = new ReviewerSubmissionPage(mgrPage);
		await mgrWizard.goto(submission.id);
		await expect(mgrPage).toHaveURL(
			/user\/authorizationDenied\?message=user\.authorization\.roleBasedAccessDenied/,
		);
		await expect(
			mgrPage.getByText(
				'The current role does not have access to this operation.',
			),
		).toBeVisible({timeout: 20_000});
		const shell = new WorkflowShellPage(mgrPage);
		await shell.gotoEditorial(submission.id);
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 25_000});

		// (c) A reviewer whose assignment was cancelled — denied here,
		// while their other current assignment opens normally.
		const amaraPage = await pageAs(asUser, 'reviewer.amara');
		const amaraWizard = new ReviewerSubmissionPage(amaraPage);
		await amaraWizard.goto(submission.id);
		await expect(amaraPage).toHaveURL(
			/user\/authorizationDenied\?message=user\.authorization\.submissionReviewer/,
		);
		await expect(amaraPage.getByText(notAssignedMessage)).toBeVisible({
			timeout: 20_000,
		});

		await amaraWizard.goto(other.id);
		await expect(amaraWizard.step2Form).toBeVisible({timeout: 25_000});
		await expect(amaraWizard.tabStrip).toContainText('3. Download & Review');
	});

	test('s9: Previous Reviews on a second round — the round-1 review, its attachment, and no Files For Review section (row H)', async ({
		asUser,
		pkpApi,
	}) => {
		test.slow(); // two rounds driven end to end, both through the UI
		const tag = uniqueTag('rri');
		// Round 1's review file has to come from the decision wizard: a
		// scenario-seeded round carries no files and no per-assignment
		// grants, so Send for Review is driven here.
		const {submission} = await pkpApi.createSubmission(
			reviewSpec({
				tag,
				stage1: true,
				participants: [{user: 'sectioneditor.ana', role: 'sectionEditor'}],
			}),
		);

		const edPage = await pageAs(asUser, 'sectioneditor.ana');
		const shell = new WorkflowShellPage(edPage);
		await shell.gotoEditorial(submission.id);
		await expect(shell.contentHeading('Workflow: Submission')).toBeVisible({
			timeout: 25_000,
		});
		await recordDecision(edPage, shell, 'Send for Review', 'Sent for Review');
		await edPage.goto(
			`/index.php/${JOURNAL}/en/dashboard/editorial?workflowSubmissionId=${submission.id}`,
			{waitUntil: 'commit'},
		);
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 25_000});

		const rm = new ReviewerManagerPage(edPage);
		await expect(rm.manager).toBeVisible({timeout: 25_000});
		await addReviewer(rm, {
			searchToken: 'Julia',
			fullName: USER.julia.name,
			tag,
		});

		// Round 1, reviewer side: the file they were sent, one attachment
		// of their own, comments in both streams, a recommendation.
		const revPage = await pageAs(asUser, 'reviewer.julia');
		const wizard = new ReviewerSubmissionPage(revPage);
		await wizard.goto(submission.id);
		await expect(wizard.step1Form).toBeVisible({timeout: 25_000});
		await wizard.acceptInvitation();
		await wizard.continueToStep3();
		await expect(wizard.reviewFilesStep3).toContainText(SEEDED_FILE, {
			timeout: 25_000,
		});
		await wizard.fillStep3Comments({
			toAuthor: `<p>Round 1 shared comment ${tag}</p>`,
			toEditor: `<p>Round 1 private comment ${tag}</p>`,
		});
		await wizard.uploadAttachment(DUMMY_PDF, 'dummy.pdf');
		await wizard.selectRecommendation('Revisions Required');
		await wizard.submitReview();

		// Round 2, with the same reviewer invited again.
		await edPage.goto(
			`/index.php/${JOURNAL}/en/dashboard/editorial?workflowSubmissionId=${submission.id}`,
			{waitUntil: 'commit'},
		);
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 25_000});
		await recordDecision(
			edPage,
			shell,
			'Create New Review Round',
			'Review Round Created',
			'New Review Round',
		);
		await edPage.goto(
			`/index.php/${JOURNAL}/en/dashboard/editorial?workflowSubmissionId=${submission.id}`,
			{waitUntil: 'commit'},
		);
		await expect(
			shell.contentHeading('Workflow: Review (Round 2)'),
		).toBeVisible({timeout: 25_000});
		await expect(rm.manager).toBeVisible({timeout: 25_000});
		await addReviewer(rm, {
			searchToken: 'Julia',
			fullName: USER.julia.name,
			tag,
		});

		// The reviewer's workspace now carries the Previous Reviews panel.
		await wizard.goto(submission.id);
		await expect(wizard.step1Form).toBeVisible({timeout: 25_000});
		await expect(
			wizard.previousReviewsPanel.getByRole('heading', {
				name: 'Previous Reviews',
			}),
		).toBeVisible({timeout: 25_000});
		await expect(wizard.previousReviewLine(1)).toContainText(
			`Round 1 Review Submitted on ${today()}`,
		);
		// One line only — the current round is the tabs themselves.
		await expect(
			wizard.previousReviewsPanel.getByRole('button', {name: /^Read Round/}),
		).toHaveCount(1);
		// The panel sits above the tab strip.
		expect(
			await revPage.evaluate(() => {
				const tabs = document.querySelector('#reviewTabs');
				const headings = Array.from(document.querySelectorAll('h2'));
				const panel = headings.find(
					(h) => h.textContent?.trim() === 'Previous Reviews',
				);
				if (!panel || !tabs) return 'missing';
				return panel.compareDocumentPosition(tabs) &
					Node.DOCUMENT_POSITION_FOLLOWING
					? 'panel-before-tabs'
					: 'tabs-before-panel';
			}),
		).toBe('panel-before-tabs');

		const history = await wizard.openRoundHistory(1);
		await expect(history).toContainText(`Reviewer response ${tag}`);
		await expect(
			history.getByRole('heading', {name: 'Recommendation'}),
		).toBeVisible();
		await expect(history).toContainText('Revisions Required');
		await expect(
			history.getByRole('heading', {name: 'Reviewer Comments'}),
		).toBeVisible();
		await expect(history).toContainText('For editors and authors');
		await expect(history).toContainText('For editors only');
		await expect(history).toContainText('Comment 1:');
		await expect(history).toContainText(`Round 1 shared comment ${tag}`);
		await expect(history).toContainText(`Round 1 private comment ${tag}`);
		await expect(history).toContainText('Attachments');
		await expect(history).toContainText('dummy.pdf');
		await expect(history).toContainText('Article Metadata');
		await expect(history).toContainText('General Information');

		// ⚠ Row H: no Files For Review section, even though round 1
		// demonstrably carried the file the reviewer read on tab 3.
		await expect(history).not.toContainText('Files For Review');
		await expect(history).not.toContainText(SEEDED_FILE);
	});

	test('s10: Previous Reviews for a round the reviewer declined — "Submitted on" wording over a Declined Date and the emailed reason', async ({
		asUser,
		pkpApi,
	}) => {
		test.slow(); // a real decline plus a second round
		const tag = uniqueTag('rrj');
		const {submission} = await pkpApi.createSubmission(
			reviewSpec({
				tag,
				participants: [{user: 'sectioneditor.ana', role: 'sectionEditor'}],
				decisions: [{type: 'sendExternalReview', by: 'sectioneditor.ana'}],
				reviewers: [{user: 'reviewer.paul', status: 'invited'}],
			}),
		);

		// The reason is only shown when a decline email was really
		// recorded, so the decline is driven through the form.
		const reason = `No time in this round. ${tag}`;
		const revPage = await pageAs(asUser, 'reviewer.paul');
		const wizard = new ReviewerSubmissionPage(revPage);
		await wizard.goto(submission.id);
		await expect(wizard.step1Form).toBeVisible({timeout: 25_000});
		const {form, textareaId} = await wizard.openDeclineForm();
		await setTinyMceContent(revPage, textareaId, `<p>${reason}</p>`);
		await wizard.submitDeclineForm(form);

		// Round 2, same reviewer invited again.
		const edPage = await pageAs(asUser, 'sectioneditor.ana');
		const shell = new WorkflowShellPage(edPage);
		await shell.gotoEditorial(submission.id);
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 25_000});
		await recordDecision(
			edPage,
			shell,
			'Create New Review Round',
			'Review Round Created',
			'New Review Round',
		);
		await edPage.goto(
			`/index.php/${JOURNAL}/en/dashboard/editorial?workflowSubmissionId=${submission.id}`,
			{waitUntil: 'commit'},
		);
		await expect(
			shell.contentHeading('Workflow: Review (Round 2)'),
		).toBeVisible({timeout: 25_000});
		const rm = new ReviewerManagerPage(edPage);
		await expect(rm.manager).toBeVisible({timeout: 25_000});
		await addReviewer(rm, {searchToken: 'Paul', fullName: USER.paul.name, tag});

		await wizard.goto(submission.id);
		await expect(wizard.step1Form).toBeVisible({timeout: 25_000});

		// ⚠ Rule 15: the line reads "Submitted on" although the round was
		// declined — and the date it carries is the decline date.
		await expect(wizard.previousReviewLine(1)).toContainText(
			`Round 1 Review Submitted on ${today()}`,
		);

		const history = await wizard.openRoundHistory(1);
		await expect(
			history.getByRole('heading', {name: 'Declined Date'}),
		).toBeVisible();
		await expect(history).toContainText(today());
		await expect(
			history.getByRole('heading', {name: 'Decline reason sent by email'}),
		).toBeVisible();
		await expect(history).toContainText('Unable to Review');
		await expect(history).toContainText(reason);
		await expect(history).not.toContainText(
			'No reason given to the decline of the review invitation.',
		);
	});

	test('s12: one-click access with Restrict File Access — the secure link signs the reviewer in on tab 1 with no file list; a different user gets a blank page (row I)', async ({
		asUser,
		page,
		pkpApi,
		pkpMail,
	}) => {
		test.slow(); // scratch journal, two settings, real invitations, two rounds of files
		const tag = uniqueTag('rrl');
		const editor = `ed${tag}`;
		const author = `au${tag}`;
		const reviewerA = `ra${tag}`;
		const reviewerB = `rb${tag}`;
		const {context} = await pkpApi.createJournal({
			tag,
			reviewerAccessKeysEnabled: true,
			users: [
				throwawayUser(editor, 'Edna', 'Editor', ['editor']),
				throwawayUser(author, 'Ada', 'Author', ['author']),
				throwawayUser(reviewerA, 'Rana', 'Onereviewer', ['reviewer']),
				throwawayUser(reviewerB, 'Rob', 'Tworeviewer', ['reviewer']),
			],
		});
		const journalPath = context.path;

		const edPage = await pageAs(asUser, editor);
		await edPage.goto(`/index.php/${journalPath}/en/dashboard/editorial`, {
			waitUntil: 'commit',
		});
		await putContextSettings(edPage, journalPath, context.id, {
			restrictReviewerFileAccess: true,
		});

		const {submission} = await pkpApi.createSubmission(
			reviewSpec({
				tag,
				journal: journalPath,
				submitter: author,
				stage1: true,
				participants: [{user: editor, role: 'editor'}],
			}),
		);

		// Send for Review through the wizard so the round really holds a
		// file, then invite both reviewers for real (invitation emails).
		const shell = new WorkflowShellPage(edPage, {journalPath});
		await shell.gotoEditorial(submission.id);
		await expect(shell.contentHeading('Workflow: Submission')).toBeVisible({
			timeout: 25_000,
		});
		await recordDecision(edPage, shell, 'Send for Review', 'Sent for Review');
		await edPage.goto(
			`/index.php/${journalPath}/en/dashboard/editorial?workflowSubmissionId=${submission.id}`,
			{waitUntil: 'commit'},
		);
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 25_000});
		const rm = new ReviewerManagerPage(edPage);
		await expect(rm.manager).toBeVisible({timeout: 25_000});
		await addReviewer(rm, {
			searchToken: 'Onereviewer',
			fullName: 'Rana Onereviewer',
			tag,
		});
		await addReviewer(rm, {
			searchToken: 'Tworeviewer',
			fullName: 'Rob Tworeviewer',
			tag,
		});

		/** The invitation's only link — it carries the invitation id + key. */
		const secureLinkFor = async (username) => {
			const [mail] = await pkpMail.find({
				to: `${username}@mailinator.com`,
				contains: tag,
				timeoutMs: 30_000,
			});
			const full = await pkpMail.fullMessage(mail.ID);
			const html = `${full.HTML ?? ''}${full.Text ?? ''}`;
			const match = html.match(/https?:\/\/[^"'\s<>]*invitation\/accept[^"'\s<>]*/);
			if (!match) {
				throw new Error(`no invitation link in mail to ${username}`);
			}
			return match[0].replace(/&amp;/g, '&');
		};

		// A signed-out browser follows the link and arrives on tab 1,
		// signed in, with no password prompt — and no Review Files list.
		const linkA = await secureLinkFor(reviewerA);
		await page.goto(linkA, {waitUntil: 'commit'});
		await page.waitForURL(/\/reviewer\/submission/, {
			timeout: 25_000,
			waitUntil: 'commit',
		});
		const wizard = new ReviewerSubmissionPage(page);
		await expect(wizard.step1Form).toBeVisible({timeout: 25_000});
		await expect(page.locator('input#password')).toHaveCount(0);
		// The page renders as the reviewer's own account, not anonymously.
		expect(
			await page.evaluate(() => window.pkp?.currentUser?.username),
		).toBe(reviewerA);
		await expect(wizard.reviewFilesStep1).toHaveCount(0);

		// After accepting and reaching tab 3 the files are listed there,
		// and they open; tab 1 still offers no list.
		await wizard.acceptInvitation();
		await wizard.continueToStep3();
		await expect(wizard.reviewFilesStep3).toContainText(SEEDED_FILE, {
			timeout: 25_000,
		});
		const fileHref = await wizard.reviewFilesStep3
			.getByRole('link', {name: SEEDED_FILE})
			.first()
			.getAttribute('href');
		const download = await page.request.get(String(fileHref));
		expect(download.status()).toBe(200);
		expect(download.headers()['content-type']).toContain('application/pdf');

		await wizard.openTab(1);
		await expect(wizard.reviewFilesStep1).toHaveCount(0);

		// ⚠ Row I: the other reviewer's link, opened while a different user
		// is signed in, answers with an empty error page.
		const linkB = await secureLinkFor(reviewerB);
		const response = await edPage.goto(linkB, {waitUntil: 'commit'});
		expect(response?.status()).toBe(500);
		expect((await edPage.locator('body').innerText()).trim()).toBe('');
	});
});
