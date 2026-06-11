// @ts-check
const {test, expect} = require('../support/base-test.js');
const {EditorialWorkflowPage} = require('../../../../playwright/pages/EditorialWorkflowPage.js');
const submissionInReview = require('../../../../playwright/fixtures/scenarios/submission-in-review.js');
const submissionPublished = require('../../../../playwright/fixtures/scenarios/submission-published.js');

/**
 * Recommend-only editor gates — docs/e2e/plans/recommend-only-editors.md
 * rows 3–4. Rows 1–2 are backed by recommend-only-editor.spec.js and
 * section-editor-recommendation.spec.js (see the plan's Absorbs).
 *
 * Row 3 closes the recommendation loop end-to-end: the recommend-only
 * section editor records Recommend Accept through the decision wizard
 * (single "Notify Editors" step, action id `discussion` —
 * IsRecommendation::getSteps), which both opens a query among deciding
 * editors AND emails them (IsRecommendation::addRecommendationQuery →
 * sendEditorsEmail, template EDITOR_RECOMMENDATION, subject "Editor
 * Recommendation"). The Mailpit assertion is scoped recipient + the
 * test's unique marker typed into the message body — no clearAll
 * (charter principle 8). The deciding editor then records the real
 * Accept Submission decision; both rows land in the decision history
 * and the recommender's review-stage panel flips from the Recommend
 * buttons to the recorded-recommendation state
 * (WorkflowRecommendOnlyControls#currentRecommendation).
 *
 * Row 4 proves the gate extends past decisions to publication actions:
 * `canPublish` requires a production-stage assignment that is NOT
 * recommend-only (useWorkflowPermissions.js:79-87), and it gates both
 * the Unpublish control (workflowConfigEditorialOJS PublicationConfig
 * getPrimaryControlsRight) and the "Create New Version" side-nav entry
 * (useWorkflowNavigationConfigOJS#getPublicationVersionItems). Note
 * the gate is belt-and-braces for a section editor — the SUB_EDITOR
 * role alone is already below canPublish's MANAGER bar — which mirrors
 * the legacy Cypress coverage (AmwandengaSubmission test 11 used
 * sberardo the same way); dbarnes (Journal editor group = MANAGER
 * role, no recommendOnly flag) is the positive control.
 */

const DECISION = {
	ACCEPT: 2, // Decision::ACCEPT
	RECOMMEND_ACCEPT: 9, // Decision::RECOMMEND_ACCEPT
};
const WORKFLOW_STAGE_ID_EDITING = 4;

const DBARNES_EMAIL = 'dbarnes@mailinator.com';

function uniqueTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

/** The workflow page's hosting side-modal. */
function workflowModal(page) {
	return page.locator('[data-cy="active-modal"]').first();
}

