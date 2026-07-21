// @ts-check
const path = require('path');
const {test, expect} = require('../support/base-test.js');
const {WorkflowShellPage} = require('../pages/WorkflowShellPage.js');
const {DecisionWizardPage} = require('../pages/DecisionWizardPage.js');
const {DashboardPage} = require('../pages/DashboardPage.js');
const {ReviewRoundPanel} = require('../pages/ReviewRoundPanel.js');
const {ReviewerManagerPage} = require('../pages/ReviewerManagerPage.js');
const {ReviewerSubmissionPage} = require('../pages/ReviewerSubmissionPage.js');
const {ActivityLogModal} = require('../pages/ActivityLogModal.js');
const {TasksGridModal} = require('../pages/TasksGridModal.js');
const {DiscussionManagerPage} = require('../pages/DiscussionManagerPage.js');

/**
 * Editorial decisions — one test per canonical scenario of
 * docs/product/specs/editorial-decisions.md (13 scenarios → 13 tests).
 * The decision engine (DecisionType roster, the decision/record wizard,
 * the Done machine, the recommendation variant) is shared pkp-lib, so
 * the spec lives here; scenario payloads use OJS vocabulary
 * (publicknowledge / ART / skipExternalReview), matching the bootstrap
 * context the suite runs against.
 *
 * Coverage per scenario:
 *   s1  Send for Review: two-step wizard (Notify Authors + Select
 *       Files, file pre-checked), "Sent for Review" completion with a
 *       single View Submission Summary button, Review Round 1 landing,
 *       carried file in Files for Review, author email
 *   s2  Accept and Skip Review with a fee (scratch journal, payments
 *       configured through the live /_payments endpoint the settings
 *       form uses — DB-seeded plugin settings are cache-blind): wizard
 *       opens on Request Payment with "Request publication fee"
 *       pre-selected; acceptance + payment-request emails; the
 *       author's payment task
 *   s3  desk decline → declined rail (Revert Decline only, the
 *       Schedule For Publication shortcut persisting as-built, Delete
 *       for a manager but not the section editor), the dashboard's
 *       Declined view, then revert → original rail restored
 *   s4  Request Revisions via the chooser (default = no new round),
 *       reviewer's uploaded file attached to the author email (the
 *       author's copy carries the attachment), round stays open on
 *       "Revisions have been requested.", author task row
 *   s5  Accept below the review minimum (scratch journal,
 *       numReviewsPerSubmission raised over one completed review):
 *       Proceed Without Minimum prompt, three-step wizard, reviewer
 *       chip shows the real name under an anonymous method (ledger row
 *       214 as-built), Copyediting landing, thank-you email +
 *       "Reviewer Thanked" row
 *   s6  Create New Review Round after a resubmit cycle: author uploads
 *       a revision, the editor carries it into Round 2 (empty of
 *       reviewers, file in its Files for Review)
 *   s7  Cancel Review Round while uncommitted (invited-only): round
 *       vanishes, submission falls back to Submission; the button is
 *       absent on an accepted sibling
 *   s8  recommend-only editor: three Recommend buttons, unskippable
 *       one-step Notify Editors, "Recommendation Submitted", the
 *       deciding editor's listing + discussion + email; stage 1 offers
 *       a bare Send for Review
 *   s9  Copyediting handoffs: Send To Production; the mislabeled
 *       "Move to Review" lands a never-reviewed submission on the
 *       Submission stage (ledger row 10 as-built) while the sibling
 *       with a round returns to Review
 *   s10 Move To Copyediting from Production (unassigned manager), with
 *       the activity-log entry
 *   s11 authority boundary on one review submission: assistant
 *       workspace with no rail (plus the as-built reviewer-suggestions
 *       error dialog), author view with no rail, recommend-only editor
 *       never offered Accept, unassigned manager records Accept
 *       end-to-end
 *   s12 automatic Done bookkeeping (scratch journal + own issue):
 *       UI publish → Published badge, Return to Workflow button and an
 *       unclicked moved-to-Done log entry; unpublish → back to
 *       Production with the return logged
 *   s13 Return to Done offered widely, honored narrowly: the assigned
 *       section editor's confirm errors with nothing recorded (ledger
 *       row 216 as-built); the unassigned manager's confirm lands the
 *       submission back in Done
 *
 * Parallel-safety: every submission (and the s2/s5/s12/s13 scratch
 * journals) is per-test; tags are single hyphenless alphanumeric
 * tokens riding in submission titles and email subjects; Mailpit reads
 * are recipient+tag scoped (no clearAll, no negative mail
 * assertions); publicknowledge is used read-only + additively — the
 * two publishing scenarios (s12, s13) run on scratch journals with
 * their own issues; no seeded user gains a role anywhere (all
 * scratch-journal roles are throwaway users; the recommend-only flags
 * are per-submission stage assignments on seeded section editors).
 */

test.use({user: 'sectioneditor.ana'}); // default actor: an assigned section editor

const JOURNAL = 'publicknowledge';
const SEEDED_FILE = 'default-article.pdf';
const DUMMY_PDF = path.join(__dirname, '..', 'fixtures', 'files', 'dummy.pdf');
const NO_ACCESS_OP_SENTENCE =
	'The current role does not have access to this operation.';
const DECISION_RETURN_TO_DONE = 35; // PKP\decision\Decision::RETURN_TO_DONE

// Seeded users this spec touches: display names + mailinator addresses.
const USER = {
	diana: {name: 'Diana Editor', email: 'editor.diana@mailinator.com'},
	ana: {name: 'Ana SectionEditor', email: 'sectioneditor.ana@mailinator.com'},
	omar: {name: 'Omar SectionEditor', email: 'sectioneditor.omar@mailinator.com'},
	julia: {name: 'Julia Reviewer', email: 'reviewer.julia@mailinator.com'},
	alex: {name: 'Alex Author', email: 'author.alex@mailinator.com'},
	rita: {name: 'Rita Assistant', email: 'assistant.rita@mailinator.com'},
};

/** A unique, hyphenless, alphanumeric tag (parallel isolation + mail scoping). */
function uniqueTag(prefix = 'edd') {
	const workerLetter = String.fromCharCode(
		97 + (test.info().parallelIndex % 26),
	);
	let suffix = '';
	while (suffix.length < 6) {
		suffix += Math.random().toString(36).replace(/[^a-z0-9]/g, '');
	}
	return `${prefix}${workerLetter}${suffix.slice(0, 6)}`;
}

/**
 * Scenario spec for a SUBMITTED submission (single unpublished AO
 * publication carrying the tag in its title — untitled seeds break the
 * completion-dialog and email copy).
 */
