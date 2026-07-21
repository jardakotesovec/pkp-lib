// @ts-check
const {test, expect} = require('../support/base-test.js');
const {ParticipantManagerPage} = require('../pages/ParticipantManagerPage.js');
const {WorkflowShellPage} = require('../pages/WorkflowShellPage.js');
const {DashboardPage} = require('../pages/DashboardPage.js');
const {ActivityLogModal} = require('../pages/ActivityLogModal.js');
const {TasksGridModal} = require('../pages/TasksGridModal.js');
const {DiscussionManagerPage} = require('../pages/DiscussionManagerPage.js');
const {DecisionWizardPage} = require('../pages/DecisionWizardPage.js');

/**
 * Stage participants — one test per canonical scenario of
 * docs/product/specs/stage-participants.md (9 scenarios → 9 tests).
 * The Participants panel (ParticipantManager, the legacy assign/edit/
 * notify forms, StageParticipantGridHandler, auto-assignment) is shared
 * pkp-lib, so the spec lives here; scenario payloads use OJS vocabulary
 * (publicknowledge / ART / skipExternalReview) matching the bootstrap
 * context the suite runs against.
 *
 * Coverage per scenario:
 *   s1  a Journal Manager assigns a copyeditor with the copyedit-request
 *       message: row under the role, "User added as a stage participant."
 *       toast, request email + stage discussion titled with the email
 *       subject, "… was assigned to this submission as a …" history entry
 *   s2  silent assignment leaves the stage status stale (ledger 9): a
 *       blank-message assign keeps "Assign a copyeditor using the Assign
 *       link in the Participants list."; a sent message (assign form or
 *       Notify) flips it to "Awaiting copyedits."; removal never changes
 *       it — even removing the only copyeditor
 *   s3  automatic editor assignment from a section's editor list on
 *       author submit (assignment + "You have been assigned as an
 *       editor…" email), and the needs-editor fallback on an empty list
 *       (managers' Tasks-bell item + needs-editor email); ⚠ ledger
 *       135/164: on any journal after the install's first the configured
 *       editor is silently skipped — test the positive leg on
 *       publicknowledge only
 *   s4  recommend-only editor: box ticked on assign → row note "Only
 *       allowed to recommend an editorial decision" + recommendation-only
 *       decision controls; ⚠ ledger 75: a recommend-only SE still gets
 *       the add-mode box (while Edit is withheld on editor rows entirely)
 *   s5  editing privileges as a manager: both boxes on an SE row + the
 *       "The stage assignment has been changed." toast; only the
 *       recommend-only box on a Journal-editor (manager-role) row; "No
 *       changes can be made to this participant" on one's own SE row
 *   s6  the picker never re-offers an assigned person: absent from that
 *       role's picker on EVERY stage panel, name search yields "No
 *       Items" (privilege changes go through Edit, never re-assign)
 *   s7  removing a participant clears them everywhere: "Remove
 *       Participant" dialog with the all-stages warning; row gone from
 *       every stage panel, dropped from the discussion, removal history
 *       entry, submission gone from the removed Assistant's dashboard
 *   s8  an Assistant sees but cannot manage: panel listed, no Assign,
 *       Notify-only row menus; an unassigned Assistant cannot open the
 *       workflow at all (empty shell; the shell's submission fetch 401s
 *       first, so the participants fetch never fires)
 *   s9  Notify starts a discussion: "Notify" dialog headed "Start
 *       Discussion", Message required, "Notification sent to users."
 *       toast, recipient email, the exchange listed as a stage discussion
 *
 * ENV NOTES for micro-authors (probe-verified 2026-07-21, probes A–D):
 *  - Scenario-seeded decisions do NOT create the per-editor stage-status
 *    notice rows. Any assertion on "Assign a copyeditor…"/"Awaiting
 *    copyedits." (s2) must reach Copyediting through a REAL decision
 *    recorded in the UI (or flip the notice via a real notify action) by
 *    an editor assigned on the stage — and must READ the notice as that
 *    assigned editor: the notices are per-assigned-editor rows, an
 *    unassigned Journal Manager sees no status line at all.
 *  - The test DB carries probe residue: scratch journals probebsp,
 *    probea1, probea2 (ids 46–48), throwaway users prefixed pb / pa,
 *    submissions 198–206.
 *    Never assert on global state (mail counts, notification totals,
 *    "only N participants"); every scenario seeds its own tagged
 *    submission (and scratch journal where needed) via the scenario
 *    endpoints.
 *  - A Journal-manager-GROUP assignment never renders in the panel (the
 *    Collector inner-joins user_group_stage; the manager group has no
 *    stage rows). "Manager row" semantics (s5) are reachable only via
 *    manager-roleId groups WITH stages — use participants role 'editor'
 *    (Journal editor group, e.g. editor.diana).
 *  - The legacy assign/edit form's cancel is an anchor `a.cancelButton`
 *    (not role=button); the reka-ui dialog close and Escape are trapped
 *    while the form is mounted — always exit via the POM's
 *    cancelAssignmentForm()/submit helpers.
 *  - Toasts auto-expire after ~5 s — assert them immediately after the
 *    triggering action (ParticipantManagerPage.toast + *_TOAST statics).
 *
 * Parallel-safety: every submission (and the s3/s8 scratch journals,
 * where needed) is per-test; tags are single hyphenless alphanumeric
 * tokens riding in submission titles; Mailpit reads are recipient+tag
 * scoped (no clearAll; pair every negative with a positive control);
 * publicknowledge is used read-only + additively; no seeded user gains
 * a role anywhere — role mutations (s3's section editor-list config,
 * s8's custom assistant coverage) run on per-test scratch journals with
 * throwaway users.
 */

test.use({user: 'manager.maya'}); // default actor: the Journal Manager

const JOURNAL = 'publicknowledge';

// Seeded users this spec touches: display names + mailinator addresses.
const USER = {
	maya: {name: 'Maya Manager', email: 'manager.maya@mailinator.com'},
	diana: {name: 'Diana Editor', email: 'editor.diana@mailinator.com'},
	ana: {name: 'Ana SectionEditor', email: 'sectioneditor.ana@mailinator.com'},
	ravi: {name: 'Ravi SectionEditor', email: 'sectioneditor.ravi@mailinator.com'},
	omar: {name: 'Omar SectionEditor', email: 'sectioneditor.omar@mailinator.com'},
	carla: {name: 'Carla Copyeditor', email: 'copyeditor.carla@mailinator.com'},
	sam: {name: 'Sam Copyeditor', email: 'copyeditor.sam@mailinator.com'},
	leo: {name: 'Leo LayoutEditor', email: 'layouteditor.leo@mailinator.com'},
	rita: {name: 'Rita Assistant', email: 'assistant.rita@mailinator.com'},
	alex: {name: 'Alex Author', email: 'author.alex@mailinator.com'},
};

