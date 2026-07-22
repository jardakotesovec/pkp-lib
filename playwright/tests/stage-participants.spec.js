// @ts-check
const {test, expect} = require('../support/base-test.js');
const {ParticipantManagerPage} = require('../pages/ParticipantManagerPage.js');
const {WorkflowShellPage} = require('../pages/WorkflowShellPage.js');
const {DiscussionManagerPage} = require('../pages/DiscussionManagerPage.js');
const {ActivityLogModal} = require('../pages/ActivityLogModal.js');
const {DecisionWizardPage} = require('../pages/DecisionWizardPage.js');
const {SubmissionWizardPage} = require('../pages/SubmissionWizardPage.js');
const {TasksGridModal} = require('../pages/TasksGridModal.js');
const {DashboardPage} = require('../pages/DashboardPage.js');
const {waitForJQueryIdle} = require('../support/jquery.js');

/**
 * Stage participants — one test per canonical scenario of
 * docs/product/specs/stage-participants.md (9 scenarios → 9 tests).
 * The Participants panel (lib/ui-library ParticipantManager) and the
 * legacy StageParticipantGridHandler forms it opens are pkp-lib, so the
 * spec lives here; scenario payloads use OJS vocabulary
 * (publicknowledge / ART) matching the bootstrap context.
 *
 * Coverage per scenario:
 *   s1  manager assigns a copyeditor with the copyedit-request message:
 *       row + role label, "User added as a stage participant." toast,
 *       the request email in Mailpit, the discussion titled with the
 *       email subject on the Copyediting stage, and the "… was assigned
 *       to this submission as a …" history entry
 *   s2  silent assignment leaves the editing status stale (ledger 9):
 *       an assigned SE records Accept through the REAL decision wizard
 *       (scenario-seeded decisions skip the notice rows), sees "Assign
 *       a copyeditor …"; the unassigned manager sees no status line at
 *       all; a message-cleared assign keeps the prompt; Notify flips it
 *       to "Awaiting Copyedits."; removing the only copyeditor leaves
 *       it standing
 *   s3  automatic editor assignment on real submit (first journal):
 *       ART's in-group configured section editors are auto-assigned and
 *       mailed, the configured-but-not-in-group editor is skipped; on a
 *       scratch journal (after the install's first) the configured
 *       editor is silently skipped and the needs-editor task + email
 *       fallback fires instead (ledger 135/164)
 *   s4  recommend-only editor: the assign-form box stamps the row note;
 *       that editor's rail offers Recommend* only; the recommend-only
 *       SE still gets the box on Assign (ledger 75) while Edit is
 *       withheld from editor rows entirely
 *   s5  edit privileges matrix: SE row → both boxes + "The stage
 *       assignment has been changed."; Journal-editor row → only the
 *       recommend-only box; own SE row → "No changes can be made to
 *       this participant"
 *   s6  the picker never re-offers an assigned person (both stage
 *       panels, name search → "No Items"); a duplicate direct POST is
 *       reported successful while its privilege boxes are silently
 *       dropped (ledger 74)
 *   s7  removal clears everywhere: all-stages warning dialog, both
 *       stage panels, discussion participation pruned, removal history
 *       entry, and the ex-participant's dashboard loses the submission
 *   s8  an assigned Assistant sees the panel read-only (no Assign, no
 *       Edit/Remove, Notify offered); an unassigned Assistant can't
 *       open the workflow at all (API 401, no panel)
 *   s9  Notify starts a discussion: dialog anatomy ("Notify" /
 *       "Start Discussion" / required Message), "Notification sent to
 *       users.", the email, and the discussion on the stage
 *
 * Parallel-safety: every submission is per-test; tags are single
 * hyphenless alphanumeric tokens riding in submission titles;
 * publicknowledge is used read-only + additively; s3's empty-editor-list
 * leg runs on a per-test scratch journal with throwaway users; Mailpit
 * reads are scoped by recipient + tag with expectNone bounded by a
 * positive control.
 */

test.use({user: 'manager.maya'}); // the default actor: the Journal Manager

const JOURNAL = 'publicknowledge';
const STAGE = {SUBMISSION: 1, REVIEW: 3, COPYEDITING: 4, PRODUCTION: 5};

const MAYA = 'Maya Manager';
const DIANA = 'Diana Editor';
const ANA = 'Ana SectionEditor';
const OMAR = 'Omar SectionEditor';
const RAVI = 'Ravi SectionEditor';
const CARLA = 'Carla Copyeditor';
const SAM = 'Sam Copyeditor';
const LEO = 'Leo LayoutEditor';
const RITA = 'Rita Assistant';

const RECOMMEND_NOTE = 'Only allowed to recommend an editorial decision';
const ASSIGN_COPYEDITOR_PROMPT =
	'Assign a copyeditor using the Assign link in the Participants list.';
const AWAITING_COPYEDITS = 'Awaiting Copyedits.';

/** A unique, hyphenless, alphanumeric tag (parallel isolation). */
function uniqueTag(prefix = 'sp') {
	const workerLetter = String.fromCharCode(
		97 + (test.info().parallelIndex % 26),
	);
	let suffix = '';
	while (suffix.length < 6) {
		suffix += Math.random().toString(36).replace(/[^a-z0-9]/g, '');
	}
	return `${prefix}${workerLetter}${suffix.slice(0, 6)}`;
}

