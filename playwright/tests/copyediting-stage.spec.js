// @ts-check
const {test, expect} = require('../../../../playwright/support/fixtures.js');
const {EditorialWorkflowPage} = require('../../../../playwright/pages/EditorialWorkflowPage.js');
const {ParticipantManagerPage} = require('../pages/ParticipantManagerPage.js');
const {DashboardPage} = require('../pages/DashboardPage.js');
const {FileStagePanel, fixtureFilePath} = require('../pages/FileStagePanel.js');

/**
 * Copyediting stage — docs/e2e/plans/copyediting-stage.md (8 rows).
 * Absorbs lib/pkp/playwright/tests/decision-send-to-production.spec.js
 * (row 6).
 *
 * Covers the WORKFLOW_STAGE_ID_EDITING surface: the copyeditor's view
 * of the stage, the editing-status notification lifecycle
 * (PKPEditingProductionStatusNotificationManager), staging final-draft
 * files via Upload/Select, the copyedited-file upload round-trip
 * (copyeditor → editor → author), and the stage's two decisions
 * (Send To Production / Back from Copyediting).
 *
 * UI labels verified against live sources (don't trust the plan rows
 * verbatim — see Principles "verify before trusting"):
 *  - Final Draft Files panel title is "Draft Files" (submission.finalDraft).
 *  - The copyedited panel's Upload/Select dialog is titled
 *    "Upload Review File" (uploadSelectTitleKey reuse) and its stacked
 *    wizard "Upload Copyedited File" (AddFileLinkAction::_getTextLabels).
 *  - Back-from-copyediting's button label is "Move to Review"
 *    (editor.submission.decision.backFromCopyediting) even when no
 *    review round exists and the decision returns the submission to
 *    the Submission stage (BackFromCopyediting::getNewStageId).
 *
 * Seeding deviation (row 2): the plan suggested decisions
 * [skipExternalReview], but Decision\Repository::getSubmissionNotificationTypes
 * only syncs ASSIGN_COPYEDITOR/AWAITING_COPYEDITS for ACCEPT and
 * SEND_TO_PRODUCTION — a skip-review transition never creates the
 * "assign a copyeditor" notification (app quirk, recorded in
 * docs/e2e/app-changes.md §2). Row 2 seeds [sendExternalReview, accept]
 * instead so the notification exists to flip. The flip itself is
 * triggered by the assign-participant NOTIFY message: only
 * PKPStageParticipantNotifyForm::sendMessage (which needs a non-empty
 * message and creates the stage discussion) re-syncs the notification —
 * a silent assignment doesn't.
 *
 * File-stage grid/upload interactions live in the new
 * lib/pkp/playwright/pages/FileStagePanel.js POM (owned by this plan
 * pair); participant assignment reuses ParticipantManagerPage.
 */

