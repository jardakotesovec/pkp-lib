// @ts-check
const path = require('path');
const {test, expect} = require('../support/base-test.js');
const {EditorialWorkflowPage} = require('../../../../playwright/pages/EditorialWorkflowPage.js');
const {ReviewerManagerPage} = require('../pages/ReviewerManagerPage.js');
const {ReviewerSubmissionPage} = require('../pages/ReviewerSubmissionPage.js');
const {DashboardPage} = require('../pages/DashboardPage.js');
const {setTinyMceContent} = require('../support/tinymce.js');
const submissionInReview = require('../../../../playwright/fixtures/scenarios/submission-in-review.js');
const submissionInRound2 = require('../../../../playwright/fixtures/scenarios/submission-in-round-2.js');

/**
 * Review rounds & revisions — docs/e2e/plans/review-rounds-revisions.md
 * (12 rows).
 *
 * The feature under test is the multi-round review lifecycle on the
 * editorial workflow page: the revisions decisions (requestRevisions /
 * resubmit), the author-side revision upload (legacy plupload wizard —
 * the adjudicated UI-FALLBACK for seeding revision files), new-round
 * creation with file promotion, round cancellation, round tabs/history,
 * the per-round status indicators, and the author-response request
 * cycle.
 *
 * Absorbs (moved + refit here, originals deleted):
 *   - lib/pkp/playwright/tests/decision-request-revisions.spec.js → row 1
 *   - lib/pkp/playwright/tests/review-round.spec.js → row 5
 *
 * Seeding: every test creates its own submission via the submission
 * scenario; decision chains (`requestRevisions`, `resubmit`,
 * `newExternalRound`) seed the pre-state, and ONLY the behavior under
 * test drives the UI. Revision files cannot be seeded (Processor scope
 * decision) — rows 2 and 4 reach "author already uploaded revisions" by
 * driving the author's plupload wizard, the path row 1 proves.
 *
 * Round-status reality checks baked into the assertions:
 *   - `requestRevisions` → `newExternalRound` resets round 1's stored
 *     status to PENDING_REVIEWERS (DecisionType::runAdditionalActions
 *     side-effect) — round-1 "closed with revisions" is asserted off the
 *     decision history, never off review_rounds.status.
 *   - invited and accepted reviewers BOTH compute round status
 *     PENDING_REVIEWS ("Awaiting responses from reviewers." —
 *     ReviewRound::determineStatus maps AWAITING_RESPONSE and ACCEPTED
 *     to the same bucket); the per-reviewer row status is what tells
 *     them apart (row 7).
 *   - a scenario-seeded `completed` reviewer carries
 *     considered=CONSIDERED, so the round computes REVIEWS_COMPLETED,
 *     not REVIEWS_READY; REVIEWS_READY is reached by a real wizard
 *     submit (row 12).
 *
 * Emails are asserted via Mailpit scoped by recipient + the test's
 * unique tag (the scenario appends " [tag]" to the submission title and
 * every decision email body carries {$submissionTitle}); submitter is
 * `atester` wherever mail is asserted so the recipient is a baseline
 * author and not rvaca.
 */

/** Decision / status / file-stage constants (grep-verified). */
const C = {
	DECISION_PENDING_REVISIONS: 4, // Decision::PENDING_REVISIONS
	DECISION_RESUBMIT: 5, // Decision::RESUBMIT
	DECISION_NEW_EXTERNAL_ROUND: 14, // Decision::NEW_EXTERNAL_ROUND
	// Decision::CANCEL_REVIEW_ROUND (31) is deliberately absent: its
	// decision row is cascade-deleted with the cancelled round (row 8).
	ROUND_REVISIONS_REQUESTED: 1, // ReviewRound::REVIEW_ROUND_STATUS_REVISIONS_REQUESTED
	ROUND_RESUBMIT_FOR_REVIEW: 2, // ReviewRound::REVIEW_ROUND_STATUS_RESUBMIT_FOR_REVIEW
	ROUND_REVIEWS_READY: 8, // ReviewRound::REVIEW_ROUND_STATUS_REVIEWS_READY
	ROUND_REVIEWS_OVERDUE: 10, // ReviewRound::REVIEW_ROUND_STATUS_REVIEWS_OVERDUE
	ROUND_REVISIONS_SUBMITTED: 11, // ReviewRound::REVIEW_ROUND_STATUS_REVISIONS_SUBMITTED
	FILE_REVIEW_FILE: 4, // SubmissionFile::SUBMISSION_FILE_REVIEW_FILE
	FILE_REVIEW_REVISION: 15, // SubmissionFile::SUBMISSION_FILE_REVIEW_REVISION
};

