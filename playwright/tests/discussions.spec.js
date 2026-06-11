// @ts-check
const {test, expect} = require('../support/base-test.js');
const {DiscussionManagerPage} = require('../pages/DiscussionManagerPage.js');
const {EditorialWorkflowPage} = require('../../../../playwright/pages/EditorialWorkflowPage.js');
const submissionDraft = require('../../../../playwright/fixtures/scenarios/submission-draft.js');

/**
 * Discussions — docs/e2e/plans/discussions.md (6 rows).
 *
 * The feature under test is the Discussion Manager panel
 * (lib/ui-library/src/managers/DiscussionManager) on the per-submission
 * workflow page: the discussion CRUD arc, per-stage scoping (each stage
 * panel fetches `stages/{stageId}/tasks` separately), participant-scoped
 * visibility (EditorialTaskController::getTasks lists everything for
 * managers/site admins, participant-only rows for everyone else),
 * participant notification email on create, the auto-created Stage 1
 * cover-note discussion ("Comments for the Editor",
 * Repo::editorialTask()->addCommentsForEditorsQuery fired from
 * Repo::submission()->submit()), and the author-side reply flow.
 *
 * Absorbs (rework, original deleted):
 *   - playwright/tests/discussions/discussion-manager.spec.js — the
 *     discussion half of its CRUD test → row 1 here. The task half and
 *     its permissions test moved to editorial-tasks.spec.js (see the
 *     editorial-tasks plan).
 *   - lib/pkp/playwright/tests/wizard-comments-become-discussion.spec.js
 *     — the seeded-comments coverage is owned by row 5 here (scenario
 *     `commentsForEditor` + `submitted` instead of driving the wizard);
 *     the wizard end-to-end spec itself stays with the
 *     submission-wizard-validation plan.
 *
 * Seeding: every test creates its own stage-1 submission via the
 * submission scenario (default editor/section-editor cast: dbarnes,
 * dbuskins, minoue). Discussions themselves are created through the UI —
 * creation is either the behavior under test or a one-line setup
 * (Principles §3/§4). Row 2 seeds decisions [skipExternalReview,
 * sendToProduction] to land on the Production stage.
 *
 * UI realities baked into the flows:
 *   - A discussion needs ≥2 participants; the Add form pre-checks the
 *     current user (useDiscussionManagerForm#getSelectedParticipants),
 *     so checking one more participant is enough.
 *   - Creating a discussion emails every participant: subject is the
 *     discussion title, body is the headnote + the stage mailable's
 *     "Reply to this comment at …" footer
 *     (EditorialTaskController::notifyParticipants → DiscussionSubmission
 *     at stage 1). Mail asserted via pkpMail.find scoped by recipient +
 *     the tag carried in the title/body (Principles §8, no clearAll).
 */

const DBUSKINS_EMAIL = 'dbuskins@mailinator.com';
const COVER_NOTE_TITLE = 'Comments for the Editor'; // submission.submit.coverNote

/** Workflow stage ids (lib/pkp/include/functions.php — grep-verified). */
const STAGE_EDITING = 4; // WORKFLOW_STAGE_ID_EDITING (Copyediting)
const STAGE_PRODUCTION = 5; // WORKFLOW_STAGE_ID_PRODUCTION

function uniqueTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

/** The editor-facing workflow surface for a submission. */
function editorialWorkflowUrl(submissionId) {
	return `/index.php/publicknowledge/en/dashboard/editorial?workflowSubmissionId=${submissionId}`;
}

/** The author's workflow surface for a submission. */
function authorWorkflowUrl(submissionId) {
	return `/index.php/publicknowledge/en/dashboard/mySubmissions?workflowSubmissionId=${submissionId}`;
}

/**
 * Fetch the per-stage tasks list via the same REST endpoint the manager
 * uses (`stages/{stageId}/tasks`) with the page's session cookies.
 * Returns the raw items array.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} submissionId
 * @param {number} stageId
 */
