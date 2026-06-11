// @ts-check
const {test, expect} = require('../support/base-test.js');
const {DiscussionManagerPage} = require('../pages/DiscussionManagerPage.js');
const {setTinyMceContent} = require('../support/tinymce.js');
const {EditorialWorkflowPage} = require('../../../../playwright/pages/EditorialWorkflowPage.js');
const submissionDraft = require('../../../../playwright/fixtures/scenarios/submission-draft.js');

/**
 * Editorial tasks — docs/e2e/plans/editorial-tasks.md (rows 1, 2 and 7;
 * rows 3–6 are backed by lib/pkp/playwright/tests/task-templates.spec.js).
 *
 * The feature under test is the task shape of the Discussion Manager
 * (EditorialTask type=TASK): the create/start/complete lifecycle with
 * due date + responsible assignee, the role-restricted edit/delete
 * access (QueryAccessPolicy/QueryWritePolicy + userHasWriteAccess in
 * the manager), and the auto-add template path
 * (Repo::editorialTask()->autoCreateFromTemplates fired from
 * DecisionType::runAdditionalActions on stage entry).
 *
 * Absorbs (rework, original deleted):
 *   - playwright/tests/discussions/discussion-manager.spec.js — the task
 *     arc of its CRUD test → row 1; its permissions test → row 2. The
 *     discussion half went to discussions.spec.js (see the discussions
 *     plan).
 *
 * Row 7 runs in an E0 scratch journal: task templates are journal-level
 * configuration that must never land on publicknowledge (Principles §1).
 * The template is created via the settings UI and the stage-entry
 * decision is recorded via the UI so the auto-create hook fires exactly
 * the way a real editor triggers it.
 */

function uniqueTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

/** Tomorrow + 1 year, YYYY-MM-DD — a safely-future task due date. */
function futureDateYmd() {
	const d = new Date();
	d.setFullYear(d.getFullYear() + 1);
	return d.toISOString().split('T')[0];
}

/** The editor-facing workflow surface for a submission. */
function editorialWorkflowUrl(submissionId, journalPath = 'publicknowledge') {
	return `/index.php/${journalPath}/en/dashboard/editorial?workflowSubmissionId=${submissionId}`;
}

/**
 * Navigate to Workflow Settings → Task Templates tab and wait for the
 * manager table to settle. Local copy of the helper task-templates.spec.js
 * uses — same selectors, same ready gate.
 * @param {import('@playwright/test').Page} page
 * @param {string} journalPath
 */
async function openTaskTemplatesTab(page, journalPath) {
	await page.goto(
		`/index.php/${journalPath}/management/settings/workflow#taskTemplates`,
	);
	await page.locator('#taskTemplates-button').click();
	await expect(
		page.getByRole('heading', {name: 'Tasks and Discussions Templates'}),
	).toBeVisible({timeout: 15_000});
}

/**
 * Click the "Add template" button for a named stage row in the Task
 * Templates settings manager. Local copy from task-templates.spec.js.
 * @param {import('@playwright/test').Page} page
 * @param {string} stageName  e.g. "Copyediting Stage"
 */
async function clickAddTemplateForStage(page, stageName) {
	const stageRow = page
		.locator('tr')
		.filter({has: page.locator('th[scope="rowgroup"]')})
		.filter({hasText: stageName});
	await expect(stageRow).toBeVisible({timeout: 10_000});
	await stageRow
		.getByRole('button', {name: 'Add template', exact: true})
		.click();
}

test.use({user: 'dbarnes'});

