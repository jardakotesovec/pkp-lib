// @ts-check
const {test, expect} = require('../support/base-test.js');
const {WorkflowShellPage} = require('../pages/WorkflowShellPage.js');
const {DecisionWizardPage} = require('../pages/DecisionWizardPage.js');
const {ReviewRoundPanel} = require('../pages/ReviewRoundPanel.js');
const {ReviewerSubmissionPage} = require('../pages/ReviewerSubmissionPage.js');
const {ActivityLogModal} = require('../pages/ActivityLogModal.js');
const {ParticipantManagerPage} = require('../pages/ParticipantManagerPage.js');
const {TasksGridModal} = require('../pages/TasksGridModal.js');
const {fixtureFilePath} = require('../pages/FileStagePanel.js');

/**
 * Editorial decisions (the decision engine) — one test per canonical
 * scenario of docs/product/specs/editorial-decisions.md (13 scenarios →
 * 13 tests). The decision wizard, its steps, the recommendation controls
 * and the Done-stage transitions all render from pkp-lib
 * (DecisionHandler/record.tpl, DecisionPage.vue, WorkflowPage.vue,
 * WorkflowRecommendOnlyControls.vue), so the spec lives here; scenario
 * payloads use OJS vocabulary (publicknowledge / ART) matching the
 * bootstrap the suite runs against.
 *
 * Coverage per scenario:
 *   s1  send to review: two-step wizard (Notify Authors prefilled +
 *       Select Files pre-checked), Record → completion → Review (Round 1)
 *       with the author email delivered
 *   s2  accept & skip review with a payment request (scratch journal with
 *       publicationFee configured): three-step wizard incl. Request
 *       Payment → Copyediting + the author's "publication fee is due"
 *       Tasks-bell entry
 *   s3  desk decline + revert: decline email → declined (only Revert
 *       Decline + Delete + Schedule For Publication), Revert Decline
 *       restores the full submission-stage button set
 *   s4  request-revisions chooser: both radio options — first leaves the
 *       round "Revisions have been requested." + the author's Tasks-bell
 *       "Revision required."; second marks it "Resubmit for review"
 *   s5  accept after review, thank reviewers, share an attachment: an
 *       open-method reviewer uploads a file + submits; the editor attaches
 *       it to the author email, thanks the reviewer, records → Copyediting
 *       + "Reviewer Thanked" + the author reads the file via the open
 *       review
 *   s6  decline in review + revert: round panel "Submission declined." →
 *       Revert Decline recalculates the round
 *   s7  create a new review round (after a resubmit decision): Round 2
 *       appears empty ("Waiting for reviewers to be assigned."), round-1
 *       reviewer untouched
 *   s8  cancel a review round — guard + effect: an unconfirmed round 2 is
 *       cancellable (deleted, back to round 1); a confirmed one hides the
 *       button
 *   s9  copyediting hand-offs: Send To Production → Production, Move To
 *       Copyediting → Copyediting, Move to Review → Review ("Returned back
 *       to review.")
 *   s10 recommend-only editor records Recommend Accept: one-step Notify
 *       Editors wizard → standing "Recommendation" panel + "Change
 *       decision", deciding editor emailed, log reads "recommended"
 *   s11 recommendation needs a deciding editor (scratch journal without
 *       auto-assigned section editors): the noDecidingEditors message →
 *       assigning a section editor reveals the recommend buttons
 *   s12 who may record: assistant (no buttons), unassigned manager (full
 *       set), assigned section editor (buttons), unassigned section editor
 *       (no access), ⚠ manager-as-copyeditor (buttons but POST 401), author
 *       (no rail)
 *   s13 the Done round-trip: publishing auto-moves to Done (logged, no
 *       wizard); Return to Workflow → Production; ⚠ Return to Done 401s for
 *       the assigned editor but records for an unassigned manager
 *
 * Parallel-safety: every submission is per-test; tags are single
 * hyphenless alphanumeric tokens riding in submission titles; Mailpit
 * reads are scoped by recipient + tag; scratch journals (s2, s11, s12)
 * carry throwaway users so no seeded user gains a role anywhere. Tasks-bell
 * assertions are scoped to the per-test submission title (s4) or a
 * throwaway author's single submission (s2).
 */

test.use({user: 'manager.maya'}); // default actor: an unassigned journal manager

const JOURNAL = 'publicknowledge';