/** Round status strings (lib/pkp/locale/en/submission.po). */
const STATUS_TEXT = {
	pendingReviews: 'Awaiting responses from reviewers.',
	reviewsReady: 'New reviews have been submitted.',
	reviewsCompleted: 'All reviews are confirmed and a decision is needed.',
	reviewOverdue: 'A review is overdue.',
	revisionsSubmitted: 'Revisions have been submitted and a decision is needed.',
};

const ATESTER_EMAIL = 'atester@mailinator.com';

function uniqueTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

/** yyyy-mm-dd, `days` from today (negative for the past). */
function isoDaysFromNow(days) {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/** The bundled PDF every revision upload uses. */
function revisionFixturePath() {
	return path.resolve(__dirname, '..', 'fixtures', 'files', 'default-article.pdf');
}

/** The author's workflow surface for a submission. */
function authorWorkflowUrl(submissionId) {
	return `/index.php/publicknowledge/en/dashboard/mySubmissions?workflowSubmissionId=${submissionId}`;
}

/** The workflow page's hosting side-modal. */
function workflowModal(page) {
	return page.locator('[data-cy="active-modal"]').first();
}

/**
 * Pick a review round in the workflow side nav ("Review Round N"
 * entries under the Review stage item). The active stage's children are
 * expanded by default; if the Review group is collapsed (e.g. when a
 * non-review stage is active), expand it first.
 */
async function selectReviewRound(page, roundNumber) {
	const nav = workflowModal(page).locator('nav');
	const roundItem = nav.getByText(`Review Round ${roundNumber}`, {exact: true});
	if (!(await roundItem.isVisible().catch(() => false))) {
		await nav.getByText('Review', {exact: true}).first().click();
	}
	await roundItem.click();
}

/**
 * Drive the author-side "Upload revisions" plupload wizard end-to-end:
 * FileUploadWizardHandler in a stacked modal titled "Upload Review
 * File"; three fbv steps (Upload File → Review Details → Confirm), each
 * advancing via the same `button#continueButton` (label flips to
 * "Complete" on the last step). The native file input is the opacity-0
 * plupload widget — drive it via setInputFiles; "Change File" appearing
 * is the upload-settled signal.
 *
 * Caller must already be on the author's workflow page with the round
 * in a revisions-requested/resubmit state (that's what surfaces the
 * button).
 */
async function uploadRevisionAsAuthor(authorPage) {
	const uploadButton = authorPage
		.getByRole('button', {name: 'Upload revisions', exact: true})
		.first();
	await expect(uploadButton).toBeVisible({timeout: 15_000});
	await uploadButton.click();

	const wizard = authorPage
		.getByRole('dialog', {name: 'Upload Review File'})
		.first();
	await expect(wizard).toBeVisible({timeout: 10_000});

	// Step 1 — genre + file.
	await wizard
		.locator('select[name=genreId]')
		.selectOption({label: 'Article Text'});
	await wizard.locator('input[type=file]').setInputFiles(revisionFixturePath());
	await expect(wizard.getByText('Change File')).toBeVisible({timeout: 15_000});
	await wizard.locator('button#continueButton').click();

	// Step 2 — metadata, name prefilled from the filename. The form
	// renders one "Name the file" label per form locale; anchor on the
	// primary-locale control to stay strict-mode-safe.
	await expect(wizard.locator('label[for$="-name-control-en"]')).toBeVisible({
		timeout: 10_000,
	});
	await wizard.locator('button#continueButton').click();

	// Step 3 — confirm; same button id, label now "Complete".
	await expect(wizard.getByText(/File Added/i)).toBeVisible({timeout: 10_000});
	await wizard.locator('button#continueButton').click();
	await expect(wizard).toBeHidden({timeout: 15_000});
}

test.use({user: 'dbarnes'});

test.describe('Review rounds & revisions', () => {
	// Row 1 — absorbed from decision-request-revisions.spec.js.
	test('editor requests revisions without a new round; author uploads revisions via the file wizard', {tag: '@smoke'}, async ({page, pkpApi, asUser}) => {
		const tag = uniqueTag('rrev1');
		// Default reviewer cast (invited + accepted, none completed) —
		// RequestRevisions only adds a notifyReviewers step when completed
		// reviewers exist, so the wizard is a single notifyAuthors step.
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({tag, submitter: 'atester'}),
		);

		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		// The Request Revisions entry point opens the revision-type radio
		// modal (WorkflowSelectRevisionFormModal) instead of navigating —
		// the no-new-round option is the pre-selected default.
		await page
			.getByRole('button', {name: 'Request Revisions', exact: true})
			.first()
			.click();
		const radioModal = page.getByRole('dialog', {name: 'Request Revisions'});
		await expect(radioModal).toBeVisible({timeout: 10_000});
		await expect(
			radioModal.getByLabel(
				'Revisions will not be subject to a new round of peer reviews.',
			),
		).toBeChecked();
		await Promise.all([
			page.waitForURL(/\/decision\/record\//, {timeout: 15_000}),
			radioModal.getByRole('button', {name: 'Next', exact: true}).click(),
		]);

		await workflow.recordDecision('have been requested');
		await workflow.viewSubmissionFromCompletionDialog(submission.id);

		// Decision row + round status flipped to REVISIONS_REQUESTED — the
		// gate that surfaces the author-side upload affordance.
		const decisions = await workflow.fetchDecisions(submission.id);
		expect(
			decisions.some((d) => d.decision === C.DECISION_PENDING_REVISIONS),
		).toBe(true);
		const sub = await workflow.fetchSubmission(submission.id);
		expect(sub.reviewRounds[0].statusId).toBe(C.ROUND_REVISIONS_REQUESTED);

		// Author side: the round panel offers Upload revisions; the wizard
		// upload lands as a REVIEW_REVISION file.
		const authorCtx = await asUser('atester');
		const authorPage = await authorCtx.newPage();
		await authorPage.goto(authorWorkflowUrl(submission.id));
		await uploadRevisionAsAuthor(authorPage);

		const filesRes = await authorPage.request.get(
			`/index.php/publicknowledge/api/v1/submissions/${submission.id}/files?fileStages[]=${C.FILE_REVIEW_REVISION}`,
		);
		expect(filesRes.ok(), `GET files: ${filesRes.status()}`).toBe(true);
		const filesBody = await filesRes.json();
		const fileItems = filesBody.items || filesBody;
		expect(fileItems.length).toBeGreaterThan(0);
		expect(
			fileItems.every((f) => f.fileStage === C.FILE_REVIEW_REVISION),
		).toBe(true);
	});

	// Row 2
	test('editor sees submitted revisions; round flips to revisions submitted', {tag: '@regression'}, async ({page, pkpApi, asUser}) => {
		const tag = uniqueTag('rrev2');
		// Seed the requestRevisions decision; the author upload itself is
		// the UI-FALLBACK piece (no Processor support for revision files).
		const {submission} = await pkpApi.createSubmission({
			...submissionInReview({tag, submitter: 'atester'}),
			decisions: [
				{type: 'sendExternalReview', by: 'dbarnes'},
				{type: 'requestRevisions', by: 'dbarnes'},
			],
		});

		const authorCtx = await asUser('atester');
		const authorPage = await authorCtx.newPage();
		await authorPage.goto(authorWorkflowUrl(submission.id));
		await uploadRevisionAsAuthor(authorPage);

		// Editor's Revisions file manager lists the author's file and the
		// round indicator flips to revisions-submitted.
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);
		const revisionsPanel = workflowModal(page).getByRole('table', {
			name: 'Revisions Uploaded',
		});
		await expect(revisionsPanel).toBeVisible({timeout: 20_000});
		await expect(revisionsPanel).toContainText('default-article', {
			timeout: 15_000,
		});
		await expect(
			workflowModal(page).getByText(STATUS_TEXT.revisionsSubmitted),
		).toBeVisible({timeout: 15_000});

		const sub = await workflow.fetchSubmission(submission.id);
		expect(sub.reviewRounds[0].statusId).toBe(C.ROUND_REVISIONS_SUBMITTED);

		// The editorial dashboard's revisions-submitted view picks it up
		// (stored round status is updated by the upload itself).
		const dashboard = new DashboardPage(page);
		await dashboard.gotoEditorial({view: 'revisions-submitted'});
		await expect(
			dashboard.viewHeading(/Author revisions submitted/),
		).toBeVisible({timeout: 15_000});
		await dashboard.search(tag);
		await expect(dashboard.row(tag)).toBeVisible({timeout: 15_000});
	});

	// Row 3
	test('resubmit-for-review decision notifies the author and gates the upload affordance', {tag: '@regression'}, async ({page, pkpApi, pkpMail, asUser}) => {
		const tag = uniqueTag('rrev3');
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({tag, submitter: 'atester'}),
		);

		// Pre-decision: the author's round panel shows review status but no
		// upload affordance (the status heading bounds the negative).
		const authorCtx = await asUser('atester');
		const authorPage = await authorCtx.newPage();
		await authorPage.goto(authorWorkflowUrl(submission.id));
		await expect(
			authorPage.getByRole('heading', {name: 'Round 1 Status'}),
		).toBeVisible({timeout: 20_000});
		await expect(
			authorPage.getByRole('button', {name: 'Upload revisions', exact: true}),
		).toHaveCount(0);

		// Editor: Request Revisions → "Resubmit for Review" radio (new
		// round of peer reviews) → record. No completed reviewers, so the
		// wizard is the single notifyAuthors step.
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);
		await workflow.clickRequestRevisions({newRound: true});
		await workflow.recordDecision('have been requested');
		await workflow.viewSubmissionFromCompletionDialog(submission.id);

		const decisions = await workflow.fetchDecisions(submission.id);
		expect(decisions.some((d) => d.decision === C.DECISION_RESUBMIT)).toBe(
			true,
		);
		const sub = await workflow.fetchSubmission(submission.id);
		expect(sub.reviewRounds[0].statusId).toBe(C.ROUND_RESUBMIT_FOR_REVIEW);

		// Notify-author email, scoped recipient + tag.
		const messages = await pkpMail.find({
			to: ATESTER_EMAIL,
			contains: tag,
			timeoutMs: 20_000,
		});
		expect(messages[0].Subject).toContain('please revise and resubmit');

		// Post-decision author panel: the resubmit request shows up in the
		// Notifications listing and the upload affordance is unlocked.
		await authorPage.goto(authorWorkflowUrl(submission.id));
		await expect(
			authorPage.getByText(/please revise and resubmit/).first(),
		).toBeVisible({timeout: 20_000});
		await expect(
			authorPage
				.getByRole('button', {name: 'Upload revisions', exact: true})
				.first(),
		).toBeVisible({timeout: 15_000});
	});

	// Row 4
	test('resubmit cycle: author revisions are promoted into the new review round', {tag: '@regression'}, async ({page, pkpApi, asUser}) => {
		const tag = uniqueTag('rrev4');
		const {submission} = await pkpApi.createSubmission({
			...submissionInReview({tag, submitter: 'atester'}),
			decisions: [
				{type: 'sendExternalReview', by: 'dbarnes'},
				{type: 'resubmit', by: 'dbarnes'},
			],
		});

		// Author uploads the revision onto round 1 (resubmit state).
		const authorCtx = await asUser('atester');
		const authorPage = await authorCtx.newPage();
		await authorPage.goto(authorWorkflowUrl(submission.id));
		await uploadRevisionAsAuthor(authorPage);

		// Editor opens the new round: notifyAuthors step → Promote Files
		// step ("Select Files") offering the author's revision under the
		// "Revisions" list.
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);
		await expect(
			page
				.getByRole('button', {name: 'Create New Review Round', exact: true})
				.first(),
		).toBeVisible({timeout: 15_000});
		await workflow.clickDecision('Create New Review Round');
		await workflow.clickContinue(); // notifyAuthors → promoteFiles

		// The promote-files list is checkbox-per-file
		// (input[name="promoteFile{id}"], see decision/record.tpl).
		await expect(page.getByText('default-article').first()).toBeVisible({
			timeout: 15_000,
		});
		const promoteCheckbox = page
			.locator('input[type="checkbox"][name^="promoteFile"]')
			.first();
		await promoteCheckbox.check();
		await workflow.recordDecision('A new round of review has been created');
		await workflow.viewSubmissionFromCompletionDialog(submission.id);

		// Round 2 exists and its review files include the promoted
		// revision (copied in as a REVIEW_FILE).
		const sub = await workflow.fetchSubmission(submission.id);
		const round2 = (sub.reviewRounds || []).find((r) => r.round === 2);
		expect(round2, 'round 2 should exist after newExternalRound').toBeTruthy();
		const filesRes = await page.request.get(
			`/index.php/publicknowledge/api/v1/submissions/${submission.id}/files?fileStages[]=${C.FILE_REVIEW_FILE}&reviewRoundIds[]=${round2.id}`,
		);
		expect(filesRes.ok(), `GET files: ${filesRes.status()}`).toBe(true);
		const filesBody = await filesRes.json();
		const fileItems = filesBody.items || filesBody;
		expect(fileItems.length).toBeGreaterThan(0);
		expect(
			fileItems.some((f) =>
				JSON.stringify(f.name || {}).includes('default-article'),
			),
		).toBe(true);
	});

	// Row 5 — absorbed from review-round.spec.js.
	test('editor closes round 1 with revisions and opens round 2 from the workflow UI', {tag: ['@regression', '@slow']}, async ({page, pkpApi}) => {
		// Two full decision wizards (3 email-template loads) + 4 workflow
		// page loads legitimately exceed the 60s cap under parallel load.
		test.slow();
		const tag = uniqueTag('rrev5');
		// Round 1 needs at least one *completed* reviewer for the
		// requestRevisions decision to mark "this round is done" and for
		// newExternalRound to surface as an available decision.
		const {submission, reviewRounds} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				reviewers: [
					{
						user: 'phudson',
						method: 'anonymous',
						status: 'completed',
						recommendation: 'pendingRevisions',
					},
				],
			}),
		);
		const round1Id = reviewRounds[0].roundId;

		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		// 1) Request Revisions on round 1. With one completed reviewer,
		// RequestRevisions::getSteps adds a notifyReviewers step on top of
		// notifyAuthors → two steps (Continue → Record Decision).
		await workflow.clickRequestRevisions(); // default: PENDING_REVISIONS
		await workflow.clickContinue(); // notifyAuthors → notifyReviewers
		await workflow.recordDecision('have been requested');
		await workflow.viewSubmissionFromCompletionDialog(submission.id);

		// 2) Round 1 closed with revisions requested — "Create New Review
		// Round" is available. NewExternalReviewRound has two steps:
		// notifyAuthors + PromoteFiles ("Select Files").
		await expect(
			page
				.getByRole('button', {name: 'Create New Review Round', exact: true})
				.first(),
		).toBeVisible({timeout: 15_000});
		await workflow.clickDecision('Create New Review Round');
		await workflow.clickContinue();
		await workflow.recordDecision('A new round of review has been created');
		await workflow.viewSubmissionFromCompletionDialog(submission.id);

		// Decision history records both decisions.
		const decisions = await workflow.fetchDecisions(submission.id);
		expect(
			decisions.some((d) => d.decision === C.DECISION_PENDING_REVISIONS),
			'requestRevisions decision row should exist',
		).toBe(true);
		expect(
			decisions.some((d) => d.decision === C.DECISION_NEW_EXTERNAL_ROUND),
			'newExternalRound decision row should exist',
		).toBe(true);

		// Two stage-3 rounds exist with distinct ids.
		const sub = await workflow.fetchSubmission(submission.id);
		const stage3Rounds = (sub.reviewRounds || []).filter(
			(r) => r.stageId === 3,
		);
		expect(stage3Rounds).toHaveLength(2);
		const round2 = stage3Rounds.find((r) => r.round === 2);
		expect(round2, 'round 2 should exist after newExternalRound').toBeTruthy();
		expect(round2.id).not.toBe(round1Id);
	});

	// Row 6
	test('round tabs preserve round-1 history', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('rrev6');
		const roundOneVerdict = `Round one verdict ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			submissionInRound2({
				tag,
				reviewRounds: [
					{
						reviewers: [
							{
								user: 'phudson',
								method: 'anonymous',
								status: 'completed',
								recommendation: 'pendingRevisions',
								comments: {toAuthor: roundOneVerdict},
							},
						],
					},
					{
						reviewers: [
							{user: 'jjanssen', method: 'anonymous', status: 'invited'},
						],
					},
				],
			}),
		);

		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id);

		// Both round entries render in the side nav; the current round (2)
		// is the landing view.
		const nav = workflowModal(page).locator('nav');
		await expect(nav.getByText('Review Round 1', {exact: true})).toBeVisible({
			timeout: 15_000,
		});
		await expect(nav.getByText('Review Round 2', {exact: true})).toBeVisible();
		await expect(
			page.getByRole('heading', {name: 'Round 2 Status'}),
		).toBeVisible({timeout: 15_000});
		await expect(rm.row('Julie Janssen')).toContainText('Request Sent', {
			timeout: 15_000,
		});

		// Round 1 keeps its completed review: phudson's row with the
		// recommendation, and the review remains readable.
		await selectReviewRound(page, 1);
		await expect(rm.row('Paul Hudson')).toContainText('Complete', {
			timeout: 15_000,
		});
		await expect(rm.row('Paul Hudson')).toContainText('Revisions Required');
		const detailsModal = await rm.openReviewDetails('Paul Hudson');
		await expect(detailsModal).toContainText(roundOneVerdict, {
			timeout: 15_000,
		});
	});

	// Row 7
	test('round status indicators track reviewer progress', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('rrev7');
		const seeds = [
			{
				reviewer: {user: 'phudson', method: 'anonymous', status: 'invited'},
				rowStatus: 'Request Sent',
				roundStatus: STATUS_TEXT.pendingReviews,
				reviewerName: 'Paul Hudson',
			},
			{
				reviewer: {user: 'jjanssen', method: 'anonymous', status: 'accepted'},
				// Accepted reviewers also compute PENDING_REVIEWS on the round
				// (determineStatus buckets AWAITING_RESPONSE + ACCEPTED
				// together); the row status is the distinguishing signal.
				rowStatus: 'Request Accepted',
				roundStatus: STATUS_TEXT.pendingReviews,
				reviewerName: 'Julie Janssen',
			},
			{
				reviewer: {
					user: 'phudson',
					method: 'anonymous',
					status: 'completed',
					recommendation: 'pendingRevisions',
				},
				// Seeded completed reviews carry considered=CONSIDERED →
				// REVIEWS_COMPLETED (reviews received, decision needed).
				rowStatus: 'Complete',
				roundStatus: STATUS_TEXT.reviewsCompleted,
				reviewerName: 'Paul Hudson',
			},
		];

		const rm = new ReviewerManagerPage(page);
		for (const seed of seeds) {
			const {submission} = await pkpApi.createSubmission(
				submissionInReview({tag, reviewers: [seed.reviewer]}),
			);
			await rm.gotoWorkflow(submission.id);
			await expect(
				page.getByRole('heading', {name: 'Round 1 Status'}),
			).toBeVisible({timeout: 15_000});
			await expect(
				workflowModal(page).getByText(seed.roundStatus),
			).toBeVisible({timeout: 15_000});
			await expect(rm.row(seed.reviewerName)).toContainText(seed.rowStatus, {
				timeout: 15_000,
			});
		}
	});

	// Row 8
	test('new round 2 starts empty; editor cancels the review round', {tag: '@regression'}, async ({page, pkpApi, pkpMail}) => {
		const tag = uniqueTag('rrev8');
		const {submission} = await pkpApi.createSubmission(
			submissionInRound2({
				tag,
				submitter: 'atester',
				reviewRounds: [
					{
						reviewers: [
							{
								user: 'phudson',
								method: 'anonymous',
								status: 'completed',
								recommendation: 'pendingRevisions',
							},
						],
					},
					{reviewers: []}, // round 2 starts empty
				],
			}),
		);

		// Round 2 (current) has an empty reviewer list — round-1 reviewers
		// are not carried over.
		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id);
		await expect(
			page.getByRole('heading', {name: 'Round 2 Status'}),
		).toBeVisible({timeout: 15_000});
		await expect(rm.manager).not.toContainText('Paul Hudson');

		// Cancel Review Round (offered because round 2 has no confirmed or
		// completed reviewers); the wizard is a single notifyAuthors step
		// since the round has no active review assignments.
		const workflow = new EditorialWorkflowPage(page);
		await workflow.clickDecision('Cancel Review Round');
		await workflow.recordDecision('has been cancelled');
		await workflow.viewSubmissionFromCompletionDialog(submission.id);

		// Notify-author email, scoped recipient + tag.
		const messages = await pkpMail.find({
			to: ATESTER_EMAIL,
			contains: tag,
			timeoutMs: 20_000,
		});
		expect(messages[0].Subject).toContain(
			'review round for your submission has been cancelled',
		);

		// Round 2 is deleted: round 1 is current again. NOTE: the cancel
		// decision row itself does NOT survive — edit_decisions carries a
		// review_round_id FK with ON DELETE CASCADE (ReviewsMigration), so
		// deleting round 2 cascade-deletes the just-recorded
		// CANCEL_REVIEW_ROUND row. The pre-cancel decision chain (recorded
		// against round 1) is what persists; see docs/e2e/app-changes.md §2.
		const sub = await workflow.fetchSubmission(submission.id);
		const stage3Rounds = (sub.reviewRounds || []).filter(
			(r) => r.stageId === 3,
		);
		expect(stage3Rounds).toHaveLength(1);
		expect(stage3Rounds[0].round).toBe(1);
		const decisions = await workflow.fetchDecisions(submission.id);
		expect(
			decisions.some((d) => d.decision === C.DECISION_PENDING_REVISIONS),
			'round-1 decision history should survive the cancellation',
		).toBe(true);
		expect(
			decisions.some((d) => d.decision === C.DECISION_NEW_EXTERNAL_ROUND),
			'newExternalRound decision row (recorded on round 1) should survive',
		).toBe(true);
		await expect(
			page.getByRole('heading', {name: 'Round 1 Status'}),
		).toBeVisible({timeout: 15_000});
		await expect(
			workflowModal(page)
				.locator('nav')
				.getByText('Review Round 2', {exact: true}),
		).toHaveCount(0);
	});

	// Row 9
	test('overdue review surfaces on the round and the editorial dashboard', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('rrev9');
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				reviewers: [
					{
						user: 'phudson',
						method: 'anonymous',
						status: 'accepted',
						reviewDueDate: `${isoDaysFromNow(-2)} 00:00:00`,
					},
				],
			}),
		);

		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id);
		await expect(rm.row('Paul Hudson')).toContainText('Overdue', {
			timeout: 20_000,
		});
		await expect(
			workflowModal(page).getByText(STATUS_TEXT.reviewOverdue),
		).toBeVisible({timeout: 15_000});
		const assignments = await rm.fetchReviewAssignments(submission.id);
		expect(assignments).toHaveLength(1);

		const sub = await new EditorialWorkflowPage(page).fetchSubmission(
			submission.id,
		);
		expect(sub.reviewRounds[0].statusId).toBe(C.ROUND_REVIEWS_OVERDUE);

		// The reviews-overdue dashboard view lists the submission.
		const dashboard = new DashboardPage(page);
		await dashboard.gotoEditorial({view: 'reviews-overdue'});
		await expect(dashboard.viewHeading(/Reviews overdue/)).toBeVisible({
			timeout: 15_000,
		});
		await dashboard.search(tag);
		await expect(dashboard.row(tag)).toBeVisible({timeout: 15_000});
	});

	// Row 10
	// FIXME(wave-4 handoff): editor half passes end-to-end (request email
	// delivered); the author half clicks "Submit Response" (button goes
	// [active] in the failure snapshot) but the "Submit Your Response to
	// Reviewer Feedback" side-modal never mounts — looks like a modal-mount
	// issue on the author dashboard, not a locator problem (wrapper-
	// visibility quirk already accounted for). Reproduce:
	// npx playwright test lib/pkp/playwright/tests/review-rounds-revisions.spec.js:710
	// Resume notes in plan row 10 + project memory.
	test.fixme('editor requests an author response to reviews; author responds', {tag: ['@regression', '@slow']}, async ({page, pkpApi, pkpMail, asUser}) => {
		// Full-page composer + author form modal + three workflow loads —
		// give it the slow budget under parallel load.
		test.slow();
		const tag = uniqueTag('rrev10');
		// All active review assignments must be completed for Request
		// Response to unlock (AuthorResponseRequestManagerStore gating).
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				submitter: 'atester',
				reviewers: [
					{
						user: 'phudson',
						method: 'anonymous',
						status: 'completed',
						recommendation: 'pendingRevisions',
						comments: {toAuthor: `Reviewer feedback ${tag}`},
					},
				],
			}),
		);

		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		// The Author Response manager flags the round as ready to invite.
		const responsePanel = workflowModal(page).getByRole('table', {
			name: 'Author Response',
		});
		await expect(responsePanel).toBeVisible({timeout: 20_000});
		await expect(responsePanel).toContainText('Ready to invite author');

		// "Request Response" navigates to the full-page composer
		// (reviewResponse/requestAuthorResponse).
		await Promise.all([
			page.waitForURL(/reviewResponse\/requestAuthorResponse/, {
				timeout: 15_000,
			}),
			workflowModal(page)
				.getByRole('button', {name: 'Request Response', exact: true})
				.click(),
		]);
		// Wait for the email template to land in the composer body (it
		// interpolates {$submissionTitle}, which carries the tag) before
		// submitting — an empty body fails server-side validation.
		// `tinymce.editors` was removed in TinyMCE 6 — enumerate live
		// editors via the no-arg `tinymce.get()` instead.
		await page.waitForFunction(
			(text) => {
				// @ts-ignore tinymce is a page global
				const tiny = window.tinymce;
				const editors =
					(typeof tiny?.get === 'function' ? tiny.get() : null) ?? [];
				return editors.some(
					(e) => e.initialized && e.getContent().includes(text),
				);
			},
			tag,
			{timeout: 30_000},
		);
		await page
			.getByRole('button', {name: 'Submit Request', exact: true})
			.click();
		const successDialog = page.locator('[data-cy="dialog"]');
		await expect(successDialog).toBeVisible({timeout: 15_000});
		await expect(successDialog).toContainText(
			'Request for review response sent',
		);

		// Request email, scoped recipient + tag.
		const messages = await pkpMail.find({
			to: ATESTER_EMAIL,
			contains: tag,
			timeoutMs: 20_000,
		});
		expect(messages[0].Subject).toContain(
			'Request For Author Response To Reviewer Feedback',
		);

		// Author submits the response through the response form modal.
		const authorCtx = await asUser('atester');
		const authorPage = await authorCtx.newPage();
		await authorPage.goto(authorWorkflowUrl(submission.id));
		// The workflow opens inside a side-modal hosted on the dashboard;
		// wait for its CONTENT to mount before reaching for controls (the
		// wrapper itself permanently computes visibility:hidden — see
		// app-changes.md §2; never assert on the wrapper). Scope the
		// trigger to the modal so dashboard-list buttons can't shadow it.
		const authorWorkflow = workflowModal(authorPage);
		await expect(
			authorWorkflow.getByRole('heading', {name: 'Round 1 Status'}),
		).toBeVisible({timeout: 20_000});
		await authorWorkflow
			.getByRole('button', {name: 'Submit Response', exact: true})
			.click();
		const responseModal = authorPage.getByRole('dialog', {
			name: /Submit Your Response/,
		});
		await expect(responseModal).toBeVisible({timeout: 15_000});
		// The response body is a multilingual rich-text field; resolve its
		// runtime control id ({formId}-authorResponse-control-en).
		const editorId = await responseModal
			.locator('[id$="-authorResponse-control-en"]')
			.first()
			.getAttribute('id');
		if (!editorId) {
			throw new Error('author response rich-text control not found');
		}
		await setTinyMceContent(
			authorPage,
			editorId,
			`<p>Author response ${tag}</p>`,
		);
		await responseModal.getByLabel('Author Tester').check();
		await responseModal
			.getByRole('button', {name: 'Submit Response', exact: true})
			.click();
		await expect(responseModal).toBeHidden({timeout: 20_000});

		// Editor sees the response-submitted status on the round.
		await workflow.goto(submission.id);
		await expect(
			workflowModal(page).getByText(
				'A response was submitted by Author Tester',
			),
		).toBeVisible({timeout: 20_000});
		const sub = await workflow.fetchSubmission(submission.id);
		expect(sub.reviewRounds[0].authorResponse).toBeTruthy();
	});

	// Row 11
	test('author revisions affordance is gated on the decision', {tag: '@regression'}, async ({pkpApi, asUser}) => {
		const tag = uniqueTag('rrev11');
		// In review with no decisions beyond sendExternalReview — no
		// revisions have been requested.
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({tag, submitter: 'atester'}),
		);

		const authorCtx = await asUser('atester');
		const authorPage = await authorCtx.newPage();
		await authorPage.goto(authorWorkflowUrl(submission.id));

		// The round panel renders with the review status (bounding the
		// negative)…
		await expect(
			authorPage.getByRole('heading', {name: 'Round 1 Status'}),
		).toBeVisible({timeout: 20_000});
		await expect(
			authorPage.getByText(STATUS_TEXT.pendingReviews),
		).toBeVisible();
		// …but no Upload revisions affordance before a revisions decision.
		await expect(
			authorPage.getByRole('button', {name: 'Upload revisions', exact: true}),
		).toHaveCount(0);
	});

	// Row 12
	test('round-2 review completes independently of round 1', {tag: '@regression'}, async ({page, pkpApi, asUser}) => {
		const tag = uniqueTag('rrev12');
		const {submission} = await pkpApi.createSubmission(
			submissionInRound2({tag}),
		);

		// jjanssen accepts and submits the round-2 review via the wizard.
		const reviewerCtx = await asUser('jjanssen');
		const reviewerPage = await reviewerCtx.newPage();
		const reviewerWizard = new ReviewerSubmissionPage(reviewerPage);
		await reviewerWizard.goto(submission.id);
		await reviewerWizard.acceptInvitation();
		await reviewerWizard.continueToStep3();
		await reviewerWizard.fillStep3Comments({
			toAuthor: `<p>Round 2 comments ${tag}</p>`,
		});
		await reviewerWizard.selectRecommendation('Revisions Required');
		await reviewerWizard.submitReview();

		// Editor: round 2 shows the received review; round 1 history
		// (phudson's completed review) stays intact.
		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id);
		await expect(rm.row('Julie Janssen')).toContainText('Review Submitted', {
			timeout: 20_000,
		});
		await expect(
			rm.row('Julie Janssen').getByRole('button', {name: 'Read Review'}),
		).toBeVisible();
		await expect(
			workflowModal(page).getByText(STATUS_TEXT.reviewsReady),
		).toBeVisible({timeout: 15_000});

		await selectReviewRound(page, 1);
		await expect(rm.row('Paul Hudson')).toContainText('Complete', {
			timeout: 15_000,
		});

		const sub = await new EditorialWorkflowPage(page).fetchSubmission(
			submission.id,
		);
		const round2 = (sub.reviewRounds || []).find((r) => r.round === 2);
		expect(round2.statusId).toBe(C.ROUND_REVIEWS_READY);
	});
});