/** Scenario spec for a submission with a tagged single publication. */
function submissionSpec({
	tag,
	title,
	journal = JOURNAL,
	submitter = 'author.alex',
	section = 'ART',
	submitted = true,
	participants,
	decisions,
	reviewRounds,
}) {
	return {
		tag,
		journal,
		submitter,
		section,
		locale: 'en',
		submitted,
		...(participants ? {participants} : {}),
		...(decisions ? {decisions} : {}),
		...(reviewRounds ? {reviewRounds} : {}),
		publications: [
			{
				versionStage: 'AO',
				published: false,
				metadata: {
					title: {en: title},
					abstract: {en: `<p>Abstract for ${tag}.</p>`},
				},
			},
		],
	};
}

/** Decisions that land a seeded submission on the Copyediting stage. */
const TO_COPYEDITING = {
	decisions: [
		{type: 'sendExternalReview', by: 'editor.diana'},
		{type: 'accept', by: 'editor.diana'},
	],
	reviewRounds: [{reviewers: []}],
};

/** A throwaway scratch-journal user spec (password rule: username×2). */
function throwawayUser(username, givenName, familyName, roles) {
	return {
		username,
		password: username + username,
		email: `${username}@mailinator.com`,
		givenName,
		familyName,
		roles,
	};
}

/**
 * Toast-notification locator (Page.vue .app__notifications). `.first()`
 * because two racing notification fetches can render the same trivial
 * toast twice (observed live on s1) — a strict-mode locator would then
 * fail on the duplicate; the assertion still requires the exact text.
 */
function toast(page, text) {
	return page.locator('.app__notifications').getByText(text).first();
}

/**
 * Arm a waiter for a toast BEFORE the action that triggers it. Toasts
 * are transient (auto-dismiss) and ride the per-user notification
 * queue, so an after-the-fact assertion can miss one that already came
 * and went while the test waited on slower signals (second observed s1
 * flake mode). Usage:
 *   const seen = expectToast(page, 'Saved.');
 *   await doTheAction();
 *   await seen;
 *
 * @returns {Promise<void>} resolves when the exact-text toast renders
 */
function expectToast(page, text) {
	const seen = toast(page, text).waitFor({state: 'visible', timeout: 20_000});
	// Mark handled so an earlier test failure doesn't surface this as an
	// unhandled rejection; awaiting `seen` still throws on timeout.
	seen.catch(() => {});
	return seen;
}

/** A decision-rail button by exact label. */
function railButton(shell, name) {
	return shell.actionItems().getByRole('button', {name, exact: true});
}

/**
 * GET the participants API for a stage panel through an authenticated
 * request context (page.request / context.request).
 *
 * @returns {Promise<Array<object>>} user summaries with stageAssignments
 */
async function fetchParticipants(requestCtx, submissionId, stageId, journal = JOURNAL) {
	const res = await requestCtx.get(
		`/index.php/${journal}/api/v1/submissions/${submissionId}/participants/${stageId}`,
	);
	expect(res.status(), 'participants API should respond 200').toBe(200);
	return res.json();
}

/** The CSRF token of the current logged-in document. */
async function csrfToken(page) {
	const token = await page.evaluate(
		() => window.pkp?.currentUser?.csrfToken ?? null,
	);
	if (!token) {
		throw new Error('No CSRF token on page (not logged in?)');
	}
	return token;
}

/**
 * Walk the submission wizard forward with Continue until `stepName`
 * is current (step counts differ per journal).
 */
async function walkTo(wizard, stepName, max = 7) {
	const current = wizard.page.locator('.pkpSteps__step__label--current');
	const done = new RegExp(
		stepName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$',
	);
	for (let i = 0; i < max; i++) {
		const label = ((await current.textContent()) ?? '').trim();
		if (done.test(label)) {
			return;
		}
		await wizard.continueStep();
	}
	await wizard.expectStep(stepName);
}

/**
 * Complete a seeded wizard-resumable draft through the REAL wizard
 * (seeded submits fire the submitted event too, but inside Mail::fake —
 * only a real submit lets the assignment/needs-editor mails reach Mailpit).
 */
async function submitDraftThroughWizard(page, submissionId, journalPath = JOURNAL) {
	await page.goto(`/index.php/${journalPath}/submission?id=${submissionId}`);
	await expect(page.locator('.submissionWizard')).toBeVisible({
		timeout: 20_000,
	});
	const wizard = new SubmissionWizardPage(page, journalPath);
	await walkTo(wizard, 'Review');
	await expect(page.getByText('Checking your submission')).toBeHidden({
		timeout: 30_000,
	});
	// Copyright confirmation only renders when the journal sets a
	// copyright notice — accept it when offered.
	const copyright = page.locator(
		'input[name="confirmCopyright"][type="checkbox"]',
	);
	if (await copyright.first().isVisible().catch(() => false)) {
		await copyright.first().check();
	}
	const dialog = await wizard.openSubmitDialog();
	await dialog.getByRole('button', {name: 'Submit', exact: true}).click();
	await expect(
		page.getByRole('heading', {name: 'Submission complete'}),
	).toBeVisible({timeout: 30_000});
}