function submittedSpec({
	tag,
	title,
	journal = JOURNAL,
	submitter = 'author.alex',
	participants,
	decisions,
	reviewRounds,
	publications,
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
		publications: publications ?? [
			{
				versionStage: 'AO',
				published: false,
				metadata: {
					title: {en: title},
					abstract: {en: `<p>Editorial decisions fixture ${tag}.</p>`},
				},
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

/** Read the logged-in page's CSRF token (exposed on any backend page). */
async function readCsrf(page) {
	await page.waitForFunction(() => !!window.pkp?.currentUser?.csrfToken, null, {
		timeout: 15_000,
	});
	return page.evaluate(() => window.pkp.currentUser.csrfToken);
}

/** A decision button in the workflow shell's action rail. */
function railButton(shell, name) {
	return shell.actionItems().getByRole('button', {name, exact: true});
}

/** Click a rail decision button and wait for the decision/record page. */
async function openDecision(page, shell, name) {
	await railButton(shell, name).click();
	await page.waitForURL(/\/decision\/record\//, {
		timeout: 20_000,
		waitUntil: 'commit',
	});
}

/**
 * Publish the CURRENT publication from the workflow panel's Publication
 * tab (Title & Abstract) into a named issue — the UI path (scenario-
 * seeded publishes skip the moved-to-Done activity-log entry). Inlined
 * rather than importing the OJS-only EditorialWorkflowPage POM: this
 * shared spec may not depend on app-root pages.
 */
async function publishViaUI(page, shell, {issueLabel}) {
	await shell.nav().getByText('Title & Abstract', {exact: true}).first().click();
	const panelHeading = shell
		.modal()
		.getByRole('heading', {name: 'Title & Abstract'})
		.first();
	await expect(panelHeading).toBeVisible({timeout: 20_000});

	const modal = shell.modal();
	const schedule = modal.getByRole('button', {
		name: 'Schedule For Publication',
		exact: true,
	});
	const publish = modal.getByRole('button', {name: 'Publish', exact: true});
	await schedule.or(publish).first().waitFor({state: 'visible', timeout: 15_000});
	if (await schedule.isVisible().catch(() => false)) {
		await schedule.click();
	} else {
		await publish.click();
	}

	const details = page.getByRole('dialog', {name: /Review Publishing Details/i});
	await expect(details).toBeVisible({timeout: 15_000});
	await details.getByText(/Assign To Current\/Back Issue/i).click();
	const issueSelect = details.locator('select[name=issueId]');
	await expect(issueSelect).toBeVisible({timeout: 10_000});
	await issueSelect.selectOption({label: issueLabel});
	await details.locator('select[name=versionStage]').selectOption('VoR');
	// A first Version of Record must be a major version — the minor
	// option is disabled until a published version exists.
	await details.locator('select[name=versionIsMinor]').selectOption('false');
	await details.getByRole('button', {name: 'Confirm', exact: true}).click();

	const publishModal = page.locator('.pkpWorkflow__publishModal');
	await expect(publishModal).toBeVisible({timeout: 15_000});
	await publishModal.getByRole('button', {name: 'Publish', exact: true}).click();
	await expect(publishModal).toBeHidden({timeout: 20_000});
}

/** Unpublish the current publication from the Title & Abstract panel. */
async function unpublishViaUI(page, shell) {
	await shell.nav().getByText('Title & Abstract', {exact: true}).first().click();
	const unpublishButton = shell
		.modal()
		.getByRole('button', {name: 'Unpublish', exact: true});
	await expect(unpublishButton).toBeVisible({timeout: 20_000});
	await unpublishButton.click();
	const dialog = page.locator('[data-cy="dialog"]');
	await expect(dialog).toBeVisible({timeout: 10_000});
	await dialog.getByRole('button', {name: 'Unpublish', exact: true}).click();
	await expect(dialog).toBeHidden({timeout: 15_000});
}

/** Open a user's Tasks bell from their dashboard and return the modal. */
async function openTasksBell(userPage, {journalPath = JOURNAL, op = 'mySubmissions'} = {}) {
	await userPage.goto(`/index.php/${journalPath}/en/dashboard/${op}`, {
		waitUntil: 'commit',
	});
	const bell = new TasksGridModal(userPage);
	await expect(bell.bellButton).toBeVisible({timeout: 20_000});
	await bell.open();
	return bell;
}

test.describe('Editorial decisions', () => {
	test('s1: Send for Review — two-step wizard, pre-checked file carried to Files for Review, completion dialog, author email', async ({
		page,
		pkpApi,
		pkpMail,
	}) => {
		const tag = uniqueTag('edda');
		const title = `Send for review ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				participants: [{user: 'sectioneditor.ana', role: 'sectionEditor'}],
			}),
		);

		const shell = new WorkflowShellPage(page);
		await shell.gotoEditorial(submission.id);
		await expect(shell.contentHeading('Workflow: Submission')).toBeVisible({
			timeout: 20_000,
		});

		await openDecision(page, shell, 'Send for Review');

		// The wizard: "Notify Authors" then "Select Files" (rule 2).
		const wizard = new DecisionWizardPage(page);
		await expect(wizard.heading()).toContainText('Send for Review');
		await expect(wizard.stepItem('Notify Authors')).toBeVisible({
			timeout: 20_000,
		});
		await expect(wizard.stepItem('Select Files')).toBeVisible();

		// Keep the prefilled email; weave the tag into the subject so the
		// delivered mail is Mailpit-scopable.
		await wizard.setEmailSubject('notifyAuthors', `Sent for review ${tag}`);
		await wizard.continueStep();

		// The submission file is offered pre-checked (Fields: promotion
		// list pre-checked by default) — this is the "tick".
		await expect(wizard.promoteFileRow(SEEDED_FILE)).toBeVisible({
			timeout: 20_000,
		});
		await expect(wizard.promoteFileCheckbox(SEEDED_FILE)).toBeChecked();

		// Record: completion dialog headed "Sent for Review" with a single
		// View Submission Summary button (rule 3).
		const dialog = await wizard.record('Sent for Review');
		await expect(
			dialog.getByRole('link', {name: 'View Submission Summary', exact: true}),
		).toBeVisible();
		await wizard.viewSummary(submission.id);

		// Back on the workflow: Review stage, Round 1, with the carried
		// file in the round's Files for Review panel.
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});
		await expect(
			page.getByRole('table', {name: 'Files for Review', exact: true}),
		).toContainText(SEEDED_FILE, {timeout: 20_000});

		// The author received the notification email.
		await pkpMail.find({
			to: USER.alex.email,
			contains: tag,
			subject: `Sent for review ${tag}`,
			timeoutMs: 30_000,
		});
	});

	test('s2: Accept and Skip Review with a fee — payment step first and pre-selected, Copyediting landing, acceptance + payment-request emails, author payment task', async ({
		asUser,
		pkpApi,
		pkpMail,
	}) => {
		test.slow(); // scratch journal + payments config + two actors
		const tag = uniqueTag('eddb');
		const mgr = `mg${tag}`;
		const au = `au${tag}`;
		const {context} = await pkpApi.createJournal({
			tag,
			users: [
				throwawayUser(mgr, 'Mona', 'Manager', ['manager']),
				throwawayUser(au, 'Abe', 'Author', ['author']),
			],
		});
		const journalPath = context.path;

		// Configure payments through the live payments-settings endpoint
		// (the same PUT the Distribution → Payments form makes): enabled,
		// currency, the ManualPayment method WITH its instructions —
		// DB-seeded paymethod settings are invisible to the plugin-settings
		// file cache — plus the publication fee.
		const mgrCtx = await asUser(mgr);
		const mgrPage = await mgrCtx.newPage();
		await mgrPage.goto(`/index.php/${journalPath}/en/dashboard/editorial`, {
			waitUntil: 'commit',
		});
		const csrf = await readCsrf(mgrPage);
		const res = await mgrPage.request.put(
			`/index.php/${journalPath}/api/v1/_payments`,
			{
				headers: {'X-Csrf-Token': csrf},
				data: {
					paymentsEnabled: 'true',
					currency: 'CAD',
					paymentPluginName: 'ManualPayment',
					manualInstructions: `Wire the fee to the JPK office (${tag}).`,
					publicationFee: 150,
				},
			},
		);
		if (!res.ok()) {
			throw new Error(`payments setup failed: ${res.status()} ${await res.text()}`);
		}

		const title = `Fee accept ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({tag, title, journal: journalPath, submitter: au}),
		);

		// The unassigned manager records Accept and Skip Review.
		const shell = new WorkflowShellPage(mgrPage, {journalPath});
		await shell.gotoEditorial(submission.id);
		await expect(shell.contentHeading('Workflow: Submission')).toBeVisible({
			timeout: 20_000,
		});
		await openDecision(mgrPage, shell, 'Accept and Skip Review');

		// The wizard opens on the Request Payment step (placed first) with
		// "Request publication fee" pre-selected against "Waive".
		const wizard = new DecisionWizardPage(mgrPage);
		await expect(wizard.stepItem('Request Payment')).toBeVisible({
			timeout: 20_000,
		});
		await expect(wizard.heading()).toContainText('Request Payment');
		const requestRadio = mgrPage.getByRole('radio', {
			name: /Request publication fee/,
		});
		await expect(requestRadio).toBeChecked();
		await expect(mgrPage.getByRole('radio', {name: 'Waive'})).toBeVisible();

		// Keep the request, notify the author, carry the file, record.
		await wizard.continueStep();
		await wizard.setEmailSubject('notifyAuthors', `Accepted ${tag}`);
		await wizard.continueStep();
		await expect(wizard.promoteFileRow(SEEDED_FILE)).toBeVisible({
			timeout: 20_000,
		});
		await wizard.record('Skipped Review');
		await wizard.viewSummary(submission.id);
		await expect(shell.contentHeading('Workflow: Copyediting')).toBeVisible({
			timeout: 20_000,
		});

		// The author got the acceptance email AND a separate
		// payment-request email (its body interpolates the tagged title).
		const auEmail = `${au}@mailinator.com`;
		await pkpMail.find({
			to: auEmail,
			contains: tag,
			subject: `Accepted ${tag}`,
			timeoutMs: 30_000,
		});
		await pkpMail.find({
			to: auEmail,
			contains: tag,
			subject: 'Payment Request Notification',
			timeoutMs: 30_000,
		});

		// ...and a payment task in their Tasks bell.
		const auCtx = await asUser(au);
		const auPage = await auCtx.newPage();
		const bell = await openTasksBell(auPage, {journalPath});
		await expect(
			bell.task('The publication fee is due for payment.').first(),
		).toBeVisible({timeout: 20_000});
	});

	test('s3: desk decline collapses the rail (manager additionally sees Delete) and lists the submission under Declined; Revert Decline restores it', async ({
		page,
		asUser,
		pkpApi,
	}) => {
		test.slow(); // two actors, two wizards, a dashboard-view visit
		const tag = uniqueTag('eddc');
		const title = `Desk decline ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				participants: [{user: 'sectioneditor.ana', role: 'sectionEditor'}],
			}),
		);

		const shell = new WorkflowShellPage(page);
		await shell.gotoEditorial(submission.id);
		await expect(shell.contentHeading('Workflow: Submission')).toBeVisible({
			timeout: 20_000,
		});
		await openDecision(page, shell, 'Decline Submission');

		const wizard = new DecisionWizardPage(page);
		await wizard.setEmailSubject('notifyAuthors', `Declined ${tag}`);
		await wizard.record('Submission Declined');
		await wizard.viewSummary(submission.id);

		// The declined rail: Revert Decline is the only decision left; the
		// Schedule For Publication navigation shortcut persists (as-built,
		// Known deviations); no Delete for a section editor.
		await expect(railButton(shell, 'Revert Decline')).toBeVisible({
			timeout: 20_000,
		});
		await expect(railButton(shell, 'Schedule For Publication')).toBeVisible();
		await expect(railButton(shell, 'Send for Review')).toHaveCount(0);
		await expect(railButton(shell, 'Accept and Skip Review')).toHaveCount(0);
		await expect(railButton(shell, 'Decline Submission')).toHaveCount(0);
		await expect(railButton(shell, 'Delete')).toHaveCount(0);

		// A Journal Manager additionally sees Delete beside Revert Decline.
		const mayaCtx = await asUser('manager.maya');
		const mayaPage = await mayaCtx.newPage();
		const mayaShell = new WorkflowShellPage(mayaPage);
		await mayaShell.gotoEditorial(submission.id);
		await expect(railButton(mayaShell, 'Revert Decline')).toBeVisible({
			timeout: 20_000,
		});
		await expect(railButton(mayaShell, 'Delete')).toBeVisible();

		// The dashboard's Declined view lists it (the view is offered to
		// managers/admins/authors — not to section editors).
		const mayaDash = new DashboardPage(mayaPage);
		await mayaDash.gotoEditorial({view: 'declined'});
		await expect(mayaDash.viewHeading(/Declined/)).toBeVisible({
			timeout: 20_000,
		});
		await mayaDash.search(tag);
		await expect(mayaDash.row(tag)).toBeVisible({timeout: 20_000});

		// Revert Decline restores the active submission with the original
		// decision buttons back.
		await shell.gotoEditorial(submission.id);
		await expect(railButton(shell, 'Revert Decline')).toBeVisible({
			timeout: 20_000,
		});
		await openDecision(page, shell, 'Revert Decline');
		await wizard.recordThrough('Submission Reactivated');
		await wizard.viewSummary(submission.id);

		await expect(railButton(shell, 'Send for Review')).toBeVisible({
			timeout: 20_000,
		});
		await expect(railButton(shell, 'Accept and Skip Review')).toBeVisible();
		await expect(railButton(shell, 'Decline Submission')).toBeVisible();
		await expect(railButton(shell, 'Revert Decline')).toHaveCount(0);
	});

	test('s4: Request Revisions via the chooser — reviewer file attached to the author email, round stays open on revisions requested, author task', async ({
		page,
		asUser,
		pkpApi,
		pkpMail,
	}) => {
		test.slow(); // reviewer wizard + editor wizard + mail + task bell
		const tag = uniqueTag('eddd');
		const title = `Request revisions ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				participants: [{user: 'sectioneditor.ana', role: 'sectionEditor'}],
				decisions: [{type: 'sendExternalReview', by: 'sectioneditor.ana'}],
				reviewRounds: [
					{
						reviewers: [
							{user: 'reviewer.julia', method: 'open', status: 'accepted'},
						],
					},
				],
			}),
		);

		// The reviewer completes their review THROUGH the wizard, uploading
		// a file — the reviewer-uploaded attachment the editor will share.
		const revCtx = await asUser('reviewer.julia');
		const revPage = await revCtx.newPage();
		const review = new ReviewerSubmissionPage(revPage);
		await review.goto(submission.id);
		await review.continueToStep3();
		await review.fillStep3Comments({
			toAuthor: `<p>Reviewer comments ${tag}</p>`,
		});
		await review.uploadAttachment(DUMMY_PDF, 'dummy.pdf');
		await review.selectRecommendation('Revisions Required');
		await review.submitReview();
		await revPage.close();

		// The editor: Request Revisions opens the chooser first.
		const shell = new WorkflowShellPage(page);
		await shell.gotoEditorial(submission.id);
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});
		await railButton(shell, 'Request Revisions').click();

		const chooser = page.getByRole('dialog', {name: 'Request Revisions'});
		await expect(chooser).toBeVisible({timeout: 15_000});
		await expect(chooser.getByText('Require New Review Round')).toBeVisible();
		const noNewRound = chooser.getByRole('radio', {
			name: 'Revisions will not be subject to a new round of peer reviews.',
		});
		await expect(noNewRound).toBeChecked(); // the default
		await expect(
			chooser.getByRole('radio', {
				name: 'Revisions will be subject to a new round of peer reviews.',
			}),
		).toBeVisible();
		await Promise.all([
			page.waitForURL(/\/decision\/record\//, {
				timeout: 20_000,
				waitUntil: 'commit',
			}),
			chooser.getByRole('button', {name: 'Next', exact: true}).click(),
		]);

		// The wizard: attach the reviewer's uploaded file to the author
		// email; skip the reviewer email; record.
		const wizard = new DecisionWizardPage(page);
		await expect(wizard.stepItem('Notify Authors')).toBeVisible({
			timeout: 20_000,
		});
		await wizard.setEmailSubject('notifyAuthors', `Revisions requested ${tag}`);
		await wizard.attachReviewFile('dummy.pdf');
		await wizard.continueStep();
		await wizard.skipCurrentEmail();
		await wizard.record('Revisions Requested');
		await wizard.viewSummary(submission.id);

		// The round remains open, showing the revisions-requested status.
		const round = new ReviewRoundPanel(page);
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});
		await round.expectRoundStatus(1, 'Revisions have been requested.');

		// The author's copy of the email carries the attachment.
		const [mail] = await pkpMail.find({
			to: USER.alex.email,
			contains: tag,
			subject: `Revisions requested ${tag}`,
			timeoutMs: 30_000,
		});
		const full = await pkpMail.fullMessage(mail.ID);
		const attachmentNames = (full.Attachments ?? []).map((a) => a.FileName);
		expect(attachmentNames).toContain('dummy.pdf');

		// The revise request lands with the author's tasks.
		const authorCtx = await asUser('author.alex');
		const authorPage = await authorCtx.newPage();
		const bell = await openTasksBell(authorPage);
		await expect(bell.task(tag).first()).toBeVisible({timeout: 20_000});
	});

	test('s5: Accept below the review minimum — warning prompt, real-name reviewer chip, Copyediting + Draft File, thank-you email and Reviewer Thanked row', async ({
		asUser,
		pkpApi,
		pkpMail,
	}) => {
		test.slow(); // scratch journal + review-setup mutation + three-step wizard
		const tag = uniqueTag('edde');
		const ed = `ed${tag}`;
		const rev = `rv${tag}`;
		const au = `au${tag}`;
		// 'editor' on scratch journals resolves to the Journal editor group
		// (a MANAGER-role group), giving the actor decision + settings
		// authority in one throwaway account.
		const {context} = await pkpApi.createJournal({
			tag,
			users: [
				throwawayUser(ed, 'Edna', 'Editor', ['editor']),
				throwawayUser(rev, 'Riva', 'Reviewer', ['reviewer']),
				throwawayUser(au, 'Ada', 'Author', ['author']),
			],
		});
		const journalPath = context.path;

		const title = `Minimum reviews ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				journal: journalPath,
				submitter: au,
				decisions: [{type: 'sendExternalReview', by: ed}],
				reviewRounds: [
					{
						reviewers: [
							{
								user: rev,
								method: 'anonymous',
								status: 'completed',
								recommendation: 'accept',
							},
						],
					},
				],
			}),
		);

		// Require more confirmed reviews than the one that exists.
		const edCtx = await asUser(ed);
		const edPage = await edCtx.newPage();
		await edPage.goto(`/index.php/${journalPath}/en/dashboard/editorial`, {
			waitUntil: 'commit',
		});
		const csrf = await readCsrf(edPage);
		const res = await edPage.request.put(
			`/index.php/${journalPath}/api/v1/contexts/${context.id}`,
			{
				headers: {'X-Csrf-Token': csrf},
				data: {numReviewsPerSubmission: 2},
			},
		);
		if (!res.ok()) {
			throw new Error(
				`review-setup mutation failed: ${res.status()} ${await res.text()}`,
			);
		}

		// Accept first raises the minimum-reviews prompt (rule 14).
		const shell = new WorkflowShellPage(edPage, {journalPath});
		await shell.gotoEditorial(submission.id);
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});
		await railButton(shell, 'Accept Submission').click();

		const warning = edPage.locator('[data-cy="dialog"]').filter({
			hasText: 'Proceed Without Minimum Confirmed Reviews?',
		});
		await expect(warning).toBeVisible({timeout: 15_000});
		await expect(
			warning.getByRole('button', {name: 'Cancel', exact: true}),
		).toBeVisible();
		await Promise.all([
			edPage.waitForURL(/\/decision\/record\//, {
				timeout: 20_000,
				waitUntil: 'commit',
			}),
			warning.getByRole('button', {name: 'Yes, Continue', exact: true}).click(),
		]);

		// Three steps: Notify Authors, Notify Reviewers, Select Files.
		const wizard = new DecisionWizardPage(edPage);
		await expect(wizard.stepItem('Notify Authors')).toBeVisible({
			timeout: 20_000,
		});
		await expect(wizard.stepItem('Notify Reviewers')).toBeVisible();
		await expect(wizard.stepItem('Select Files')).toBeVisible();

		await wizard.setEmailSubject('notifyAuthors', `Accepted ${tag}`);
		await wizard.continueStep();

		// The completed reviewer is offered by REAL name despite the
		// anonymous review method (ledger row 214, as-built).
		await expect(wizard.recipients()).toContainText('Riva Reviewer', {
			timeout: 20_000,
		});
		await wizard.setEmailSubject('notifyReviewers', `Review thanks ${tag}`);
		await wizard.continueStep();

		// The Select Files step (Accept promotes the round's revision
		// files; this round has none, so its list is offered empty).
		await expect(wizard.heading()).toContainText('Select Files', {
			timeout: 20_000,
		});
		await wizard.record('Submission Accepted');
		await wizard.viewSummary(submission.id);

		// The submission moves to Copyediting.
		await expect(shell.contentHeading('Workflow: Copyediting')).toBeVisible({
			timeout: 20_000,
		});

		// The reviewer got their own thank-you copy...
		await pkpMail.find({
			to: `${rev}@mailinator.com`,
			contains: tag,
			subject: `Review thanks ${tag}`,
			timeoutMs: 30_000,
		});

		// ...and their round-1 row now reads Reviewer Thanked.
		await shell.clickMenu('Review Round 1');
		const rm = new ReviewerManagerPage(edPage);
		await expect(rm.row('Riva Reviewer')).toContainText('Reviewer Thanked', {
			timeout: 20_000,
		});
	});

	test('s6: Create New Review Round after a resubmit cycle — Round 2 appears empty of reviewers with the revised file carried into its review files', async ({
		page,
		asUser,
		pkpApi,
		pkpMail,
	}) => {
		test.slow(); // author upload wizard + editor wizard
		const tag = uniqueTag('eddf');
		const title = `New round ${tag}`;
		const revisionName = `revised${tag}.pdf`;
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				participants: [{user: 'sectioneditor.ana', role: 'sectionEditor'}],
				decisions: [
					{type: 'sendExternalReview', by: 'sectioneditor.ana'},
					{type: 'resubmit', by: 'sectioneditor.ana'},
				],
				reviewRounds: [
					{
						reviewers: [
							{
								user: 'reviewer.julia',
								method: 'anonymous',
								status: 'completed',
								recommendation: 'resubmitHere',
							},
						],
					},
				],
			}),
		);

		// The author answers the resubmit request with a revised file.
		const authorCtx = await asUser('author.alex');
		const authorPage = await authorCtx.newPage();
		const authorRound = new ReviewRoundPanel(authorPage);
		await authorRound.gotoAuthor(submission.id);
		await authorRound.uploadRevision({
			filePath: DUMMY_PDF,
			displayName: revisionName,
		});
		await authorPage.close();

		// The editor creates the new round, keeping the author email and
		// carrying the revised file forward.
		const shell = new WorkflowShellPage(page);
		await shell.gotoEditorial(submission.id);
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});
		await openDecision(page, shell, 'Create New Review Round');

		const wizard = new DecisionWizardPage(page);
		await expect(wizard.stepItem('Notify Authors')).toBeVisible({
			timeout: 20_000,
		});
		await expect(wizard.stepItem('Select Files')).toBeVisible();
		await wizard.setEmailSubject('notifyAuthors', `New round ${tag}`);
		await wizard.continueStep();

		await expect(wizard.promoteFileRow(revisionName)).toBeVisible({
			timeout: 20_000,
		});
		await expect(wizard.promoteFileCheckbox(revisionName)).toBeChecked();
		await wizard.record('Review Round Created');
		await wizard.viewSummary(submission.id);

		// Round 2: in the menu, selected, waiting for reviewers, with the
		// carried file in its Files for Review.
		await expect(
			shell.contentHeading('Workflow: Review (Round 2)'),
		).toBeVisible({timeout: 20_000});
		await expect(shell.menuItem('Review Round 2')).toBeVisible();
		const round = new ReviewRoundPanel(page);
		await round.expectRoundStatus(2, 'Waiting for reviewers to be assigned.');
		await expect(
			page.getByRole('table', {name: 'Files for Review', exact: true}),
		).toContainText(revisionName, {timeout: 20_000});

		// The author was notified.
		await pkpMail.find({
			to: USER.alex.email,
			contains: tag,
			subject: `New round ${tag}`,
			timeoutMs: 30_000,
		});
	});

	test('s7: Cancel Review Round while uncommitted — the round vanishes and the submission falls back; the button is absent once a reviewer confirmed', async ({
		page,
		pkpApi,
	}) => {
		const tag = uniqueTag('eddg');
		// A: a fresh round with only an unconfirmed invitation.
		const {submission: subInvited} = await pkpApi.createSubmission(
			submittedSpec({
				tag: `${tag}i`,
				title: `Cancelable round ${tag}i`,
				participants: [{user: 'sectioneditor.ana', role: 'sectionEditor'}],
				decisions: [{type: 'sendExternalReview', by: 'sectioneditor.ana'}],
				reviewRounds: [
					{
						reviewers: [
							{user: 'reviewer.julia', method: 'anonymous', status: 'invited'},
						],
					},
				],
			}),
		);
		// B: a sibling where the reviewer has confirmed.
		const {submission: subAccepted} = await pkpApi.createSubmission(
			submittedSpec({
				tag: `${tag}c`,
				title: `Committed round ${tag}c`,
				participants: [{user: 'sectioneditor.ana', role: 'sectionEditor'}],
				decisions: [{type: 'sendExternalReview', by: 'sectioneditor.ana'}],
				reviewRounds: [
					{
						reviewers: [
							{user: 'reviewer.julia', method: 'anonymous', status: 'accepted'},
						],
					},
				],
			}),
		);

		// A: Cancel Review Round is offered and completes; the round is
		// erased and the submission falls back to the Submission stage.
		const shell = new WorkflowShellPage(page);
		await shell.gotoEditorial(subInvited.id);
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});
		await openDecision(page, shell, 'Cancel Review Round');

		const wizard = new DecisionWizardPage(page);
		await wizard.recordThrough('Cancelled the latest round of review.');
		await wizard.viewSummary(subInvited.id);

		await expect(shell.contentHeading('Workflow: Submission')).toBeVisible({
			timeout: 20_000,
		});
		await expect(shell.menuItem('Review Round 1')).toHaveCount(0);

		// B: with a confirmed reviewer, the button is gone (anchored on the
		// sibling rail having rendered its other decisions).
		await shell.gotoEditorial(subAccepted.id);
		await expect(railButton(shell, 'Accept Submission')).toBeVisible({
			timeout: 20_000,
		});
		await expect(railButton(shell, 'Cancel Review Round')).toHaveCount(0);
	});

	test('s8: a recommend-only editor records a recommendation — unskippable Notify Editors, listing + discussion for the deciding editor, bare Send for Review on stage 1', async ({
		page,
		asUser,
		pkpApi,
		pkpMail,
	}) => {
		test.slow(); // two submissions, two actors, wizard + discussion checks
		const tag = uniqueTag('eddh');
		const reviewTitle = `Recommend accept ${tag}r`;
		const stageOneTitle = `Recommend stage one ${tag}s`;
		// The review-stage submission: diana decides, omar is assigned
		// recommend-only (the flag updates his auto-assignment).
		const {submission: subReview} = await pkpApi.createSubmission(
			submittedSpec({
				tag: `${tag}r`,
				title: reviewTitle,
				participants: [
					{user: 'editor.diana', role: 'editor'},
					{user: 'sectioneditor.omar', role: 'sectionEditor', recommendOnly: true},
				],
				decisions: [{type: 'sendExternalReview', by: 'editor.diana'}],
				reviewRounds: [{reviewers: []}],
			}),
		);
		// A stage-1 sibling with the same recommend-only assignment.
		const {submission: subStageOne} = await pkpApi.createSubmission(
			submittedSpec({
				tag: `${tag}s`,
				title: stageOneTitle,
				participants: [
					{user: 'editor.diana', role: 'editor'},
					{user: 'sectioneditor.omar', role: 'sectionEditor', recommendOnly: true},
				],
			}),
		);

		// --- The recommend-only editor on the review stage. ---
		const omarCtx = await asUser('sectioneditor.omar');
		const omarPage = await omarCtx.newPage();
		const omarShell = new WorkflowShellPage(omarPage);
		await omarShell.gotoEditorial(subReview.id);

		// Three recommendation buttons instead of decisions.
		await expect(railButton(omarShell, 'Recommend Accept')).toBeVisible({
			timeout: 20_000,
		});
		await expect(railButton(omarShell, 'Recommend Revisions')).toBeVisible();
		await expect(railButton(omarShell, 'Recommend Decline')).toBeVisible();
		await expect(railButton(omarShell, 'Accept Submission')).toHaveCount(0);

		// Recommend Accept: a one-step wizard whose Notify Editors email
		// offers no skip option (rule 9).
		await railButton(omarShell, 'Recommend Accept').click();
		await omarPage.waitForURL(/\/decision\/record\//, {
			timeout: 20_000,
			waitUntil: 'commit',
		});
		const wizard = new DecisionWizardPage(omarPage);
		await expect(wizard.heading()).toContainText('Recommend Accept');
		await wizard.setEmailSubject('discussion', `Recommendation ${tag}`);
		await expect(wizard.recordButton).toBeVisible();
		await expect(wizard.skipLink).toHaveCount(0);
		await wizard.record('Recommendation Submitted');
		await wizard.viewSummary(subReview.id);

		// --- The deciding editor finds the recommendation + discussion. ---
		const dianaCtx = await asUser('editor.diana');
		const dianaPage = await dianaCtx.newPage();
		const dianaShell = new WorkflowShellPage(dianaPage);
		await dianaShell.gotoEditorial(subReview.id);
		await expect(
			dianaShell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});
		// The recommendation listing in the side column.
		await expect(
			dianaShell.secondaryItems().getByText('Accept Submission'),
		).toBeVisible({timeout: 20_000});
		// The same message waits as a discussion (titled by the subject).
		const dm = new DiscussionManagerPage(dianaPage);
		await dm.expectVisible();
		await dm.expectInGroup(`Recommendation ${tag}`, 'In progress');

		// ...and as the Notify Editors email.
		await pkpMail.find({
			to: USER.diana.email,
			contains: tag,
			subject: `Recommendation ${tag}`,
			timeoutMs: 30_000,
		});

		// --- Stage 1: the same editor gets a bare Send for Review. ---
		await omarShell.gotoEditorial(subStageOne.id);
		await expect(railButton(omarShell, 'Send for Review')).toBeVisible({
			timeout: 20_000,
		});
		await expect(railButton(omarShell, 'Accept and Skip Review')).toHaveCount(0);
		await expect(railButton(omarShell, 'Decline Submission')).toHaveCount(0);
		await expect(railButton(omarShell, 'Recommend Accept')).toHaveCount(0);
	});

	test('s9: copyediting handoffs — Send To Production; the mislabeled back-move lands a never-reviewed submission on Submission, the reviewed sibling on Review', async ({
		page,
		pkpApi,
	}) => {
		test.slow(); // three seeded submissions, three wizards
		const tag = uniqueTag('eddi');
		const seedCopyediting = (suffix, decisions, reviewRounds) =>
			pkpApi.createSubmission(
				submittedSpec({
					tag: `${tag}${suffix}`,
					title: `Handoff ${tag}${suffix}`,
					participants: [{user: 'sectioneditor.ana', role: 'sectionEditor'}],
					decisions,
					...(reviewRounds ? {reviewRounds} : {}),
				}),
			);
		// A: accepted straight from the Submission stage — no round.
		const {submission: subNoRound} = await seedCopyediting('a', [
			{type: 'skipExternalReview', by: 'editor.diana'},
		]);
		// B: went through review, then accepted.
		const {submission: subWithRound} = await seedCopyediting(
			'b',
			[
				{type: 'sendExternalReview', by: 'editor.diana'},
				{type: 'accept', by: 'editor.diana'},
			],
			[{reviewers: []}],
		);
		// C: the forward handoff to Production.
		const {submission: subToProduction} = await seedCopyediting('c', [
			{type: 'skipExternalReview', by: 'editor.diana'},
		]);

		const shell = new WorkflowShellPage(page);
		const wizard = new DecisionWizardPage(page);

		// C: Send To Production moves the submission to Production.
		await shell.gotoEditorial(subToProduction.id);
		await expect(shell.contentHeading('Workflow: Copyediting')).toBeVisible({
			timeout: 20_000,
		});
		await openDecision(page, shell, 'Send To Production');
		await wizard.recordThrough('Sent to Production');
		await wizard.viewSummary(subToProduction.id);
		await expect(shell.contentHeading('Workflow: Production')).toBeVisible({
			timeout: 20_000,
		});

		// A: the back button still reads "Move to Review" and its wizard
		// speaks of review, but with no round the submission lands on the
		// Submission stage (as-built, ledger row 10).
		await shell.gotoEditorial(subNoRound.id);
		await expect(shell.contentHeading('Workflow: Copyediting')).toBeVisible({
			timeout: 20_000,
		});
		await openDecision(page, shell, 'Move to Review');
		await expect(wizard.heading()).toContainText('Move to Review');
		await wizard.recordThrough('Sent Back from Copyediting');
		await wizard.viewSummary(subNoRound.id);
		await expect(shell.contentHeading('Workflow: Submission')).toBeVisible({
			timeout: 20_000,
		});

		// B: the same button returns the reviewed sibling to Review.
		await shell.gotoEditorial(subWithRound.id);
		await expect(shell.contentHeading('Workflow: Copyediting')).toBeVisible({
			timeout: 20_000,
		});
		await openDecision(page, shell, 'Move to Review');
		await wizard.recordThrough('Sent Back from Copyediting');
		await wizard.viewSummary(subWithRound.id);
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});
	});

	test('s10: back from Production — a Journal Manager moves the submission to Copyediting and the decision lands in the activity log', async ({
		asUser,
		pkpApi,
	}) => {
		const tag = uniqueTag('eddj');
		const title = `Back from production ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				participants: [{user: 'editor.diana', role: 'editor'}],
				decisions: [
					{type: 'skipExternalReview', by: 'editor.diana'},
					{type: 'sendToProduction', by: 'editor.diana'},
				],
			}),
		);

		const mayaCtx = await asUser('manager.maya');
		const mayaPage = await mayaCtx.newPage();
		const shell = new WorkflowShellPage(mayaPage);
		await shell.gotoEditorial(submission.id);
		await expect(shell.contentHeading('Workflow: Production')).toBeVisible({
			timeout: 20_000,
		});
		await openDecision(mayaPage, shell, 'Move To Copyediting');

		const wizard = new DecisionWizardPage(mayaPage);
		await wizard.setEmailSubject('notifyAuthors', `Back to copyediting ${tag}`);
		await wizard.recordThrough('Moved to Copyediting');
		await wizard.viewSummary(submission.id);
		await expect(shell.contentHeading('Workflow: Copyediting')).toBeVisible({
			timeout: 20_000,
		});

		// The decision is in the activity log.
		const log = new ActivityLogModal(mayaPage);
		await log.openFromWorkflow();
		await log.openHistoryTab();
		await expect(
			log.historyRow(/moved this submission to the copyediting stage/).first(),
		).toBeVisible({timeout: 20_000});
		await log.close();
	});

	test('s11: decision authority boundary — assistant and author see no decisions, the recommend-only editor no Accept, the unassigned manager records Accept', async ({
		asUser,
		pkpApi,
	}) => {
		test.slow(); // four actors on one submission + a full wizard
		const tag = uniqueTag('eddk');
		const title = `Authority boundary ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				participants: [
					{user: 'editor.diana', role: 'editor'},
					{user: 'assistant.rita', role: 'funding'},
					{user: 'sectioneditor.omar', role: 'sectionEditor', recommendOnly: true},
				],
				decisions: [{type: 'sendExternalReview', by: 'editor.diana'}],
				reviewRounds: [{reviewers: []}],
			}),
		);

		// --- The assigned Assistant: workspace, no decision buttons. On
		// publicknowledge (reviewer suggestions enabled) the review-stage
		// open also pops the as-built role-access error dialog (spec Known
		// deviations, new findings) over the otherwise functional page.
		const ritaCtx = await asUser('assistant.rita');
		const ritaPage = await ritaCtx.newPage();
		const ritaShell = new WorkflowShellPage(ritaPage);
		await ritaShell.gotoEditorial(submission.id);
		const ritaError = ritaPage
			.locator('[data-cy="dialog"]')
			.filter({hasText: NO_ACCESS_OP_SENTENCE});
		await expect(ritaError).toBeVisible({timeout: 20_000});
		// Dismiss it — while open it holds the active-modal tag the shell
		// locators scope by.
		await ritaError.getByRole('button', {name: 'OK', exact: true}).click();
		await expect(ritaError).toBeHidden({timeout: 10_000});
		await expect(
			ritaShell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});
		// Anchor on the content pane before the rail-absence check.
		await expect(
			ritaShell.modal().getByRole('heading', {name: 'Round 1 Status'}),
		).toBeVisible({timeout: 20_000});
		await expect(ritaShell.actionItems()).toHaveCount(0);

		// --- The submission's Author: tracking view, no decisions.
		const alexCtx = await asUser('author.alex');
		const alexPage = await alexCtx.newPage();
		const alexShell = new WorkflowShellPage(alexPage);
		await alexShell.gotoTracking(submission.id);
		await expect(alexShell.header()).toContainText(title, {timeout: 20_000});
		await expect(
			alexPage.locator('[data-cy="discussion-manager"]'),
		).toBeVisible({timeout: 20_000});
		await expect(alexShell.actionItems()).toHaveCount(0);
		await expect(
			alexShell.modal().getByRole('button', {name: 'Accept Submission'}),
		).toHaveCount(0);

		// --- The recommend-only Section Editor is never offered Accept.
		const omarCtx = await asUser('sectioneditor.omar');
		const omarPage = await omarCtx.newPage();
		const omarShell = new WorkflowShellPage(omarPage);
		await omarShell.gotoEditorial(submission.id);
		await expect(railButton(omarShell, 'Recommend Accept')).toBeVisible({
			timeout: 20_000,
		});
		await expect(railButton(omarShell, 'Accept Submission')).toHaveCount(0);

		// --- The unassigned Journal Manager sees every decision and can
		// record one end-to-end.
		const mayaCtx = await asUser('manager.maya');
		const mayaPage = await mayaCtx.newPage();
		const mayaShell = new WorkflowShellPage(mayaPage);
		await mayaShell.gotoEditorial(submission.id);
		for (const name of [
			'Request Revisions',
			'Accept Submission',
			'Create New Review Round',
			'Cancel Review Round',
			'Decline Submission',
		]) {
			await expect(railButton(mayaShell, name)).toBeVisible({timeout: 20_000});
		}

		await openDecision(mayaPage, mayaShell, 'Accept Submission');
		const wizard = new DecisionWizardPage(mayaPage);
		await expect(wizard.stepItem('Notify Authors')).toBeVisible({
			timeout: 20_000,
		});
		// No completed reviews → no Notify Reviewers step (rule 2).
		await expect(wizard.stepItem('Notify Reviewers')).toHaveCount(0);
		await wizard.setEmailSubject('notifyAuthors', `Boundary accept ${tag}`);
		await wizard.continueStep();
		await wizard.record('Submission Accepted');
		await wizard.viewSummary(submission.id);
		await expect(mayaShell.contentHeading('Workflow: Copyediting')).toBeVisible({
			timeout: 20_000,
		});
	});

	test('s12: automatic Done bookkeeping — UI publish flips to Published + Return to Workflow with an unclicked log entry; unpublish returns to Production', async ({
		asUser,
		pkpApi,
	}) => {
		test.slow(); // scratch journal + full publish and unpublish flows
		const tag = uniqueTag('eddl');
		const mgr = `mg${tag}`;
		const se = `se${tag}`;
		const au = `au${tag}`;
		const {context} = await pkpApi.createJournal({
			tag,
			users: [
				throwawayUser(mgr, 'Mila', 'Manager', ['manager']),
				throwawayUser(se, 'Sena', 'Sectioneditor', ['sectionEditor']),
				throwawayUser(au, 'Aldo', 'Author', ['author']),
			],
			issues: [{volume: 1, number: 1, year: 2026, published: true}],
		});
		const journalPath = context.path;

		const title = `Done machine ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				journal: journalPath,
				submitter: au,
				participants: [{user: se, role: 'sectionEditor'}],
				decisions: [
					{type: 'skipExternalReview', by: mgr},
					{type: 'sendToProduction', by: mgr},
				],
			}),
		);

		const mgrCtx = await asUser(mgr);
		const mgrPage = await mgrCtx.newPage();
		const shell = new WorkflowShellPage(mgrPage, {journalPath});
		await shell.gotoEditorial(submission.id);
		await expect(shell.contentHeading('Workflow: Production')).toBeVisible({
			timeout: 20_000,
		});

		// Publish the first Version of Record through the UI.
		await publishViaUI(mgrPage, shell, {issueLabel: 'Vol. 1 No. 1 (2026)'});

		// The submission is in Done: Published badge + Return to Workflow.
		await shell.gotoEditorial(submission.id);
		await expect(shell.header()).toContainText(title, {timeout: 20_000});
		await expect(shell.header()).toContainText('Published');
		await expect(shell.headerButton('Return to Workflow')).toBeVisible({
			timeout: 20_000,
		});

		// The activity log carries the moved-to-Done entry nobody clicked.
		const log = new ActivityLogModal(mgrPage);
		await log.openFromWorkflow();
		await log.openHistoryTab();
		await expect(
			log.historyRow(/moved this submission to the Done stage/).first(),
		).toBeVisible({timeout: 20_000});
		await log.close();

		// Unpublishing the only published VoR returns it to Production.
		await unpublishViaUI(mgrPage, shell);
		await shell.gotoEditorial(submission.id);
		await expect(shell.contentHeading('Workflow: Production')).toBeVisible({
			timeout: 20_000,
		});
		await expect(shell.headerButton('Return to Workflow')).toHaveCount(0);

		const log2 = new ActivityLogModal(mgrPage);
		await log2.openFromWorkflow();
		await log2.openHistoryTab();
		await expect(
			log2.historyRow(/returned this submission to the workflow/).first(),
		).toBeVisible({timeout: 20_000});
		await log2.close();
	});

	test('s13: Return to Done — the assigned section editor is refused with nothing recorded (as-built); the unassigned manager succeeds', async ({
		asUser,
		pkpApi,
	}) => {
		test.slow(); // scratch journal + unpublish + two confirm attempts
		const tag = uniqueTag('eddm');
		const mgr = `mg${tag}`;
		const se = `se${tag}`;
		const au = `au${tag}`;
		const {context} = await pkpApi.createJournal({
			tag,
			users: [
				throwawayUser(mgr, 'Mira', 'Manager', ['manager']),
				throwawayUser(se, 'Sula', 'Sectioneditor', ['sectionEditor']),
				throwawayUser(au, 'Avi', 'Author', ['author']),
			],
			issues: [{volume: 1, number: 1, year: 2026, published: true}],
		});
		const journalPath = context.path;

		// Seed a published (Done) submission on the scratch journal's own
		// issue, then unpublish through the UI: the auto Return to Workflow
		// leaves it on Production WITH Done history.
		const title = `Return to done ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				journal: journalPath,
				submitter: au,
				participants: [{user: se, role: 'sectionEditor'}],
				decisions: [
					{type: 'skipExternalReview', by: mgr},
					{type: 'sendToProduction', by: mgr},
				],
				publications: [
					{
						versionStage: 'VoR',
						published: true,
						issue: 'latest',
						metadata: {
							title: {en: title},
							abstract: {en: `<p>Return-to-done fixture ${tag}.</p>`},
						},
					},
				],
			}),
		);

		const mgrCtx = await asUser(mgr);
		const mgrPage = await mgrCtx.newPage();
		const mgrShell = new WorkflowShellPage(mgrPage, {journalPath});
		await mgrShell.gotoEditorial(submission.id);
		await expect(mgrShell.headerButton('Return to Workflow')).toBeVisible({
			timeout: 20_000,
		});
		await unpublishViaUI(mgrPage, mgrShell);
		await mgrShell.gotoEditorial(submission.id);
		await expect(mgrShell.contentHeading('Workflow: Production')).toBeVisible({
			timeout: 20_000,
		});
		await expect(mgrShell.headerButton('Return to Done')).toBeVisible({
			timeout: 20_000,
		});

		// --- The ASSIGNED section editor is offered the same button, but
		// the confirm ends in the role-access error and records nothing
		// (as-built, ledger row 216).
		const seCtx = await asUser(se);
		const sePage = await seCtx.newPage();
		const seShell = new WorkflowShellPage(sePage, {journalPath});
		await seShell.gotoEditorial(submission.id);
		await expect(seShell.headerButton('Return to Done')).toBeVisible({
			timeout: 20_000,
		});
		await seShell.headerButton('Return to Done').click();
		const seDialog = sePage.locator('[data-cy="dialog"]').filter({
			hasText: 'Return this submission to the Done stage.',
		});
		await expect(seDialog).toBeVisible({timeout: 15_000});
		await seDialog.getByRole('button', {name: 'Confirm', exact: true}).click();
		await expect(sePage.getByText(NO_ACCESS_OP_SENTENCE)).toBeVisible({
			timeout: 20_000,
		});
		// Nothing recorded: no RETURN_TO_DONE decision row; the submission
		// still sits on an active stage offering the button.
		const decRes = await sePage.request.get(
			`/index.php/${journalPath}/api/v1/submissions/${submission.id}/decisions`,
		);
		if (!decRes.ok()) {
			throw new Error(`GET decisions failed: ${decRes.status()}`);
		}
		const decBody = await decRes.json();
		const decisions = decBody.items || decBody;
		expect(
			decisions.some((d) => d.decision === DECISION_RETURN_TO_DONE),
		).toBe(false);
		await seShell.gotoEditorial(submission.id);
		await expect(seShell.contentHeading('Workflow: Production')).toBeVisible({
			timeout: 20_000,
		});
		await expect(seShell.headerButton('Return to Done')).toBeVisible({
			timeout: 20_000,
		});

		// --- The UNASSIGNED manager confirms the same dialog and the
		// submission moves back to Done.
		await mgrShell.gotoEditorial(submission.id);
		await expect(mgrShell.headerButton('Return to Done')).toBeVisible({
			timeout: 20_000,
		});
		await mgrShell.headerButton('Return to Done').click();
		const mgrDialog = mgrPage.locator('[data-cy="dialog"]').filter({
			hasText: 'Return this submission to the Done stage.',
		});
		await expect(mgrDialog).toBeVisible({timeout: 15_000});
		await mgrDialog.getByRole('button', {name: 'Confirm', exact: true}).click();
		await expect(mgrDialog).toBeHidden({timeout: 20_000});
		await mgrShell.gotoEditorial(submission.id);
		await expect(mgrShell.headerButton('Return to Workflow')).toBeVisible({
			timeout: 20_000,
		});
		await expect(mgrShell.headerButton('Return to Done')).toHaveCount(0);
	});
});
