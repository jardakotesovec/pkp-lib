// @ts-check
const path = require('path');
const {test, expect} = require('../../../../playwright/support/fixtures.js');
const {EditorialWorkflowPage} = require('../../../../playwright/pages/EditorialWorkflowPage.js');
const submissionInReview = require('../../../../playwright/fixtures/scenarios/submission-in-review.js');

/**
 * Review decisions — docs/e2e/plans/review-decisions.md (8 rows).
 * The post-review primary decisions an editor records from the external
 * review stage: accept (with and without completed reviews), decline,
 * revert decline, the notify-author/notify-reviewer decision emails
 * (incl. an Upload-attacher attachment), and the recorded decision
 * history.
 *
 * Absorption note: rows 1–2 were moved here from the wave-1 specs
 * decision-accept.spec.js and decision-decline.spec.js (both files
 * deleted — their stage-1 halves had already moved to
 * submission-stage-actions.spec.js during that plan's refit).
 *
 * POM note: the spec lives in lib/pkp because the review-stage decision
 * flow ships identically across OJS/OMP/OPS. The workflow-page POM it
 * drives is OJS-only (playwright/pages/EditorialWorkflowPage.js);
 * OMP/OPS will import their own sibling once those apps adopt the
 * scenario endpoint.
 */
test.describe('Review decisions', () => {
	// Plan row 1 (absorbed from decision-accept.spec.js, post-review test).
	test('editor accepts a submission after external review', {tag: '@regression'}, async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag(test.info(), 'accept-review');
		const spec = submissionInReview({tag});
		const {submission} = await pkpApi.createSubmission(spec);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		// "Accept Submission" is the review-stage accept button. The two
		// seeded reviewers are in 'invited'/'accepted' states (not
		// completed), so Accept ships only the notifyAuthors step + the
		// promoteFilesToCopyediting step — no notifyReviewers step because
		// Accept::getSteps only adds it when there are
		// REVIEW_ASSIGNMENT_COMPLETED assignments (row 3 owns that case).
		await expect(
			page
				.getByRole('button', {name: 'Accept Submission', exact: true})
				.first(),
		).toBeVisible();

		await workflow.clickDecision('Accept Submission');
		await workflow.clickContinue();
		await workflow.recordDecision(
			'has been accepted for publication and sent to the copyediting stage',
		);
		await workflow.viewSubmissionFromCompletionDialog(submission.id);

		const after = await workflow.fetchSubmission(submission.id);
		expect(after.stageId).toBe(pkpConst.WORKFLOW_STAGE_ID_EDITING);
		expect(after.status).toBe(pkpConst.STATUS_QUEUED);

		const decisions = await workflow.fetchDecisions(submission.id);
		expect(decisions.some((d) => d.decision === pkpConst.DECISION_ACCEPT)).toBe(
			true,
		);
	});

	// Plan row 2 (absorbed from decision-decline.spec.js, post-review test).
	test('editor declines a submission after review', {tag: '@regression'}, async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag(test.info(), 'decline-review');
		const spec = submissionInReview({tag});
		const {submission} = await pkpApi.createSubmission(spec);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		// Review-stage decline lives inside the review-round action
		// items. The review tab is auto-selected for an in-review
		// submission. Seeded reviewers are in 'invited' and 'accepted'
		// states, so no completed reviews — Decline has a single
		// notifyAuthors step with no notifyReviewers step appended (see
		// lib/pkp/classes/decision/types/Decline.php — reviewer
		// notification only on REVIEW_ASSIGNMENT_COMPLETED).
		await expect(
			page
				.getByRole('button', {name: 'Decline Submission', exact: true})
				.first(),
		).toBeVisible();

		await workflow.clickDecision('Decline Submission');
		await workflow.recordDecision('has been declined and sent to the archives');
		await workflow.viewSubmissionFromCompletionDialog(submission.id);

		const after = await workflow.fetchSubmission(submission.id);
		expect(after.status).toBe(pkpConst.STATUS_DECLINED);

		const decisions = await workflow.fetchDecisions(submission.id);
		expect(
			decisions.some((d) => d.decision === pkpConst.DECISION_DECLINE),
		).toBe(true);
	});

	// Plan row 3. Rows 1 covers accept WITHOUT completed reviews (no
	// Notify Reviewers step); this row owns the completed-reviews shape
	// and the two decision emails.
	test('accept with completed reviews notifies author and reviewers', {tag: ['@regression', '@slow']}, async ({
		pkpApi,
		asUser,
		pkpMail,
	}) => {
		// Wizard + two Mailpit polls — headroom under parallel load.
		test.slow();
		const tag = uniqueTag(test.info(), 'accept-notify');
		// phudson completed (recommendation accept) is what makes
		// Accept::getSteps add the Notify Reviewers step; jjanssen stays
		// 'accepted' to prove non-completed reviewers are not recipients.
		const spec = submissionInReview({
			tag,
			submitter: 'atester',
			reviewers: [
				{
					user: 'phudson',
					method: 'anonymous',
					status: 'completed',
					recommendation: 'accept',
				},
				{user: 'jjanssen', method: 'anonymous', status: 'accepted'},
			],
		});
		const {submission} = await pkpApi.createSubmission(spec);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		await workflow.clickDecision('Accept Submission');
		// Step 1: Notify Authors → Continue lands on the Notify Reviewers
		// step, which only exists because phudson's review is completed.
		await workflow.clickContinue();
		await expect(
			page
				.locator('.decision__stepHeader h2')
				.filter({hasText: 'Notify Reviewers'}),
		).toBeVisible({timeout: 15_000});
		// Step 2: Notify Reviewers → Continue → promote files → record.
		await workflow.clickContinue();
		await workflow.recordDecision(
			'has been accepted for publication and sent to the copyediting stage',
		);

		// Principle 8: scope both Mailpit reads by recipient + this test's
		// unique tag — the seeded title carries "[tag]" and both default
		// templates interpolate {$submissionTitle} into the body.
		const [authorMsg] = await pkpMail.find({
			to: 'atester@mailinator.com',
			contains: tag,
			timeoutMs: 20_000,
		});
		expect(authorMsg.Subject).toContain('has been accepted');

		const [reviewerMsg] = await pkpMail.find({
			to: 'phudson@mailinator.com',
			contains: tag,
			timeoutMs: 20_000,
		});
		expect(reviewerMsg.Subject).toContain('Thank you for your review');
	});

	// Plan row 4. Email content ownership: edited subject + body + an
	// Upload-attacher attachment all round-trip into the delivered
	// message (the other attachers belong to the email-delivery plan).
	test('notify-author decision email carries an attachment', {tag: ['@regression', '@slow']}, async ({
		pkpApi,
		asUser,
		pkpMail,
	}) => {
		// Wizard + stacked attacher modals + Mailpit poll.
		test.slow();
		const tag = uniqueTag(test.info(), 'accept-attach');
		// Whitespace-free marker distinct from the title tag so the
		// Mailpit match proves the EDITED content arrived, not the
		// default template (whose body also carries the tagged title).
		const marker = `EditedAcceptBody-${tag}`;
		const spec = submissionInReview({tag, submitter: 'atester'});
		const {submission} = await pkpApi.createSubmission(spec);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		await workflow.clickDecision('Accept Submission');
		// Edit subject + body AFTER the template load settles (the
		// AJAX-loaded default would overwrite an earlier edit), then
		// attach dummy.pdf through the Upload attacher.
		await workflow.setDecisionEmailSubject(
			'notifyAuthors',
			`Submission accepted ${marker}`,
		);
		await workflow.setDecisionEmailBody(
			'notifyAuthors',
			`<p>We are pleased to accept your submission. ${marker}</p>`,
		);
		await workflow.attachDecisionEmailUpload(attachmentFixturePath());
		// Continue past the email step; the remaining step is
		// promoteFilesToCopyediting → Record Decision.
		await workflow.clickContinue();
		await workflow.recordDecision(
			'has been accepted for publication and sent to the copyediting stage',
		);

		const [message] = await pkpMail.find({
			to: 'atester@mailinator.com',
			contains: marker,
			timeoutMs: 20_000,
		});
		expect(message.Subject).toBe(`Submission accepted ${marker}`);
		const full = await pkpMail.fullMessage(message.ID);
		expect(`${full.HTML ?? ''}${full.Text ?? ''}`).toContain(marker);
		// Mailpit's full-message payload lists attachments as
		// [{PartID, FileName, ContentType, Size}, ...].
		const attachments = full.Attachments ?? [];
		expect(
			attachments.some((a) => a.FileName === 'dummy.pdf'),
			`expected dummy.pdf among attachments: ${JSON.stringify(attachments)}`,
		).toBe(true);
	});

	// Plan row 5. Row 8 owns the exhaustive offered/withheld button
	// assertions on the declined state; this row owns the revert flow
	// and the post-revert state.
	test('editor reverts a post-review decline', {tag: '@regression'}, async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag(test.info(), 'revert-decline');
		const spec = submissionInReview({tag});
		spec.decisions.push({type: 'decline', by: 'dbarnes'});
		const {submission} = await pkpApi.createSubmission(spec);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		// The declined review-stage state offers the revert decision
		// (OJS Schema.php#getAvailableEditorialDecisions swaps the list
		// for [RevertDecline] when status=DECLINED in review).
		const actions = workflow.actionItems();
		await expect(
			actions.getByRole('button', {name: 'Revert Decline', exact: true}),
		).toBeVisible({timeout: 20_000});

		// RevertDecline has a single notifyAuthors step — straight to
		// Record Decision. Completion copy comes from
		// editor.submission.decision.revertDecline.completed.description.
		await workflow.clickDecision('Revert Decline');
		await workflow.recordDecision(
			'is now an active submission in the review stage',
		);
		await workflow.viewSubmissionFromCompletionDialog(submission.id);

		// Queued back at the review stage with a REVERT_DECLINE row.
		const after = await workflow.fetchSubmission(submission.id);
		expect(after.status).toBe(pkpConst.STATUS_QUEUED);
		expect(after.stageId).toBe(pkpConst.WORKFLOW_STAGE_ID_EXTERNAL_REVIEW);
		const decisions = await workflow.fetchDecisions(submission.id);
		expect(
			decisions.some((d) => d.decision === pkpConst.DECISION_REVERT_DECLINE),
		).toBe(true);

		// The primary review-stage decisions are offered again.
		await expect(
			actions.getByRole('button', {name: 'Accept Submission', exact: true}),
		).toBeVisible({timeout: 20_000});
		await expect(
			actions.getByRole('button', {name: 'Request Revisions', exact: true}),
		).toBeVisible();
		await expect(
			actions.getByRole('button', {name: 'Decline Submission', exact: true}),
		).toBeVisible();
		await expect(
			actions.getByRole('button', {name: 'Revert Decline', exact: true}),
		).toHaveCount(0);
	});

	// Plan row 6. Complements row 2, which owns the state-transition
	// assertions — this row owns email delivery + the author's archived
	// view.
	test('post-review decline notifies the author and archives the submission for them', {tag: ['@regression', '@slow']}, async ({
		pkpApi,
		asUser,
		pkpMail,
	}) => {
		// Editor wizard + Mailpit poll + author dashboard in one journey.
		test.slow();
		const tag = uniqueTag(test.info(), 'decline-email');
		// Marker distinct from the title tag so the Mailpit match proves
		// the EDITED body arrived (the default decline template also
		// carries the tagged title).
		const marker = `EditedDeclineBody-${tag}`;
		const spec = submissionInReview({tag, submitter: 'atester'});
		const {submission} = await pkpApi.createSubmission(spec);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		await workflow.clickDecision('Decline Submission');
		// Replace the notify-authors body AFTER the template load settles.
		await workflow.setDecisionEmailBody(
			'notifyAuthors',
			`<p>The editors have decided to decline this submission. ${marker}</p>`,
		);
		await workflow.recordDecision('has been declined and sent to the archives');

		// Principle 8: recipient + unique marker. atester is shared
		// across workers; the marker is not.
		const [message] = await pkpMail.find({
			to: 'atester@mailinator.com',
			contains: marker,
			timeoutMs: 20_000,
		});
		const full = await pkpMail.fullMessage(message.ID);
		expect(`${full.HTML ?? ''}${full.Text ?? ''}`).toContain(marker);

		// The author's mySubmissions shows the submission as declined.
		const authorCtx = await asUser('atester');
		const authorPage = await authorCtx.newPage();
		await authorPage.goto(mySubmissionsUrl({view: 'declined'}));
		await expect(
			authorPage.getByRole('heading', {name: /Declined/}),
		).toBeVisible({timeout: 15_000});
		await searchList(authorPage, tag);
		const row = authorPage.getByRole('row').filter({hasText: tag});
		await expect(row).toBeVisible({timeout: 15_000});
		await expect(row).toContainText('Declined');
	});

	// Plan row 7.
	test('decision history records the chain in order', {tag: ['@regression', '@slow']}, async ({
		pkpApi,
		asUser,
	}) => {
		// Wizard + two workflow-panel loads.
		test.slow();
		const tag = uniqueTag(test.info(), 'history');
		const spec = submissionInReview({tag});
		spec.decisions.push({type: 'requestRevisions', by: 'dbarnes'});
		const {submission} = await pkpApi.createSubmission(spec);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		// Accept is still offered with round 1 in REVISIONS_REQUESTED;
		// record it through the UI on top of the seeded chain.
		await workflow.clickDecision('Accept Submission');
		await workflow.clickContinue();
		await workflow.recordDecision(
			'has been accepted for publication and sent to the copyediting stage',
		);
		await workflow.viewSubmissionFromCompletionDialog(submission.id);

		// The decisions endpoint lists the chain ordered by dateDecided
		// DESC (PKPSubmissionController#getDecisions): the UI accept is
		// strictly newer than the seeded pendingRevisions, so it comes
		// first; every row carries the deciding editor + a full
		// timestamp. (The two seeded rows can share a second, so their
		// relative tie-order is not asserted.) All three decisions here
		// were taken by dbarnes (seeded + UI), so the editorId must be
		// constant across the chain.
		const decisions = await workflow.fetchDecisions(submission.id);
		const seq = decisions.map((d) => d.decision);
		expect(seq).toContain(pkpConst.DECISION_EXTERNAL_REVIEW);
		const pendingIdx = seq.indexOf(pkpConst.DECISION_PENDING_REVISIONS);
		const acceptIdx = seq.indexOf(pkpConst.DECISION_ACCEPT);
		expect(acceptIdx).toBeGreaterThanOrEqual(0);
		expect(pendingIdx).toBeGreaterThan(acceptIdx);
		for (const d of decisions) {
			expect(d.dateDecided).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
			expect(d.editorId).toBe(decisions[0].editorId);
		}

		// The workflow page shows copyediting started (the Draft Files
		// panel of stage 4) …
		const after = await workflow.fetchSubmission(submission.id);
		expect(after.stageId).toBe(pkpConst.WORKFLOW_STAGE_ID_EDITING);
		await expect(
			workflow.workflowModal().getByText('Draft Files').first(),
		).toBeVisible({timeout: 20_000});

		// … while the review stage retains its recorded state: round 1 is
		// still navigable and lists the reviewers it was recorded with.
		await workflow.openReviewRoundPanel(1);
		await expect(
			workflow.workflowModal().getByText('Paul Hudson').first(),
		).toBeVisible({timeout: 15_000});
		await expect(
			workflow.workflowModal().getByText('Julie Janssen').first(),
		).toBeVisible();
	});

	// Plan row 8. Gate coverage for the declined review-stage state;
	// row 5 owns the revert flow itself.
	test('declined submission offers only revert and delete', {tag: '@regression'}, async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag(test.info(), 'declined-gates');
		const spec = submissionInReview({tag});
		spec.decisions.push({type: 'decline', by: 'dbarnes'});
		const {submission} = await pkpApi.createSubmission(spec);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		// Revert Decline is offered; Delete too — dbarnes's "Journal
		// editor" group maps to ROLE_ID_MANAGER in OJS's default groups,
		// satisfying the Delete gate (workflowConfigEditorialOJS.js ties
		// Delete to DECISION_REVERT_DECLINE availability + a
		// manager/site-admin stage role).
		const actions = workflow.actionItems();
		await expect(
			actions.getByRole('button', {name: 'Revert Decline', exact: true}),
		).toBeVisible({timeout: 20_000});
		await expect(
			actions.getByRole('button', {name: 'Delete', exact: true}),
		).toBeVisible();

		// None of the primary review-stage decisions are offered.
		await expect(
			actions.getByRole('button', {name: 'Accept Submission', exact: true}),
		).toHaveCount(0);
		await expect(
			actions.getByRole('button', {name: 'Request Revisions', exact: true}),
		).toHaveCount(0);
		await expect(
			actions.getByRole('button', {name: 'Decline Submission', exact: true}),
		).toHaveCount(0);
	});
});

