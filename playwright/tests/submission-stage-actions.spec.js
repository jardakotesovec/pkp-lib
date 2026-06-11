// @ts-check
const {test, expect} = require('../../../../playwright/support/fixtures.js');
const {EditorialWorkflowPage} = require('../../../../playwright/pages/EditorialWorkflowPage.js');
const submissionDraft = require('../../../../playwright/fixtures/scenarios/submission-draft.js');

/**
 * Submission stage actions — docs/e2e/plans/submission-stage-actions.md
 * (9 rows). Everything an editor/manager can do to a submission while it
 * sits at stage 1: the three primary decisions (send to review, accept
 * and skip review, decline), the needs-editor → assign-editor journey,
 * revert-decline, post-decline delete, the author's read-only view, the
 * cancel-out-of-the-wizard path, and the decline notification email.
 *
 * Absorption note: rows 1–3 were moved here from the wave-1 specs
 * decision-send-to-review.spec.js (file deleted — it held only the
 * stage-1 test), decision-accept.spec.js and decision-decline.spec.js
 * (each kept its post-review test for the review-decisions plan).
 *
 * POM note: the spec lives in lib/pkp because the stage-1 decision flow
 * ships identically across OJS/OMP/OPS. The workflow-page POM it drives
 * is OJS-only (playwright/pages/EditorialWorkflowPage.js); OMP/OPS will
 * import their own sibling once those apps adopt the scenario endpoint.
 */
