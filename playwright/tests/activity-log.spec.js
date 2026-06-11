// @ts-check
const {test, expect} = require('../support/base-test.js');
const {EditorialWorkflowPage} = require('../../../../playwright/pages/EditorialWorkflowPage.js');
const {ActivityLogModal} = require('../pages/ActivityLogModal.js');
const submissionDraft = require('../../../../playwright/fixtures/scenarios/submission-draft.js');
const submissionInReview = require('../../../../playwright/fixtures/scenarios/submission-in-review.js');
const submissionInRound2 = require('../../../../playwright/fixtures/scenarios/submission-in-round-2.js');

/**
 * Activity log — docs/e2e/plans/activity-log.md (4 rows).
 *
 * Rows 1–3 cover the legacy info-center modal ("Activity Log & Notes")
 * opened from the workflow page header: the event-log History grid, the
 * Notes tab, and the role gate on the button
 * (`canAccessEditorialHistory` — manager/sub-editor/site-admin on the
 * active stage; see useWorkflowPermissions.js).
 *
 * Row 4 covers the reviewer-side Round History modal
 * (RoundHistoryModal.vue + `reviews/history/{submissionId}/{roundId}`)
 * reachable from the "Previous Reviews" box on the reviewer submission
 * page once a past round exists.
 *
 * Seeded-history parity (rows 1 and 4): the assertions on seeded state
 * rely on the Processors writing the same event_log /
 * submission_comments / review-assignment rows production writes —
 * LogSubmissionSubmitted fires through the real Repo::submission()->
 * submit(), DecisionProcessor goes through Repo::decision()->add()
 * (which logs the decision), and ReviewRoundProcessor writes the
 * reviewer-assigned event log row explicitly. A missing entry here is a
 * Processor parity defect (PRINCIPLES §2), not a test-flow problem.
 *
 * The grid's user column is empty for most seeded rows (the scenario
 * request carries no session user, so EventLogEntry.userId is null);
 * the actor is asserted via the message interpolation
 * ({$editorName} / {$reviewerName}) for seeded rows, and via both the
 * message and the user column for the live-recorded decision.
 */

test.use({user: 'dbarnes'});

function uniqueTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

const CURRENT_YEAR = String(new Date().getFullYear());