test.describe('Stage participants', () => {
	test('s1: a Journal Manager assigns a copyeditor with the copyedit request — row, toast, email, stage discussion, history entry', async ({
		page,
		pkpApi,
		pkpMail,
	}) => {
		test.slow(); // assign flow + Mailpit round-trip + activity log
		const tag = uniqueTag('spa');
		const title = `Copyedit assign ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			submissionSpec({
				tag,
				title,
				participants: [{user: 'editor.diana', role: 'editor'}],
				...TO_COPYEDITING,
			}),
		);

		const pm = new ParticipantManagerPage(page);
		const shell = new WorkflowShellPage(page);
		await pm.gotoWorkflow(submission.id);
		await expect(
			shell.contentHeading('Workflow: Copyediting'),
		).toBeVisible({timeout: 20_000});

		// Assign Carla in the Copyeditor role with the predefined
		// copyedit request ("Request Copyedit"), tagging the message so
		// the email is Mailpit-scopable. The toast waiter is armed
		// BEFORE the save so the transient toast can't slip past.
		const {modal, form} = await pm.openAssignForm();
		await pm.selectUser(
			{modal, form},
			{userGroup: 'Copyeditor', nameSearch: 'Carla', fullName: CARLA},
		);
		await pm.selectNotifyTemplate(form, 'Request Copyedit');
		await pm.setNotifyMessage(
			form,
			`<p>Please copyedit this submission. ${tag}</p>`,
		);
		const addedToast = expectToast(
			page,
			'User added as a stage participant.',
		);
		await pm.submitAssignmentForm(modal);
		// The confirmation toast appears…
		await addedToast;
		// …and the panel lists the person under their role.
		await expect(pm.participantRow(CARLA)).toBeVisible({timeout: 15_000});
		await expect(pm.roleLabel(CARLA, 'Copyeditor')).toBeVisible();

		// The copyeditor receives the request email.
		await pkpMail.find({
			to: 'copyeditor.carla@mailinator.com',
			contains: tag,
		});

		// A discussion titled with the email's subject line appears on
		// the stage (emails.copyeditRequest.subject).
		const dm = new DiscussionManagerPage(page);
		await dm.expectVisible();
		await expect(
			dm.titleButton(
				`Submission ${submission.id} is ready to be copyedited for JPK`,
			),
		).toBeVisible({timeout: 15_000});

		// The submission history gains the assignment entry (the role
		// name never resolves — ledger 14 — so match up to the "as a").
		const log = new ActivityLogModal(page);
		await log.openFromWorkflow();
		await log.openHistoryTab();
		await expect(
			log.historyRow(
				/Carla Copyeditor \(copyeditor\.carla\) was assigned to this submission as a/,
			),
		).toBeVisible({timeout: 20_000});
	});

	test('s2: silent assignment leaves the stage status stale — prompt only flips on a sent message, never on assignment or removal (ledger 9)', async ({
		page,
		asUser,
		pkpApi,
	}) => {
		test.slow(); // a real decision wizard + four status checks
		const tag = uniqueTag('spb');
		const title = `Stale status ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			submissionSpec({
				tag,
				title,
				participants: [
					{user: 'editor.diana', role: 'editor'},
					{user: 'sectioneditor.ana', role: 'sectionEditor'},
				],
				decisions: [{type: 'sendExternalReview', by: 'editor.diana'}],
				reviewRounds: [{reviewers: []}],
			}),
		);

		// The assigned Section Editor records Accept through the REAL
		// wizard — only UI-recorded ACCEPT decisions create the editing
		// status notice rows (spec rule 8 footnote; scenario-seeded
		// decisions skip them).
		const anaCtx = await asUser('sectioneditor.ana');
		const anaPage = await anaCtx.newPage();
		const anaShell = new WorkflowShellPage(anaPage);
		await anaShell.gotoEditorial(submission.id);
		await expect(
			anaShell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});
		await railButton(anaShell, 'Accept Submission').click();
		// A journal with a minimum-reviews threshold raises a prompt
		// first; publicknowledge has none, so the click usually goes
		// straight to the wizard. Handle both.
		const warning = anaPage.locator('[data-cy="dialog"]').filter({
			hasText: 'Proceed Without Minimum Confirmed Reviews?',
		});
		const prompted = await warning
			.waitFor({state: 'visible', timeout: 4_000})
			.then(() => true)
			.catch(() => false);
		if (prompted) {
			await warning
				.getByRole('button', {name: 'Yes, Continue', exact: true})
				.click();
		}
		await anaPage.waitForURL(/\/decision\/record\//, {
			timeout: 20_000,
			waitUntil: 'commit',
		});
		const wizard = new DecisionWizardPage(anaPage);
		await wizard.recordThrough('Submission Accepted');
		await wizard.viewSummary(submission.id);

		// The assigned editor sees the assign-a-copyeditor prompt.
		await expect(
			anaShell.contentHeading('Workflow: Copyediting'),
		).toBeVisible({timeout: 20_000});
		await expect(
			anaShell.primaryItems().getByText(ASSIGN_COPYEDITOR_PROMPT),
		).toBeVisible({timeout: 20_000});

		// The unassigned Journal Manager sees no status line at all
		// (rule 8 — the notice rows are per-assigned-editor).
		const mgrShell = new WorkflowShellPage(page);
		const mgrPm = new ParticipantManagerPage(page);
		await mgrShell.gotoEditorial(submission.id);
		await expect(
			mgrShell.contentHeading('Workflow: Copyediting'),
		).toBeVisible({timeout: 20_000});
		await mgrPm.expectVisible(); // panel loaded — page settled
		await expect(
			mgrShell.primaryItems().getByText(ASSIGN_COPYEDITOR_PROMPT),
		).toHaveCount(0);
		await expect(
			mgrShell.primaryItems().getByText(AWAITING_COPYEDITS),
		).toHaveCount(0);

		// The SE assigns a copyeditor but CLEARS the message box — the
		// participant is listed, yet the prompt stays.
		const anaPm = new ParticipantManagerPage(anaPage);
		const {modal, form} = await anaPm.openAssignForm();
		await anaPm.selectUser(
			{modal, form},
			{userGroup: 'Copyeditor', nameSearch: 'Sam', fullName: SAM},
		);
		await anaPm.setNotifyMessage(form, '');
		await anaPm.submitAssignmentForm(modal);
		await expect(anaPm.participantRow(SAM)).toBeVisible({timeout: 15_000});

		await anaShell.gotoEditorial(submission.id);
		await expect(
			anaShell.primaryItems().getByText(ASSIGN_COPYEDITOR_PROMPT),
		).toBeVisible({timeout: 20_000});
		await expect(
			anaShell.primaryItems().getByText(AWAITING_COPYEDITS),
		).toHaveCount(0);

		// A later Notify (a sent message) flips it to Awaiting.
		await anaPm.notifyParticipant(SAM, {
			message: `<p>Copyedit please. ${tag}</p>`,
		});
		await anaShell.gotoEditorial(submission.id);
		await expect(
			anaShell.primaryItems().getByText(AWAITING_COPYEDITS),
		).toBeVisible({timeout: 20_000});
		await expect(
			anaShell.primaryItems().getByText(ASSIGN_COPYEDITOR_PROMPT),
		).toHaveCount(0);

		// Removing the ONLY copyeditor never updates it — the awaiting
		// state stands (stale in the other direction).
		await anaPm.removeParticipant(SAM);
		await anaShell.gotoEditorial(submission.id);
		await expect(
			anaShell.contentHeading('Workflow: Copyediting'),
		).toBeVisible({timeout: 20_000});
		await expect(
			anaShell.primaryItems().getByText(AWAITING_COPYEDITS),
		).toBeVisible({timeout: 20_000});
	});

	test('s3: automatic editor assignment — configured section editors auto-assigned + mailed on the first journal; scratch journal falls to the needs-editor fallback (ledger 135/164)', async ({
		page,
		asUser,
		pkpApi,
		pkpMail,
	}) => {
		test.slow(); // two real wizard submits + Mailpit round-trips

		// --- Leg A: publicknowledge (the install's first journal). ---
		const tag = uniqueTag('spc');
		const title = `Auto assign ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			submissionSpec({tag, title, submitted: false}),
		);
		const authorCtx = await asUser('author.alex');
		const authorPage = await authorCtx.newPage();
		await submitDraftThroughWizard(authorPage, submission.id);

		// ART's configured editor list is diana + ana + omar; only ana
		// and omar hold the Section editor group, so exactly they are
		// auto-assigned — nobody touched the panel (rule 10).
		const pm = new ParticipantManagerPage(page);
		await pm.gotoWorkflow(submission.id);
		await pm.expectVisible();
		await expect(pm.roleLabel(ANA, 'Section editor')).toBeVisible({
			timeout: 20_000,
		});
		await expect(pm.roleLabel(OMAR, 'Section editor')).toBeVisible();
		// The configured-but-not-in-group editor is skipped.
		await expect(pm.participantRow(DIANA)).toHaveCount(0);

		// The assigned editor receives the editor-assigned email; the
		// skipped one gets nothing (bounded by the positive control).
		await pkpMail.find({
			to: 'sectioneditor.ana@mailinator.com',
			contains: tag,
		});
		await pkpMail.expectNone({
			to: 'editor.diana@mailinator.com',
			contains: tag,
			afterControl: {
				to: 'sectioneditor.omar@mailinator.com',
				contains: tag,
			},
		});

		// --- Leg B: a scratch journal (created after the install's
		// first) with a CONFIGURED section editor — as-built the editor
		// is silently skipped and the needs-editor fallback fires as if
		// the list were empty (ledger 135/164).
		const tagB = uniqueTag('spd');
		const mg = `mg${tagB}`;
		const se = `se${tagB}`;
		const au = `au${tagB}`;
		const {context} = await pkpApi.createJournal({
			tag: tagB,
			users: [
				throwawayUser(mg, 'Mira', 'Manager', ['manager']),
				throwawayUser(se, 'Sela', 'Sectioneditor', ['sectionEditor']),
				throwawayUser(au, 'Aldo', 'Author', ['author']),
			],
			sections: [
				{
					abbrev: {en: 'ART'},
					title: {en: 'Articles'},
					sectionEditors: [se],
				},
			],
		});
		const journalPath = context.path;
		const titleB = `Needs editor ${tagB}`;
		const {submission: subB} = await pkpApi.createSubmission(
			submissionSpec({
				tag: tagB,
				title: titleB,
				journal: journalPath,
				submitter: au,
				submitted: false,
			}),
		);
		const auCtx = await asUser(au);
		const auPage = await auCtx.newPage();
		await submitDraftThroughWizard(auPage, subB.id, journalPath);

		// The configured editor was NOT assigned…
		const mgCtx = await asUser(mg);
		const mgPage = await mgCtx.newPage();
		const mgPm = new ParticipantManagerPage(mgPage);
		await mgPm.gotoWorkflow(subB.id, {journalPath});
		await mgPm.expectVisible();
		await expect(mgPm.participantRow('Sela Sectioneditor')).toHaveCount(0);

		// …instead every Journal Manager gets the needs-editor task…
		await mgPage.goto(`/index.php/${journalPath}/en/dashboard/editorial`);
		const tasks = new TasksGridModal(mgPage);
		await tasks.open();
		const taskCell = tasks.task(titleB);
		await expect(taskCell).toBeVisible({timeout: 20_000});
		await expect(taskCell).toContainText(
			'A new article has been submitted to which an editor needs to be assigned.',
		);

		// …and the needs-editor email; the configured editor gets none.
		await pkpMail.find({to: `${mg}@mailinator.com`, contains: tagB});
		await pkpMail.expectNone({
			to: `${se}@mailinator.com`,
			contains: tagB,
			afterControl: {to: `${mg}@mailinator.com`, contains: tagB},
		});
	});

	test('s4: recommend-only editor — row note, recommendation-only rail, and the add-mode box a recommend-only SE still gets while Edit is withheld (ledger 75)', async ({
		page,
		asUser,
		pkpApi,
	}) => {
		test.slow(); // two actors, two assign flows
		const tag = uniqueTag('spe');
		const title = `Recommend only ${tag}`;
		// Section REV: the scenario submit auto-assigns the section's
		// configured editors (ravi; diana is configured but not in the
		// Section editor group), leaving Omar and Ana free for the
		// assign-form legs — on ART they'd be auto-assigned and the
		// picker would exclude them.
		const {submission} = await pkpApi.createSubmission(
			submissionSpec({
				tag,
				title,
				section: 'REV',
				participants: [{user: 'editor.diana', role: 'editor'}],
				decisions: [{type: 'sendExternalReview', by: 'editor.diana'}],
				reviewRounds: [{reviewers: []}],
			}),
		);

		// The manager assigns Omar as Section editor, ticking the
		// recommend-only box in the assign form.
		const pm = new ParticipantManagerPage(page);
		const shell = new WorkflowShellPage(page);
		await pm.gotoWorkflow(submission.id);
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});
		{
			const {modal, form} = await pm.openAssignForm();
			await pm.selectUser(
				{modal, form},
				{userGroup: 'Section editor', nameSearch: 'Omar', fullName: OMAR},
			);
			const box = form.locator('input[name="recommendOnly"]');
			await expect(box).toBeVisible();
			await box.check();
			await pm.setNotifyMessage(form, '');
			await pm.submitAssignmentForm(modal);
		}
		// The new row carries the recommend-only note.
		await expect(pm.recommendOnlyIndicator(OMAR)).toBeVisible({
			timeout: 15_000,
		});

		// Omar's decision controls offer only recommendations.
		const omarCtx = await asUser('sectioneditor.omar');
		const omarPage = await omarCtx.newPage();
		const omarShell = new WorkflowShellPage(omarPage);
		await omarShell.gotoEditorial(submission.id);
		await expect(railButton(omarShell, 'Recommend Accept')).toBeVisible({
			timeout: 20_000,
		});
		await expect(railButton(omarShell, 'Recommend Revisions')).toBeVisible();
		await expect(railButton(omarShell, 'Recommend Decline')).toBeVisible();
		await expect(railButton(omarShell, 'Accept Submission')).toHaveCount(0);

		// ⚠ Ledger 75: the recommend-only SE assigning someone new gets
		// the same box — enabled and honored end-to-end.
		const omarPm = new ParticipantManagerPage(omarPage);
		{
			const {modal, form} = await omarPm.openAssignForm();
			await omarPm.selectUser(
				{modal, form},
				{userGroup: 'Section editor', nameSearch: 'Ana', fullName: ANA},
			);
			const box = form.locator('input[name="recommendOnly"]');
			await expect(box).toBeVisible();
			await expect(box).toBeEnabled();
			await box.check();
			await omarPm.setNotifyMessage(form, '');
			await omarPm.submitAssignmentForm(modal);
		}
		await expect(omarPm.recommendOnlyIndicator(ANA)).toBeVisible({
			timeout: 15_000,
		});

		// …while the Edit action on existing editor rows is withheld
		// from the recommend-only SE entirely.
		await omarPm.expectMenuForRow(omarPm.participantRow(RAVI), {
			present: ['Notify', 'Remove'],
			absent: ['Edit'],
		});
	});

	test('s5: editing privileges — both boxes on an SE row + saved-change toast, recommend-only box alone on a Journal-editor row, "No changes" on one\'s own SE assignment', async ({
		page,
		asUser,
		pkpApi,
	}) => {
		test.slow(); // three edit-form openings across two actors
		const tag = uniqueTag('spf');
		const title = `Edit privileges ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			submissionSpec({
				tag,
				title,
				participants: [
					{user: 'sectioneditor.ana', role: 'sectionEditor'},
					{user: 'editor.diana', role: 'editor'},
					{user: 'editor.diana', role: 'sectionEditor'},
				],
			}),
		);

		const pm = new ParticipantManagerPage(page);
		await pm.gotoWorkflow(submission.id);
		await pm.expectVisible();

		// SE row (Ana): the fixed person read-only plus BOTH privilege
		// boxes; ticking recommend-only saves and confirms.
		{
			const {modal, form} = await pm.openEditAssignmentForm(ANA);
			await expect(form).toContainText(ANA);
			await expect(form).toContainText('Section editor');
			// The form has no notify section in edit mode.
			await expect(form.locator('select#template')).toHaveCount(0);
			const recommendBox = form.locator('input[name="recommendOnly"]');
			const metadataBox = form.locator('input[name="canChangeMetadata"]');
			await expect(recommendBox).toBeVisible();
			await expect(metadataBox).toBeVisible();
			await recommendBox.check();
			const changedToast = expectToast(
				page,
				'The stage assignment has been changed.',
			);
			await pm.submitAssignmentForm(modal);
			await changedToast;
		}
		// The saved privilege is really on the row (persistence proof).
		await expect(pm.recommendOnlyIndicator(ANA)).toBeVisible({
			timeout: 15_000,
		});

		// Journal-editor row (Diana-as-editor, a manager-level role):
		// only the recommend-only box is offered — the metadata box is
		// never shown on manager-level rows.
		{
			const row = pm.participantRowByRole(DIANA, 'Journal editor');
			const {modal, form} = await pm.openEditAssignmentFormForRow(row);
			await expect(form.locator('input[name="recommendOnly"]')).toBeVisible();
			await expect(form.locator('input[name="canChangeMetadata"]')).toHaveCount(0);
			await expect(form).not.toContainText(
				'No changes can be made to this participant',
			);
			await pm.cancelAssignmentForm(modal);
		}

		// One's OWN Section-Editor assignment: the form still opens but
		// reads "No changes can be made to this participant".
		const dianaCtx = await asUser('editor.diana');
		const dianaPage = await dianaCtx.newPage();
		const dianaPm = new ParticipantManagerPage(dianaPage);
		await dianaPm.gotoWorkflow(submission.id);
		await dianaPm.expectVisible();
		{
			const ownRow = dianaPm.participantRowByRole(DIANA, 'Section editor');
			const {modal, form} = await dianaPm.openEditAssignmentFormForRow(ownRow);
			await expect(
				form.getByText('No changes can be made to this participant'),
			).toBeVisible();
			await expect(form.locator('input[name="recommendOnly"]')).toHaveCount(0);
			await expect(form.locator('input[name="canChangeMetadata"]')).toHaveCount(0);
			await dianaPm.cancelAssignmentForm(modal);
		}
	});

	test('s6: the picker never re-offers an assigned person — hidden on every stage panel, name search finds No Items; a direct duplicate POST "succeeds" without applying its boxes (ledger 74)', async ({
		page,
		pkpApi,
	}) => {
		test.slow(); // two assign-form openings + API round-trips
		const tag = uniqueTag('spg');
		const title = `Picker exclusion ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			submissionSpec({
				tag,
				title,
				participants: [
					{user: 'editor.diana', role: 'editor'},
					{user: 'sectioneditor.ana', role: 'sectionEditor'},
				],
			}),
		);

		const pm = new ParticipantManagerPage(page);
		const shell = new WorkflowShellPage(page);
		await pm.gotoWorkflow(submission.id);
		await expect(
			shell.contentHeading('Workflow: Submission'),
		).toBeVisible({timeout: 20_000});

		/**
		 * In the open assign form: filter to Section editor, expect the
		 * unassigned control row, then search the assigned person's name
		 * and expect the empty grid.
		 */
		const expectAnaExcluded = async ({modal, form}) => {
			await form
				.locator('select[name="filterUserGroupId"]')
				.selectOption({label: 'Section editor'});
			// The role filter only applies when the search form is
			// submitted — the initial grid load uses the first option.
			await form.getByRole('button', {name: 'Search', exact: true}).click();
			await waitForJQueryIdle(page);
			// Positive control: an UNASSIGNED section editor is offered
			// (ravi — the ART auto-assignment catches ana and omar).
			await expect(
				modal.locator('tr', {hasText: RAVI}).first(),
			).toBeVisible({timeout: 15_000});
			// The assigned one is missing from the unfiltered list…
			await expect(modal.locator('tr', {hasText: ANA})).toHaveCount(0);
			// …and searching the name finds "No Items".
			await form.locator('input[name="name"]').fill('Ana');
			await form.getByRole('button', {name: 'Search', exact: true}).click();
			await waitForJQueryIdle(page);
			await expect(
				modal.locator('#userSelectGridContainer').getByText('No Items'),
			).toBeVisible({timeout: 15_000});
		};

		// On the Submission stage's panel…
		await expectAnaExcluded(await pm.openAssignForm());
		await pm.cancelAssignmentForm(
			page.getByRole('dialog', {name: 'Assign Participant', exact: true}),
		);

		// …and on another stage's panel alike (the exclusion has no
		// stage condition).
		await shell.clickMenu('Copyediting');
		await expect(
			shell.contentHeading('Workflow: Copyediting'),
		).toBeVisible({timeout: 20_000});
		await expectAnaExcluded(await pm.openAssignForm());
		await pm.cancelAssignmentForm(
			page.getByRole('dialog', {name: 'Assign Participant', exact: true}),
		);

		// ⚠ Ledger 74: a duplicate submitted another way (direct POST to
		// saveParticipant) is reported successful while the existing
		// assignment's privilege settings stay unchanged.
		const before = await fetchParticipants(
			page.request,
			submission.id,
			STAGE.SUBMISSION,
		);
		const ana = before.find((u) => u.fullName === ANA);
		if (!ana) throw new Error('Ana not in participants payload');
		const anaAssignment = ana.stageAssignments[0];
		expect(anaAssignment.recommendOnly).toBe(false);
		const token = await csrfToken(page);
		const res = await page.request.post(
			`/index.php/${JOURNAL}/$$$call$$$/grid/users/stage-participant/stage-participant-grid/save-participant?submissionId=${submission.id}&stageId=${STAGE.SUBMISSION}`,
			{
				headers: {'X-Requested-With': 'XMLHttpRequest'},
				form: {
					csrfToken: token,
					submissionId: String(submission.id),
					stageId: String(STAGE.SUBMISSION),
					userGroupId: String(anaAssignment.stageAssignmentUserGroup.id),
					userId: String(ana.id),
					recommendOnly: '1',
				},
			},
		);
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body.status, 'duplicate save is reported successful').toBe(true);

		// …with no warning and no effect: the flag did not change and no
		// duplicate assignment appeared.
		const after = await fetchParticipants(
			page.request,
			submission.id,
			STAGE.SUBMISSION,
		);
		const anaAfter = after.find((u) => u.fullName === ANA);
		expect(anaAfter.stageAssignments).toHaveLength(1);
		expect(anaAfter.stageAssignments[0].recommendOnly).toBe(false);
		expect(anaAfter.stageAssignments[0].stageAssignmentId).toBe(
			anaAssignment.stageAssignmentId,
		);
		// The UI agrees: no recommend-only note on Ana's row.
		await pm.gotoWorkflow(submission.id);
		await pm.expectVisible();
		await expect(pm.participantRow(ANA)).toBeVisible();
		await expect(pm.recommendOnlyIndicator(ANA)).toHaveCount(0);
	});

	test('s7: removing a participant clears them everywhere — all-stages dialog, both panels, discussion participation, history, and their dashboard', async ({
		page,
		asUser,
		pkpApi,
	}) => {
		test.slow(); // notify + removal + cross-actor dashboard check
		const tag = uniqueTag('sph');
		const title = `Remove participant ${tag}`;
		// Rita (Funding coordinator — the assistant group covering
		// stages 1 and 3) so the all-stages removal is observable on two
		// panels.
		const {submission} = await pkpApi.createSubmission(
			submissionSpec({
				tag,
				title,
				participants: [
					{user: 'editor.diana', role: 'editor'},
					{user: 'assistant.rita', role: 'funding'},
				],
			}),
		);

		const pm = new ParticipantManagerPage(page);
		const shell = new WorkflowShellPage(page);
		await pm.gotoWorkflow(submission.id);
		await expect(
			shell.contentHeading('Workflow: Submission'),
		).toBeVisible({timeout: 20_000});
		await expect(pm.roleLabel(RITA, 'Funding coordinator')).toBeVisible({
			timeout: 15_000,
		});

		// Rita participates in a discussion (started via Notify).
		await pm.notifyParticipant(RITA, {
			message: `<p>Please advise on funding. ${tag}</p>`,
		});
		const participants = await fetchParticipants(
			page.request,
			submission.id,
			STAGE.SUBMISSION,
		);
		const rita = participants.find((u) => u.fullName === RITA);
		if (!rita) throw new Error('Rita not in participants payload');
		const tasksRes = await page.request.get(
			`/index.php/${JOURNAL}/api/v1/submissions/${submission.id}/stages/${STAGE.SUBMISSION}/tasks`,
		);
		expect(tasksRes.status()).toBe(200);
		const tasksBeforeBody = await tasksRes.json();
		const tasksBefore = Array.isArray(tasksBeforeBody)
			? tasksBeforeBody
			: tasksBeforeBody.items ?? [];
		const discussionBefore = tasksBefore.find((t) =>
			(t.participants ?? []).some((p) => p.userId === rita.id),
		);
		expect(
			discussionBefore,
			'the Notify discussion should list Rita as a participant',
		).toBeTruthy();

		// Her assignment spans the Review panel too (rule 1).
		await shell.clickMenu('Review');
		await expect(
			shell.contentHeading('Workflow: Review'),
		).toBeVisible({timeout: 20_000});
		await expect(pm.participantRow(RITA)).toBeVisible({timeout: 15_000});

		// Remove — the dialog warns about all stages (asserted inside
		// removeParticipant via awaitRemoveDialog).
		await pm.removeParticipant(RITA);

		// Gone from every stage's panel.
		await shell.clickMenu('Submission');
		await expect(
			shell.contentHeading('Workflow: Submission'),
		).toBeVisible({timeout: 20_000});
		await expect(pm.participantRow(DIANA)).toBeVisible({timeout: 15_000});
		await expect(pm.participantRow(RITA)).toHaveCount(0);

		// Dropped from the discussion's participants.
		const tasksAfterRes = await page.request.get(
			`/index.php/${JOURNAL}/api/v1/submissions/${submission.id}/stages/${STAGE.SUBMISSION}/tasks`,
		);
		const tasksAfterBody = await tasksAfterRes.json();
		const tasksAfter = Array.isArray(tasksAfterBody)
			? tasksAfterBody
			: tasksAfterBody.items ?? [];
		const discussionAfter = tasksAfter.find(
			(t) => t.id === discussionBefore.id,
		);
		expect(discussionAfter, 'the discussion itself survives').toBeTruthy();
		expect(
			(discussionAfter.participants ?? []).some((p) => p.userId === rita.id),
		).toBe(false);

		// The removal is logged in the history
		// (submission.event.participantRemoved; role placeholder never
		// resolves — ledger 14).
		const log = new ActivityLogModal(page);
		await log.openFromWorkflow();
		await log.openHistoryTab();
		await expect(
			log.historyRow(
				/"Rita Assistant" \(assistant\.rita\) is removed as a/,
			),
		).toBeVisible({timeout: 20_000});

		// The submission disappears from Rita's own dashboard.
		const ritaCtx = await asUser('assistant.rita');
		const ritaPage = await ritaCtx.newPage();
		const dash = new DashboardPage(ritaPage);
		await dash.gotoEditorial();
		const searched = ritaPage.waitForResponse(
			(res) => res.url().includes(`searchPhrase=${tag}`) && res.ok(),
			{timeout: 20_000},
		);
		await dash.search(tag);
		await searched;
		await expect(dash.row(tag)).toHaveCount(0);
	});

	test('s8: an assigned Assistant sees but cannot manage — Notify only, no Assign/Edit/Remove; an unassigned Assistant cannot open the workflow at all', async ({
		asUser,
		pkpApi,
	}) => {
		test.slow(); // two assistant contexts
		const tag = uniqueTag('spi');
		const title = `Assistant readonly ${tag}`;
		// Copyediting is the stage an assistant can open cleanly
		// (ledger 234 blocks Submission/Review behind the
		// reviewer-suggestions 401 dialog).
		const {submission} = await pkpApi.createSubmission(
			submissionSpec({
				tag,
				title,
				participants: [
					{user: 'editor.diana', role: 'editor'},
					{user: 'copyeditor.carla', role: 'copyeditor'},
				],
				...TO_COPYEDITING,
			}),
		);

		// The assigned Assistant: the panel lists the team, offers no
		// Assign button, and each row's menu holds Notify but neither
		// Edit nor Remove.
		const carlaCtx = await asUser('copyeditor.carla');
		const carlaPage = await carlaCtx.newPage();
		const pm = new ParticipantManagerPage(carlaPage);
		const shell = new WorkflowShellPage(carlaPage);
		await pm.gotoWorkflow(submission.id);
		await expect(
			shell.contentHeading('Workflow: Copyediting'),
		).toBeVisible({timeout: 20_000});
		await pm.expectVisible();
		await expect(pm.participantRow(DIANA)).toBeVisible({timeout: 15_000});
		await expect(pm.participantRow(CARLA)).toBeVisible();
		await expect(pm.assignButton).toHaveCount(0);
		await pm.expectMenuForRow(pm.participantRow(DIANA), {
			present: ['Notify'],
			absent: ['Edit', 'Remove'],
		});
		await pm.expectMenuForRow(pm.participantRow(CARLA), {
			present: ['Notify'],
			absent: ['Edit', 'Remove'],
		});

		// A different Assistant with no assignment: the API refuses the
		// submission outright and no panel ever renders.
		const samCtx = await asUser('copyeditor.sam');
		const apiRes = await samCtx.request.get(
			`/index.php/${JOURNAL}/api/v1/submissions/${submission.id}/participants/${STAGE.COPYEDITING}`,
		);
		expect(apiRes.status()).toBe(401);
		const samPage = await samCtx.newPage();
		const samPm = new ParticipantManagerPage(samPage);
		const denied = samPage.waitForResponse(
			(res) =>
				res.url().includes(`/api/v1/submissions/${submission.id}`) &&
				res.status() === 401,
			{timeout: 20_000},
		);
		await samPm.gotoWorkflow(submission.id);
		await denied; // the workflow shell's own submission fetch is refused
		await expect(samPm.panel).toHaveCount(0);
		await expect(
			new WorkflowShellPage(samPage).modal().getByText(title),
		).toHaveCount(0);
	});

	test('s9: Notify starts a discussion — Start Discussion dialog with required Message, confirmation toast, the email, and the discussion on the stage', async ({
		asUser,
		pkpApi,
		pkpMail,
	}) => {
		test.slow(); // notify + Mailpit + discussion round-trip
		const tag = uniqueTag('spj');
		const title = `Notify layout ${tag}`;
		// Seeded through to Production — a not-yet-initiated stage view
		// renders no Discussion Manager, and the discussion must appear
		// "on the stage" the Notify was sent from.
		const {submission} = await pkpApi.createSubmission(
			submissionSpec({
				tag,
				title,
				participants: [
					{user: 'editor.diana', role: 'editor'},
					{user: 'sectioneditor.ana', role: 'sectionEditor'},
					{user: 'layouteditor.leo', role: 'layoutEditor'},
				],
				decisions: [
					{type: 'sendExternalReview', by: 'editor.diana'},
					{type: 'accept', by: 'editor.diana'},
					{type: 'sendToProduction', by: 'editor.diana'},
				],
				reviewRounds: [{reviewers: []}],
			}),
		);

		// The Section Editor opens the Production panel (the layout
		// editor's rows live where his group works).
		const anaCtx = await asUser('sectioneditor.ana');
		const anaPage = await anaCtx.newPage();
		const pm = new ParticipantManagerPage(anaPage);
		const shell = new WorkflowShellPage(anaPage);
		await pm.gotoWorkflow(submission.id);
		await expect(
			shell.contentHeading('Workflow: Production'),
		).toBeVisible({timeout: 20_000});
		await expect(pm.roleLabel(LEO, 'Layout Editor')).toBeVisible({
			timeout: 15_000,
		});

		// The Notify dialog: titled "Notify", headed "Start Discussion",
		// explaining it begins a discussion between the two of them, with
		// the Message field required.
		const {modal, form} = await pm.openNotifyForm(LEO);
		await expect(form.getByText('Start Discussion')).toBeVisible();
		await expect(
			form.getByText(`Begin a discussion between yourself and ${LEO}.`),
		).toBeVisible();
		await expect(
			form.locator('label', {hasText: 'Message'}).locator('span.req'),
		).toBeVisible();

		// Send with the layout-request predefined message + tagged body.
		await pm.selectNotifyTemplate(form, 'Ready for Production');
		await pm.setNotifyMessage(
			form,
			`<p>Galleys please. ${tag}</p>`,
		);
		const sentToast = expectToast(anaPage, 'Notification sent to users.');
		await modal.getByRole('button', {name: 'Notify', exact: true}).click();
		await expect(modal).toBeHidden({timeout: 20_000});
		await sentToast;

		// The layout editor gets the email…
		await pkpMail.find({
			to: 'layouteditor.leo@mailinator.com',
			contains: tag,
		});

		// …and the exchange appears as a discussion on the stage, titled
		// with the chosen email's subject line.
		const dm = new DiscussionManagerPage(anaPage);
		await dm.expectVisible();
		await dm.expectHeading('Production Tasks & Discussions');
		const discussionTitle = `Submission ${submission.id} is ready for production at JPK`;
		await expect(dm.titleButton(discussionTitle)).toBeVisible({
			timeout: 15_000,
		});
		await dm.expectInGroup(discussionTitle, 'In progress');
	});
});