/** A unique, hyphenless, alphanumeric tag (parallel isolation + mail scoping). */
function uniqueTag(prefix = 'spt') {
	const workerLetter = String.fromCharCode(
		97 + (test.info().parallelIndex % 26),
	);
	let suffix = '';
	while (suffix.length < 6) {
		suffix += Math.random().toString(36).replace(/[^a-z0-9]/g, '');
	}
	return `${prefix}${workerLetter}${suffix.slice(0, 6)}`;
}

/**
 * Scenario spec for a SUBMITTED submission (single unpublished AO
 * publication carrying the tag in its title — titles feed email
 * subjects and history copy).
 */
function submittedSpec({
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
					abstract: {en: `<p>Stage participants fixture ${tag}.</p>`},
				},
			},
		],
	};
}

/**
 * A submission sitting in Copyediting (stage 4) on publicknowledge:
 * editor.diana (Journal editor — the panel's manager-role row) skipped
 * review straight to Copyediting. NOTE (env notes above): the seeded
 * decision does NOT create the stage-status notice rows — s2 must
 * record its decision through the real UI instead of using this.
 */
function inCopyeditingSpec({tag, title, participants = []}) {
	return submittedSpec({
		tag,
		title,
		participants: [{user: 'editor.diana', role: 'editor'}, ...participants],
		decisions: [{type: 'skipExternalReview', by: 'editor.diana'}],
	});
}

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