test.describe('Recommend-only editor gates', () => {
	// Row 3
	test('deciding editor is notified and acts on the recommendation', {tag: ['@regression', '@slow']}, async ({pkpApi, pkpMail, asUser}) => {
		// Two decision wizards (each with an email-template load) plus
		// several workflow-page loads — give it the slow budget.
		test.slow();
		const tag = uniqueTag('rgate3');
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				participants: [
					{user: 'dbarnes', role: 'editor'},
					{user: 'minoue', role: 'sectionEditor', recommendOnly: true},
				],
			}),
		);

		// --- minoue records Recommend Accept with a unique marker. ------
		const minoueCtx = await asUser('minoue');
		const minouePage = await minoueCtx.newPage();
		const minoueWorkflow = new EditorialWorkflowPage(minouePage);
		await minoueWorkflow.goto(submission.id);
		await expect(
			minouePage
				.getByRole('button', {name: 'Recommend Accept', exact: true})
				.first(),
		).toBeVisible({timeout: 15_000});
		await minoueWorkflow.clickDecision('Recommend Accept');
		// Single step: Notify Editors (id `discussion`). Replace the
		// precompiled body with the marker message — the same body lands
		// in the editors' email and the discussion head note.
		await minoueWorkflow.setDecisionEmailBody(
			'discussion',
			`<p>I recommend accepting this submission. ${tag}</p>`,
		);
		await minoueWorkflow.recordDecision(
			'Your recommendation has been recorded',
		);
		await minoueWorkflow.viewSubmissionFromCompletionDialog(submission.id);

		// --- The Notify Editors message reaches the deciding editor. ----
		// Scoped by recipient + the marker we typed (principle 8).
		const messages = await pkpMail.find({
			to: DBARNES_EMAIL,
			contains: tag,
			timeoutMs: 20_000,
		});
		expect(
			messages.some((m) => /Editor Recommendation/i.test(m.Subject)),
			'EDITOR_RECOMMENDATION subject reaches dbarnes',
		).toBe(true);

		// --- dbarnes records the real decision. --------------------------
		const editorCtx = await asUser('dbarnes');
		const editorPage = await editorCtx.newPage();
		const editorWorkflow = new EditorialWorkflowPage(editorPage);
		await editorWorkflow.goto(submission.id);
		// The deciding editor sees the recommendation listing before
		// acting on it.
		await expect(
			editorPage
				.locator('[data-cy="workflow-secondary-items"]')
				.filter({hasText: 'Recommendation'}),
		).toBeVisible({timeout: 15_000});
		await editorWorkflow.clickDecision('Accept Submission');
		await editorWorkflow.clickContinue(); // notifyAuthors → promote files
		await editorWorkflow.recordDecision('has been accepted for publication');
		await editorWorkflow.viewSubmissionFromCompletionDialog(submission.id);

		// Decision history holds the recommendation AND the final accept.
		const decisions = await editorWorkflow.fetchDecisions(submission.id);
		expect(
			decisions.some((d) => d.decision === DECISION.RECOMMEND_ACCEPT),
			'RECOMMEND_ACCEPT decision row exists',
		).toBe(true);
		expect(
			decisions.some((d) => d.decision === DECISION.ACCEPT),
			'ACCEPT decision row exists',
		).toBe(true);
		const sub = await editorWorkflow.fetchSubmission(submission.id);
		expect(sub.stageId).toBe(WORKFLOW_STAGE_ID_EDITING);

		// --- minoue's view reflects the recorded state. ------------------
		// Back on the review round, the recommend-only panel shows the
		// recorded recommendation (with a Change-decision affordance)
		// instead of the Recommend buttons.
		await minoueWorkflow.goto(submission.id);
		await minoueWorkflow.openReviewRoundPanel(1);
		const actionItems = minoueWorkflow.actionItems();
		await expect(
			actionItems.getByRole('heading', {name: 'Recommendation', exact: true}),
		).toBeVisible({timeout: 15_000});
		await expect(actionItems).toContainText('Accept Submission');
		await expect(
			actionItems.getByRole('button', {name: 'Change decision', exact: true}),
		).toBeVisible();
		await expect(
			minouePage.getByRole('button', {name: 'Recommend Accept', exact: true}),
		).toHaveCount(0);
	});

	// Row 4
	test('recommend-only gate extends to publication actions', {tag: '@regression'}, async ({pkpApi, asUser}) => {
		const tag = uniqueTag('rgate4');
		const {submission} = await pkpApi.createSubmission(
			submissionPublished({
				tag,
				participants: [
					{user: 'dbarnes', role: 'editor'},
					{user: 'minoue', role: 'sectionEditor', recommendOnly: true},
				],
			}),
		);

		// --- minoue: publication panels render, publish powers don't. ---
		const minoueCtx = await asUser('minoue');
		const minouePage = await minoueCtx.newPage();
		const minoueWorkflow = new EditorialWorkflowPage(minouePage);
		await minoueWorkflow.goto(submission.id);
		await minoueWorkflow.openPublicationPanel('Title & Abstract');
		// Positive anchors bounding the negatives: the published-version
		// status pill and the published-publication edit warning both
		// render for any user with publication access.
		await expect(
			workflowModal(minouePage).getByText('Published', {exact: true}).first(),
		).toBeVisible({timeout: 15_000});
		await expect(
			workflowModal(minouePage).getByText(
				'Warning: This version has been published. Editing it may impact the published content.',
			),
		).toBeVisible();
		// canPublish=false (recommend-only production assignment): no
		// Unpublish control, no Create New Version nav entry.
		await expect(
			workflowModal(minouePage).getByRole('button', {
				name: 'Unpublish',
				exact: true,
			}),
		).toHaveCount(0);
		await expect(
			workflowModal(minouePage)
				.locator('nav')
				.getByText('Create New Version', {exact: true}),
		).toHaveCount(0);

		// --- dbarnes keeps both controls on the same submission. --------
		const editorCtx = await asUser('dbarnes');
		const editorPage = await editorCtx.newPage();
		const editorWorkflow = new EditorialWorkflowPage(editorPage);
		await editorWorkflow.goto(submission.id);
		await editorWorkflow.openPublicationPanel('Title & Abstract');
		await expect(
			workflowModal(editorPage).getByRole('button', {
				name: 'Unpublish',
				exact: true,
			}),
		).toBeVisible({timeout: 15_000});
		await expect(
			workflowModal(editorPage)
				.locator('nav')
				.getByText('Create New Version', {exact: true}),
		).toBeVisible();
	});
});
