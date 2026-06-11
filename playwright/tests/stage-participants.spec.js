// @ts-check
const {test, expect} = require('../../../../playwright/support/fixtures.js');
const {ParticipantManagerPage} = require('../pages/ParticipantManagerPage.js');
const submissionDraft = require('../../../../playwright/fixtures/scenarios/submission-draft.js');

/**
 * Stage-participant management — docs/e2e/plans/stage-participants.md
 * (7 rows). Exercises the ParticipantManager panel (Vue) + the legacy
 * StageParticipantGridHandler forms it opens: add/remove participants,
 * assignment-notification email, recommend-only flag editing, the
 * access gate stage assignment provides, panel-side Login As, and the
 * author auto-assignment / author-view absence of the panel.
 *
 * Rows 1–2 are the original Playwright port of the DdioufSubmission
 * Cypress chain (copyeditor assignment at the copyediting stage),
 * refit onto ParticipantManagerPage. Most seeds use skipExternalReview
 * to land on WORKFLOW_STAGE_ID_EDITING without wiring a review round —
 * copyediting is the first stage whose default cast adds a non-editor
 * participant.
 *
 * Out of scope here (see the plan's Round 2 bullets): recommendOnly
 * decision-flow consequences, canChangeMetadata permission effects,
 * the user-grid impersonation entry point, the Notify action's
 * delivery surface (template prefill/discussion/email log → the
 * email-delivery plan owns it).
 */

/** Random-suffix tag — unique per run so parallel workers and repeated
 * runs against the long-lived test DB never collide on search scopes. */
function uniqueTag(suffix) {
	const rand = Math.random().toString(36).slice(2, 8);
	return `sp-${suffix}-w${test.info().parallelIndex}-${rand}`;
}

/**
 * Copyediting-stage scenario spec: stage-1 draft + skipExternalReview
 * decision (no review round needed; lands on WORKFLOW_STAGE_ID_EDITING).
 *
 * @param {{tag: string, participants?: Array<{user: string, role: string}>}} opts
 */
function copyeditStageSpec({tag, participants}) {
	const spec = submissionDraft({
		tag,
		participants: participants ?? [{user: 'dbarnes', role: 'editor'}],
	});
	spec.decisions = [{type: 'skipExternalReview', by: 'dbarnes'}];
	return spec;
}