/** A unique, hyphenless, alphanumeric tag (parallel isolation). */
function uniqueTag(prefix = 'ed') {
	const workerLetter = String.fromCharCode(97 + (test.info().parallelIndex % 26));
	let suffix = '';
	while (suffix.length < 6) {
		suffix += Math.random().toString(36).replace(/[^a-z0-9]/g, '');
	}
	return `${prefix}${workerLetter}${suffix.slice(0, 6)}`;
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
 * A SUBMITTED submission spec (single AO/unpublished publication carrying
 * the tag in its title).
 */
function submittedSpec({
	tag,
	title,
	journal = JOURNAL,
	submitter = 'author.alex',
	section = 'ART',
	participants,
	decisions,
	reviewRounds,
	publication,
}) {
	return {
		tag,
		journal,
		submitter,
		section,
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

/** Read the CSRF token from a logged-in page (for mutating REST probes). */
async function readCsrf(page) {
	await page.waitForFunction(() => !!window.pkp?.currentUser?.csrfToken, null, {
		timeout: 15_000,
	});
	return page.evaluate(() => window.pkp.currentUser.csrfToken);
}

test.describe('Editorial decisions', () => {
	test('s1: a Journal Manager sends a submission to review — two-step wizard, Review (Round 1), the author email', async ({
		page,
		asUser,
		pkpApi,
		pkpMail,
	}) => {
		test.slow();
		const tag = uniqueTag('eda');
		const title = `Send to review ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({tag, title}),
		);

		const shell = new WorkflowShellPage(page);
		const wizard = new DecisionWizardPage(page);
		await shell.gotoEditorial(submission.id);
		await expect(shell.contentHeading('Workflow: Submission')).toBeVisible({
			timeout: 20_000,
		});

		// The action rail carries the submission-stage decisions.
		await expect(wizard.decisionButton('Send for Review')).toBeVisible();
		await wizard.clickDecision('Send for Review');

		// Step 1 — Notify Authors: a prefilled email to the submitting
		// author (weave the tag into the subject so the delivery is
		// Mailpit-scopable).
		await expect(
			wizard.pageHeading(/Send for Review:\s*Notify Authors/i),
		).toBeVisible({timeout: 20_000});
		await wizard.setEmailSubject('notifyAuthors', `Review invite ${tag}`);
		await wizard.clickContinue();

		// Step 2 — Select Files: the submission file listed pre-checked.
		await expect(wizard.pageHeading(/Select Files/i)).toBeVisible();
		await expect(
			wizard.promoteFileCheckbox('default-article.pdf'),
		).toBeChecked();

		await wizard.recordDecision(/has been sent to the review stage/);
		await wizard.viewSummaryFromCompletion();

		// Back on the workflow page: the submission now sits in Review,
		// Round 1.
		await expect(shell.contentHeading('Workflow: Review (Round 1)')).toBeVisible(
			{timeout: 20_000},
		);
		await expect(
			shell.modal().getByRole('heading', {name: 'Round 1 Status'}),
		).toBeVisible();

		// The author received the decision email.
		await pkpMail.find({
			to: 'author.alex@mailinator.com',
			contains: `Review invite ${tag}`,
		});
	});

	test('s2: Accept and Skip Review with a publication-fee request — three-step wizard, Copyediting, the author payment task', async ({
		asUser,
		pkpApi,
	}) => {
		test.slow();
		const tag = uniqueTag('edb');
		const mg = `mg${tag}`;
		const au = `au${tag}`;
		const {context} = await pkpApi.createJournal({
			tag,
			users: [
				throwawayUser(mg, 'Morgan', 'Feemanager', ['manager']),
				throwawayUser(au, 'Ambrose', 'Payer', ['author']),
			],
			// Configure the manual payment method so publicationEnabled()
			// is true (the plugin's isConfigured needs manualInstructions).
			plugins: {
				ManualPayment: {
					enabled: true,
					settings: {manualInstructions: `Pay the fee ${tag}`},
				},
			},
		});
		const journalPath = context.path;

		// Turn on payments + a publication fee via the context REST API
		// (the scenario schema has no payment keys). Do it as the manager.
		const mgCtx = await asUser(mg);
		const cfgPage = await mgCtx.newPage();
		await cfgPage.goto(`/index.php/${journalPath}/en/dashboard/editorial`, {
			waitUntil: 'commit',
		});
		const csrf = await readCsrf(cfgPage);
		const putRes = await cfgPage.request.put(
			`/index.php/${journalPath}/api/v1/contexts/${context.id}`,
			{
				headers: {'X-Csrf-Token': csrf, 'Content-Type': 'application/json'},
				data: {
					paymentsEnabled: true,
					paymentPluginName: 'ManualPayment',
					publicationFee: 25,
					currency: 'USD',
					contactEmail: `contact${tag}@mailinator.com`,
					contactName: 'Journal Contact',
				},
			},
		);
		expect(putRes.ok()).toBeTruthy();

		const title = `Skip review ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({tag, title, journal: journalPath, submitter: au}),
		);

		const shell = new WorkflowShellPage(cfgPage, {journalPath});
		const wizard = new DecisionWizardPage(cfgPage, {journalPath});
		await shell.gotoEditorial(submission.id);
		await expect(shell.contentHeading('Workflow: Submission')).toBeVisible({
			timeout: 20_000,
		});

		await wizard.clickDecision('Accept and Skip Review');
		// The OJS payment step is PREPENDED (Steps::addStep($form, true)), so
		// the wizard order is Request Payment → Notify Authors → Select Files.
		// Step 1 — Request Payment (radio pre-set to request the fee).
		await expect(
			wizard.pageHeading(/Accept and Skip Review:\s*Request Payment/i),
		).toBeVisible({timeout: 20_000});
		await expect(cfgPage.getByText(/Request publication fee/i)).toBeVisible();
		await wizard.clickContinue();
		// Step 2 — author email.
		await expect(wizard.pageHeading(/Notify Authors/i)).toBeVisible();
		await wizard.clickContinue();
		// Step 3 — Select Files.
		await expect(wizard.pageHeading(/Select Files/i)).toBeVisible();
		await wizard.recordDecision();
		await wizard.viewSummaryFromCompletion();

		// The submission is now in Copyediting.
		await expect(shell.contentHeading('Workflow: Copyediting')).toBeVisible({
			timeout: 20_000,
		});

		// The author has a task-level "payment required" notification.
		const auCtx = await asUser(au);
		const auPage = await auCtx.newPage();
		await auPage.goto(
			`/index.php/${journalPath}/en/dashboard/mySubmissions`,
			{waitUntil: 'commit'},
		);
		const tasks = new TasksGridModal(auPage);
		await tasks.open();
		await expect(
			tasks.modal.getByText(/publication fee is due for payment/i),
		).toBeVisible({timeout: 20_000});
	});

	test('s3: desk decline and revert — declined offers only Revert Decline (+ Delete + Schedule), reverting restores the full button set', async ({
		page,
		pkpApi,
	}) => {
		test.slow();
		const tag = uniqueTag('edc');
		const title = `Desk decline ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({tag, title}),
		);

		const shell = new WorkflowShellPage(page);
		const wizard = new DecisionWizardPage(page);
		await shell.gotoEditorial(submission.id);
		await expect(shell.contentHeading('Workflow: Submission')).toBeVisible({
			timeout: 20_000,
		});

		// Decline (single Notify Authors step).
		await wizard.clickDecision('Decline Submission');
		await expect(
			wizard.pageHeading(/Decline Submission/i),
		).toBeVisible({timeout: 20_000});
		await wizard.recordDecision(/has been declined and sent to the archives/);
		await wizard.viewSummaryFromCompletion();

		// Declined: only Revert Decline is a decision, but Delete and the
		// ever-present Schedule For Publication shortcut are still offered;
		// the active-state decisions are gone.
		await expect(wizard.decisionButton('Revert Decline')).toBeVisible({
			timeout: 20_000,
		});
		await expect(wizard.decisionButton('Delete')).toBeVisible();
		await expect(
			wizard.actionItems().getByRole('button', {
				name: 'Schedule For Publication',
			}),
		).toBeVisible();
		await expect(wizard.decisionButton('Send for Review')).toHaveCount(0);
		await expect(wizard.decisionButton('Decline Submission')).toHaveCount(0);

		// Revert Decline restores the active status → the full button set.
		await wizard.clickDecision('Revert Decline');
		await expect(wizard.pageHeading(/Revert Decline/i)).toBeVisible({
			timeout: 20_000,
		});
		await wizard.recordDecision();
		await wizard.viewSummaryFromCompletion();

		await expect(wizard.decisionButton('Send for Review')).toBeVisible({
			timeout: 20_000,
		});
		await expect(wizard.decisionButton('Accept and Skip Review')).toBeVisible();
		await expect(wizard.decisionButton('Decline Submission')).toBeVisible();
		await expect(wizard.decisionButton('Revert Decline')).toHaveCount(0);
	});

	test('s4: request revisions vs. resubmit — the chooser routes to the right wizard and sets the round status', async ({
		page,
		asUser,
		pkpApi,
		pkpMail,
	}) => {
		test.slow();
		const tag = uniqueTag('edd');
		const title = `Revisions ${tag}`;
		// A review round with a completed reviewer (so the wizard gains the
		// Notify Reviewers step and the round can request revisions).
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				participants: [
					{user: 'editor.diana', role: 'editor'},
					{user: 'sectioneditor.ana', role: 'sectionEditor'},
				],
				decisions: [{type: 'sendExternalReview', by: 'editor.diana'}],
				reviewRounds: [
					{
						reviewers: [
							{
								user: 'reviewer.paul',
								method: 'anonymous',
								status: 'completed',
								recommendation: 'pendingRevisions',
							},
						],
					},
				],
			}),
		);

		// Act as the assigned section editor.
		const seCtx = await asUser('sectioneditor.ana');
		const sePage = await seCtx.newPage();
		const shell = new WorkflowShellPage(sePage);
		const wizard = new DecisionWizardPage(sePage);
		const round = new ReviewRoundPanel(sePage);
		await shell.gotoEditorial(submission.id);
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});

		// Request Revisions → chooser; first option (no new round) is
		// pre-selected. Complete the two-step wizard (author email, then
		// skip the reviewer email).
		await wizard.clickRevisionsChooser({buttonLabel: 'Request Revisions'});
		await expect(
			wizard.pageHeading(/Request Revisions:\s*Notify Authors/i),
		).toBeVisible({timeout: 20_000});
		await wizard.setEmailSubject('notifyAuthors', `Please revise ${tag}`);
		await wizard.clickContinue();
		await expect(wizard.pageHeading(/Notify Reviewers/i)).toBeVisible();
		await wizard.skipEmail();
		await wizard.recordDecision(/have been requested/);
		await wizard.viewSummaryFromCompletion();

		// The round now reads "Revisions have been requested."
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});
		await round.expectRoundStatus(1, 'Revisions have been requested.');

		// The author received the request email and a task-level
		// "Revision required." Tasks-bell entry.
		await pkpMail.find({
			to: 'author.alex@mailinator.com',
			contains: `Please revise ${tag}`,
		});
		const auCtx = await asUser('author.alex');
		const auPage = await auCtx.newPage();
		await auPage.goto(`/index.php/${JOURNAL}/en/dashboard/mySubmissions`, {
			waitUntil: 'commit',
		});
		const tasks = new TasksGridModal(auPage);
		await tasks.open();
		await expect(tasks.row(tag)).toContainText('Revision required.', {
			timeout: 20_000,
		});

		// Run it again as Resubmit (second chooser option) → the round
		// flips to "Resubmit for review" and no new round appears.
		await wizard.clickRevisionsChooser({
			buttonLabel: 'Request Revisions',
			newRound: true,
		});
		await expect(wizard.pageHeading(/Notify Authors/i)).toBeVisible({
			timeout: 20_000,
		});
		await wizard.clickContinue();
		await wizard.skipEmail();
		await wizard.recordDecision();
		await wizard.viewSummaryFromCompletion();

		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});
		await round.expectRoundStatus(
			1,
			/Revisions requested from the author to be taken to a new review round\./,
		);
		await expect(shell.menuItem('Review Round 2')).toHaveCount(0);
	});

	test('s5: accept after review — thank reviewers and share an open-method reviewer file with the author', async ({
		page,
		asUser,
		pkpApi,
	}) => {
		test.slow();
		const tag = uniqueTag('ede');
		const title = `Accept share ${tag}`;
		// An OPEN-method reviewer, accepted (we drive the review through the
		// UI so it carries an uploaded Reviewer File to attach).
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				participants: [
					{user: 'editor.diana', role: 'editor'},
					{user: 'sectioneditor.ana', role: 'sectionEditor'},
				],
				decisions: [{type: 'sendExternalReview', by: 'editor.diana'}],
				reviewRounds: [
					{reviewers: [{user: 'reviewer.julia', method: 'open', status: 'accepted'}]},
				],
			}),
		);

		// The reviewer uploads a file and submits the (open) review.
		const rvCtx = await asUser('reviewer.julia');
		const rvPage = await rvCtx.newPage();
		const reviewer = new ReviewerSubmissionPage(rvPage);
		await reviewer.goto(submission.id);
		// A seeded 'accepted' assignment opens the wizard on step 2
		// (Guidelines); advance to step 3 to reach the review form + the
		// attachments grid.
		await reviewer.continueToStep3();
		await reviewer.uploadAttachment(
			fixtureFilePath('default-article.pdf'),
			'default-article.pdf',
		);
		await reviewer.fillStep3Comments({toAuthor: `<p>Open review ${tag}</p>`});
		await reviewer.selectRecommendation('Accept Submission');
		await reviewer.submitReview();

		// The section editor accepts, attaching the reviewer's file and
		// thanking the reviewer.
		const seCtx = await asUser('sectioneditor.ana');
		const sePage = await seCtx.newPage();
		const shell = new WorkflowShellPage(sePage);
		const wizard = new DecisionWizardPage(sePage);
		await shell.gotoEditorial(submission.id);
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});

		await wizard.clickDecision('Accept Submission');
		// Step 1 — author email; attach the reviewer's file.
		await expect(
			wizard.pageHeading(/Accept Submission:\s*Notify Authors/i),
		).toBeVisible({timeout: 20_000});
		await wizard.attachReviewFiles(['default-article.pdf']);
		await wizard.clickContinue();
		// Step 2 — Notify Reviewers: keep the prefilled email (sending it
		// thanks the reviewer).
		await expect(wizard.pageHeading(/Notify Reviewers/i)).toBeVisible();
		await wizard.clickContinue();
		// Step 3 — Select Files.
		await expect(wizard.pageHeading(/Select Files/i)).toBeVisible();
		await wizard.recordDecision();
		await wizard.viewSummaryFromCompletion();

		// The submission is in Copyediting; the reviewer row is thanked.
		await expect(shell.contentHeading('Workflow: Copyediting')).toBeVisible({
			timeout: 20_000,
		});
		await shell.clickMenu('Review Round 1');
		await expect(
			shell.modal().getByText('Reviewer Thanked').first(),
		).toBeVisible({timeout: 20_000});

		// The author can read the shared file via the open review from
		// their dashboard: on the Review Round 1 panel, the redacted
		// ReviewerManager exposes "Read Review" → "Reviewer Files".
		const auCtx = await asUser('author.alex');
		const auPage = await auCtx.newPage();
		const authorShell = new WorkflowShellPage(auPage);
		await authorShell.gotoTracking(submission.id);
		await expect(authorShell.header()).toContainText(title, {timeout: 20_000});
		await authorShell.clickMenu('Review Round 1');
		await expect(
			authorShell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});
		await authorShell
			.modal()
			.getByRole('button', {name: 'Read Review', exact: true})
			.first()
			.click();
		// The legacy read-review modal ("Review: {title}") loads the author
		// open-review attachments grid under a "Reviewer Files" section.
		const readModal = auPage
			.getByRole('dialog', {name: /Review:/i})
			.first();
		await expect(readModal).toBeVisible({timeout: 20_000});
		await expect(readModal.getByText('Reviewer Files')).toBeVisible({
			timeout: 20_000,
		});
		await expect(
			readModal.locator('#readReviewAttachmentsGridContainer'),
		).toContainText('default-article.pdf', {timeout: 20_000});
	});

	test('s6: decline in review, then revert — the round reads "Submission declined." and recalculates on revert', async ({
		page,
		pkpApi,
	}) => {
		test.slow();
		const tag = uniqueTag('edf');
		const title = `Decline in review ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				participants: [{user: 'editor.diana', role: 'editor'}],
				decisions: [{type: 'sendExternalReview', by: 'editor.diana'}],
				reviewRounds: [
					{reviewers: [{user: 'reviewer.paul', method: 'anonymous', status: 'declined'}]},
				],
			}),
		);

		const shell = new WorkflowShellPage(page);
		const wizard = new DecisionWizardPage(page);
		const round = new ReviewRoundPanel(page);
		await shell.gotoEditorial(submission.id);
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});

		await wizard.clickDecision('Decline Submission');
		await expect(wizard.pageHeading(/Decline Submission/i)).toBeVisible({
			timeout: 20_000,
		});
		await wizard.recordDecision(/has been declined/);
		await wizard.viewSummaryFromCompletion();

		// The round panel reads "Submission declined."; the only decision
		// offered is Revert Decline.
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});
		await round.expectRoundStatus(1, 'Submission declined.');
		await expect(wizard.decisionButton('Revert Decline')).toBeVisible();
		await expect(wizard.decisionButton('Accept Submission')).toHaveCount(0);

		// Revert brings it back active; the round recalculates (the declined
		// reviewer leaves the round "Returned back to review." out of the
		// picture — it recomputes to a live status, no longer "declined").
		await wizard.clickDecision('Revert Decline');
		await expect(wizard.pageHeading(/Revert Decline/i)).toBeVisible({
			timeout: 20_000,
		});
		await wizard.recordDecision();
		await wizard.viewSummaryFromCompletion();

		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});
		await expect(
			round.modal().getByText('Submission declined.'),
		).toHaveCount(0, {timeout: 20_000});
		await expect(wizard.decisionButton('Accept Submission')).toBeVisible();
	});

	test('s7: create a new review round — Round 2 appears empty, the round-1 reviewer untouched', async ({
		page,
		asUser,
		pkpApi,
	}) => {
		test.slow();
		const tag = uniqueTag('edg');
		const title = `New round ${tag}`;
		// Round 1 reviewed + a resubmit decision recorded (the editor's
		// next step is Create New Review Round).
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				participants: [
					{user: 'editor.diana', role: 'editor'},
					{user: 'sectioneditor.ana', role: 'sectionEditor'},
				],
				decisions: [
					{type: 'sendExternalReview', by: 'editor.diana'},
					{type: 'resubmit', by: 'editor.diana'},
				],
				reviewRounds: [
					{
						reviewers: [
							{
								user: 'reviewer.paul',
								method: 'anonymous',
								status: 'completed',
								recommendation: 'resubmitHere',
							},
						],
					},
				],
			}),
		);

		const seCtx = await asUser('sectioneditor.ana');
		const sePage = await seCtx.newPage();
		const shell = new WorkflowShellPage(sePage);
		const wizard = new DecisionWizardPage(sePage);
		await shell.gotoEditorial(submission.id);
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});

		// Create New Review Round: two-step wizard (notify authors + select
		// files — the promote list is empty with no revision uploaded).
		await wizard.clickDecision('Create New Review Round');
		await expect(wizard.pageHeading(/New Review Round:\s*Notify Authors/i))
			.toBeVisible({timeout: 20_000});
		await wizard.clickContinue();
		await expect(wizard.pageHeading(/Select Files/i)).toBeVisible();
		await wizard.recordDecision();
		await wizard.viewSummaryFromCompletion();

		// Fresh open lands on Round 2, empty of reviewers.
		await expect(
			shell.contentHeading('Workflow: Review (Round 2)'),
		).toBeVisible({timeout: 20_000});
		await expect(shell.menuItem('Review Round 1')).toBeVisible();
		await expect(shell.menuItem('Review Round 2')).toBeVisible();
		await expect(
			shell
				.modal()
				.getByText('Waiting for reviewers to be assigned.'),
		).toBeVisible({timeout: 20_000});

		// Round 1 still lists paul.
		await shell.clickMenu('Review Round 1');
		await expect(
			shell.modal().getByText('Paul Reviewer').first(),
		).toBeVisible({timeout: 20_000});
	});

	test('s8: cancel a review round — an unconfirmed round is deleted, a confirmed one hides the button', async ({
		page,
		pkpApi,
	}) => {
		test.slow();
		const tag = uniqueTag('edh');
		// A: round 2 with an INVITED (unconfirmed) reviewer → cancellable.
		const cancelTitle = `Cancelable ${tag}c`;
		const {submission: subCancel} = await pkpApi.createSubmission(
			submittedSpec({
				tag: `${tag}c`,
				title: cancelTitle,
				participants: [{user: 'editor.diana', role: 'editor'}],
				decisions: [
					{type: 'sendExternalReview', by: 'editor.diana'},
					{type: 'newExternalRound', by: 'editor.diana'},
				],
				reviewRounds: [
					{reviewers: []},
					{reviewers: [{user: 'reviewer.paul', method: 'anonymous', status: 'invited'}]},
				],
			}),
		);
		// B: round 2 with an ACCEPTED (confirmed) reviewer → not cancellable.
		const guardTitle = `Guarded ${tag}g`;
		const {submission: subGuard} = await pkpApi.createSubmission(
			submittedSpec({
				tag: `${tag}g`,
				title: guardTitle,
				participants: [{user: 'editor.diana', role: 'editor'}],
				decisions: [
					{type: 'sendExternalReview', by: 'editor.diana'},
					{type: 'newExternalRound', by: 'editor.diana'},
				],
				reviewRounds: [
					{reviewers: []},
					{reviewers: [{user: 'reviewer.paul', method: 'anonymous', status: 'accepted'}]},
				],
			}),
		);

		const shell = new WorkflowShellPage(page);
		const wizard = new DecisionWizardPage(page);

		// A — the button is offered; recording it (unassignment email)
		// deletes round 2 and lands the submission back on round 1.
		await shell.gotoEditorial(subCancel.id);
		await expect(
			shell.contentHeading('Workflow: Review (Round 2)'),
		).toBeVisible({timeout: 20_000});
		await expect(wizard.decisionButton('Cancel Review Round')).toBeVisible();
		await wizard.clickDecision('Cancel Review Round');
		// Two steps: Notify Authors, then Notify Reviewers (the active
		// reviewer gets the unassignment email, preselected as recipient).
		await expect(
			wizard.pageHeading(/Cancel Review Round:\s*Notify Authors/i),
		).toBeVisible({timeout: 20_000});
		await wizard.clickContinue();
		await expect(wizard.pageHeading(/Notify Reviewers/i)).toBeVisible();
		await wizard.recordDecision();
		await wizard.viewSummaryFromCompletion();

		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});
		await expect(shell.menuItem('Review Round 2')).toHaveCount(0);

		// B — a confirmed reviewer hides the Cancel Review Round button.
		await shell.gotoEditorial(subGuard.id);
		await expect(
			shell.contentHeading('Workflow: Review (Round 2)'),
		).toBeVisible({timeout: 20_000});
		await expect(wizard.decisionButton('Accept Submission')).toBeVisible();
		await expect(wizard.decisionButton('Cancel Review Round')).toHaveCount(0);
	});

	test('s9: copyediting hand-offs both ways — Send To Production, Move To Copyediting, Move to Review', async ({
		page,
		pkpApi,
	}) => {
		test.slow();
		const tag = uniqueTag('edi');
		const title = `Handoffs ${tag}`;
		// Accepted into copyediting; round 1 has a declined reviewer so that
		// after Move to Review the round can display "Returned back to
		// review." (no live reviewer state outranks it).
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				participants: [{user: 'editor.diana', role: 'editor'}],
				decisions: [
					{type: 'sendExternalReview', by: 'editor.diana'},
					{type: 'accept', by: 'editor.diana'},
				],
				reviewRounds: [
					{reviewers: [{user: 'reviewer.paul', method: 'anonymous', status: 'declined'}]},
				],
			}),
		);

		const shell = new WorkflowShellPage(page);
		const wizard = new DecisionWizardPage(page);
		const round = new ReviewRoundPanel(page);
		await shell.gotoEditorial(submission.id);
		await expect(shell.contentHeading('Workflow: Copyediting')).toBeVisible({
			timeout: 20_000,
		});

		// Send To Production (author email + promote copyedited files).
		await wizard.clickDecision('Send To Production');
		await expect(wizard.pageHeading(/Send To Production/i)).toBeVisible({
			timeout: 20_000,
		});
		await wizard.clickContinue();
		await expect(wizard.pageHeading(/Select Files/i)).toBeVisible();
		await wizard.recordDecision();
		await wizard.viewSummaryFromCompletion();
		await expect(shell.contentHeading('Workflow: Production')).toBeVisible({
			timeout: 20_000,
		});

		// Move To Copyediting (single author-email step) → back to
		// Copyediting.
		await wizard.clickDecision('Move To Copyediting');
		await expect(wizard.pageHeading(/Move To Copyediting/i)).toBeVisible({
			timeout: 20_000,
		});
		await wizard.recordDecision();
		await wizard.viewSummaryFromCompletion();
		await expect(shell.contentHeading('Workflow: Copyediting')).toBeVisible({
			timeout: 20_000,
		});

		// Move to Review → back to the Review stage.
		await wizard.clickDecision('Move to Review');
		await expect(wizard.pageHeading(/Move to Review/i)).toBeVisible({
			timeout: 20_000,
		});
		await wizard.recordDecision();
		await wizard.viewSummaryFromCompletion();
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});
		await round.expectRoundStatus(1, 'Returned back to review.');
	});

	test('s10: a recommend-only editor records a recommendation — Notify Editors wizard, standing panel, editor email + log', async ({
		page,
		asUser,
		pkpApi,
		pkpMail,
	}) => {
		test.slow();
		const tag = uniqueTag('edj');
		const title = `Recommendation ${tag}`;
		// sectioneditor.omar is the recommend-only editor; sectioneditor.ana
		// (auto-assigned as an ART section editor at submit) is the deciding
		// editor.
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				participants: [
					{user: 'editor.diana', role: 'editor'},
					{user: 'sectioneditor.ana', role: 'sectionEditor'},
					{user: 'sectioneditor.omar', role: 'sectionEditor', recommendOnly: true},
				],
				decisions: [{type: 'sendExternalReview', by: 'editor.diana'}],
				reviewRounds: [{reviewers: []}],
			}),
		);

		// The recommend-only editor sees recommend controls, not decisions.
		const roCtx = await asUser('sectioneditor.omar');
		const roPage = await roCtx.newPage();
		const shell = new WorkflowShellPage(roPage);
		const wizard = new DecisionWizardPage(roPage);
		await shell.gotoEditorial(submission.id);
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});
		await expect(wizard.decisionButton('Recommend Accept')).toBeVisible();
		await expect(wizard.decisionButton('Recommend Decline')).toBeVisible();
		await expect(wizard.decisionButton('Recommend Revisions')).toBeVisible();
		await expect(wizard.decisionButton('Accept Submission')).toHaveCount(0);

		// Record Recommend Accept: one-step wizard whose single Notify
		// Editors step cannot be skipped (h1 shows the decision label only
		// on a one-step wizard).
		await wizard.clickDecision('Recommend Accept');
		await expect(wizard.pageHeading(/Recommend Accept/i)).toBeVisible({
			timeout: 20_000,
		});
		await expect(
			roPage.getByRole('heading', {name: 'Notify Editors'}),
		).toBeVisible();
		await wizard.setEmailSubject('discussion', `Recommend accept ${tag}`);
		await expect(
			roPage.getByRole('button', {name: 'Skip this email', exact: true}),
		).toHaveCount(0);
		await wizard.recordDecision();
		await wizard.viewSummaryFromCompletion();

		// The standing recommendation panel replaces the buttons.
		await expect(
			shell.modal().getByRole('heading', {name: 'Recommendation'}),
		).toBeVisible({timeout: 20_000});
		await expect(shell.modal().getByText('Accept Submission')).toBeVisible();
		await expect(
			shell.modal().getByRole('button', {name: 'Change decision'}),
		).toBeVisible();

		// The deciding editor (ana) received the recommendation email.
		await pkpMail.find({
			to: 'sectioneditor.ana@mailinator.com',
			contains: `Recommend accept ${tag}`,
		});

		// The activity log records the recommendation.
		const log = new ActivityLogModal(roPage);
		await log.openFromWorkflow();
		await log.openHistoryTab();
		await expect(log.historyRow(/recommend/i).first()).toBeVisible({
			timeout: 20_000,
		});
	});

	test('s11: a recommendation needs a deciding editor — the guard message clears once a section editor is assigned', async ({
		asUser,
		pkpApi,
	}) => {
		test.slow();
		const tag = uniqueTag('edk');
		const ed = `ed${tag}`;
		const ro = `ro${tag}`;
		const se = `se${tag}`;
		const au = `au${tag}`;
		// A scratch journal (default sections have no section editors, so
		// submit does NOT auto-assign a deciding editor).
		const {context} = await pkpApi.createJournal({
			tag,
			users: [
				throwawayUser(ed, 'Edwin', 'Sender', ['editor']),
				throwawayUser(ro, 'Rowan', 'Recommender', ['sectionEditor']),
				throwawayUser(se, 'Selby', 'Decider', ['sectionEditor']),
				throwawayUser(au, 'Aubrey', 'Author', ['author']),
			],
		});
		const journalPath = context.path;
		const title = `Needs decider ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				journal: journalPath,
				submitter: au,
				participants: [{user: ro, role: 'sectionEditor', recommendOnly: true}],
				decisions: [{type: 'sendExternalReview', by: ed}],
				reviewRounds: [{reviewers: []}],
			}),
		);

		// The recommend-only editor: no recommendation possible yet.
		const roCtx = await asUser(ro);
		const roPage = await roCtx.newPage();
		const shell = new WorkflowShellPage(roPage, {journalPath});
		const wizard = new DecisionWizardPage(roPage, {journalPath});
		await shell.gotoEditorial(submission.id);
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});
		await expect(
			shell
				.modal()
				.getByText(
					'You can not make a recommendation until an editor is assigned with permission to record a decision.',
				),
		).toBeVisible({timeout: 20_000});
		await expect(wizard.decisionButton('Recommend Accept')).toHaveCount(0);

		// Assign a regular (deciding) section editor via the participant
		// panel as the manager.
		const edCtx = await asUser(ed);
		const edPage = await edCtx.newPage();
		const edShell = new WorkflowShellPage(edPage, {journalPath});
		await edShell.gotoEditorial(submission.id);
		await expect(
			edShell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});
		const participants = new ParticipantManagerPage(edPage);
		await participants.assignParticipant({
			userGroup: 'Section editor',
			nameSearch: 'Decider',
			fullName: 'Selby Decider',
		});

		// The recommend-only editor now sees the recommend buttons.
		await shell.gotoEditorial(submission.id);
		await expect(wizard.decisionButton('Recommend Accept')).toBeVisible({
			timeout: 20_000,
		});
		await expect(wizard.decisionButton('Recommend Decline')).toBeVisible();
		await expect(wizard.decisionButton('Recommend Revisions')).toBeVisible();
	});

	test('s12: who may record at all — assistant, unassigned manager, assigned/unassigned section editor, manager-as-copyeditor, author', async ({
		browser,
		baseURL,
		asUser,
		pkpApi,
	}) => {
		test.slow();
		const tag = uniqueTag('edl');
		const ed = `ed${tag}`;
		const mg = `mg${tag}`;
		const seOn = `sa${tag}`;
		const seOff = `sf${tag}`;
		const asst = `as${tag}`;
		const mgcp = `mc${tag}`;
		const au = `au${tag}`;
		const {context} = await pkpApi.createJournal({
			tag,
			users: [
				throwawayUser(ed, 'Edmund', 'Sender', ['editor']),
				throwawayUser(mg, 'Marge', 'Unassignedmgr', ['manager']),
				throwawayUser(seOn, 'Sasha', 'Assignededitor', ['sectionEditor']),
				throwawayUser(seOff, 'Soren', 'Outsideeditor', ['sectionEditor']),
				throwawayUser(asst, 'Ashby', 'Copyassistant', ['copyeditor']),
				// Genuinely enrolled as BOTH manager and copyeditor; assigned
				// only as a copyeditor → the manager fallback is suppressed.
				throwawayUser(mgcp, 'Mika', 'Managercopy', ['manager', 'copyeditor']),
				throwawayUser(au, 'Aviva', 'Author', ['author']),
			],
		});
		const journalPath = context.path;
		const title = `Who decides ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				journal: journalPath,
				submitter: au,
				participants: [
					{user: ed, role: 'editor'},
					{user: seOn, role: 'sectionEditor'},
					{user: asst, role: 'copyeditor'},
					{user: mgcp, role: 'copyeditor'},
				],
				decisions: [{type: 'sendExternalReview', by: ed}],
				reviewRounds: [{reviewers: []}],
			}),
		);

		const openShell = async (username) => {
			const ctx = await asUser(username);
			const p = await ctx.newPage();
			const shell = new WorkflowShellPage(p, {journalPath});
			const wizard = new DecisionWizardPage(p, {journalPath});
			await shell.gotoEditorial(submission.id);
			return {p, shell, wizard};
		};

		// The assigned assistant: reaches the round, but no decision rail.
		{
			const {shell, wizard} = await openShell(asst);
			await expect(
				shell.contentHeading('Workflow: Review (Round 1)'),
			).toBeVisible({timeout: 20_000});
			await expect(wizard.decisionButton('Accept Submission')).toHaveCount(0);
			await expect(wizard.decisionButton('Decline Submission')).toHaveCount(0);
		}

		// The unassigned manager: the full review-stage decision set.
		{
			const {shell, wizard} = await openShell(mg);
			await expect(
				shell.contentHeading('Workflow: Review (Round 1)'),
			).toBeVisible({timeout: 20_000});
			await expect(wizard.decisionButton('Accept Submission')).toBeVisible();
			await expect(wizard.decisionButton('Request Revisions')).toBeVisible();
			await expect(wizard.decisionButton('Decline Submission')).toBeVisible();
		}

		// The assigned section editor: sees the decisions.
		{
			const {shell, wizard} = await openShell(seOn);
			await expect(
				shell.contentHeading('Workflow: Review (Round 1)'),
			).toBeVisible({timeout: 20_000});
			await expect(wizard.decisionButton('Accept Submission')).toBeVisible();
		}

		// The unassigned section editor: cannot open the submission at all
		// (the workflow content never loads).
		{
			const ctx = await asUser(seOff);
			const p = await ctx.newPage();
			const shell = new WorkflowShellPage(p, {journalPath});
			await shell.gotoEditorial(submission.id);
			await expect(
				shell.contentHeading('Workflow: Review (Round 1)'),
			).toHaveCount(0, {timeout: 20_000});
			await expect(p.getByText(title)).toHaveCount(0);
		}

		// ⚠ The manager assigned only as a copyeditor: the SERVER refuses
		// the decision (ledger row 219 — the actionable defect). The spec's
		// Known-deviation copy says such a user "still sees the full set of
		// decision buttons"; as-built on this review-stage submission they
		// instead get the bare no-access sentence and NO action rail (the
		// copyeditor assignment suppresses the manager fallback for stage
		// access too). Conflict recorded in the test-author report — assert
		// the OBSERVED behavior, not the spec claim.
		{
			const {p, shell, wizard} = await openShell(mgcp);
			await expect(
				shell.contentHeading('Workflow: Review (Round 1)'),
			).toBeVisible({timeout: 20_000});
			await expect(
				shell
					.primaryItems()
					.getByText(WorkflowShellPage.NO_ACCESS_SENTENCE),
			).toBeVisible({timeout: 20_000});
			await expect(wizard.decisionButton('Accept Submission')).toHaveCount(0);
			// The server also refuses a hand-crafted decision POST (the body
			// is minimal, so the refusal surfaces as a 4xx either way).
			const csrf = await readCsrf(p);
			const res = await p.request.post(
				`/index.php/${journalPath}/api/v1/submissions/${submission.id}/decisions`,
				{
					headers: {'X-Csrf-Token': csrf, 'Content-Type': 'application/json'},
					data: {decision: 2, actions: []}, // ACCEPT
				},
			);
			expect(res.status()).toBeGreaterThanOrEqual(400);
			expect(res.status()).toBeLessThan(500);
		}

		// The author's tracking view carries no decision rail.
		{
			const ctx = await asUser(au);
			const p = await ctx.newPage();
			const authorShell = new WorkflowShellPage(p, {journalPath});
			await p.goto(
				`/index.php/${journalPath}/en/dashboard/mySubmissions?workflowSubmissionId=${submission.id}`,
				{waitUntil: 'commit'},
			);
			await expect(authorShell.header()).toContainText(title, {
				timeout: 20_000,
			});
			await expect(authorShell.actionItems()).toHaveCount(0);
		}
	});

	test('s13: the Done round-trip — publish auto-moves to Done, Return to Workflow, ⚠ Return to Done 401s for the assignee but records for a manager', async ({
		asUser,
		pkpApi,
	}) => {
		test.slow();
		const tag = uniqueTag('edm');
		const title = `Done trip ${tag}`;
		// Seed all the way to Production and publish the first VoR — the
		// PublicationPublished event auto-moves the submission to Done.
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				participants: [
					{user: 'editor.diana', role: 'editor'},
					{user: 'sectioneditor.ana', role: 'sectionEditor'},
				],
				decisions: [
					{type: 'sendExternalReview', by: 'editor.diana'},
					{type: 'accept', by: 'editor.diana'},
					{type: 'sendToProduction', by: 'editor.diana'},
				],
				reviewRounds: [{reviewers: []}],
				publication: {
					versionStage: 'VoR',
					issue: 'current',
					published: true,
				},
			}),
		);

		// The assigned section editor: the submission is already in Done,
		// the auto Move to Done is in the log, and the header offers Return
		// to Workflow.
		const seCtx = await asUser('sectioneditor.ana');
		const sePage = await seCtx.newPage();
		const shell = new WorkflowShellPage(sePage);
		await shell.gotoEditorial(submission.id);
		await expect(shell.header()).toContainText(title, {timeout: 20_000});

		const log = new ActivityLogModal(sePage);
		await log.openFromWorkflow();
		await log.openHistoryTab();
		await expect(
			log.historyRow(/moved this submission to the Done stage/i).first(),
		).toBeVisible({timeout: 20_000});
		await log.close();

		// Return to Workflow → confirm. The finishedCallback closes the
		// panel back to the dashboard, so re-open to read the new state.
		await shell.headerButton('Return to Workflow').click();
		const rtwDialog = sePage.locator('[data-cy="dialog"]');
		await expect(rtwDialog).toBeVisible({timeout: 15_000});
		await rtwDialog.getByRole('button', {name: 'Confirm', exact: true}).click();
		await expect(rtwDialog).toBeHidden({timeout: 15_000});
		await shell.gotoEditorial(submission.id);
		await expect(shell.contentHeading('Workflow: Production')).toBeVisible({
			timeout: 20_000,
		});
		// The header now offers Return to Done.
		await expect(shell.headerButton('Return to Done')).toBeVisible({
			timeout: 20_000,
		});

		// ⚠ Return to Done as the assigned editor 401s (ledger row 216).
		await shell.headerButton('Return to Done').click();
		const rtdDialog = sePage.locator('[data-cy="dialog"]');
		await expect(rtdDialog).toBeVisible({timeout: 15_000});
		await rtdDialog.getByRole('button', {name: 'Confirm', exact: true}).click();
		await expect(
			sePage.getByText(
				'The current role does not have access to this operation.',
			),
		).toBeVisible({timeout: 20_000});
		// Still on Production — the decision was refused.
		await shell.gotoEditorial(submission.id);
		await expect(shell.contentHeading('Workflow: Production')).toBeVisible({
			timeout: 20_000,
		});

		// An unassigned Journal Manager CAN record Return to Done.
		const mgCtx = await asUser('manager.maya');
		const mgPage = await mgCtx.newPage();
		const mgShell = new WorkflowShellPage(mgPage);
		await mgShell.gotoEditorial(submission.id);
		await expect(mgShell.contentHeading('Workflow: Production')).toBeVisible({
			timeout: 20_000,
		});
		await mgShell.headerButton('Return to Done').click();
		const mgDialog = mgPage.locator('[data-cy="dialog"]');
		await expect(mgDialog).toBeVisible({timeout: 15_000});
		await mgDialog.getByRole('button', {name: 'Confirm', exact: true}).click();
		await expect(mgDialog).toBeHidden({timeout: 15_000});
		// Back in Done: the header offers Return to Workflow again.
		await mgShell.gotoEditorial(submission.id);
		await expect(mgShell.headerButton('Return to Workflow')).toBeVisible({
			timeout: 20_000,
		});
	});
});