async function fetchStageTasks(page, submissionId, stageId) {
	const res = await page.request.get(
		`/index.php/publicknowledge/api/v1/submissions/${submissionId}/stages/${stageId}/tasks?orderBy=dateCreated`,
	);
	expect(res.ok(), `GET stages/${stageId}/tasks: ${res.status()}`).toBe(true);
	const body = await res.json();
	return body.items || [];
}

test.use({user: 'dbarnes'});

test.describe('Discussions', () => {
	// Row 1 — absorbed (reworked) from
	// playwright/tests/discussions/discussion-manager.spec.js (discussion
	// half of its CRUD test).
	test('discussion CRUD arc on a stage panel', {tag: '@smoke'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('disc1');
		const {submission} = await pkpApi.createSubmission(
			submissionDraft({tag}),
		);

		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		const dm = new DiscussionManagerPage(page);
		await dm.expectVisible();
		await dm.expectGroupsVisible();

		const title = `Discussion ${tag}`;
		const editedTitle = `Edited ${tag}`;
		const message = `Discussion message ${tag}`;
		const reply = `Reply message ${tag}`;

		// Create with participants + message → listed "In progress".
		let form = await dm.openAdd();
		await form.fillTitle(title);
		await form.checkParticipant('David Buskins');
		await form.checkParticipant('Minoti Inoue');
		await form.fillDescription(message);
		await form.save();
		await dm.expectInGroup(title, 'In progress');

		// Open: shows the message; reply + close in one save (the legacy
		// arc this reworks did the same — the close checkbox and the new
		// message are both committed by the display modal's Save).
		let display = await dm.openByTitle(title);
		await display.expectContains(message);
		await display.checkCloseThisDiscussion();
		await display.clickAddNewMessage();
		await display.fillReply(reply);
		await display.save();
		await display.expectContains(reply);
		await display.expectClosedLabel();
		await display.close();
		await dm.expectInGroup(title, 'Closed');

		// Reopen via the row checkbox (confirm dialog).
		await dm.toggleRowCheckbox(title);
		await dm.confirmReopen();
		await dm.expectInGroup(title, 'In progress');

		// Edit the title via row actions.
		form = /** @type {any} */ (await dm.openActions(title, 'Edit'));
		await form.fillTitle(editedTitle);
		await form.save();
		await expect(dm.row(editedTitle)).toBeVisible();

		// Delete after confirm.
		await dm.openActions(editedTitle, 'Delete');
		await dm.confirmDelete();
		await expect(dm.row(editedTitle)).toHaveCount(0);
	});

	// Row 2
	test('discussions are stage-scoped', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('disc2');
		// skipExternalReview → copyediting, sendToProduction → production:
		// two visited stages, each with its own (empty) tasks list.
		const {submission} = await pkpApi.createSubmission({
			...submissionDraft({tag}),
			decisions: [
				{type: 'skipExternalReview', by: 'dbarnes'},
				{type: 'sendToProduction', by: 'dbarnes'},
			],
		});

		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		// The workflow page lands on the active stage — Production.
		const dm = new DiscussionManagerPage(page);
		await dm.expectHeading('Production Tasks & Discussions');
		await dm.expectAllGroupsEmpty();

		// Create a discussion on the Production stage panel.
		const title = `Production discussion ${tag}`;
		const form = await dm.openAdd();
		await form.fillTitle(title);
		await form.checkParticipant('David Buskins');
		await form.fillDescription(`Production-stage body ${tag}`);
		await form.save();
		await dm.expectInGroup(title, 'In progress');

		// Switch to the Copyediting stage panel via the workflow side nav
		// — its own per-stage list starts empty and does NOT carry the
		// Production discussion. Gate the panel switch on the page's
		// "Workflow: Copyediting" heading, NOT the manager's own <h3>:
		// the in-place stage switch reuses the DiscussionManager
		// component instance and its heading is computed non-reactively
		// (DiscussionManager.vue:115 calls getDiscussionTitleByStage once
		// at setup), so it keeps reading "Production Tasks & Discussions"
		// even though the per-stage list correctly refetches — known app
		// bug, reported in the wave ledger.
		await workflow
			.workflowModal()
			.locator('nav')
			.getByText('Copyediting', {exact: true})
			.click();
		await expect(
			workflow
				.workflowModal()
				.getByRole('heading', {name: 'Workflow: Copyediting'}),
		).toBeVisible({timeout: 15_000});
		await dm.expectAllGroupsEmpty();
		await expect(dm.row(title)).toHaveCount(0);

		// Pin the per-stage fetch semantics on the REST surface the panel
		// uses: the row exists on stages/5/tasks only.
		const productionTasks = await fetchStageTasks(
			page,
			submission.id,
			STAGE_PRODUCTION,
		);
		expect(productionTasks.map((t) => t.title)).toContain(title);
		expect(productionTasks[0].stageId).toBe(STAGE_PRODUCTION);
		const copyeditingTasks = await fetchStageTasks(
			page,
			submission.id,
			STAGE_EDITING,
		);
		expect(copyeditingTasks).toHaveLength(0);
	});

	// Row 3
	test('discussion visibility is participant-scoped', {tag: '@regression'}, async ({page, pkpApi, asUser}) => {
		const tag = uniqueTag('disc3');
		const {submission} = await pkpApi.createSubmission(
			submissionDraft({tag}),
		);
		const title = `Visibility ${tag}`;

		// dbarnes creates a discussion adding only dbuskins (dbarnes is
		// pre-checked as the creator — participants are exactly the two).
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);
		const dm = new DiscussionManagerPage(page);
		await dm.expectVisible();
		const form = await dm.openAdd();
		await form.fillTitle(title);
		await form.checkParticipant('David Buskins');
		await form.fillDescription(`Visibility body ${tag}`);
		await form.save();
		await expect(dm.row(title)).toBeVisible();

		// dbuskins (discussion participant) sees it on their workflow view.
		const buskinsCtx = await asUser('dbuskins');
		const buskinsPage = await buskinsCtx.newPage();
		await buskinsPage.goto(editorialWorkflowUrl(submission.id));
		const dmBuskins = new DiscussionManagerPage(buskinsPage);
		await dmBuskins.expectVisible();
		await expect(dmBuskins.row(title)).toBeVisible({timeout: 15_000});

		// minoue (stage participant, NOT discussion participant) sees the
		// panel but not the row — getTasks filters by participant for
		// non-managers. The three "No Items" placeholders bound the
		// negative (the list fetch has settled and is empty).
		const minoueCtx = await asUser('minoue');
		const minouePage = await minoueCtx.newPage();
		await minouePage.goto(editorialWorkflowUrl(submission.id));
		const dmMinoue = new DiscussionManagerPage(minouePage);
		await dmMinoue.expectVisible();
		await dmMinoue.expectAllGroupsEmpty();
		await expect(dmMinoue.row(title)).toHaveCount(0);

		// The site admin is neither creator nor participant but lists all
		// tasks (manager branch of getTasks).
		const adminCtx = await asUser('admin');
		const adminPage = await adminCtx.newPage();
		await adminPage.goto(editorialWorkflowUrl(submission.id));
		const dmAdmin = new DiscussionManagerPage(adminPage);
		await dmAdmin.expectVisible();
		await expect(dmAdmin.row(title)).toBeVisible({timeout: 15_000});
	});

	// Row 4
	test('creating a discussion emails the added participants', {tag: '@regression'}, async ({page, pkpApi, pkpMail}) => {
		const tag = uniqueTag('disc4');
		const {submission} = await pkpApi.createSubmission(
			submissionDraft({tag}),
		);
		// Both the title (→ subject) and the body carry the tag, so the
		// Mailpit query is doubly scoped: recipient + unique marker.
		const title = `Mail discussion ${tag}`;
		const marker = `Mail marker ${tag}`;

		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);
		const dm = new DiscussionManagerPage(page);
		await dm.expectVisible();
		const form = await dm.openAdd();
		await form.fillTitle(title);
		await form.checkParticipant('David Buskins');
		await form.fillDescription(`<p>${marker}</p>`);
		await form.save();
		await expect(dm.row(title)).toBeVisible();

		// The stage-1 discussion mailable (DiscussionSubmission) goes out
		// to the added participant: subject is the discussion title, the
		// body carries the message plus the "Reply to this comment"
		// footer that links back to the workflow page.
		const messages = await pkpMail.find({
			to: DBUSKINS_EMAIL,
			contains: tag,
			timeoutMs: 20_000,
		});
		expect(messages[0].Subject).toBe(title);
		const full = await pkpMail.fullMessage(messages[0].ID);
		expect(full.Text).toContain(marker);
		expect(full.Text).toContain('Reply to this comment');
		expect(full.Text).toContain(
			`workflowSubmissionId=${submission.id}`,
		);
	});

	// Row 5 — owns the seeded-comments coverage absorbed from
	// wizard-comments-become-discussion.spec.js (see header note).
	test('wizard comments for the editors surface as a stage-1 discussion', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('disc5');
		const comment = `Cover note ${tag}: please fast-track this submission.`;
		// commentsForEditor + submitted fires SubmissionSubmitted; the
		// submit pipeline converts the comment into the Stage 1
		// "Comments for the Editor" discussion with the stage-1 cast
		// (editors + author) as participants.
		const {submission} = await pkpApi.createSubmission({
			...submissionDraft({tag}),
			commentsForEditor: comment,
			submitted: true,
		});

		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);
		const dm = new DiscussionManagerPage(page);
		await dm.expectVisible();
		await dm.expectInGroup(COVER_NOTE_TITLE, 'In progress');

		// Opening it shows the seeded comment text; the display-only form
		// lists ONLY checked participants (FieldOptionsDisplay filters to
		// selected values), so these name assertions prove participantship:
		// the submitter (rvaca = default draft submitter) and the editors
		// AssignEditors auto-assigned on submit. For ART those are
		// dbuskins + sberardo — dbarnes' sub-editor row is dropped by
		// SubEditorsDAO::assignEditors' userInGroup filter (he's enrolled
		// as Journal editor, not Section editor), at parity with a real
		// wizard submit; the scenario's explicit `participants` are
		// attached after submit() so they never join the cover note.
		const display = await dm.openByTitle(COVER_NOTE_TITLE);
		await display.expectContains(comment);
		await display.expectContains('Ramiro Vaca');
		await display.expectContains('David Buskins');
		await display.close();
	});

	// Row 6
	test('author replies to a discussion from the author view', {tag: '@regression'}, async ({page, pkpApi, asUser}) => {
		const tag = uniqueTag('disc6');
		const comment = `Author cover note ${tag}`;
		const reply = `Author reply ${tag}`;
		const {submission} = await pkpApi.createSubmission({
			...submissionDraft({tag, submitter: 'atester'}),
			commentsForEditor: comment,
			submitted: true,
		});

		// atester opens their own submission: the Stage 1 cover-note
		// discussion is on the author view (atester is a participant).
		const authorCtx = await asUser('atester');
		const authorPage = await authorCtx.newPage();
		await authorPage.goto(authorWorkflowUrl(submission.id));
		const dmAuthor = new DiscussionManagerPage(authorPage);
		await dmAuthor.expectVisible();
		await dmAuthor.expectInGroup(COVER_NOTE_TITLE, 'In progress');

		const display = await dmAuthor.openByTitle(COVER_NOTE_TITLE);
		await display.expectContains(comment);
		await display.clickAddNewMessage();
		await display.fillReply(reply);
		await display.save();
		await display.expectContains(reply);
		await display.close();

		// dbarnes sees the author's reply in the editorial view thread.
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);
		const dmEditor = new DiscussionManagerPage(page);
		await dmEditor.expectVisible();
		const editorDisplay = await dmEditor.openByTitle(COVER_NOTE_TITLE);
		await editorDisplay.expectContains(reply);
		await editorDisplay.close();
	});
});