test.describe('Stage-participant management', () => {
	// Row 1
	test('editor adds a copyeditor to a copyediting-stage submission via the Participants panel', async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag('add');
		const {submission} = await pkpApi.createSubmission(
			copyeditStageSpec({tag}),
		);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const pm = new ParticipantManagerPage(page);
		await pm.gotoWorkflow(submission.id);
		await pm.expectVisible();

		// Baseline: only dbarnes (editor) is seeded as a participant.
		await expect(pm.participantRow('Daniel Barnes')).toBeVisible();
		await expect(pm.participantRow('Maria Fritz')).toHaveCount(0);

		// Assign → filter by Copyeditor group + name search → pick → OK.
		await pm.assignParticipant({
			userGroup: 'Copyeditor',
			nameSearch: 'Fritz',
			fullName: 'Maria Fritz',
		});

		// New row carries the Copyeditor role label.
		await expect(pm.roleLabel('Maria Fritz', 'Copyeditor')).toBeVisible();
	});

	// Row 2
	test('editor removes a stage participant via the more-actions menu', async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag('remove');
		const {submission} = await pkpApi.createSubmission(
			copyeditStageSpec({
				tag,
				participants: [
					{user: 'dbarnes', role: 'editor'},
					// Seed mfritz directly so the remove path doesn't depend
					// on the add-path test's success.
					{user: 'mfritz', role: 'copyeditor'},
				],
			}),
		);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const pm = new ParticipantManagerPage(page);
		await pm.gotoWorkflow(submission.id);
		await pm.expectVisible();
		await expect(pm.participantRow('Maria Fritz')).toBeVisible();

		// More Actions → Remove → confirm; row leaves the list.
		await pm.removeParticipant('Maria Fritz');

		// Sanity: the editor we kept is still there.
		await expect(pm.participantRow('Daniel Barnes')).toBeVisible();
	});

	// Row 3 — the add-participant form's notify section. Only the
	// assignment-notification receipt is asserted here; the Notify
	// action's full delivery surface belongs to the email-delivery plan.
	test('assigning a participant with a notification message emails them the stage mailable', async ({
		pkpApi,
		pkpMail,
		asUser,
	}) => {
		const tag = uniqueTag('notify');
		const marker = `marker-${tag}`;
		const {submission} = await pkpApi.createSubmission(
			copyeditStageSpec({tag}),
		);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const pm = new ParticipantManagerPage(page);
		await pm.gotoWorkflow(submission.id);

		// Assign svogt with the notify section filled: pick the
		// COPYEDIT_REQUEST alternate template for the copyediting-stage
		// mailable (DiscussionCopyediting), then replace the fetched
		// template body with a message carrying the unique marker.
		await pm.assignParticipant({
			userGroup: 'Copyeditor',
			nameSearch: 'Vogt',
			fullName: 'Sarah Vogt',
			notify: {
				template: 'Request Copyedit',
				message: `<p>Please copyedit this submission. ${marker}</p>`,
			},
		});

		// Mailpit assertion scoped by recipient + unique marker — no
		// clearAll (Principles §8). The subject comes from the selected
		// COPYEDIT_REQUEST template, proving the template select flowed
		// into the sent mailable.
		const [message] = await pkpMail.find({
			to: 'svogt@mailinator.com',
			contains: marker,
			timeoutMs: 15_000,
		});
		expect(message.Subject).toMatch(/ready to be copyedited/);
		const full = await pkpMail.fullMessage(message.ID);
		expect(`${full.HTML ?? ''}${full.Text ?? ''}`).toContain(marker);
	});

	// Row 4 — edit-assignment flags. The edit path goes through
	// StageAssignment::save() (not Repo::stageAssignment()->build), so
	// the firstOr flag-drop quirk doesn't apply here.
	test('editing an assignment persists the recommend-only flag and shows the list indicator', async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag('flags');
		// Default draft cast: dbarnes editor + dbuskins/minoue section
		// editors. dbarnes edits dbuskins — a sub-editor-group participant
		// other than himself, so both flag checkboxes are editable
		// (AddParticipantForm::_isChangeRecommendOnlyAllowed/
		// _isChangePermitMetadataAllowed).
		const {submission} = await pkpApi.createSubmission(
			submissionDraft({tag}),
		);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const pm = new ParticipantManagerPage(page);
		await pm.gotoWorkflow(submission.id);
		await pm.expectVisible();
		await expect(pm.participantRow('David Buskins')).toBeVisible();
		await expect(pm.recommendOnlyIndicator('David Buskins')).toHaveCount(0);

		// Edit re-opens the assignment form (edit shape: no user grid,
		// just the participant summary + flag checkboxes).
		const edit = await pm.openEditAssignmentForm('David Buskins');
		const recommendOnly = edit.form.locator('input[name="recommendOnly"]');
		const canChangeMetadata = edit.form.locator(
			'input[name="canChangeMetadata"]',
		);
		await expect(recommendOnly).toBeVisible();
		await expect(canChangeMetadata).toBeVisible();
		await expect(recommendOnly).not.toBeChecked();
		await recommendOnly.check();
		await pm.submitAssignmentForm(edit.modal);

		// The list re-renders with the recommend-only indicator on the
		// edited participant only.
		await expect(pm.recommendOnlyIndicator('David Buskins')).toBeVisible({
			timeout: 15_000,
		});
		await expect(pm.recommendOnlyIndicator('Daniel Barnes')).toHaveCount(0);

		// Reopen Edit: the checkbox persisted; canChangeMetadata is still
		// offered on the same form.
		const reopened = await pm.openEditAssignmentForm('David Buskins');
		await expect(
			reopened.form.locator('input[name="recommendOnly"]'),
		).toBeChecked();
		await expect(
			reopened.form.locator('input[name="canChangeMetadata"]'),
		).toBeVisible();
	});

	// Row 5 — stage assignment is the access gate. svogt holds the
	// journal-level copyeditor role but is NOT a participant, so the
	// workflow is denied until dbarnes assigns them at the stage.
	test('an unassigned user cannot open the submission workflow until assigned at the stage', async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag('gate');
		const {submission} = await pkpApi.createSubmission(
			copyeditStageSpec({tag}),
		);
		const apiUrl = `/index.php/publicknowledge/api/v1/submissions/${submission.id}`;

		const svogtCtx = await asUser('svogt');
		const svogtPage = await svogtCtx.newPage();

		// API-level denial (deterministic): the submission GET is refused
		// for an unassigned assistant.
		const denied = await svogtPage.request.get(apiUrl);
		expect([401, 403]).toContain(denied.status());

		// UI-level denial: the workflow modal's submission fetch fails and
		// surfaces the network-error dialog; no workflow panels render.
		const pmSvogt = new ParticipantManagerPage(svogtPage);
		await pmSvogt.gotoWorkflow(submission.id);
		const errorDialog = svogtPage
			.locator('[data-cy="dialog"]')
			.filter({hasText: 'Error'});
		await expect(errorDialog.first()).toBeVisible({timeout: 20_000});
		await expect(pmSvogt.panel).toHaveCount(0);

		// dbarnes assigns svogt at the copyediting stage.
		const editorCtx = await asUser('dbarnes');
		const editorPage = await editorCtx.newPage();
		const pmEditor = new ParticipantManagerPage(editorPage);
		await pmEditor.gotoWorkflow(submission.id);
		await pmEditor.assignParticipant({
			userGroup: 'Copyeditor',
			nameSearch: 'Vogt',
			fullName: 'Sarah Vogt',
		});

		// The same URL now renders the workflow for svogt — panel visible
		// with their own row; assistants get no Assign affordance
		// (manager/sub-editor/site-admin gate in
		// useParticipantManagerConfig#getTopItems).
		await pmSvogt.gotoWorkflow(submission.id);
		await pmSvogt.expectVisible();
		await expect(pmSvogt.participantRow('Sarah Vogt')).toBeVisible();
		await expect(pmSvogt.assignButton).toHaveCount(0);
		const allowed = await svogtPage.request.get(apiUrl);
		expect(allowed.status()).toBe(200);
	});

	// Row 6 — panel-side Login As entry point (the user-management grid
	// entry point belongs to the login-as plan).
	test('admin logs in as a participant from the Participants panel and logs out back to admin', async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag('loginas');
		const {submission} = await pkpApi.createSubmission(
			copyeditStageSpec({
				tag,
				participants: [
					{user: 'dbarnes', role: 'editor'},
					{user: 'mfritz', role: 'copyeditor'},
				],
			}),
		);

		const ctx = await asUser('admin');
		const page = await ctx.newPage();
		const pm = new ParticipantManagerPage(page);
		await pm.gotoWorkflow(submission.id);
		await pm.expectVisible();
		await expect(pm.participantRow('Maria Fritz')).toBeVisible();

		// The more-actions menu offers Log In As (participant.canLoginAs).
		await pm.openMoreActions('Maria Fritz');
		await expect(pm.menuItem('Login As')).toBeVisible();
		await pm.menuItem('Login As').click();

		// Confirm dialog → redirect through login/signInAsUser back to the
		// workflow URL for mfritz's (assistant) dashboard.
		const confirm = page.locator('[data-cy="dialog"]').filter({
			hasText: 'Log in as this user?',
		});
		await expect(confirm).toBeVisible({timeout: 10_000});
		await confirm.getByRole('button', {name: /^OK$/i}).click();
		await pm.waitForImpersonation(true);

		await expect(page).toHaveURL(
			new RegExp(`dashboard/editorial\\?.*workflowSubmissionId=${submission.id}`),
		);
		let identity = await pm.currentUser();
		expect(identity?.username).toBe('mfritz');
		expect(identity?.isUserLoggedInAs).toBe(true);
		expect(identity?.loggedInAsUser).toMatchObject({username: 'admin'});

		// The panel renders the logout-as affordance for the impersonated
		// session, labelled with the impersonated user's name.
		await expect(
			pm.panel.getByRole('button', {name: 'Logout as Maria Fritz'}),
		).toBeVisible({timeout: 15_000});
		await pm.logoutAsParticipant();

		// Back to the admin session, on the same submission's workflow.
		identity = await pm.currentUser();
		expect(identity?.username).toBe('admin');
		expect(identity?.isUserLoggedInAs).toBeFalsy();
		await expect(page).toHaveURL(
			new RegExp(`workflowSubmissionId=${submission.id}`),
		);
		await pm.expectVisible();
		await expect(pm.logoutAsButton).toHaveCount(0);
	});

	// Row 7 — author auto-assignment (seed parity with the wizard's
	// submit) + author-side absence of the panel.
	test('the submitter is auto-assigned as Author and the author view renders no Participants panel', async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag('author');
		const {submission} = await pkpApi.createSubmission(
			submissionDraft({tag, submitter: 'atester'}),
		);

		// Editor view: atester appears under the Author group without any
		// explicit participants[] entry for them.
		const editorCtx = await asUser('dbarnes');
		const editorPage = await editorCtx.newPage();
		const pm = new ParticipantManagerPage(editorPage);
		await pm.gotoWorkflow(submission.id);
		await pm.expectVisible();
		await expect(pm.participantRow('Author Tester')).toBeVisible();
		await expect(pm.roleLabel('Author Tester', 'Author')).toBeVisible();

		// Author view: the workflow renders (title carries the tag), but
		// the author workflow config has no ParticipantManager panel.
		const authorCtx = await asUser('atester');
		const authorPage = await authorCtx.newPage();
		const pmAuthor = new ParticipantManagerPage(authorPage);
		await pmAuthor.gotoWorkflow(submission.id, {
			dashboardPage: 'mySubmissions',
		});
		const authorModal = authorPage.locator('[data-cy="active-modal"]').first();
		await expect(authorModal.getByText(tag).first()).toBeVisible({
			timeout: 20_000,
		});
		await expect(pmAuthor.panel).toHaveCount(0);
	});
});
