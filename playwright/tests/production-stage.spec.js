// @ts-check
const {test, expect} = require('../../../../playwright/support/fixtures.js');
const {EditorialWorkflowPage} = require('../../../../playwright/pages/EditorialWorkflowPage.js');
const {ParticipantManagerPage} = require('../pages/ParticipantManagerPage.js');
const {DashboardPage} = require('../pages/DashboardPage.js');
const {FileStagePanel, fixtureFilePath} = require('../pages/FileStagePanel.js');

/**
 * Production stage — docs/e2e/plans/production-stage.md (6 rows).
 *
 * Covers the WORKFLOW_STAGE_ID_PRODUCTION surface: the production
 * status notification lifecycle (assign-a-galley-user → awaiting
 * galleys), the layout editor's Production Ready Files upload +
 * Download All archive, the assistant's stripped-down editor controls,
 * the Schedule For Publication handoff into the Publication tab, the
 * Back to Copyediting decision, and the author's discussion-only view.
 *
 * Out of scope per the plan: galley CRUD (galleys plan), the actual
 * publish flow + issue assignment (publication-publish-flow /
 * issue-assignment-scheduling), Schedule For Publication's
 * updateType/summary fields (publication-amendments), participant
 * mechanics (stage-participants).
 *
 * UI labels verified against live sources:
 *  - Back-to-copyediting button label is "Move To Copyediting"
 *    (editor.submission.decision.backToCopyediting).
 *  - The direct upload wizard is titled "Upload a Production Ready
 *    File" (submission.upload.productionReady).
 *  - The status notification flip needs a production-stage discussion:
 *    only an assignment WITH a notify message
 *    (PKPStageParticipantNotifyForm::sendMessage) re-syncs
 *    ASSIGN_PRODUCTIONUSER → AWAITING_REPRESENTATIONS; a silent
 *    assignment doesn't (same quirk as the copyediting flip).
 *
 * File-stage grid/upload interactions live in the
 * lib/pkp/playwright/pages/FileStagePanel.js POM (owned by this plan
 * pair); participant assignment reuses ParticipantManagerPage.
 */