test.describe('Submission stage actions', () => {
	// Plan row 1 (absorbed from decision-send-to-review.spec.js).
	test('editor sends a stage-1 submission to external review', {tag: '@regression'}, async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag(test.info(), 'send-to-review');
		const spec = submissionDraft({tag});
		const {submission} = await pkpApi.createSubmission(spec);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		// Before the decision, the submission is in stage 1 (SUBMISSION).
		// Confirm the Send for Review entry point is visible — it's both
		// a sanity check on the scenario state and on our translation
		// label (the Cypress suite hardcoded "Send for Review").
		await expect(
			page.getByRole('button', {name: 'Send for Review', exact: true}).first(),
		).toBeVisible();

		// Drive the decision wizard. SendExternalReview has two steps:
		// notifyAuthors (Continue) + promoteFilesToReview (Record Decision).
		await workflow.clickDecision('Send for Review');
		await workflow.clickContinue();
		await workflow.recordDecision('has been sent to the review stage');
		await workflow.viewSubmissionFromCompletionDialog(submission.id);

		// Stage-advance assertion via the API — decoupled from the exact
		// shape of the workflow-page indicator so it survives UI reshuffles.
		const after = await workflow.fetchSubmission(submission.id);
		expect(after.stageId).toBe(pkpConst.WORKFLOW_STAGE_ID_EXTERNAL_REVIEW);
		expect(after.status).toBe(pkpConst.STATUS_QUEUED);

		// A decision row exists for this submission.
		const decisions = await workflow.fetchDecisions(submission.id);
		expect(
			decisions.some((d) => d.decision === pkpConst.DECISION_EXTERNAL_REVIEW),
		).toBe(true);
	});

	// Plan row 2 (absorbed from decision-accept.spec.js, stage-1 test).
	test('editor accepts and skips review from stage 1', {tag: '@regression'}, async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag(test.info(), 'accept-stage-1');
		const spec = submissionDraft({tag});
		const {submission} = await pkpApi.createSubmission(spec);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		// The stage-1 "accept without review" decision lives behind the
		// "Accept and Skip Review" button (editor.submission.decision.skipReview).
		// See workflowConfigEditorialOJS.js L239-253.
		await expect(
			page
				.getByRole('button', {name: 'Accept and Skip Review', exact: true})
				.first(),
		).toBeVisible();

		await workflow.clickDecision('Accept and Skip Review');
		// SkipExternalReview has two steps (notifyAuthors + promoteFilesToReview);
		// the only email step auto-loads its template, so we need to wait
		// before Continue / Record Decision.
		await workflow.clickContinue();
		await workflow.recordDecision('skipped the review stage');
		await workflow.viewSubmissionFromCompletionDialog(submission.id);

		const after = await workflow.fetchSubmission(submission.id);
		expect(after.stageId).toBe(pkpConst.WORKFLOW_STAGE_ID_EDITING);
		expect(after.status).toBe(pkpConst.STATUS_QUEUED);

		const decisions = await workflow.fetchDecisions(submission.id);
		expect(
			decisions.some(
				(d) => d.decision === pkpConst.DECISION_SKIP_EXTERNAL_REVIEW,
			),
		).toBe(true);
	});

	// Plan row 3 (absorbed from decision-decline.spec.js, stage-1 test).
	test('editor declines a stage-1 submission', {tag: '@regression'}, async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag(test.info(), 'decline-stage-1');
		const spec = submissionDraft({tag});
		const {submission} = await pkpApi.createSubmission(spec);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		// Stage 1 surfaces the initial-decline button under the
		// "Decline Submission" label. See
		// lib/ui-library/src/pages/workflow/composables/useWorkflowConfig/
		// workflowConfigEditorialOJS.js#266 — action
		// DECISION_INITIAL_DECLINE, label 'editor.submission.decision.decline'.
		await expect(
			page
				.getByRole('button', {name: 'Decline Submission', exact: true})
				.first(),
		).toBeVisible();

		await workflow.clickDecision('Decline Submission');
		// InitialDecline has one step (notifyAuthors) — straight to
		// Record Decision.
		await workflow.recordDecision('has been declined and sent to the archives');
		await workflow.viewSubmissionFromCompletionDialog(submission.id);

		const after = await workflow.fetchSubmission(submission.id);
		expect(after.status).toBe(pkpConst.STATUS_DECLINED);

		// Decision row recorded.
		const decisions = await workflow.fetchDecisions(submission.id);
		expect(
			decisions.some((d) => d.decision === pkpConst.DECISION_INITIAL_DECLINE),
		).toBe(true);
	});

	// Plan row 4.
	test('manager assigns an editor to a needs-editor submission and decisions unlock', {tag: ['@regression', '@slow']}, async ({
		pkpApi,
		asUser,
	}) => {
		// Three-actor journey (admin dashboard ×2 + legacy assign form +
		// dbuskins workflow) — the default 60s cap is too tight under
		// parallel-worker server contention.
		test.slow();
		const tag = uniqueTag(test.info(), 'needs-editor');
		// Empty participant list — nobody but the auto-assigned author —
		// is what lands a queued submission in the needs-editor view
		// (Repository.php TYPE_NEEDS_EDITOR: isUnassigned + queued).
		const spec = submissionDraft({tag, participants: []});
		const {submission} = await pkpApi.createSubmission(spec);

		const ctx = await asUser('admin');
		const page = await ctx.newPage();

		// Pre-state: listed in the admin's "Needs editor" dashboard view.
		await page.goto(editorialUrl({view: 'needs-editor'}));
		await expect(
			page.getByRole('heading', {name: /Needs editor/}),
		).toBeVisible({timeout: 15_000});
		await searchList(page, tag);
		await expect(
			page.getByRole('row').filter({hasText: tag}),
		).toBeVisible({timeout: 15_000});

		// Assign dbuskins through the Participants panel on the workflow
		// page (defaults: full decision powers — recommendOnly unchecked).
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);
		await workflow.assignParticipant({
			userGroup: 'Section editor',
			nameSearch: 'Buskins',
			fullName: 'David Buskins',
		});

		// The submission leaves the needs-editor view.
		await page.goto(editorialUrl({view: 'needs-editor'}));
		await expect(
			page.getByRole('heading', {name: /Needs editor/}),
		).toBeVisible({timeout: 15_000});
		await searchList(page, tag);
		await expect(page.getByText('No Items')).toBeVisible({timeout: 15_000});
		await expect(page.getByRole('row').filter({hasText: tag})).toHaveCount(0);

		// dbuskins — previously unassigned, now the stage editor — sees
		// the full set of stage-1 decision buttons on the workflow page.
		const editorCtx = await asUser('dbuskins');
		const editorPage = await editorCtx.newPage();
		const editorWorkflow = new EditorialWorkflowPage(editorPage);
		await editorWorkflow.goto(submission.id);
		const actions = editorWorkflow.actionItems();
		await expect(
			actions.getByRole('button', {name: 'Send for Review', exact: true}),
		).toBeVisible({timeout: 20_000});
		await expect(
			actions.getByRole('button', {
				name: 'Accept and Skip Review',
				exact: true,
			}),
		).toBeVisible();
		await expect(
			actions.getByRole('button', {name: 'Decline Submission', exact: true}),
		).toBeVisible();
	});

	// Plan row 5.
	test('editor reverts an initial decline and the author sees the submission active again', {tag: ['@regression', '@slow']}, async ({
		pkpApi,
		asUser,
	}) => {
		// Editor wizard + author dashboard in one journey — needs
		// headroom under parallel-worker server contention.
		test.slow();
		const tag = uniqueTag(test.info(), 'revert-decline');
		const spec = submissionDraft({tag, submitter: 'atester'});
		spec.decisions = [{type: 'initialDecline', by: 'dbarnes'}];
		const {submission} = await pkpApi.createSubmission(spec);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		// The declined stage-1 state offers ONLY the revert decision
		// (OJS Schema.php#getAvailableEditorialDecisions swaps the
		// decision list for [RevertInitialDecline] when status=DECLINED).
		// Delete is also offered — dbarnes's "Journal editor" group maps
		// to ROLE_ID_MANAGER in OJS's default groups, satisfying the
		// Delete gate; row 6 owns the delete coverage.
		const actions = workflow.actionItems();
		await expect(
			actions.getByRole('button', {name: 'Revert Decline', exact: true}),
		).toBeVisible({timeout: 20_000});
		await expect(
			actions.getByRole('button', {name: 'Send for Review', exact: true}),
		).toHaveCount(0);
		await expect(
			actions.getByRole('button', {name: 'Decline Submission', exact: true}),
		).toHaveCount(0);

		// RevertInitialDecline has a single notifyAuthors step — straight
		// to Record Decision. Completion copy comes from
		// editor.submission.decision.revertInitialDecline.completed.description.
		await workflow.clickDecision('Revert Decline');
		await workflow.recordDecision('is now active in the submission stage');
		await workflow.viewSubmissionFromCompletionDialog(submission.id);

		const after = await workflow.fetchSubmission(submission.id);
		expect(after.status).toBe(pkpConst.STATUS_QUEUED);
		expect(after.stageId).toBe(pkpConst.WORKFLOW_STAGE_ID_SUBMISSION);
		const decisions = await workflow.fetchDecisions(submission.id);
		expect(
			decisions.some(
				(d) => d.decision === pkpConst.DECISION_REVERT_INITIAL_DECLINE,
			),
		).toBe(true);

		// The author's mySubmissions lists the submission as active again.
		const authorCtx = await asUser('atester');
		const authorPage = await authorCtx.newPage();
		await authorPage.goto(mySubmissionsUrl({view: 'active'}));
		await expect(
			authorPage.getByRole('heading', {name: /Active submissions/}),
		).toBeVisible({timeout: 15_000});
		await searchList(authorPage, tag);
		const row = authorPage.getByRole('row').filter({hasText: tag});
		await expect(row).toBeVisible({timeout: 15_000});
		await expect(row).toContainText('Submission'); // stage bubble
	});

	// Plan row 6.
	test('site admin deletes a declined submission', {tag: ['@regression', '@slow']}, async ({
		pkpApi,
		asUser,
	}) => {
		// Five workflow/dashboard page loads in one journey — give it
		// headroom under parallel-worker server contention.
		test.slow();
		const tag = uniqueTag(test.info(), 'delete-declined');
		const declinedSpec = submissionDraft({tag});
		declinedSpec.decisions = [{type: 'initialDecline', by: 'dbarnes'}];
		const {submission: declined} = await pkpApi.createSubmission(declinedSpec);
		const {submission: queued} = await pkpApi.createSubmission(
			submissionDraft({tag}),
		);

		// The site admin is NOT assigned to either submission — the
		// global manager/site-admin fallback (lib/pkp Schema.php
		// getPropertyStages) is what satisfies the Delete gate.
		const ctx = await asUser('admin');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);

		// Gate: no Delete on a queued stage-1 submission, even for the
		// admin (workflowConfigEditorialOJS.js ties Delete to the
		// REVERT_INITIAL_DECLINE availability, i.e. post-decline only).
		await workflow.goto(queued.id);
		const actions = workflow.actionItems();
		await expect(
			actions.getByRole('button', {name: 'Send for Review', exact: true}),
		).toBeVisible({timeout: 20_000});
		await expect(
			actions.getByRole('button', {name: 'Delete', exact: true}),
		).toHaveCount(0);

		// The declined submission offers Revert Decline + Delete.
		await workflow.goto(declined.id);
		await expect(
			actions.getByRole('button', {name: 'Revert Decline', exact: true}),
		).toBeVisible({timeout: 20_000});
		await workflow.deleteSubmissionFromWorkflow();

		// Gone: the API 404s …
		const res = await page.request.get(
			`/index.php/publicknowledge/api/v1/submissions/${declined.id}`,
		);
		expect(res.status()).toBeGreaterThanOrEqual(400);

		// … the workflow URL surfaces an Error dialog instead of content …
		await workflow.goto(declined.id);
		await expect(page.getByRole('dialog', {name: 'Error'})).toBeVisible({
			timeout: 20_000,
		});

		// … and the declined dashboard view no longer lists it. (The
		// queued sibling shares the tag but never had declined status, so
		// the empty state proves the deletion, not the search scoping.)
		await page.goto(editorialUrl({view: 'declined'}));
		await expect(
			page.getByRole('heading', {name: /Declined/}),
		).toBeVisible({timeout: 15_000});
		await searchList(page, tag);
		await expect(page.getByText('No Items')).toBeVisible({timeout: 15_000});
	});

	// Plan row 7.
	test('author sees no editorial decision controls on their own submission', {tag: '@regression'}, async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag(test.info(), 'author-view');
		const spec = submissionDraft({tag, submitter: 'atester'});
		const {submission} = await pkpApi.createSubmission(spec);

		const ctx = await asUser('atester');
		const page = await ctx.newPage();
		await page.goto(mySubmissionsUrl({workflowSubmissionId: submission.id}));

		// The side-modal wrapper reports `visibility: hidden`; anchor on
		// rendered content and use the wrapper for scoping. The seeded
		// title carries the tag (the scenario processor appends it).
		const modal = page.locator('[data-cy="active-modal"]').first();
		await expect(modal.getByText(tag).first()).toBeVisible({timeout: 20_000});

		// Positive control: the author's stage-1 view renders the
		// submission files panel (incl. the scenario's default file) …
		await expect(modal.getByText('Submission Files').first()).toBeVisible({
			timeout: 15_000,
		});
		await expect(
			modal.getByText('default-article.pdf').first(),
		).toBeVisible({timeout: 15_000});

		// … but none of the stage-1 editorial decisions.
		for (const decision of [
			'Send for Review',
			'Accept and Skip Review',
			'Decline Submission',
		]) {
			await expect(modal.getByRole('button', {name: decision})).toHaveCount(0);
		}
	});

	// Plan row 8.
	test('cancelling the decision wizard records nothing', {tag: '@regression'}, async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag(test.info(), 'cancel-wizard');
		const {submission} = await pkpApi.createSubmission(submissionDraft({tag}));

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		// Open the Send for Review wizard, let the notify-authors email
		// template settle (proves the wizard genuinely started), then
		// abandon it via Cancel → "Cancel Decision".
		await workflow.clickDecision('Send for Review');
		await workflow.awaitEmailTemplateLoaded();
		await workflow.cancelDecision();

		// Nothing recorded: no decision rows, stage/status unchanged, and
		// the decision buttons are still offered.
		const decisions = await workflow.fetchDecisions(submission.id);
		expect(decisions).toHaveLength(0);
		const after = await workflow.fetchSubmission(submission.id);
		expect(after.stageId).toBe(pkpConst.WORKFLOW_STAGE_ID_SUBMISSION);
		expect(after.status).toBe(pkpConst.STATUS_QUEUED);

		const actions = workflow.actionItems();
		await expect(
			actions.getByRole('button', {name: 'Send for Review', exact: true}),
		).toBeVisible({timeout: 20_000});
		await expect(
			actions.getByRole('button', {
				name: 'Accept and Skip Review',
				exact: true,
			}),
		).toBeVisible();
		await expect(
			actions.getByRole('button', {name: 'Decline Submission', exact: true}),
		).toBeVisible();
	});

	// Plan row 9. Complements row 3, which owns the state-transition
	// assertions — this row owns delivery + content of the notify email.
	test('stage-1 decline email reaches the author', {tag: '@regression'}, async ({
		pkpApi,
		asUser,
		pkpMail,
	}) => {
		const tag = uniqueTag(test.info(), 'decline-email');
		// Whitespace-free marker distinct from the title tag so the
		// Mailpit match proves the EDITED body arrived, not the default
		// template (whose body also carries the tagged title).
		const marker = `EditedDeclineBody-${tag}`;
		const spec = submissionDraft({tag, submitter: 'atester'});
		const {submission} = await pkpApi.createSubmission(spec);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		await workflow.clickDecision('Decline Submission');
		// Replace the notify-authors body AFTER the template load settles
		// (the AJAX-loaded default would overwrite an earlier edit).
		await workflow.setDecisionEmailBody(
			'notifyAuthors',
			`<p>The editors have reached a decision to decline. ${marker}</p>`,
		);
		await workflow.recordDecision('has been declined and sent to the archives');

		// Principle 8: scope the Mailpit read by recipient + the test's
		// unique marker. atester is shared across workers; the marker is
		// not.
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
});