// Matches lib/pkp/classes/submission/PKPSubmission.php + Decision\Decision.php.
const pkpConst = {
	STATUS_QUEUED: 1,
	STATUS_DECLINED: 4,
	WORKFLOW_STAGE_ID_EXTERNAL_REVIEW: 3,
	WORKFLOW_STAGE_ID_EDITING: 4,
	DECISION_ACCEPT: 2,
	DECISION_EXTERNAL_REVIEW: 3,
	DECISION_PENDING_REVISIONS: 4,
	DECISION_DECLINE: 6,
	DECISION_REVERT_DECLINE: 15,
};

/**
 * Resolve the bundled dummy.pdf fixture used as the email attachment.
 */
function attachmentFixturePath() {
	return path.resolve(__dirname, '..', 'fixtures', 'files', 'dummy.pdf');
}

/**
 * Build a tag scoped to this worker + a random suffix. The worker index
 * isolates parallel workers; the random part isolates RUNS — the local
 * test DB is long-lived, so a deterministic tag would match leftover
 * rows from earlier runs and break strict-mode row assertions.
 *
 * @param {import('@playwright/test').TestInfo} info
 * @param {string} suffix
 */
function uniqueTag(info, suffix) {
	const rand = Math.random().toString(36).slice(2, 8);
	return `t-w${info.parallelIndex}-${suffix}-${rand}`;
}

/** Author dashboard URL pinned to a left-nav view. */
function mySubmissionsUrl({journal = 'publicknowledge', view} = {}) {
	const query = view ? `?currentViewId=${view}` : '';
	return `/index.php/${journal}/en/dashboard/mySubmissions${query}`;
}

/**
 * Scope a dashboard list to this test's rows. Shared users' views
 * accumulate rows from every parallel spec and the table paginates at
 * 30 per page, so tag-scoped presence/absence assertions must narrow
 * the list server-side first. The search component listens on
 * (debounced) keyup — type the token, don't just fill it.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} token  whitespace-free unique marker (the test tag)
 */
async function searchList(page, token) {
	const search = page.locator('.pkpSearch__input');
	await expect(search).toBeVisible({timeout: 15_000});
	await search.fill('');
	await search.pressSequentially(token);
}