/** Random-suffix tag — whitespace-free, unique per run + worker. */
function uniqueTag(prefix) {
	const rand = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${test.info().parallelIndex}-${rand}`;
}

/**
 * A submission sitting at WORKFLOW_STAGE_ID_PRODUCTION via the
 * skipExternalReview → sendToProduction decision chain (no review
 * round needed). The sendToProduction decision also seeds the
 * ASSIGN_PRODUCTIONUSER notification for the assigned editors
 * (Decision\Repository::getSubmissionNotificationTypes).
 *
 * @param {{tag: string, title: string, submitter?: string,
 *   participants?: Array<{user: string, role: string}>}} opts
 */
function productionStageSpec({tag, title, submitter = 'atester', participants}) {
	return {
		tag,
		journal: 'publicknowledge',
		submitter,
		section: 'ART',
		locale: 'en',
		participants: participants ?? [{user: 'dbarnes', role: 'editor'}],
		decisions: [
			{type: 'skipExternalReview', by: 'dbarnes'},
			{type: 'sendToProduction', by: 'dbarnes'},
		],
		publications: [
			{
				metadata: {
					title: {en: title},
					abstract: {en: '<p>Production-stage e2e submission.</p>'},
				},
			},
		],
	};
}

// Matches lib/pkp/classes/decision/Decision.php + workflow stage
// constants — verified against live sources.
const pkpConst = {
	WORKFLOW_STAGE_ID_EDITING: 4,
	DECISION_SEND_TO_PRODUCTION: 7,
	DECISION_BACK_FROM_PRODUCTION: 29,
	SUBMISSION_FILE_PRODUCTION_READY: 11,
};

test.describe('Production stage', () => {
	// See copyediting-stage.spec.js: heavy multi-actor flows under
	// parallel server load need more headroom than the 60s default.
	// A ceiling, not a wait.
	test.describe.configure({timeout: 120_000});

	// Row 1
	test('production status notification flips when a layout editor is assigned', async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag('prs1');
		const title = `Vprd1-${tag}`;
		const {submission} = await pkpApi.createSubmission(
			productionStageSpec({tag, title}),
		);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		// sendToProduction seeded the production status notification
		// (notification.type.assignProductionUser).
		const modal = workflow.workflowModal();
		const assignPrompt = modal.getByText(
			'Assign a user to create galleys using the Assign link in the Participants list.',
		);
		await expect(assignPrompt).toBeVisible({timeout: 20_000});

		// Assign gcox (Layout Editor group) WITH a notify message — the
		// message creates the production-stage discussion that flips the
		// notification.
		const pm = new ParticipantManagerPage(page);
		await pm.assignParticipant({
			userGroup: 'Layout Editor',
			nameSearch: 'Cox',
			fullName: 'Graham Cox',
			notify: {message: `<p>Please prepare galleys ${tag}</p>`},
		});

		// Flip: awaiting galleys (notification.type.awaitingRepresentations).
		await expect(modal.getByText('Awaiting Galleys.')).toBeVisible({
			timeout: 20_000,
		});
		await expect(assignPrompt).toHaveCount(0);

		// gcox now sees the submission on their dashboard.
		const layoutEditorCtx = await asUser('gcox');
		const layoutEditorPage = await layoutEditorCtx.newPage();
		const dashboard = new DashboardPage(layoutEditorPage);
		await dashboard.gotoEditorial({view: 'assigned-to-me'});
		await dashboard.search(tag);
		const row = dashboard.row(title);
		await expect(row).toBeVisible({timeout: 15_000});
		await expect(row).toContainText('Production');
	});

	// Row 2
	test('layout editor uploads a production-ready file; editor sees it and downloads all', async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag('prs2');
		const displayName = `prodready-${tag}.pdf`;
		const {submission} = await pkpApi.createSubmission(
			productionStageSpec({
				tag,
				title: `Vprd2-${tag}`,
				participants: [
					{user: 'dbarnes', role: 'editor'},
					{user: 'gcox', role: 'layoutEditor'},
				],
			}),
		);

		// --- gcox uploads via the direct (FILE_UPLOAD) wizard --------------
		const layoutEditorCtx = await asUser('gcox');
		const layoutEditorPage = await layoutEditorCtx.newPage();
		await new EditorialWorkflowPage(layoutEditorPage).goto(submission.id);

		const layoutPanel = new FileStagePanel(layoutEditorPage, 'Production Ready Files');
		await layoutPanel.expectVisible();
		const wizard = await layoutPanel.openDirectUploadWizard(
			'Upload a Production Ready File',
		);
		await layoutPanel.driveUploadWizard(wizard, {
			filePath: fixtureFilePath(),
			displayName,
		});
		await expect(layoutPanel.row(displayName)).toBeVisible({timeout: 20_000});

		// --- dbarnes sees the row (name, date, type) ------------------------
		const editorCtx = await asUser('dbarnes');
		const editorPage = await editorCtx.newPage();
		await new EditorialWorkflowPage(editorPage).goto(submission.id);

		const editorPanel = new FileStagePanel(editorPage, 'Production Ready Files');
		await editorPanel.expectVisible();
		const row = editorPanel.row(displayName);
		await expect(row).toBeVisible({timeout: 20_000});
		await expect(row).toContainText('Article Text'); // type badge
		await expect(row).toContainText(/\d{4}/); // upload date (year)

		// --- Download All renders once a file exists; archive responds -----
		// downloadAllFiles serves a zip named
		// `{submissionId}-{nameLocaleKey}.zip`.
		const download = await editorPanel.downloadAll();
		expect(download.suggestedFilename()).toMatch(/production-ready-files\.zip$/i);
		// failure() resolves null for a completed download.
		expect(await download.failure()).toBeNull();
	});

	// Row 3
	test('layout editor sees production panels without editor controls', async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag('prs3');
		const {submission} = await pkpApi.createSubmission(
			productionStageSpec({
				tag,
				title: `Vprd3-${tag}`,
				participants: [
					{user: 'dbarnes', role: 'editor'},
					{user: 'gcox', role: 'layoutEditor'},
				],
			}),
		);

		const ctx = await asUser('gcox');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		// All three production panels render for the assistant.
		await new FileStagePanel(page, 'Production Ready Files').expectVisible();
		await expect(
			page.locator('[data-cy="discussion-manager"]'),
		).toBeVisible({timeout: 15_000});
		const participantManager = page.locator('[data-cy="participant-manager"]');
		await expect(participantManager).toBeVisible({timeout: 15_000});

		// No Back to Copyediting decision (assistants get no available
		// decisions)...
		await expect(
			workflow
				.actionItems()
				.getByRole('button', {name: 'Move To Copyediting', exact: true}),
		).toHaveCount(0);

		// ...and no Assign button on the Participants panel (gated to
		// manager / sub-editor / admin in useParticipantManagerConfig).
		await expect(
			participantManager.getByRole('button', {name: 'Assign', exact: true}),
		).toHaveCount(0);
	});

	// Row 4 — handoff only; the publish flow itself is owned by the
	// publication-publish-flow plan.
	test('Schedule For Publication hands off to the Publication tab', async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag('prs4');
		const {submission} = await pkpApi.createSubmission(
			productionStageSpec({tag, title: `Vprd4-${tag}`}),
		);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		// The production-stage action button navigates to the Publication
		// menu's Title & Abstract panel (action: navigateToMenu).
		await workflow
			.actionItems()
			.getByRole('button', {name: 'Schedule For Publication', exact: true})
			.click();

		const modal = workflow.workflowModal();
		await expect(
			modal.getByRole('heading', {name: /Title & Abstract/}),
		).toBeVisible({timeout: 20_000});

		// The publish entry button is present for the editor on the
		// Publication tab (publication status QUEUED + canPublish).
		await expect(
			modal
				.getByRole('button', {name: 'Schedule For Publication', exact: true})
				.first(),
		).toBeVisible({timeout: 20_000});
	});

	// Row 5
	test('back to copyediting returns the submission to the copyediting stage', async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag('prs5');
		const {submission} = await pkpApi.createSubmission(
			productionStageSpec({tag, title: `Vprd5-${tag}`}),
		);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		// Single wizard step (notifyAuthors — atester is an author
		// participant), so Record Decision follows directly.
		await workflow.clickDecision('Move To Copyediting');
		await workflow.recordDecision('was moved to the copyediting stage');
		await workflow.viewSubmissionFromCompletionDialog(submission.id);

		// REST: stage back at WORKFLOW_STAGE_ID_EDITING.
		const after = await workflow.fetchSubmission(submission.id);
		expect(after.stageId).toBe(pkpConst.WORKFLOW_STAGE_ID_EDITING);

		// UI: the copyediting panels render again.
		await new FileStagePanel(page, 'Draft Files').expectVisible();
		await new FileStagePanel(page, 'Copyedited Files').expectVisible();

		// Decision history records the return (and keeps the original
		// promotion).
		const decisions = await workflow.fetchDecisions(submission.id);
		expect(
			decisions.some(
				(d) => d.decision === pkpConst.DECISION_BACK_FROM_PRODUCTION,
			),
		).toBe(true);
		expect(
			decisions.some(
				(d) => d.decision === pkpConst.DECISION_SEND_TO_PRODUCTION,
			),
		).toBe(true);
	});

	// Row 6
	test('author view of the production stage is discussion-only', async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag('prs6');
		const {submission} = await pkpApi.createSubmission(
			productionStageSpec({tag, title: `Vprd6-${tag}`, submitter: 'atester'}),
		);

		const ctx = await asUser('atester');
		const page = await ctx.newPage();
		await page.goto(
			`/index.php/publicknowledge/en/dashboard/mySubmissions?workflowSubmissionId=${submission.id}`,
		);

		// Discussions panel renders (positive bound for the negatives
		// below)...
		await expect(
			page.locator('[data-cy="discussion-manager"]'),
		).toBeVisible({timeout: 20_000});

		// ...but per workflowConfigAuthorOJS the production stage exposes
		// neither the Production Ready Files panel nor the Participants
		// panel to authors.
		await expect(
			page.getByRole('table', {name: 'Production Ready Files', exact: true}),
		).toHaveCount(0);
		await expect(
			page.locator('[data-cy="participant-manager"]'),
		).toHaveCount(0);
	});
});