test.describe('Editorial tasks', () => {
	// Row 1 — absorbed (reworked) from
	// playwright/tests/discussions/discussion-manager.spec.js (task arc
	// of its CRUD test).
	test('task lifecycle: create, start, complete', {tag: '@smoke'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('etask1');
		const {submission} = await pkpApi.createSubmission(
			submissionDraft({tag}),
		);

		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);
		const dm = new DiscussionManagerPage(page);
		await dm.expectVisible();

		const taskTitle = `Task ${tag}`;
		const taskMessage = `Task message content ${tag}`;

		// Unsaved-changes guard: Cancel with a dirty form opens the
		// confirmation dialog on top of the form modal; "No" stays in
		// the form with the typed value intact.
		const form = await dm.openAdd();
		await form.fillTitle('Unsaved test');
		await form.cancel();
		await page
			.getByRole('dialog')
			.last()
			.getByRole('button', {name: 'No', exact: true})
			.click();
		await expect(form.title).toHaveValue('Unsaved test');

		// Create the task in the same form: participants, responsible
		// assignee, future due date, Do-Not-Start.
		await form.fillTitle(taskTitle);
		await form.checkParticipant('David Buskins');
		await form.enableTaskInfo();
		await form.setDateDue(futureDateYmd());
		await form.setResponsibleAssignee('David Buskins');
		await form.setShouldStart('false');
		await form.fillDescription(taskMessage);
		await form.save();
		await dm.expectInGroup(taskTitle, 'Yet to begin');

		// Start the task, then complete it, in one display session.
		const display = await dm.openByTitle(taskTitle);
		await display.expectContains(taskMessage);
		await display.clickStartTask();
		await display.save();
		await display.expectTaskStarted();

		await display.clickCompleteTask();
		await display.save();
		await display.expectClosedLabel();
		// Edit stays visible but disabled once the task is completed.
		await display.expectEditDisabled();
		await display.close();
		await dm.expectInGroup(taskTitle, 'Closed');
	});

	// Row 2 — absorbed (moved) from
	// playwright/tests/discussions/discussion-manager.spec.js test 2.
	test('task edit/delete access is restricted by role', {tag: '@regression'}, async ({page, pkpApi, asUser}) => {
		const tag = uniqueTag('etask2');
		const {submission} = await pkpApi.createSubmission(
			submissionDraft({tag}),
		);
		const taskTitle = `Access ${tag}`;

		// dbarnes creates the task with dbuskins (responsible) + minoue
		// (participant, not responsible).
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);
		const dm = new DiscussionManagerPage(page);
		await dm.expectVisible();
		const form = await dm.openAdd();
		await form.fillTitle(taskTitle);
		await form.checkParticipant('David Buskins');
		await form.checkParticipant('Minoti Inoue');
		await form.enableTaskInfo();
		await form.setDateDue(futureDateYmd());
		await form.setResponsibleAssignee('David Buskins');
		await form.setShouldStart('true');
		await form.fillDescription(`Access control test message ${tag}`);
		await form.save();
		await expect(dm.row(taskTitle)).toBeVisible();

		// minoue — participant but NOT responsible — gets a read-only row:
		// no actions menu, disabled checkboxes, no Edit in the display.
		{
			const ctx = await asUser('minoue');
			const minouePage = await ctx.newPage();
			await minouePage.goto(editorialWorkflowUrl(submission.id));
			const dmMinoue = new DiscussionManagerPage(minouePage);
			await dmMinoue.expectVisible();

			await dmMinoue.expectActionsMenuHidden(taskTitle);
			await dmMinoue.expectRowCheckboxDisabled(taskTitle);

			const display = await dmMinoue.openByTitle(taskTitle);
			await display.expectEditHidden();
			await display.close();
		}

		// dbuskins — the responsible participant — has the actions menu
		// and can delete.
		{
			const ctx = await asUser('dbuskins');
			const buskinsPage = await ctx.newPage();
			await buskinsPage.goto(editorialWorkflowUrl(submission.id));
			const dmBuskins = new DiscussionManagerPage(buskinsPage);
			await dmBuskins.expectVisible();

			await dmBuskins.expectActionsMenuVisible(taskTitle);
			await dmBuskins.openActions(taskTitle, 'Delete');
			await dmBuskins.confirmDelete();
			await expect(dmBuskins.row(taskTitle)).toHaveCount(0);
		}
	});

	// Row 7
	test('auto-add template instantiates a task on stage entry', {tag: ['@regression', '@slow']}, async ({page, pkpApi}) => {
		// Settings UI round-trip + full decision wizard + two workflow
		// loads legitimately exceed the default cap under parallel load.
		test.slow();
		const tag = uniqueTag('etask7');
		const {context} = await pkpApi.createJournal({
			tag,
			users: [{username: 'dbarnes', roles: ['manager']}],
		});

		// Phase 1 — create a Copyediting-stage task template with
		// auto-add ON via the settings UI (templates are journal config;
		// E0 scratch journal only).
		await openTaskTemplatesTab(page, context.path);
		const templateTitle = `Auto Template ${tag}`;
		await clickAddTemplateForStage(page, 'Copyediting Stage');

		const modal = page.locator('[data-cy="active-modal"]');
		const titleInput = modal.locator('#taskTemplate-title-control');
		await expect(titleInput).toBeVisible({timeout: 10_000});
		await titleInput.fill(templateTitle);
		// Task shape: the auto-created item must be a task (Yet to begin),
		// not a discussion — enable task info with a one-week due interval.
		await modal.locator('input[name="taskInfoAdd"]').check();
		await modal.locator('select[name="dueInterval"]').selectOption('P1W');
		await setTinyMceContent(
			page,
			'taskTemplate-description-control',
			`<p>Auto-add template description ${tag}.</p>`,
		);
		// The auto-add-at-stage flag (include) is what arms
		// autoCreateFromTemplates on stage entry.
		await modal.locator('input[name="include"]').check();
		await modal.getByRole('button', {name: 'Save', exact: true}).click();
		await expect(titleInput).toHaveCount(0, {timeout: 15_000});
		await expect(page.getByText(templateTitle)).toBeVisible({
			timeout: 10_000,
		});

		// Phase 2 — seed a submitted stage-1 submission in the same
		// scratch journal with dbarnes as editor participant.
		const {submission} = await pkpApi.createSubmission({
			tag,
			journal: context.path,
			submitter: 'rvaca',
			section: 'ART',
			locale: 'en',
			submitted: true,
			participants: [{user: 'dbarnes', role: 'editor'}],
			publications: [
				{
					versionStage: 'AO',
					metadata: {
						title: {en: `Auto-add stage entry ${tag}`},
						abstract: {
							en: '<p>Submission for the auto-add template test.</p>',
						},
						keywords: {en: ['testing', 'editorial-tasks']},
					},
					published: false,
				},
			],
		});

		// Phase 3 — record "Accept and Skip Review" through the decision
		// wizard (notifyAuthors → Select Files), the UI path that fires
		// DecisionType::runAdditionalActions → autoCreateFromTemplates on
		// entering Copyediting.
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id, {journalPath: context.path});
		await workflow.clickDecision('Accept and Skip Review');
		await workflow.clickContinue(); // notifyAuthors → promote files
		await workflow.recordDecision('skipped the review stage');
		await workflow.viewSubmissionFromCompletionDialog(submission.id);

		// Phase 4 — the Copyediting panel lists the system-created task
		// from the template under "Yet to begin" (no participants, not
		// started; createdBy stays NULL for system-created tasks).
		const dm = new DiscussionManagerPage(page);
		await dm.expectHeading('Copyediting Tasks & Discussions');
		await dm.expectInGroup(templateTitle, 'Yet to begin');
	});
});