test.describe('Stage participants', () => {
	test('s1: a Journal Manager assigns a copyeditor with the copyedit request — row, toast, email, stage discussion, history entry', async ({
		page,
		pkpApi,
		pkpMail,
	}) => {
		const tag = uniqueTag('spta');
		const title = `Copyeditor assignment ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			inCopyeditingSpec({tag, title}),
		);
		// COPYEDIT_REQUEST subject (emails.copyeditRequest.subject):
		// "Submission {$submissionId} is ready to be copyedited for JPK".
		// It titles both the email and the stage discussion (rule 12).
		const emailSubject = `Submission ${submission.id} is ready to be copyedited for JPK`;

		const pm = new ParticipantManagerPage(page);
		const shell = new WorkflowShellPage(page);
		await pm.gotoWorkflow(submission.id);
		// The workflow opens on the submission's current stage — Copyediting.
		await expect(shell.contentHeading('Workflow: Copyediting')).toBeVisible({
			timeout: 20_000,
		});

		// Assign: filter the picker to the Copyeditor role, search and
		// select Carla, pick the copyedit request as the predefined
		// message (body auto-fills, carrying the tagged title), save.
		const {modal, form} = await pm.openAssignForm();
		await pm.selectUser(
			{modal, form},
			{userGroup: 'Copyeditor', nameSearch: 'Carla', fullName: USER.carla.name},
		);
		await pm.selectNotifyTemplate(form, 'Request Copyedit');
		// Submit; the toast is asserted from click-time (it auto-expires
		// after ~5 s and can render duplicated — POM handles both).
		await pm.submitAssignmentForm(modal, {
			toast: ParticipantManagerPage.ADDED_TOAST,
		});

		// The panel lists the person under their role.
		await expect(pm.participantRow(USER.carla.name)).toBeVisible({
			timeout: 15_000,
		});
		await expect(pm.roleLabel(USER.carla.name, 'Copyeditor')).toBeVisible();

		// The copyeditor receives the request email (recipient + tag
		// scoped; the body carries the tagged submission title).
		await pkpMail.find({
			to: USER.carla.email,
			contains: tag,
			subject: emailSubject,
			timeoutMs: 30_000,
		});

		// A discussion titled with the email's subject appears on the
		// stage (reload so the Vue discussion list refetches after the
		// legacy form save).
		await pm.gotoWorkflow(submission.id);
		const dm = new DiscussionManagerPage(page);
		await dm.expectHeading('Copyediting Tasks & Discussions');
		await expect(dm.row(emailSubject)).toBeVisible({timeout: 20_000});

		// The submission history gains the assignment entry
		// (submission.event.participantAdded; its trailing role name
		// renders as a raw placeholder — ledger 14 — so match up to
		// "as a").
		const log = new ActivityLogModal(page);
		await log.openFromWorkflow();
		await log.openHistoryTab();
		await expect(
			log
				.historyRow(
					`${USER.carla.name} (copyeditor.carla) was assigned to this submission as a`,
				)
				.first(),
		).toBeVisible({timeout: 20_000});
	});

	test('s2: silent assignment leaves the stage status stale — only a sent message flips the prompt, and removal never does', async ({
		page,
		asUser,
		pkpApi,
		pkpMail,
	}) => {
		test.slow(); // two actors, a real decision wizard, three notice reads
		const tag = uniqueTag('sptb');
		const title = `Stale stage status ${tag}`;
		// Seeded up to External Review only: the stage-status notice rows
		// are created solely by a REAL Decision::ACCEPT recorded in the UI
		// (env notes above — seeded decisions skip them, and Accept-and-
		// Skip-Review is not in getSubmissionNotificationTypes at all), so
		// diana — the assigned deciding Journal editor — records the
		// Accept herself.
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				participants: [{user: 'editor.diana', role: 'editor'}],
				decisions: [{type: 'sendExternalReview', by: 'editor.diana'}],
				reviewRounds: [{reviewers: []}],
			}),
		);

		// Diana records Accept Submission → the submission lands in
		// Copyediting and her per-assigned-editor notice row is created.
		const dianaCtx = await asUser('editor.diana');
		const dianaPage = await dianaCtx.newPage();
		const dianaShell = new WorkflowShellPage(dianaPage);
		await dianaShell.gotoEditorial(submission.id);
		await expect(
			dianaShell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});
		await dianaShell
			.actionItems()
			.getByRole('button', {name: 'Accept Submission', exact: true})
			.click();
		await dianaPage.waitForURL(/\/decision\/record\//, {
			timeout: 20_000,
			waitUntil: 'commit',
		});
		const wizard = new DecisionWizardPage(dianaPage);
		await wizard.recordThrough('Submission Accepted');
		await wizard.viewSummary(submission.id);
		await expect(
			dianaShell.contentHeading('Workflow: Copyediting'),
		).toBeVisible({timeout: 20_000});

		// The notice starts as the assign-a-copyeditor prompt (read as the
		// assigned editor — an unassigned manager sees no status line).
		const prompt = dianaShell
			.primaryItems()
			.getByText(ParticipantManagerPage.ASSIGN_COPYEDITOR_PROMPT);
		const awaiting = dianaShell
			.primaryItems()
			.getByText(ParticipantManagerPage.AWAITING_COPYEDITS);
		await expect(prompt).toBeVisible({timeout: 20_000});

		// The manager assigns Carla SILENTLY — message box cleared.
		const pm = new ParticipantManagerPage(page);
		await pm.gotoWorkflow(submission.id);
		await expect(
			new WorkflowShellPage(page).contentHeading('Workflow: Copyediting'),
		).toBeVisible({timeout: 20_000});
		const {modal, form} = await pm.openAssignForm();
		await pm.selectUser(
			{modal, form},
			{userGroup: 'Copyeditor', nameSearch: 'Carla', fullName: USER.carla.name},
		);
		await pm.clearNotifyMessage(form);
		await pm.submitAssignmentForm(modal, {
			toast: ParticipantManagerPage.ADDED_TOAST,
		});

		// The person IS listed as a participant (legacy save doesn't
		// refetch the Vue panel — reload first).
		await pm.gotoWorkflow(submission.id);
		await expect(pm.participantRow(USER.carla.name)).toBeVisible({
			timeout: 15_000,
		});
		await expect(pm.roleLabel(USER.carla.name, 'Copyeditor')).toBeVisible();

		// ...yet the stage status is STALE: still the prompt (ledger 9 —
		// saveParticipant never recomputes; no discussion was created).
		await dianaShell.gotoEditorial(submission.id);
		await expect(prompt).toBeVisible({timeout: 20_000});
		await expect(awaiting).toHaveCount(0);

		// A later Notify sends Carla a message — the path that creates the
		// stage discussion and recomputes the status.
		await pm.notifyParticipant(USER.carla.name, {
			message: `<p>Please begin the copyedit ${tag}.</p>`,
			toast: ParticipantManagerPage.NOTIFY_TOAST,
		});
		// Positive control bounding the flip: Carla received the message.
		await pkpMail.find({
			to: USER.carla.email,
			contains: tag,
			timeoutMs: 30_000,
		});

		// The notice flips to "Awaiting copyedits." — prompt gone.
		await dianaShell.gotoEditorial(submission.id);
		await expect(awaiting).toBeVisible({timeout: 20_000});
		await expect(prompt).toHaveCount(0);

		// Removing the ONLY copyeditor never updates the status: the
		// discussion survives, so the notice stays "Awaiting copyedits."
		await pm.gotoWorkflow(submission.id);
		await expect(pm.participantRow(USER.carla.name)).toBeVisible({
			timeout: 15_000,
		});
		await pm.removeParticipant(USER.carla.name);

		await dianaShell.gotoEditorial(submission.id);
		await expect(awaiting).toBeVisible({timeout: 20_000});
		await expect(prompt).toHaveCount(0);
	});

	test('s3: automatic editor assignment from the section editor list on submit, and the needs-editor fallback on an empty list', async ({
		page,
		asUser,
		pkpApi,
		pkpMail,
	}) => {
		test.slow(); // two journals, two real submits, four actors, mail waits

		/**
		 * Submit a seeded draft through the REAL submit endpoint as its
		 * author — the same server path the wizard's Submit uses. The
		 * SubmissionSubmitted event (→ auto-assign / needs-editor fallback)
		 * must fire as a test ACTION: scenario-side mail is dropped by
		 * Mail::fake(), so a scenario-submitted spec could never assert
		 * the assignment emails.
		 *
		 * @param {import('@playwright/test').Page} authorPage
		 * @param {string} journalPath
		 * @param {number} submissionId
		 */
		async function submitAsAuthor(authorPage, journalPath, submissionId) {
			await authorPage.goto(
				`/index.php/${journalPath}/dashboard/mySubmissions`,
				{waitUntil: 'commit'},
			);
			await authorPage.waitForFunction(
				() => !!window.pkp?.currentUser?.csrfToken,
				null,
				{timeout: 15_000},
			);
			const csrf = await authorPage.evaluate(
				() => window.pkp.currentUser.csrfToken,
			);
			const res = await authorPage.request.put(
				`/index.php/${journalPath}/api/v1/submissions/${submissionId}/submit`,
				{headers: {'X-Csrf-Token': csrf}, data: {}},
			);
			expect(res.ok(), `submit: ${res.status()} ${await res.text()}`).toBe(
				true,
			);
		}

		// --- Positive leg: publicknowledge (the install's FIRST journal —
		// the only place auto-assign works, ledger 135/164). Its seeded ART
		// section editor list is reused ADDITIVELY, read-only:
		// ['editor.diana', 'sectioneditor.ana', 'sectioneditor.omar'] —
		// ana + omar hold the Section editor group and get auto-assigned;
		// diana is configured but not in the group, so she is skipped.
		const tagA = uniqueTag('sptc');
		const titleA = `Section hand off ${tagA}`;
		const {submission: subA} = await pkpApi.createSubmission(
			submittedSpec({tag: tagA, title: titleA, submitted: false}),
		);
		const alexCtx = await asUser('author.alex');
		const alexPage = await alexCtx.newPage();
		await submitAsAuthor(alexPage, JOURNAL, subA.id);

		// Both configured Section editors appear in the Participants panel
		// without anyone touching it.
		const pm = new ParticipantManagerPage(page);
		await pm.gotoWorkflow(subA.id);
		await expect(
			new WorkflowShellPage(page).contentHeading('Workflow: Submission'),
		).toBeVisible({timeout: 20_000});
		await expect(pm.participantRow(USER.ana.name)).toBeVisible({
			timeout: 15_000,
		});
		await expect(pm.roleLabel(USER.ana.name, 'Section editor')).toBeVisible();
		await expect(pm.participantRow(USER.omar.name)).toBeVisible();
		await expect(pm.roleLabel(USER.omar.name, 'Section editor')).toBeVisible();
		// The configured-but-not-in-group editor is skipped (rule 10's
		// userInGroup filter) — bounded by ana/omar's rows above.
		await expect(pm.participantRow(USER.diana.name)).toHaveCount(0);

		// Each auto-assigned editor receives the "You have been assigned as
		// an editor…" email (emails.editorAssign.subject; the body carries
		// the tagged title). Recipient + tag scoped.
		await pkpMail.find({
			to: USER.ana.email,
			contains: tagA,
			subject: 'You have been assigned as an editor',
			timeoutMs: 30_000,
		});
		await pkpMail.find({
			to: USER.omar.email,
			contains: tagA,
			subject: 'You have been assigned as an editor',
			timeoutMs: 30_000,
		});
		// The skipped editor hears nothing (ana's email bounds the wait).
		await pkpMail.expectNone({
			to: USER.diana.email,
			contains: tagA,
			afterControl: {to: USER.ana.email, contains: tagA},
			timeoutMs: 30_000,
		});

		// --- Fallback leg on a SCRATCH journal: auto-assign is broken on
		// any journal after the install's first (ledger 135/164), so a
		// section WITH a configured editor behaves exactly as if the list
		// were empty — the configured editor is silently skipped and the
		// needs-editor fallback fires: every Journal Manager gets the
		// Tasks-bell item plus the needs-editor email.
		const tagB = uniqueTag('sptd');
		const titleB = `Needs an editor ${tagB}`;
		const se = `se${tagB}`;
		const mgr = `mg${tagB}`;
		const au = `au${tagB}`;
		const {context} = await pkpApi.createJournal({
			tag: tagB,
			sections: [
				{
					abbrev: {en: 'ART'},
					title: {en: 'Articles'},
					abstractsNotRequired: true,
					sectionEditors: [se],
				},
			],
			users: [
				throwawayUser(se, 'Sena', 'Sectioneditor', ['sectionEditor']),
				throwawayUser(mgr, 'Mori', 'Manager', ['manager']),
				throwawayUser(au, 'Avon', 'Author', ['author']),
			],
		});
		const journalPath = context.path;
		const {submission: subB} = await pkpApi.createSubmission(
			submittedSpec({
				tag: tagB,
				title: titleB,
				journal: journalPath,
				submitter: au,
				submitted: false,
			}),
		);
		const auCtx = await asUser(au);
		const auPage = await auCtx.newPage();
		await submitAsAuthor(auPage, journalPath, subB.id);

		// The Journal Manager gets the needs-editor email
		// (emails.needsEditor.subject carries the tagged title).
		await pkpMail.find({
			to: `${mgr}@mailinator.com`,
			contains: tagB,
			subject: 'needs an editor',
			timeoutMs: 30_000,
		});

		// …and the editor-assignment task in their Tasks bell. (The task
		// text is generic — safe because this manager is a throwaway user
		// on a per-test journal receiving nothing else.)
		const mgrCtx = await asUser(mgr);
		const mgrPage = await mgrCtx.newPage();
		await mgrPage.goto(`/index.php/${journalPath}/dashboard/editorial`, {
			waitUntil: 'commit',
		});
		const bell = new TasksGridModal(mgrPage);
		await expect(bell.bellButton).toBeVisible({timeout: 20_000});
		await bell.open();
		await expect(
			bell
				.task(
					'A new article has been submitted to which an editor needs to be assigned.',
				)
				.first(),
		).toBeVisible({timeout: 15_000});

		// ⚠ The configured Section editor was silently skipped: absent from
		// the Participants panel (the author's own row bounds the panel
		// load) and no assignment email (the manager's mail above bounds
		// the negative).
		const mgrPm = new ParticipantManagerPage(mgrPage);
		await mgrPm.gotoWorkflow(subB.id, {journalPath});
		await mgrPm.expectVisible();
		await expect(mgrPm.participantRow('Avon Author')).toBeVisible({
			timeout: 15_000,
		});
		await expect(mgrPm.participantRow('Sena Sectioneditor')).toHaveCount(0);
		await pkpMail.expectNone({
			to: `${se}@mailinator.com`,
			contains: tagB,
			afterControl: {to: `${mgr}@mailinator.com`, contains: tagB},
			timeoutMs: 30_000,
		});
	});

	test('s4: recommend-only editor — the row note, recommendation-only decision controls, and the unguarded add-mode box (ledger 75)', async ({
		page,
		asUser,
		pkpApi,
	}) => {
		test.slow(); // two actors, three legacy-form round-trips
		const tag = uniqueTag('spte');
		const title = `Recommend only ${tag}`;
		// In External Review (round 1, no reviewers): the review rail is
		// where recommendations diverge from decisions. diana is the
		// deciding Journal editor. Seeded into the REV section: seeding a
		// SUBMITTED spec fires the section auto-assign on publicknowledge,
		// so ART would consume ana AND omar (making them unpickable) —
		// REV auto-assigns only ravi, leaving ana and omar free for the
		// UI assignments below (ravi's plain row doubles as the
		// no-note negative bound).
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				section: 'REV',
				participants: [{user: 'editor.diana', role: 'editor'}],
				decisions: [{type: 'sendExternalReview', by: 'editor.diana'}],
				reviewRounds: [{reviewers: []}],
			}),
		);

		// --- The manager assigns Ana as a Section editor with the
		// recommend-only box ticked (message cleared: the privilege flag,
		// not the notification, is under test here).
		const pm = new ParticipantManagerPage(page);
		const shell = new WorkflowShellPage(page);
		await pm.gotoWorkflow(submission.id);
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});
		const {modal, form} = await pm.openAssignForm();
		await pm.selectUser(
			{modal, form},
			{userGroup: 'Section editor', nameSearch: 'Ana', fullName: USER.ana.name},
		);
		await expect(pm.recommendOnlyCheckbox(form)).toBeVisible();
		await pm.setRecommendOnly(form, true);
		await pm.clearNotifyMessage(form);
		await pm.submitAssignmentForm(modal, {
			toast: ParticipantManagerPage.ADDED_TOAST,
		});

		// The new row carries the recommend-only note (reload first — the
		// legacy save never refetches the Vue panel).
		await pm.gotoWorkflow(submission.id);
		await expect(pm.participantRow(USER.ana.name)).toBeVisible({
			timeout: 15_000,
		});
		await expect(pm.roleLabel(USER.ana.name, 'Section editor')).toBeVisible();
		await expect(pm.recommendOnlyIndicator(USER.ana.name)).toBeVisible();
		// Negative bound: ravi's auto-assigned (plain) SE row renders
		// WITHOUT the note.
		await expect(pm.participantRow(USER.ravi.name)).toBeVisible();
		await expect(pm.recommendOnlyIndicator(USER.ravi.name)).toHaveCount(0);

		// --- Ana's decision controls offer ONLY recommendations. Rail
		// labels only: the wizard internals belong to the
		// editorial-decisions suite (its s8).
		const anaCtx = await asUser('sectioneditor.ana');
		const anaPage = await anaCtx.newPage();
		const anaShell = new WorkflowShellPage(anaPage);
		await anaShell.gotoEditorial(submission.id);
		await expect(
			anaShell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});
		const anaRail = (name) =>
			anaShell.actionItems().getByRole('button', {name, exact: true});
		await expect(anaRail('Recommend Accept')).toBeVisible({timeout: 20_000});
		await expect(anaRail('Recommend Revisions')).toBeVisible();
		await expect(anaRail('Recommend Decline')).toBeVisible();
		// ...and none of the full decisions (bounded by the Recommends).
		await expect(anaRail('Accept Submission')).toHaveCount(0);
		await expect(anaRail('Decline Submission')).toHaveCount(0);
		await expect(anaRail('Request Revisions')).toHaveCount(0);

		// --- ⚠ Ledger 75: the recommend-only SE herself gets the SAME
		// add-mode recommend-only box when assigning a new editor…
		const anaPm = new ParticipantManagerPage(anaPage);
		const add = await anaPm.openAssignForm();
		await anaPm.selectUser(add, {
			userGroup: 'Section editor',
			nameSearch: 'Omar',
			fullName: USER.omar.name,
		});
		await expect(anaPm.recommendOnlyCheckbox(add.form)).toBeVisible();
		await expect(anaPm.recommendOnlyCheckbox(add.form)).toBeEnabled();
		await anaPm.setRecommendOnly(add.form, true);
		await anaPm.clearNotifyMessage(add.form);
		await anaPm.submitAssignmentForm(add.modal, {
			toast: ParticipantManagerPage.ADDED_TOAST,
		});

		// …and it sticks end-to-end: the new editor's row carries the note.
		await anaPm.gotoWorkflow(submission.id);
		await expect(anaPm.participantRow(USER.omar.name)).toBeVisible({
			timeout: 15_000,
		});
		await expect(
			anaPm.roleLabel(USER.omar.name, 'Section editor'),
		).toBeVisible();
		await expect(anaPm.recommendOnlyIndicator(USER.omar.name)).toBeVisible();

		// …while the Edit action on existing editor rows is withheld from
		// her entirely: exact Notify+Remove set on the SE row (probe A
		// item 3)...
		await anaPm.expectMenuActions(USER.omar.name, ['Notify', 'Remove']);
		// ...and no Edit on the Journal editor's row either (Notify still
		// offered — the positive control that the menu rendered).
		await anaPm.openMoreActions(USER.diana.name);
		await expect(anaPm.menuItem('Notify')).toBeVisible();
		await expect(anaPm.menuItem('Edit')).toHaveCount(0);
		await anaPm.closeMoreActions(USER.diana.name);
	});

	test("s5: editing a participant's privileges — both boxes on an SE row, recommend-only box only on a Journal-editor row, 'No changes' on one's own", async ({
		asUser,
		pkpApi,
	}) => {
		test.slow(); // scratch journal + three legacy-form round-trips
		const tag = uniqueTag('sptf');
		const title = `Privilege edits ${tag}`;
		// The acting "Journal Manager who ALSO holds her own Section-editor
		// assignment" cannot exist on publicknowledge (manager.maya has no
		// SE group, and no seeded user may gain a role — parallel-safety
		// note), so the guard matrix runs on a per-test scratch journal
		// with throwaway users: probe B item 13's exact setup. The
		// "Journal Manager row" is the Journal editor group (role 'editor'
		// — manager roleId WITH stages, env notes above).
		const mgr = `mg${tag}`;
		const je = `je${tag}`;
		const se = `se${tag}`;
		const au = `au${tag}`;
		const MGR_NAME = 'Mona Manager';
		const JE_NAME = 'Jorin Journaleditor';
		const SE_NAME = 'Selda Sectioneditor';
		const {context} = await pkpApi.createJournal({
			tag,
			sections: [
				{
					abbrev: {en: 'ART'},
					title: {en: 'Articles'},
					abstractsNotRequired: true,
				},
			],
			users: [
				throwawayUser(mgr, 'Mona', 'Manager', ['manager', 'sectionEditor']),
				throwawayUser(je, 'Jorin', 'Journaleditor', ['editor']),
				throwawayUser(se, 'Selda', 'Sectioneditor', ['sectionEditor']),
				throwawayUser(au, 'Auric', 'Author', ['author']),
			],
		});
		const journalPath = context.path;
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				journal: journalPath,
				submitter: au,
				participants: [
					{user: mgr, role: 'sectionEditor'}, // the manager's OWN SE row
					{user: je, role: 'editor'}, // Journal editor (manager-power) row
					{user: se, role: 'sectionEditor'}, // an ordinary SE row
				],
			}),
		);

		const mgrCtx = await asUser(mgr);
		const mgrPage = await mgrCtx.newPage();
		const pm = new ParticipantManagerPage(mgrPage);
		await pm.gotoWorkflow(submission.id, {journalPath});
		await expect(
			new WorkflowShellPage(mgrPage).contentHeading('Workflow: Submission'),
		).toBeVisible({timeout: 20_000});
		await expect(pm.participantRow(SE_NAME)).toBeVisible({timeout: 15_000});

		// --- An ordinary Section-editor row: "Edit Assignment" shows the
		// person READ-ONLY (name + group as text, no user-picker grid) with
		// BOTH privilege boxes.
		{
			const {modal, form} = await pm.openEditAssignmentForm(SE_NAME);
			await expect(form.getByText(SE_NAME)).toBeVisible();
			await expect(form.locator('#userSelectGridContainer')).toHaveCount(0);
			await expect(pm.recommendOnlyCheckbox(form)).toBeVisible();
			await expect(pm.metadataCheckbox(form)).toBeVisible();
			// Save a real change (tick recommend-only) → the edit toast.
			await pm.setRecommendOnly(form, true);
			await pm.submitAssignmentForm(modal, {
				toast: ParticipantManagerPage.EDITED_TOAST,
			});
		}

		// The save actually stuck: after a reload (legacy save never
		// refetches the Vue panel) the row carries the recommend-only note.
		await pm.gotoWorkflow(submission.id, {journalPath});
		await expect(pm.participantRow(SE_NAME)).toBeVisible({timeout: 15_000});
		await expect(pm.recommendOnlyIndicator(SE_NAME)).toBeVisible();

		// --- The Journal-editor row (a role with journal-manager powers):
		// ONLY the recommend-only box — the metadata box is never offered
		// on a manager-level row (rule 6).
		{
			const {modal, form} = await pm.openEditAssignmentForm(JE_NAME);
			await expect(form.getByText(JE_NAME)).toBeVisible();
			await expect(pm.recommendOnlyCheckbox(form)).toBeVisible();
			await expect(pm.metadataCheckbox(form)).toHaveCount(0);
			await pm.cancelAssignmentForm({modal, form});
		}

		// --- Her OWN Section-editor row: Edit still opens the form, but it
		// reads "No changes can be made to this participant" — no
		// checkboxes at all.
		{
			const {modal, form} = await pm.openEditAssignmentForm(MGR_NAME);
			await expect(pm.noChangesMessage(form)).toBeVisible();
			await expect(pm.recommendOnlyCheckbox(form)).toHaveCount(0);
			await expect(pm.metadataCheckbox(form)).toHaveCount(0);
			await pm.cancelAssignmentForm({modal, form});
		}
	});

	test('s6: the picker never re-offers an assigned person — hidden from the role list on every stage panel, name search finds No Items', async ({
		page,
		pkpApi,
	}) => {
		test.slow(); // four assign-form round-trips + one privilege edit
		const tag = uniqueTag('sptg');
		const title = `Picker exclusion ${tag}`;
		// Seeded into REV: the SUBMITTED spec fires section auto-assign on
		// publicknowledge, and REV consumes ONLY ravi — he becomes the
		// already-assigned Section editor under test, while ana and omar
		// stay unassigned as the picker's positive controls (ART would
		// consume both of them). diana's editor row + the review decision
		// put the submission in External Review so all four stage panels
		// (one reached, two not yet initiated) are on the menu.
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				section: 'REV',
				participants: [{user: 'editor.diana', role: 'editor'}],
				decisions: [{type: 'sendExternalReview', by: 'editor.diana'}],
				reviewRounds: [{reviewers: []}],
			}),
		);

		const pm = new ParticipantManagerPage(page);
		const shell = new WorkflowShellPage(page);
		await pm.gotoWorkflow(submission.id);
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});

		// Ravi already holds a Section-editor assignment (auto-assigned on
		// submit) — the panel row is the "somebody already holds this role"
		// precondition the picker must honor.
		await expect(pm.participantRow(USER.ravi.name)).toBeVisible({
			timeout: 15_000,
		});
		await expect(pm.roleLabel(USER.ravi.name, 'Section editor')).toBeVisible();

		// On the CURRENT stage's panel, prove the picker itself works
		// before reading any absence: filtered to Section editor it lists
		// the two unassigned SEs, and a name search really applies (Ana's
		// search drops Omar) — bounding both negatives that follow.
		{
			const {modal, form} = await pm.openAssignForm();
			// The grid refetches only when Search submits the filter form —
			// an empty-name Search loads the full Section-editor list.
			await pm.filterPickerByGroup(form, 'Section editor');
			await pm.searchPicker(form, '');
			await expect(pm.pickerRow(modal, USER.ana.name)).toBeVisible({
				timeout: 15_000,
			});
			await expect(pm.pickerRow(modal, USER.omar.name)).toBeVisible();
			// The assigned person is missing from the unsearched role list.
			await expect(modal.locator('tr').filter({hasText: 'Ravi'})).toHaveCount(
				0,
			);
			// Positive search control: an UNassigned SE is findable by name.
			await pm.searchPicker(form, 'Ana');
			await expect(pm.pickerRow(modal, USER.ana.name)).toBeVisible({
				timeout: 15_000,
			});
			await expect(modal.locator('tr').filter({hasText: 'Omar'})).toHaveCount(
				0,
			);
			// Searching the assigned person's name finds "No Items".
			await pm.searchPicker(form, 'Ravi');
			await expect(pm.pickerNoItems(modal)).toBeVisible({timeout: 15_000});
			await expect(modal.locator('tr').filter({hasText: 'Ravi'})).toHaveCount(
				0,
			);
			await pm.cancelAssignmentForm({modal, form});
		}

		// ...and on EVERY OTHER stage's panel alike (the exclusion filter
		// carries no stage condition — probe C item 6), including the
		// stages the submission has not reached: same role list without
		// Ravi (Ana's row bounds each grid load), same "No Items" on his
		// name — the same assignment cannot be made twice from the form.
		for (const stage of [
			{menu: 'Submission', heading: 'Workflow: Submission'},
			{menu: 'Copyediting', heading: 'Workflow: Copyediting'},
			{menu: 'Production', heading: 'Workflow: Production'},
		]) {
			await shell.clickMenu(stage.menu);
			await expect(shell.contentHeading(stage.heading)).toBeVisible({
				timeout: 20_000,
			});
			const {modal, form} = await pm.openAssignForm();
			await pm.filterPickerByGroup(form, 'Section editor');
			await pm.searchPicker(form, '');
			await expect(pm.pickerRow(modal, USER.ana.name)).toBeVisible({
				timeout: 15_000,
			});
			await expect(modal.locator('tr').filter({hasText: 'Ravi'})).toHaveCount(
				0,
			);
			await pm.searchPicker(form, 'Ravi');
			await expect(pm.pickerNoItems(modal)).toBeVisible({timeout: 15_000});
			await expect(modal.locator('tr').filter({hasText: 'Ravi'})).toHaveCount(
				0,
			);
			await pm.cancelAssignmentForm({modal, form});
		}

		// Changing an existing participant's privileges goes through the
		// row's Edit action instead — never a re-assign: Edit on Ravi's
		// row saves a real privilege change ("The stage assignment has
		// been changed.") that lands on the row as the recommend-only note.
		await expect(pm.participantRow(USER.ravi.name)).toBeVisible({
			timeout: 15_000,
		});
		{
			const {modal, form} = await pm.openEditAssignmentForm(USER.ravi.name);
			await expect(form.getByText(USER.ravi.name)).toBeVisible();
			await pm.setRecommendOnly(form, true);
			await pm.submitAssignmentForm(modal, {
				toast: ParticipantManagerPage.EDITED_TOAST,
			});
		}
		// Reload (legacy save never refetches the Vue panel): the edit stuck.
		await pm.gotoWorkflow(submission.id);
		await expect(pm.participantRow(USER.ravi.name)).toBeVisible({
			timeout: 15_000,
		});
		await expect(pm.recommendOnlyIndicator(USER.ravi.name)).toBeVisible();
	});

	test('s7: removing a participant clears them everywhere — all-stages warning, panels, discussions, history, and their dashboard', async ({
		page,
		asUser,
		pkpApi,
	}) => {
		test.slow(); // two actors, a discussion round-trip, four panel reads
		const tag = uniqueTag('spth');
		const title = `Removal everywhere ${tag}`;
		// Seeded into REV (auto-assigns only ravi, keeping the roster
		// small). diana's Journal-editor row (group on all four stages)
		// bounds every panel read below; rita — the Assistant under
		// test — is seeded as Funding coordinator, the one default
		// ASSISTANT group spanning TWO stages (1+3, probe D item 12), so
		// her single assignment renders on two panels before removal.
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				section: 'REV',
				participants: [
					{user: 'editor.diana', role: 'editor'},
					{user: 'assistant.rita', role: 'funding'},
				],
				decisions: [{type: 'sendExternalReview', by: 'editor.diana'}],
				reviewRounds: [{reviewers: []}],
			}),
		);
		const discussionTitle = `Removal discussion ${tag}`;

		const pm = new ParticipantManagerPage(page);
		const shell = new WorkflowShellPage(page);
		await pm.gotoWorkflow(submission.id);
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});

		// Precondition: rita's row is on the Review panel under her role.
		await expect(pm.participantRow(USER.rita.name)).toBeVisible({
			timeout: 15_000,
		});
		await expect(
			pm.roleLabel(USER.rita.name, 'Funding coordinator'),
		).toBeVisible();

		// Rita participates in a stage discussion: the manager starts one
		// with rita and diana; the display modal's participant list (it
		// renders only SELECTED people) shows both.
		const dm = new DiscussionManagerPage(page);
		await dm.expectHeading('Review Tasks & Discussions');
		{
			const form = await dm.openAdd();
			await form.fillTitle(discussionTitle);
			await form.fillDescription(`<p>Pre-removal exchange ${tag}.</p>`);
			await form.checkParticipant(USER.rita.name);
			await form.checkParticipant(USER.diana.name);
			await form.save();
			const view = await dm.openByTitle(discussionTitle);
			await view.expectContains(USER.rita.name);
			await view.expectContains(USER.diana.name);
			await view.close();
		}

		// ...and the submission sits on rita's own editorial dashboard
		// (the pre-removal positive of the disappearance check below).
		const ritaCtx = await asUser('assistant.rita');
		const ritaPage = await ritaCtx.newPage();
		const ritaDash = new DashboardPage(ritaPage);
		await ritaDash.gotoEditorial();
		await expect(ritaDash.viewHeading(/Assigned to me/)).toBeVisible({
			timeout: 20_000,
		});
		await ritaDash.search(tag);
		await expect(ritaDash.row(title)).toBeVisible({timeout: 20_000});

		// The one assignment spans stages: rita's row also renders on the
		// Submission panel — where the Remove is issued from.
		await shell.clickMenu('Submission');
		await expect(shell.contentHeading('Workflow: Submission')).toBeVisible({
			timeout: 20_000,
		});
		await expect(pm.participantRow(USER.rita.name)).toBeVisible({
			timeout: 15_000,
		});

		// --- Remove: the "Remove Participant" dialog warns about ALL
		// stages; confirming clears the row.
		const confirm = await pm.openRemoveDialog(USER.rita.name);
		await expect(confirm.getByText('Remove Participant').first()).toBeVisible();
		await expect(
			confirm.getByText(ParticipantManagerPage.REMOVE_WARNING),
		).toBeVisible();
		await confirm.getByRole('button', {name: /^OK$/i}).click();
		await expect(pm.participantRow(USER.rita.name)).toHaveCount(0, {
			timeout: 15_000,
		});

		// The submission history logs the removal
		// (submission.event.participantRemoved; matched through the
		// username up to the role name, mirroring s1's ledger-14 caution).
		const log = new ActivityLogModal(page);
		await log.openFromWorkflow();
		await log.openHistoryTab();
		await expect(
			log.historyRow(/\(assistant\.rita\) is removed as a/).first(),
		).toBeVisible({timeout: 20_000});
		await log.close();

		// Row gone from EVERY stage's panel — the current stage on reload,
		// then every other panel alike (diana's all-stage Journal-editor
		// row bounds each panel's load).
		await pm.gotoWorkflow(submission.id);
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});
		await expect(pm.participantRow(USER.diana.name)).toBeVisible({
			timeout: 15_000,
		});
		await expect(pm.participantRow(USER.rita.name)).toHaveCount(0);

		// Dropped from the discussion: the exchange survives, diana is
		// still listed (positive bound), rita no longer is.
		{
			const view = await dm.openByTitle(discussionTitle);
			await view.expectContains(USER.diana.name);
			await expect(view.modal.getByText(USER.rita.name)).toHaveCount(0);
			await view.close();
		}

		for (const stage of [
			{menu: 'Submission', heading: 'Workflow: Submission'},
			{menu: 'Copyediting', heading: 'Workflow: Copyediting'},
			{menu: 'Production', heading: 'Workflow: Production'},
		]) {
			await shell.clickMenu(stage.menu);
			await expect(shell.contentHeading(stage.heading)).toBeVisible({
				timeout: 20_000,
			});
			await expect(pm.participantRow(USER.diana.name)).toBeVisible({
				timeout: 15_000,
			});
			await expect(pm.participantRow(USER.rita.name)).toHaveCount(0);
		}

		// ...and the submission has disappeared from rita's own dashboard
		// (same view + same search that found it above).
		await ritaDash.gotoEditorial();
		await expect(ritaDash.viewHeading(/Assigned to me/)).toBeVisible({
			timeout: 20_000,
		});
		await ritaDash.search(tag);
		await expect(ritaDash.viewHeading(/Assigned to me \(0\)/)).toBeVisible({
			timeout: 20_000,
		});
		await expect(ritaDash.row(title)).toHaveCount(0);
	});

	test('s8: an Assistant sees but cannot manage — Notify-only menus, no Assign; an unassigned Assistant is locked out entirely', async ({
		asUser,
		pkpApi,
	}) => {
		const tag = uniqueTag('spti');
		const title = `Assistant affordances ${tag}`;
		// carla — the assigned Assistant — is seeded via role 'copyeditor'
		// (the default assistant group working exactly Copyediting), and
		// diana's seeded skip-review decision parks the submission on that
		// stage: the spec's literal staging, and the panel probe A item 10
		// verified. Seeded into REV so the section auto-assign consumes
		// only ravi (ART would add ana AND omar) — the team carla sees is
		// diana (Journal editor), ravi (Section editor), herself, and alex
		// (Author). NOTE: do NOT stage this leg on Submission/Review — the
		// workflow page there fires a reviewers/suggestions API call that
		// 401s for assistants and pops a blocking "Error" dialog whose
		// aria-modal hides the panel from role queries.
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				section: 'REV',
				participants: [
					{user: 'editor.diana', role: 'editor'},
					{user: 'copyeditor.carla', role: 'copyeditor'},
				],
				decisions: [{type: 'skipExternalReview', by: 'editor.diana'}],
			}),
		);

		// --- The ASSIGNED Assistant sees the team...
		const carlaCtx = await asUser('copyeditor.carla');
		const carlaPage = await carlaCtx.newPage();
		const pm = new ParticipantManagerPage(carlaPage);
		const shell = new WorkflowShellPage(carlaPage);
		await pm.gotoWorkflow(submission.id);
		await expect(shell.contentHeading('Workflow: Copyediting')).toBeVisible({
			timeout: 20_000,
		});

		// The panel lists everyone under their role — the editors, herself,
		// and the author.
		await expect(pm.participantRow(USER.diana.name)).toBeVisible({
			timeout: 15_000,
		});
		await expect(pm.roleLabel(USER.diana.name, 'Journal editor')).toBeVisible();
		await expect(pm.participantRow(USER.ravi.name)).toBeVisible();
		await expect(pm.roleLabel(USER.ravi.name, 'Section editor')).toBeVisible();
		await expect(pm.participantRow(USER.carla.name)).toBeVisible();
		await expect(pm.roleLabel(USER.carla.name, 'Copyeditor')).toBeVisible();
		await expect(pm.participantRow(USER.alex.name)).toBeVisible();
		await expect(pm.roleLabel(USER.alex.name, 'Author')).toBeVisible();

		// ...but cannot manage: no Assign button at all (the rows above
		// bound the panel render)...
		await expect(pm.assignButton).toHaveCount(0);

		// ...and every row's menu is EXACTLY Notify — no Edit, no Remove,
		// no Login As — on both editor rows, the author's row, and her own
		// alike (probe A item 10's affordance matrix).
		await pm.expectMenuActions(USER.diana.name, ['Notify']);
		await pm.expectMenuActions(USER.ravi.name, ['Notify']);
		await pm.expectMenuActions(USER.alex.name, ['Notify']);
		await pm.expectMenuActions(USER.carla.name, ['Notify']);

		// --- A DIFFERENT Assistant with no assignment on this submission
		// (sam holds the same assistant-level role on the journal) cannot
		// open the workflow at all: the modal opens as an EMPTY shell,
		// denied at the request level with a 401 (probe A item 10). The
		// shell's submission fetch is the request that carries the denial —
		// it 401s first and the workflow page (and so the participants
		// fetch) never mounts; accept either endpoint shape.
		const samCtx = await asUser('copyeditor.sam');
		const samPage = await samCtx.newPage();
		const samPm = new ParticipantManagerPage(samPage);
		const samShell = new WorkflowShellPage(samPage);
		const deniedUrl = new RegExp(
			`/api/v1/submissions/${submission.id}(/participants/\\d+)?$`,
		);
		const denied = samPage.waitForResponse(
			(r) => deniedUrl.test(r.url()) && r.status() === 401,
			{timeout: 20_000},
		);
		await samPm.gotoWorkflow(submission.id);
		const deniedResponse = await denied;
		expect((await deniedResponse.json()).error).toBe(
			'user.authorization.roleBasedAccessDenied',
		);

		// The 401 surfaces to the user as a blocking "Error" dialog with
		// the role-denial sentence; while it is up its aria-modal hides
		// the shell from role queries — assert it, then dismiss.
		const errorDialog = samPage.getByRole('dialog', {name: 'Error'});
		await expect(errorDialog).toBeVisible({timeout: 20_000});
		await expect(
			errorDialog.getByText(
				'The current role does not have access to this operation.',
			),
		).toBeVisible();
		await errorDialog.getByRole('button', {name: 'OK', exact: true}).click();
		await expect(errorDialog).toBeHidden({timeout: 10_000});

		// Behind it the shell shows only its chrome — the Close control
		// (the positive bound that the modal DID open) — with no
		// "Workflow: …" stage heading, no Participants panel, none of the
		// team's rows. (The header's submission id renders as CSS-generated
		// content, so it is not text-matchable.)
		await expect(
			samShell.modal().getByRole('button', {name: 'Close', exact: true}).first(),
		).toBeVisible({timeout: 20_000});
		await expect(
			samShell.modal().getByRole('heading', {name: /workflow:/i}),
		).toHaveCount(0);
		await expect(samPm.panel).toHaveCount(0);
		await expect(samPm.participantRow(USER.diana.name)).toHaveCount(0);
	});

	test('s9: Notify starts a discussion — Start Discussion dialog, required Message, sent toast, the email and the stage discussion', async ({
		asUser,
		pkpApi,
		pkpMail,
	}) => {
		const tag = uniqueTag('sptj');
		const title = `Layout notify ${tag}`;
		// In PRODUCTION — the one stage the Layout Editor group works, so
		// leo's row renders on the panel the acting Section editor opens.
		// Seeded into REV so the section auto-assign consumes ONLY ravi —
		// he becomes the assigned Section editor the scenario acts as
		// (his SE group covers Production). diana's Journal-editor row
		// carries the two seeded decisions that park the submission there.
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				section: 'REV',
				participants: [
					{user: 'editor.diana', role: 'editor'},
					{user: 'layouteditor.leo', role: 'layoutEditor'},
				],
				decisions: [
					{type: 'skipExternalReview', by: 'editor.diana'},
					{type: 'sendToProduction', by: 'editor.diana'},
				],
			}),
		);
		// LAYOUT_REQUEST subject (emails.layoutRequest.subject):
		// "Submission {$submissionId} is ready for production at JPK".
		// The compiled subject titles both the email and the stage
		// discussion (the sendMessage head note — same mechanism s1
		// asserts on the assign form's message).
		const emailSubject = `Submission ${submission.id} is ready for production at JPK`;

		// The SECTION EDITOR (ravi, auto-assigned on submit) opens the
		// workflow — it lands on the submission's current stage,
		// Production, where leo's Layout Editor row is listed.
		const raviCtx = await asUser('sectioneditor.ravi');
		const raviPage = await raviCtx.newPage();
		const pm = new ParticipantManagerPage(raviPage);
		const shell = new WorkflowShellPage(raviPage);
		await pm.gotoWorkflow(submission.id);
		await expect(shell.contentHeading('Workflow: Production')).toBeVisible({
			timeout: 20_000,
		});
		await expect(pm.participantRow(USER.leo.name)).toBeVisible({
			timeout: 15_000,
		});
		await expect(pm.roleLabel(USER.leo.name, 'Layout Editor')).toBeVisible();

		// --- Notify on the layout editor's row: the dialog is titled
		// "Notify" (openNotifyForm asserts the dialog name), headed
		// "Start Discussion", and explains it begins a discussion
		// between the two of them.
		const {modal, form} = await pm.openNotifyForm(USER.leo.name);
		await expect(
			form.getByText('Start Discussion', {exact: true}),
		).toBeVisible();
		await expect(
			form.getByText(
				`Begin a discussion between yourself and ${USER.leo.name}.`,
			),
		).toBeVisible();

		// The Message field is REQUIRED here (unlike the assign form's
		// optional notify section): its label carries the asterisk and
		// the form shows the required-fields legend (probe A item 10:
		// "Message starred required"; notify.tpl required="true").
		await expect(
			form
				.locator('label')
				.filter({hasText: /^Message/})
				.locator('span.req'),
		).toBeVisible();
		await expect(
			form.getByText('Required fields are marked with an asterisk'),
		).toBeVisible();

		// Pick the stage's predefined "Ready for Production" message
		// (LAYOUT_REQUEST — offered on the Production panel alongside
		// "Discussion (Production)"); the body auto-fills, carrying the
		// tagged submission title. Send with the dialog's single
		// "Notify" button.
		await pm.selectNotifyTemplate(form, 'Ready for Production');

		// FINAL CLAUSE 1/3 — "Notification sent to users." confirms
		// (asserted from click-time on the page of the user who sent it;
		// the toast auto-expires after ~5 s).
		await pm.submitNotifyForm(modal, {
			toast: ParticipantManagerPage.NOTIFY_TOAST,
		});

		// FINAL CLAUSE 2/3 — the layout editor gets the email (recipient
		// + tag scoped; the body carries the tagged title).
		await pkpMail.find({
			to: USER.leo.email,
			contains: tag,
			subject: emailSubject,
			timeoutMs: 30_000,
		});

		// FINAL CLAUSE 3/3 — the exchange appears as a discussion on the
		// stage, titled with the message's subject (reload first: the
		// legacy notify form never refetches the Vue panels).
		await pm.gotoWorkflow(submission.id);
		const dm = new DiscussionManagerPage(raviPage);
		await dm.expectHeading('Production Tasks & Discussions');
		await expect(dm.row(emailSubject)).toBeVisible({timeout: 20_000});
	});
});