test.describe('Activity log', () => {
	// Row 1
	test('Activity Log history lists seeded and live workflow events', {tag: '@smoke'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('alog1');
		// One accepted reviewer; the requestRevisions decision recorded
		// live below stays a single notifyAuthors step (no completed
		// reviewers → no notifyReviewers step).
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				reviewers: [
					{user: 'jjanssen', method: 'anonymous', status: 'accepted'},
				],
			}),
		);

		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		const log = new ActivityLogModal(page);
		await log.openFromWorkflow();

		// History is the default-selected tab for an assigned editor.
		await expect(log.historyTab).toBeVisible();

		// Seeded events at production parity: the wizard submit… (OJS
		// overrides submission.event.submissionSubmitted — "Article
		// submitted", not pkp-lib's "Initial submission completed.")
		const submitRow = log.historyRow('Article submitted');
		await expect(submitRow).toBeVisible({timeout: 20_000});
		// …with the date column populated (journal short date format).
		await expect(submitRow).toContainText(CURRENT_YEAR);

		// …the reviewer assignment (actor in the message interpolation)…
		await expect(
			log.historyRow(
				`Julie Janssen has been assigned to review submission ${submission.id} for review round 1.`,
			),
		).toBeVisible();

		// …and the seeded sendExternalReview decision, attributed to the
		// deciding editor.
		const seededDecisionRow = log.historyRow(
			'sent this submission to the review stage.',
		);
		await expect(seededDecisionRow).toBeVisible();
		await expect(seededDecisionRow).toContainText('Daniel Barnes');

		// Record a live decision through the UI (Request Revisions, no
		// new round) and confirm the log picks it up on reopen.
		await log.close();
		await workflow.clickRequestRevisions();
		await workflow.recordDecision('have been requested');
		await workflow.viewSubmissionFromCompletionDialog(submission.id);

		await log.openFromWorkflow();
		const liveDecisionRow = log.historyRow(
			'requested revisions for this submission.',
		);
		await expect(liveDecisionRow).toBeVisible({timeout: 20_000});
		// Actor (message interpolation + user column) and date.
		await expect(liveDecisionRow).toContainText('Daniel Barnes');
		await expect(liveDecisionRow).toContainText(CURRENT_YEAR);
	});

	// Row 2
	test('a note posted in the Notes tab persists across editors', {tag: '@regression'}, async ({page, pkpApi, asUser}) => {
		const tag = uniqueTag('alog2');
		const noteText = `Editorial note for the record ${tag}`;
		// Default draft cast: dbarnes (editor) + dbuskins/minoue (section
		// editors) as stage participants.
		const {submission} = await pkpApi.createSubmission(
			submissionDraft({tag}),
		);

		// dbarnes posts the note.
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);
		const log = new ActivityLogModal(page);
		await log.openFromWorkflow();
		await log.openNotesTab();
		await log.addNote(noteText);

		// The note renders with author + posted date.
		const note = log.note(noteText);
		await expect(note).toBeVisible();
		await expect(note.locator('.details .user')).toHaveText(/Daniel Barnes/);
		await expect(note.locator('.details .date')).toContainText(CURRENT_YEAR);

		// The other assigned section editor reopens the modal and sees
		// the same note with the original author attribution.
		const otherCtx = await asUser('dbuskins');
		const otherPage = await otherCtx.newPage();
		const otherWorkflow = new EditorialWorkflowPage(otherPage);
		await otherWorkflow.goto(submission.id);
		const otherLog = new ActivityLogModal(otherPage);
		await otherLog.openFromWorkflow();
		await otherLog.openNotesTab();
		const sharedNote = otherLog.note(noteText);
		await expect(sharedNote).toBeVisible({timeout: 20_000});
		await expect(sharedNote.locator('.details .user')).toHaveText(
			/Daniel Barnes/,
		);
	});

	// Row 3
	test('Activity Log access is gated by role', {tag: '@regression'}, async ({pkpApi, asUser}) => {
		const tag = uniqueTag('alog3');
		// Submitter is the baseline author atester (patterns.md: routing
		// the submitter through a non-editor user keeps the author-side
		// assertion meaningful); participants cover the two gated roles.
		const {submission} = await pkpApi.createSubmission(
			submissionDraft({
				tag,
				submitter: 'atester',
				participants: [
					{user: 'dbuskins', role: 'sectionEditor'},
					{user: 'mfritz', role: 'copyeditor'},
				],
			}),
		);

		const activityLogButton = (p) =>
			p.getByRole('button', {name: 'Activity Log', exact: true});
		// The Library header action renders unconditionally in both the
		// editorial and the author workflow configs — it bounds every
		// negative assertion below (the header strip did render).
		const libraryButton = (p) =>
			p.getByRole('button', {name: 'Library', exact: true});

		// Assigned section editor: sub-editor role on the active stage →
		// canAccessEditorialHistory → button present.
		const editorCtx = await asUser('dbuskins');
		const editorPage = await editorCtx.newPage();
		await new EditorialWorkflowPage(editorPage).goto(submission.id);
		await expect(activityLogButton(editorPage)).toBeVisible({
			timeout: 20_000,
		});

		// Assigned assistant (copyeditor): workflow page renders (Library
		// present) but the Activity Log action does not.
		const assistantCtx = await asUser('mfritz');
		const assistantPage = await assistantCtx.newPage();
		await new EditorialWorkflowPage(assistantPage).goto(submission.id);
		await expect(libraryButton(assistantPage)).toBeVisible({timeout: 20_000});
		await expect(activityLogButton(assistantPage)).toHaveCount(0);

		// Submitting author on their mySubmissions workflow view: the
		// author workflow config carries no Activity Log action at all.
		const authorCtx = await asUser('atester');
		const authorPage = await authorCtx.newPage();
		await authorPage.goto(
			`/index.php/publicknowledge/en/dashboard/mySubmissions?workflowSubmissionId=${submission.id}`,
		);
		await expect(libraryButton(authorPage)).toBeVisible({timeout: 20_000});
		await expect(activityLogButton(authorPage)).toHaveCount(0);
	});

	// Row 4
	test('reviewer round-history modal shows the past-round outcome', {tag: '@regression'}, async ({pkpApi, asUser}) => {
		const tag = uniqueTag('alog4');
		const roundOneComment = `Round one verdict for the record ${tag}`;
		// phudson completed round 1 with a pendingRevisions
		// recommendation + a for-author comment; round 2 belongs to
		// jjanssen, which makes round 1 a *past* round on phudson's
		// reviewer page (PKPReviewerHandler only lists rounds other than
		// the submission's last round under Previous Reviews).
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
								comments: {toAuthor: roundOneComment},
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

		const reviewerCtx = await asUser('phudson');
		const reviewerPage = await reviewerCtx.newPage();
		await reviewerPage.goto(
			`/index.php/publicknowledge/en/reviewer/submission/${submission.id}`,
		);

		// Past round 1 is listed in the Previous Reviews box.
		await expect(
			reviewerPage.getByRole('heading', {name: 'Previous Reviews'}),
		).toBeVisible({timeout: 20_000});
		await expect(
			reviewerPage.getByText(/Round 1 Review Submitted on/),
		).toBeVisible();

		// Open the Round History modal.
		await reviewerPage
			.getByRole('button', {name: 'Read Round 1 Review', exact: true})
			.click();
		const modal = reviewerPage.getByRole('dialog', {
			name: /Round 1 Review submitted by you for/,
		});
		await expect(modal).toBeVisible({timeout: 20_000});

		// Round number sits in the modal title; the publication title is
		// the modal description (carries the tag).
		await expect(
			modal.getByText(`Multi-round article ${tag}`).first(),
		).toBeVisible({timeout: 20_000});

		// Completed review details: recommendation…
		await expect(
			modal.getByRole('heading', {name: 'Recommendation'}),
		).toBeVisible();
		await expect(modal.getByText('Revisions Required')).toBeVisible();

		// …the for-author-and-editor comment stream…
		await expect(
			modal.getByRole('heading', {name: 'Reviewer Comments'}),
		).toBeVisible();
		await expect(modal.getByText('For editors and authors')).toBeVisible();
		await expect(modal.getByText(roundOneComment)).toBeVisible();

		// …and the assignment dates under General Information (request /
		// accepted / submitted are all stamped on a completed seeded
		// review). Each renders as an h3 "<heading>:" + date paragraph.
		await expect(
			modal.getByRole('heading', {name: 'General Information'}),
		).toBeVisible();
		for (const heading of [
			"Editor's Request:",
			'Review Accepted On:',
			'Review Submitted On:',
		]) {
			const row = modal.locator('div').filter({
				has: reviewerPage.getByRole('heading', {name: heading, exact: true}),
			});
			await expect(row.locator('p').first()).toHaveText(/\d/);
		}
	});
});