/** Random-suffix tag — whitespace-free, unique per run + worker. */
function uniqueTag(prefix) {
	const rand = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${test.info().parallelIndex}-${rand}`;
}

/**
 * A submission sitting at WORKFLOW_STAGE_ID_EDITING. Default route is
 * the skipExternalReview decision (no review round needed). atester
 * submits so author-side steps (notifyAuthors email step, author view)
 * have a workable login (see users.md on why atester).
 *
 * @param {{tag: string, title: string, submitter?: string,
 *   participants?: Array<{user: string, role: string}>,
 *   decisions?: Array<{type: string, by: string}>}} opts
 */
function copyeditStageSpec({tag, title, submitter = 'atester', participants, decisions}) {
	return {
		tag,
		journal: 'publicknowledge',
		submitter,
		section: 'ART',
		locale: 'en',
		participants: participants ?? [{user: 'dbarnes', role: 'editor'}],
		decisions: decisions ?? [{type: 'skipExternalReview', by: 'dbarnes'}],
		publications: [
			{
				metadata: {
					title: {en: title},
					abstract: {en: '<p>Copyediting-stage e2e submission.</p>'},
				},
			},
		],
	};
}

// Matches lib/pkp/classes/submission/PKPSubmission.php,
// decision/Decision.php, submissionFile/SubmissionFile.php — verified.
const pkpConst = {
	STATUS_QUEUED: 1,
	WORKFLOW_STAGE_ID_SUBMISSION: 1,
	WORKFLOW_STAGE_ID_PRODUCTION: 5,
	DECISION_SEND_TO_PRODUCTION: 7,
	DECISION_SKIP_EXTERNAL_REVIEW: 17,
	DECISION_BACK_FROM_COPYEDITING: 30,
	SUBMISSION_FILE_FINAL: 6,
	SUBMISSION_FILE_COPYEDIT: 9,
	SUBMISSION_FILE_PRODUCTION_READY: 11,
};

/** GET the submission's files for a stage with a logged-in context. */
async function fetchFiles(requestContext, submissionId, fileStage) {
	const res = await requestContext.get(
		`/index.php/publicknowledge/api/v1/submissions/${submissionId}/files?fileStages[]=${fileStage}`,
	);
	expect(res.ok(), `GET files (stage ${fileStage}): ${res.status()}`).toBe(true);
	const body = await res.json();
	return body.items || body;
}

test.describe('Copyediting stage', () => {
	// Multi-actor flows here stack scenario seeding + several full
	// workflow-page loads + legacy wizard round-trips; under parallel
	// load (multiple suite runs sharing the per-port PHP dev servers)
	// individual requests see multi-second tails, which can push a
	// healthy test past the default 60s. Raise the ceiling — not a
	// wait; fast runs finish as fast as before.
	test.describe.configure({timeout: 120_000});

	// Row 1
	test('copyeditor opens an assigned copyediting-stage submission', async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag('cps1');
		const title = `Vced1-${tag}`;
		const {submission} = await pkpApi.createSubmission(
			copyeditStageSpec({
				tag,
				title,
				participants: [
					{user: 'dbarnes', role: 'editor'},
					{user: 'mfritz', role: 'copyeditor'},
				],
			}),
		);

		const ctx = await asUser('mfritz');
		const page = await ctx.newPage();

		// The submission shows up on the copyeditor's editorial dashboard
		// (assistants get the assigned-to-me view).
		const dashboard = new DashboardPage(page);
		await dashboard.gotoEditorial({view: 'assigned-to-me'});
		await dashboard.search(tag);
		const row = dashboard.row(title);
		await expect(row).toBeVisible({timeout: 15_000});
		await expect(row).toContainText('Copyediting'); // stage bubble

		// Open the workflow modal from the row.
		await row.getByRole('button', {name: 'View', exact: true}).click();
		await expect(page).toHaveURL(
			new RegExp(`workflowSubmissionId=${submission.id}`),
		);

		// The copyediting stage renders all four panels for the assistant.
		await new FileStagePanel(page, 'Draft Files').expectVisible();
		await new FileStagePanel(page, 'Copyedited Files').expectVisible();
		await expect(
			page.locator('[data-cy="discussion-manager"]'),
		).toBeVisible({timeout: 15_000});
		await expect(
			page.locator('[data-cy="participant-manager"]'),
		).toBeVisible({timeout: 15_000});

		// Assistants get no available editorial decisions: no Send To
		// Production action (panels above bound the page load).
		const workflow = new EditorialWorkflowPage(page);
		await expect(
			workflow
				.actionItems()
				.getByRole('button', {name: 'Send To Production', exact: true}),
		).toHaveCount(0);
	});

	// Row 2 — seeded via accept (not skipExternalReview); see header.
	test('editing-status notification flips when a copyeditor is assigned', async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag('cps2');
		const {submission} = await pkpApi.createSubmission(
			copyeditStageSpec({
				tag,
				title: `Vced2-${tag}`,
				decisions: [
					{type: 'sendExternalReview', by: 'dbarnes'},
					{type: 'accept', by: 'dbarnes'},
				],
			}),
		);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		// The accept decision synced the editing-stage status notification
		// for the assigned editor (notification.type.assignCopyeditors).
		const modal = workflow.workflowModal();
		const assignPrompt = modal.getByText(
			'Assign a copyeditor using the Assign link in the Participants list.',
		);
		await expect(assignPrompt).toBeVisible({timeout: 20_000});

		// Assign mfritz (Copyeditor group) WITH a notify message — the
		// message is what creates the editing-stage discussion and
		// re-syncs the notification (silent assignments don't flip it).
		const pm = new ParticipantManagerPage(page);
		await pm.assignParticipant({
			userGroup: 'Copyeditor',
			nameSearch: 'Fritz',
			fullName: 'Maria Fritz',
			notify: {message: `<p>Please copyedit this submission ${tag}</p>`},
		});

		// The panel refetches notifications on data-change: the prompt
		// flips to "Awaiting Copyedits." (notification.type.awaitingCopyedits).
		await expect(modal.getByText('Awaiting Copyedits.')).toBeVisible({
			timeout: 20_000,
		});
		await expect(assignPrompt).toHaveCount(0);
	});

	// Row 3
	test('editor stages the final-draft file via Upload/Select', async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag('cps3');
		const {submission} = await pkpApi.createSubmission(
			copyeditStageSpec({tag, title: `Vced3-${tag}`}),
		);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		// "Upload/Select Files" on Draft Files opens the
		// ManageFinalDraftFilesGridHandler selectFiles modal: a category
		// grid of the submission's files. The seeded submission-stage
		// Article Text (default-article.pdf) is listed; selecting it and
		// saving imports it into SUBMISSION_FILE_FINAL.
		const panel = new FileStagePanel(page, 'Draft Files');
		await panel.expectVisible();
		const modal = await panel.openUploadSelect('Upload/Select Files');
		// The grid defaults to the panel's own stage — reveal the
		// submission-stage category first.
		await panel.showAllStages(modal);
		await panel.ensureFileSelected(modal, 'default-article.pdf');
		await panel.saveUploadSelect(modal);

		// The imported file renders in the Draft Files panel...
		await expect(panel.row('default-article.pdf')).toBeVisible({
			timeout: 20_000,
		});

		// ...and exists at the FINAL file stage via REST.
		const finalFiles = await fetchFiles(
			page.request,
			submission.id,
			pkpConst.SUBMISSION_FILE_FINAL,
		);
		expect(finalFiles.length).toBe(1);
		expect(JSON.stringify(finalFiles[0].name)).toContain('default-article.pdf');
	});

	// Row 4
	test('copyeditor uploads the copyedited file; editor sees and downloads it', async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag('cps4');
		const displayName = `copyedited-${tag}.pdf`;
		const {submission} = await pkpApi.createSubmission(
			copyeditStageSpec({
				tag,
				title: `Vced4-${tag}`,
				participants: [
					{user: 'dbarnes', role: 'editor'},
					{user: 'mfritz', role: 'copyeditor'},
				],
			}),
		);

		// --- mfritz uploads into Copyedited Files --------------------------
		const copyeditorCtx = await asUser('mfritz');
		const copyeditorPage = await copyeditorCtx.newPage();
		await new EditorialWorkflowPage(copyeditorPage).goto(submission.id);

		const copyeditorPanel = new FileStagePanel(copyeditorPage, 'Copyedited Files');
		await copyeditorPanel.expectVisible();
		await copyeditorPanel.uploadViaUploadSelect({
			selectTitle: 'Upload Review File',
			wizardTitle: 'Upload Copyedited File',
			filePath: fixtureFilePath(),
			displayName,
		});

		// --- dbarnes sees the row: name, type (genre badge), date ----------
		const editorCtx = await asUser('dbarnes');
		const editorPage = await editorCtx.newPage();
		await new EditorialWorkflowPage(editorPage).goto(submission.id);

		const editorPanel = new FileStagePanel(editorPage, 'Copyedited Files');
		await editorPanel.expectVisible();
		const row = editorPanel.row(displayName);
		await expect(row).toBeVisible({timeout: 20_000});
		await expect(row).toContainText('Article Text'); // type badge
		await expect(row).toContainText(/\d{4}/); // upload date (year)

		// --- download round-trips ------------------------------------------
		const href = await editorPanel.fileLink(displayName).getAttribute('href');
		expect(href, 'file row should expose a download url').toBeTruthy();
		const download = await editorPage.request.get(String(href));
		expect(download.ok(), `download: ${download.status()}`).toBe(true);
		expect(download.headers()['content-type']).toContain('pdf');

		// REST: the file sits at SUBMISSION_FILE_COPYEDIT.
		const copyeditFiles = await fetchFiles(
			editorPage.request,
			submission.id,
			pkpConst.SUBMISSION_FILE_COPYEDIT,
		);
		expect(copyeditFiles.length).toBe(1);
		expect(JSON.stringify(copyeditFiles[0].name)).toContain(displayName);
	});

	// Row 5
	test('author sees copyedited files read-only and can download', async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag('cps5');
		const displayName = `authorcheck-${tag}.pdf`;
		const {submission} = await pkpApi.createSubmission(
			copyeditStageSpec({
				tag,
				title: `Vced5-${tag}`,
				submitter: 'atester',
				participants: [
					{user: 'dbarnes', role: 'editor'},
					{user: 'mfritz', role: 'copyeditor'},
				],
			}),
		);

		// mfritz stages the copyedited file via the UI (one-off state —
		// Principles §3).
		const copyeditorCtx = await asUser('mfritz');
		const copyeditorPage = await copyeditorCtx.newPage();
		await new EditorialWorkflowPage(copyeditorPage).goto(submission.id);
		const copyeditorPanel = new FileStagePanel(copyeditorPage, 'Copyedited Files');
		await copyeditorPanel.expectVisible();
		await copyeditorPanel.uploadViaUploadSelect({
			selectTitle: 'Upload Review File',
			wizardTitle: 'Upload Copyedited File',
			filePath: fixtureFilePath(),
			displayName,
		});

		// atester's author view of the copyediting stage
		// (workflowConfigAuthorOJS: Discussions + Copyedited Files with
		// FILE_LIST only — no upload, no per-row actions).
		const authorCtx = await asUser('atester');
		const authorPage = await authorCtx.newPage();
		await authorPage.goto(
			`/index.php/publicknowledge/en/dashboard/mySubmissions?workflowSubmissionId=${submission.id}`,
		);

		const authorPanel = new FileStagePanel(authorPage, 'Copyedited Files');
		await authorPanel.expectVisible();
		await expect(authorPanel.row(displayName)).toBeVisible({timeout: 20_000});

		// FILE_LIST only: no Upload/Select control, no More Actions menu.
		await expect(
			authorPanel
				.root()
				.getByRole('button', {name: 'Upload/Select Files', exact: true}),
		).toHaveCount(0);
		await expect(
			authorPanel.root().getByRole('button', {name: /More Actions/}),
		).toHaveCount(0);
		// The author's editing view carries no Draft Files panel at all.
		await expect(
			authorPage.getByRole('table', {name: 'Draft Files', exact: true}),
		).toHaveCount(0);

		// The author can download the copyedited file.
		const href = await authorPanel.fileLink(displayName).getAttribute('href');
		expect(href, 'author row should expose a download url').toBeTruthy();
		const download = await authorPage.request.get(String(href));
		expect(download.ok(), `author download: ${download.status()}`).toBe(true);
		expect(download.headers()['content-type']).toContain('pdf');
	});

	// Row 6 — absorbed from decision-send-to-production.spec.js.
	// SendToProduction has two steps (notifyAuthors + promoteFiles), so
	// the wizard shape is Continue → Record Decision.
	test('editor sends a copyediting-stage submission to production', async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag('cps6');
		const {submission} = await pkpApi.createSubmission(
			copyeditStageSpec({tag, title: `Vced6-${tag}`}),
		);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		// "Send To Production" is the copyediting-stage primary decision.
		await expect(
			workflow
				.actionItems()
				.getByRole('button', {name: 'Send To Production', exact: true}),
		).toBeVisible({timeout: 20_000});

		await workflow.clickDecision('Send To Production');
		await workflow.clickContinue(); // past the notifyAuthors email step
		await workflow.recordDecision('was sent to the production stage');
		await workflow.viewSubmissionFromCompletionDialog(submission.id);

		// Stage-advance assertion via REST — decoupled from the exact
		// workflow-page indicator.
		const after = await workflow.fetchSubmission(submission.id);
		expect(after.stageId).toBe(pkpConst.WORKFLOW_STAGE_ID_PRODUCTION);
		expect(after.status).toBe(pkpConst.STATUS_QUEUED);

		// Decision row recorded.
		const decisions = await workflow.fetchDecisions(submission.id);
		expect(
			decisions.some(
				(d) => d.decision === pkpConst.DECISION_SEND_TO_PRODUCTION,
			),
		).toBe(true);
	});

	// Row 7 — notify-authors email (Mailpit, scoped recipient + marker;
	// Principles §8) + file promotion to Production Ready Files.
	test('Send To Production promotes files and notifies the author', async ({
		pkpApi,
		pkpMail,
		asUser,
	}) => {
		const tag = uniqueTag('cps7');
		const displayName = `promote-${tag}.pdf`;
		const marker = `promote-marker-${tag}`;
		const {submission} = await pkpApi.createSubmission(
			copyeditStageSpec({
				tag,
				title: `Vced7-${tag}`,
				submitter: 'atester',
				participants: [
					{user: 'dbarnes', role: 'editor'},
					{user: 'mfritz', role: 'copyeditor'},
				],
			}),
		);

		// Stage a copyedited file via the UI — the promote step's
		// "Copyedited" list is selected by default (PromoteFiles::addFileList).
		const copyeditorCtx = await asUser('mfritz');
		const copyeditorPage = await copyeditorCtx.newPage();
		await new EditorialWorkflowPage(copyeditorPage).goto(submission.id);
		const copyeditorPanel = new FileStagePanel(copyeditorPage, 'Copyedited Files');
		await copyeditorPanel.expectVisible();
		await copyeditorPanel.uploadViaUploadSelect({
			selectTitle: 'Upload Review File',
			wizardTitle: 'Upload Copyedited File',
			filePath: fixtureFilePath(),
			displayName,
		});

		// Editor drives the decision with a marked notify-authors body.
		const editorCtx = await asUser('dbarnes');
		const editorPage = await editorCtx.newPage();
		const workflow = new EditorialWorkflowPage(editorPage);
		await workflow.goto(submission.id);

		await workflow.clickDecision('Send To Production');
		await workflow.setDecisionEmailBody(
			'notifyAuthors',
			`<p>Your submission is moving to production. ${marker}</p>`,
		);
		await workflow.clickContinue();

		// Promote step: the staged copyedited file is listed (and selected
		// by default) before recording.
		await expect(editorPage.getByText(displayName).first()).toBeVisible({
			timeout: 15_000,
		});
		await workflow.recordDecision('was sent to the production stage');
		await workflow.viewSubmissionFromCompletionDialog(submission.id);

		// Mailpit — scoped by recipient + unique marker (no clearAll).
		await pkpMail.find({
			to: 'atester@mailinator.com',
			contains: marker,
			timeoutMs: 20_000,
		});

		// The promoted file appears in Production Ready Files (UI + REST).
		const productionPanel = new FileStagePanel(editorPage, 'Production Ready Files');
		await productionPanel.expectVisible();
		await expect(productionPanel.row(displayName)).toBeVisible({
			timeout: 20_000,
		});
		const productionFiles = await fetchFiles(
			editorPage.request,
			submission.id,
			pkpConst.SUBMISSION_FILE_PRODUCTION_READY,
		);
		expect(
			productionFiles.some((f) =>
				JSON.stringify(f.name).includes(displayName),
			),
		).toBe(true);
	});

	// Row 8 — no review round (skipExternalReview), so the decision
	// returns the submission to the Submission stage. The button label
	// stays "Move to Review" (static decision label).
	test('back from copyediting returns the submission to the submission stage', async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag('cps8');
		const title = `Vced8-${tag}`;
		const {submission} = await pkpApi.createSubmission(
			copyeditStageSpec({tag, title}),
		);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		// Single wizard step (notifyAuthors — the submitter is an author
		// participant), so Record Decision follows directly.
		await workflow.clickDecision('Move to Review');
		await workflow.recordDecision('was sent back from the copyediting stage');
		await workflow.viewSubmissionFromCompletionDialog(submission.id);

		// Stage flipped back to Submission (no review round to return to).
		const after = await workflow.fetchSubmission(submission.id);
		expect(after.stageId).toBe(pkpConst.WORKFLOW_STAGE_ID_SUBMISSION);

		// The workflow page reflects it: submission-stage decisions are
		// offered again.
		await expect(
			workflow
				.actionItems()
				.getByRole('button', {name: 'Send for Review', exact: true}),
		).toBeVisible({timeout: 20_000});

		// Decision history retains both the skip-review promotion and the
		// back-from-copyediting return.
		const decisions = await workflow.fetchDecisions(submission.id);
		expect(
			decisions.some(
				(d) => d.decision === pkpConst.DECISION_BACK_FROM_COPYEDITING,
			),
		).toBe(true);
		expect(
			decisions.some(
				(d) => d.decision === pkpConst.DECISION_SKIP_EXTERNAL_REVIEW,
			),
		).toBe(true);

		// Dashboard stage column reflects the return.
		const dashboard = new DashboardPage(page);
		await dashboard.gotoEditorial({view: 'assigned-to-me'});
		await dashboard.search(tag);
		const row = dashboard.row(title);
		await expect(row).toBeVisible({timeout: 15_000});
		await expect(row).toContainText('Submission');
	});
});