// Matches lib/pkp/classes/submission/PKPSubmission.php + Decision\Decision.php.
const pkpConst = {
	STATUS_QUEUED: 1,
	STATUS_DECLINED: 4,
	WORKFLOW_STAGE_ID_SUBMISSION: 1,
	WORKFLOW_STAGE_ID_EXTERNAL_REVIEW: 3,
	WORKFLOW_STAGE_ID_EDITING: 4,
	DECISION_EXTERNAL_REVIEW: 3, // Decision::EXTERNAL_REVIEW
	DECISION_INITIAL_DECLINE: 8,
	DECISION_REVERT_INITIAL_DECLINE: 16,
	DECISION_SKIP_EXTERNAL_REVIEW: 17,
};

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

/** Editorial dashboard URL, optionally pinned to a left-nav view. */
function editorialUrl({journal = 'publicknowledge', view} = {}) {
	const query = view ? `?currentViewId=${view}` : '';
	return `/index.php/${journal}/en/dashboard/editorial${query}`;
}

/** Author dashboard URL (view or direct workflow-modal deep link). */
function mySubmissionsUrl({
	journal = 'publicknowledge',
	view,
	workflowSubmissionId,
} = {}) {
	const params = new URLSearchParams();
	if (view) params.set('currentViewId', view);
	if (workflowSubmissionId) {
		params.set('workflowSubmissionId', String(workflowSubmissionId));
	}
	const query = params.toString();
	return `/index.php/${journal}/en/dashboard/mySubmissions${query ? `?${query}` : ''}`;
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
