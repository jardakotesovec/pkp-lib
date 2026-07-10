// @ts-check
const {test, expect} = require('../support/base-test.js');
const {ReviewerManagerPage} = require('../pages/ReviewerManagerPage.js');
const {ReviewerSubmissionPage} = require('../pages/ReviewerSubmissionPage.js');
const {TasksGridModal} = require('../pages/TasksGridModal.js');
const {ActivityLogModal} = require('../pages/ActivityLogModal.js');

/**
 * Assign & manage reviewers — one test per canonical scenario of
 * docs/product/specs/assign-and-manage-reviewers.md (13 scenarios →
 * 13 tests). The feature is shared pkp-lib (ReviewerManager Vue panel +
 * PKPReviewerGridHandler legacy modals), and the config's testMatch
 * wires this tree into the app project, so the spec lives here; the
 * scenario payloads it seeds necessarily use OJS vocabulary
 * (publicknowledge / ART / sendExternalReview), matching the
 * bootstrap's OJS context the suite runs against.
 *
 * Coverage per scenario:
 *   s1  assign from the pool: Request Sent row + invitation email +
 *       reviewer task notification
 *   s2  skip email: row + notification still fire, no invitation mail
 *       (expectNone bounded by a positive control to a 2nd reviewer)
 *   s3  conflict warning: a reviewer who authored the submission is
 *       locked in the picker, Unlock exposes Select, assign proceeds
 *   s4  create reviewer mid-assignment (registration + request mails);
 *       assistant's picker offers neither Create nor Enroll
 *   s5  round-2 pins last round's reviewer with "Reassign" and preloads
 *       the subsequent-request template
 *   s6  unassign-before-answer deletes the row; cancel-after-accept
 *       keeps a Request Cancelled row; both email the reviewer
 *   s7  reinstate returns the cancelled-after-accept row to
 *       Request Accepted
 *   s8  decline → resend with fresh dates → Request Resent → editor
 *       logs the acceptance on the reviewer's behalf
 *   s9  read (flips to Review Viewed), set recommendation by proxy,
 *       rate, confirm (Complete + by-proxy activity-log row), revert
 *       (back to Review Submitted)
 *   s10 thank from a Complete row → Reviewer Thanked + ack email
 *   s11 edit moves the review due date → email + updated task
 *       notification + persisted dateDue
 *   s12 overdue row's headline Send Reminder → remind email + History
 *       shows the reminded milestone
 *   s13 author sees no panel while nothing is disclosable; a completed
 *       open review yields the redacted panel (reviewer, type, Read
 *       Review only)
 *
 * Parallel-safety: every submission (and the s4 scratch journal) is
 * per-test; tags are single hyphenless alphanumeric tokens riding in
 * the submission title (all reviewer emails interpolate
 * {$submissionTitle}); Mailpit reads are recipient+tag scoped, the one
 * negative assertion is bounded by a positive control; no seeded user
 * gains a role anywhere (throwaway users carry the s4 scratch-journal
 * roles).
 */

test.use({user: 'dbarnes'});

const JOURNAL = 'publicknowledge';

// Seeded users this spec touches: display names (row lookups) +
// mailinator addresses (Mailpit scoping).
const USER = {
	dbarnes: {name: 'Daniel Barnes', email: 'dbarnes@mailinator.com'},
	dbuskins: {name: 'David Buskins', email: 'dbuskins@mailinator.com'},
	jjanssen: {name: 'Julie Janssen', email: 'jjanssen@mailinator.com'},
	phudson: {name: 'Paul Hudson', email: 'phudson@mailinator.com'},
	amccrae: {name: 'Aisla McCrae', email: 'amccrae@mailinator.com'},
	agallego: {name: 'Adela Gallego', email: 'agallego@mailinator.com'},
	atester: {name: 'Author Tester', email: 'atester@mailinator.com'},
};

/** A unique, hyphenless, alphanumeric tag (parallel isolation + mail scoping). */
function uniqueTag(prefix = 'amr') {
	const workerLetter = String.fromCharCode(
		97 + (test.info().parallelIndex % 26),
	);
	let suffix = '';
	while (suffix.length < 6) {
		suffix += Math.random().toString(36).replace(/[^a-z0-9]/g, '');
	}
	return `${prefix}${workerLetter}${suffix.slice(0, 6)}`;
}

/** YYYY-MM-DD, `days` from today. */
function isoDate(days = 0) {
	const d = new Date();
	d.setDate(d.getDate() + days);
	return d.toISOString().slice(0, 10);
}

/**
 * Scenario payload: a submission in external review round 1.
 *
 * @param {object} opts
 * @param {string} opts.tag
 * @param {Array}  [opts.reviewers]     round-1 reviewer specs
 * @param {string} [opts.submitter]
 * @param {string} [opts.journal]
 * @param {Array}  [opts.participants]
 * @param {Array}  [opts.decisions]
 * @param {Array}  [opts.reviewRounds]  overrides reviewers wholesale
 */
function inReviewSpec({
	tag,
	reviewers = [],
	submitter = 'rvaca',
	journal = JOURNAL,
	participants,
	decisions,
	reviewRounds,
}) {
	return {
		tag,
		journal,
		submitter,
		section: 'ART',
		locale: 'en',
		participants: participants ?? [{user: 'dbarnes', role: 'editor'}],
		decisions: decisions ?? [{type: 'sendExternalReview', by: 'dbarnes'}],
		reviewRounds: reviewRounds ?? [{reviewers}],
		publications: [
			{
				versionStage: 'AO',
				metadata: {
					title: {en: `Reviewer management ${tag}`},
					abstract: {en: `<p>Assign-and-manage-reviewers fixture ${tag}.</p>`},
				},
				published: false,
			},
		],
	};
}

/**
 * Drive the Add Reviewer picker end to end for a pool candidate:
 * search, select, (optionally) tick skip-email, order the due dates,
 * wait for the compiled request body (it interpolates the tagged
 * submission title), submit.
 *
 * @param {InstanceType<typeof ReviewerManagerPage>} rm
 * @param {{searchToken: string, fullName: string, tag: string, skipEmail?: boolean}} opts
 */
async function assignFromPool(rm, {searchToken, fullName, tag, skipEmail = false}) {
	const modal = await rm.openAddReviewerModal();
	await rm.searchSelectPanel(modal, searchToken);
	const form = await rm.selectReviewer(modal, fullName);
	if (skipEmail) {
		await form.locator('input[name="skipEmail"]').last().check();
	}
	await rm.ensureDueDatesOrdered(form);
	await rm.awaitRichTextContains(form, 'personalMessage', tag);
	await rm.submitLegacyForm(form, 'Add Reviewer', modal);
}

/**
 * Assert the reviewer's task bell carries a review-assignment
 * notification for the tagged submission (the task cell renders the
 * submission title for ASSOC_TYPE_REVIEW_ASSIGNMENT notifications).
 *
 * @param {(u: string) => Promise<import('@playwright/test').BrowserContext>} asUser
 * @param {string} username
 * @param {string} tag
 * @param {{messageText?: string}} [opts]  extra filter, e.g. the
 *   "Review assignment updated." message that distinguishes the edit
 *   notification from the seeded assignment one
 */
async function expectReviewTaskNotification(asUser, username, tag, {messageText} = {}) {
	const ctx = await asUser(username);
	const page = await ctx.newPage();
	await page.goto(`/index.php/${JOURNAL}/en/dashboard/reviewAssignments`, {
		waitUntil: 'commit',
	});
	const tasks = new TasksGridModal(page);
	await tasks.open();
	let task = tasks.task(tag);
	if (messageText) {
		task = task.filter({hasText: messageText});
	}
	await expect(task.first()).toBeVisible({timeout: 20_000});
	await page.close();
}

test.describe('assign and manage reviewers', () => {
	test('s1: section editor assigns from the pool — Request Sent row, invitation email, reviewer task notification', async ({
		asUser,
		pkpApi,
		pkpMail,
	}) => {
		const tag = uniqueTag();
		const {submission} = await pkpApi.createSubmission(
			inReviewSpec({
				tag,
				participants: [
					{user: 'dbarnes', role: 'editor'},
					{user: 'dbuskins', role: 'sectionEditor'},
				],
			}),
		);

		const edCtx = await asUser('dbuskins');
		const edPage = await edCtx.newPage();
		const rm = new ReviewerManagerPage(edPage);
		await rm.gotoWorkflow(submission.id);

		await assignFromPool(rm, {
			searchToken: 'McCrae',
			fullName: USER.amccrae.name,
			tag,
		});

		await expect(rm.row(USER.amccrae.name)).toContainText('Request Sent');

		// Invitation email, scoped by recipient + the tagged title.
		await pkpMail.find({
			to: USER.amccrae.email,
			contains: tag,
			subject: 'Invitation to review',
		});

		// In-app task notification for the reviewer.
		await expectReviewTaskNotification(asUser, 'amccrae', tag);
	});

	test('s2: skip the email — row and task notification still fire, no invitation email', async ({
		page,
		asUser,
		pkpApi,
		pkpMail,
	}) => {
		const tag = uniqueTag();
		const {submission} = await pkpApi.createSubmission(inReviewSpec({tag}));

		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id);

		// The assignment whose email is skipped.
		await assignFromPool(rm, {
			searchToken: 'Gallego',
			fullName: USER.agallego.name,
			tag,
			skipEmail: true,
		});
		await expect(rm.row(USER.agallego.name)).toContainText('Request Sent');

		// The in-app notification is unconditional (rule 5).
		await expectReviewTaskNotification(asUser, 'agallego', tag);

		// Positive control: a second assignment WITH email, sent after the
		// skipped one, bounds the negative wait.
		await assignFromPool(rm, {
			searchToken: 'Janssen',
			fullName: USER.jjanssen.name,
			tag,
		});
		await expect(rm.row(USER.jjanssen.name)).toContainText('Request Sent');

		await pkpMail.expectNone({
			to: USER.agallego.email,
			contains: tag,
			afterControl: {to: USER.jjanssen.email, contains: tag},
		});
	});

	test('s3: conflict warning and unlock — the reviewer-author is locked in the picker until unlocked', async ({
		page,
		pkpApi,
	}) => {
		const tag = uniqueTag();
		// agallego (a seeded reviewer) submits — as a stage-assigned user
		// they land on the picker's warn list (users who could know the
		// author identities).
		const {submission} = await pkpApi.createSubmission(
			inReviewSpec({tag, submitter: 'agallego'}),
		);

		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id);

		const modal = await rm.openAddReviewerModal();
		await rm.searchSelectPanel(modal, 'Gallego');

		const item = rm
			.selectPanel(modal)
			.locator('.listPanel__item')
			.filter({hasText: USER.agallego.name})
			.first();
		await expect(item.getByText(/This reviewer is locked/)).toBeVisible({
			timeout: 15_000,
		});
		await expect(
			modal.getByRole('button', {
				name: `Select ${USER.agallego.name}`,
				exact: true,
			}),
		).toBeHidden();

		await item.getByRole('button', {name: 'Unlock', exact: true}).click();

		const form = await rm.selectReviewer(modal, USER.agallego.name);
		await rm.ensureDueDatesOrdered(form);
		await rm.awaitRichTextContains(form, 'personalMessage', tag);
		await rm.submitLegacyForm(form, 'Add Reviewer', modal);

		await expect(rm.row(USER.agallego.name)).toContainText('Request Sent');
	});

	test('s4: create a reviewer mid-assignment; an assistant sees neither Create nor Enroll', async ({
		asUser,
		pkpApi,
		pkpMail,
	}) => {
		test.slow(); // scratch journal + two actors
		const tag = uniqueTag();
		const ed = `ed${tag}`;
		const ast = `ast${tag}`;
		const au = `au${tag}`;

		// Scratch journal with throwaway users: an editor-group manager,
		// a Funding-coordinator assistant (the one default assistant
		// group whose stages include external review), and a plain
		// author to submit — the editor must NOT be the submitter, or
		// the maps layer redacts reviewer identities from the assigned
		// author under anonymous review modes (spec, Actors footnote a).
		const {context} = await pkpApi.createJournal({
			tag,
			users: [
				{
					username: ed,
					password: ed + ed,
					email: `${ed}@mailinator.com`,
					givenName: 'Edda',
					familyName: 'Editor',
					roles: ['editor'],
				},
				{
					username: ast,
					password: ast + ast,
					email: `${ast}@mailinator.com`,
					givenName: 'Asta',
					familyName: 'Helper',
					roles: ['funding'],
				},
				{
					username: au,
					password: au + au,
					email: `${au}@mailinator.com`,
					givenName: 'Alma',
					familyName: 'Author',
					roles: ['author'],
				},
			],
		});
		const journalPath = context.path;

		const {submission} = await pkpApi.createSubmission(
			inReviewSpec({
				tag,
				journal: journalPath,
				submitter: au,
				participants: [
					{user: ed, role: 'editor'},
					{user: ast, role: 'funding'},
				],
				decisions: [{type: 'sendExternalReview', by: ed}],
			}),
		);

		// --- The manager creates a brand-new reviewer from inside the dialog.
		const edCtx = await asUser(ed);
		const edPage = await edCtx.newPage();
		const rm = new ReviewerManagerPage(edPage);
		await rm.gotoWorkflow(submission.id, {journalPath});

		const modal = await rm.openAddReviewerModal();
		const createForm = await rm.openCreateReviewerForm(modal);

		const revUsername = `rev${tag}`;
		const revEmail = `${revUsername}@mailinator.com`;
		await createForm.locator('input[name="givenName[en]"]').last().fill('Nova');
		await createForm.locator('input[name="familyName[en]"]').last().fill('Probe');
		await createForm.locator('input[name="username"]').last().fill(revUsername);
		await createForm.locator('input[name="email"]').last().fill(revEmail);
		await rm.ensureDueDatesOrdered(createForm);
		await rm.awaitRichTextContains(createForm, 'personalMessage', tag);
		await rm.submitLegacyForm(createForm, 'Add Reviewer', modal);

		await expect(rm.row('Nova Probe')).toContainText('Request Sent');

		// The new account got BOTH the registration welcome (body carries
		// the username) and the tagged review request.
		await pkpMail.find({
			to: revEmail,
			contains: revUsername,
			subject: 'Registration as Reviewer',
		});
		await pkpMail.find({
			to: revEmail,
			contains: tag,
			subject: 'Invitation to review',
		});

		// --- The assistant's picker offers neither Create nor Enroll.
		const astCtx = await asUser(ast);
		const astPage = await astCtx.newPage();
		const rmAst = new ReviewerManagerPage(astPage);
		await rmAst.gotoWorkflow(submission.id, {journalPath});

		const astModal = await rmAst.openAddReviewerModal();
		// Positive control: the picker itself rendered for the assistant.
		await expect(
			rmAst.selectPanel(astModal).locator('.pkpSearch__input'),
		).toBeVisible({timeout: 15_000});
		await expect(
			astModal.getByRole('link', {name: 'Create New Reviewer', exact: true}),
		).toHaveCount(0);
		await expect(
			astModal.getByRole('link', {name: 'Enroll Existing User', exact: true}),
		).toHaveCount(0);
	});

	test('s5: round two pins last round\'s reviewer with Reassign and preloads the subsequent-request template', async ({
		page,
		pkpApi,
		pkpMail,
	}) => {
		const tag = uniqueTag();
		const {submission} = await pkpApi.createSubmission(
			inReviewSpec({
				tag,
				decisions: [
					{type: 'sendExternalReview', by: 'dbarnes'},
					{type: 'requestRevisions', by: 'dbarnes'},
					{type: 'newExternalRound', by: 'dbarnes'},
				],
				reviewRounds: [
					{
						reviewers: [
							{
								user: 'phudson',
								method: 'anonymous',
								status: 'completed',
								recommendation: 'pendingRevisions',
							},
						],
					},
					{reviewers: []},
				],
			}),
		);

		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id); // round 2 is the selected round

		const modal = await rm.openAddReviewerModal();
		// The round-1 reviewer is pinned with a Reassign action.
		const form = await rm.reassignReviewer(modal, USER.phudson.name);
		// The subsequent-round request template is preloaded.
		await rm.awaitRichTextContains(
			form,
			'personalMessage',
			'second round of peer review',
		);
		await rm.ensureDueDatesOrdered(form);
		await rm.submitLegacyForm(form, 'Add Reviewer', modal);

		await expect(rm.row(USER.phudson.name)).toContainText('Request Sent');
		await pkpMail.find({
			to: USER.phudson.email,
			contains: tag,
			subject: 'Request to review a revised submission',
		});
	});

	test('s6: unassign before an answer deletes the row; cancel after acceptance keeps a Request Cancelled row; both email', async ({
		page,
		pkpApi,
		pkpMail,
	}) => {
		const tag = uniqueTag();
		const {submission} = await pkpApi.createSubmission(
			inReviewSpec({
				tag,
				reviewers: [
					{user: 'phudson', method: 'anonymous', status: 'invited'},
					{user: 'jjanssen', method: 'anonymous', status: 'accepted'},
				],
			}),
		);

		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id);

		// Invited row → "Unassign Reviewer" → the row disappears outright.
		const unassignModal = await rm.openRowAction(
			USER.phudson.name,
			'Unassign Reviewer',
			'Unassign Reviewer',
		);
		const unassignForm = await rm.legacyForm(unassignModal, 'unassignReviewerForm');
		await rm.awaitRichTextContains(unassignForm, 'personalMessage', tag);
		await rm.submitLegacyForm(unassignForm, 'Unassign Reviewer', unassignModal);
		await expect(rm.row(USER.phudson.name)).toBeHidden();

		// Accepted row → the same op is labelled "Cancel Reviewer" and the
		// row survives as Request Cancelled.
		const cancelModal = await rm.openRowAction(
			USER.jjanssen.name,
			'Cancel Reviewer',
			'Cancel Reviewer',
		);
		const cancelForm = await rm.legacyForm(cancelModal, 'unassignReviewerForm');
		await rm.awaitRichTextContains(cancelForm, 'personalMessage', tag);
		await rm.submitLegacyForm(cancelForm, 'Cancel Reviewer', cancelModal);
		await expect(rm.row(USER.jjanssen.name)).toContainText('Request Cancelled');

		// Both reviewers got the cancellation notice.
		await pkpMail.find({
			to: USER.phudson.email,
			contains: tag,
			subject: 'Request for Review Cancelled',
		});
		await pkpMail.find({
			to: USER.jjanssen.email,
			contains: tag,
			subject: 'Request for Review Cancelled',
		});
	});

	test('s7: reinstating a cancelled reviewer returns the row to Request Accepted', async ({
		page,
		pkpApi,
		pkpMail,
	}) => {
		const tag = uniqueTag();
		// Seeded 'cancelled' carries dateConfirmed — cancelled after accept.
		const {submission} = await pkpApi.createSubmission(
			inReviewSpec({
				tag,
				reviewers: [{user: 'jjanssen', method: 'anonymous', status: 'cancelled'}],
			}),
		);

		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id);
		await expect(rm.row(USER.jjanssen.name)).toContainText('Request Cancelled');

		// Cancelled rows lose Edit and offer Reinstate (rule 3).
		await rm
			.row(USER.jjanssen.name)
			.getByRole('button', {name: 'More Actions'})
			.click();
		await expect(
			page.getByRole('menuitem', {name: 'Reinstate Reviewer', exact: true}),
		).toBeVisible();
		await expect(
			page.getByRole('menuitem', {name: 'Edit', exact: true}),
		).toHaveCount(0);
		await page
			.getByRole('menuitem', {name: 'Reinstate Reviewer', exact: true})
			.click();

		const modal = await rm.actionModal('Reinstate Reviewer');
		const form = await rm.legacyForm(modal, 'reinstateReviewerForm');
		await rm.awaitRichTextContains(form, 'personalMessage', tag);
		await rm.submitLegacyForm(form, 'Reinstate Reviewer', modal);

		await expect(rm.row(USER.jjanssen.name)).toContainText('Request Accepted');
		await pkpMail.find({
			to: USER.jjanssen.email,
			contains: tag,
			subject: 'Can you still review',
		});
	});

	test('s8: declined request is resent with fresh dates, then the editor logs the acceptance on the reviewer\'s behalf', async ({
		page,
		pkpApi,
		pkpMail,
	}) => {
		const tag = uniqueTag();
		const {submission} = await pkpApi.createSubmission(
			inReviewSpec({
				tag,
				reviewers: [{user: 'phudson', method: 'anonymous', status: 'declined'}],
			}),
		);

		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id);
		await expect(rm.row(USER.phudson.name)).toContainText('Request Declined');

		const modal = await rm.openRowAction(
			USER.phudson.name,
			'Resend Review Request',
			'Resend Review Request',
		);
		const form = await rm.legacyForm(modal, 'resendRequestReviewerForm');
		await rm.setDatepickerDate(form, 'responseDueDate', isoDate(10));
		await rm.setDatepickerDate(form, 'reviewDueDate', isoDate(30));
		await rm.awaitRichTextContains(form, 'personalMessage', tag);
		await rm.submitLegacyForm(form, 'Resend Review Request', modal);

		await expect(rm.row(USER.phudson.name)).toContainText('Request Resent');
		await pkpMail.find({
			to: USER.phudson.email,
			contains: tag,
			subject: 'Requesting your review again',
		});

		// The decline is cleared, so Log Response is offered again — use it
		// to record the acceptance on the reviewer's behalf (rule 10).
		await rm
			.row(USER.phudson.name)
			.getByRole('button', {name: 'More Actions'})
			.click();
		await page.getByRole('menuitem', {name: 'Log Response', exact: true}).click();

		const logModal = page.getByRole('dialog', {name: /Log Response for/});
		await expect(logModal).toBeVisible({timeout: 15_000});
		await logModal
			.getByRole('radio', {
				name: 'Reviewer has accepted the invitation to review',
			})
			.check();
		await logModal
			.getByRole('button', {name: 'Log Response', exact: true})
			.click();
		await expect(logModal).toBeHidden({timeout: 20_000});

		await expect(rm.row(USER.phudson.name)).toContainText('Request Accepted');
	});

	test('s9: read (Review Viewed), set recommendation by proxy, rate, confirm (Complete + log), revert (Review Submitted)', async ({
		page,
		asUser,
		pkpApi,
	}) => {
		test.slow(); // reviewer wizard + full editor read/confirm/revert cycle
		const tag = uniqueTag();
		const {submission} = await pkpApi.createSubmission(
			inReviewSpec({
				tag,
				reviewers: [{user: 'jjanssen', method: 'anonymous', status: 'accepted'}],
			}),
		);

		// The reviewer genuinely submits through the wizard — the only way
		// to a fresh (considered=NEW) submitted review, which is what makes
		// the first editor open flip the row to Review Viewed.
		const revCtx = await asUser('jjanssen');
		const revPage = await revCtx.newPage();
		const wizard = new ReviewerSubmissionPage(revPage);
		await wizard.goto(submission.id);
		await wizard.continueToStep3();
		await wizard.fillStep3Comments({
			toAuthor: `<p>Author-facing comments ${tag}</p>`,
			toEditor: `<p>Editor-only comments ${tag}</p>`,
		});
		await wizard.selectRecommendation('Revisions Required');
		await wizard.submitReview();
		await revPage.close();

		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id);
		await expect(rm.row(USER.jjanssen.name)).toContainText('Review Submitted');

		// Merely opening the fresh review marks it Viewed (rule 11).
		const first = await rm.openReadReview(USER.jjanssen.name);
		await expect(
			first.form.getByText(`Author-facing comments ${tag}`),
		).toBeVisible();
		await first.form.getByRole('link', {name: 'Cancel', exact: true}).click();
		await expect(first.modal).toBeHidden({timeout: 15_000});
		// The viewed stamp is server-side (considered NEW → VIEWED on the
		// modal fetch); assert it through the API, then on a fresh mount
		// of the panel (the cancel-close path doesn't refetch the rows).
		await expect
			.poll(async () => {
				const assignments = await rm.fetchReviewAssignments(submission.id);
				return assignments[0]?.statusId;
			})
			.toBe(12); // REVIEW_ASSIGNMENT_STATUS_VIEWED
		await rm.gotoWorkflow(submission.id);
		await expect(rm.row(USER.jjanssen.name)).toContainText('Review Viewed');

		// Re-open: adjust the recommendation on the reviewer's behalf,
		// rate, confirm.
		const second = await rm.openReadReview(USER.jjanssen.name);
		await second.form
			.locator('select#reviewerRecommendationId')
			.last()
			.selectOption({label: 'Accept Submission'});
		await second.form
			.locator('input[name="quality"][value="5"]')
			.last()
			.check();
		await rm.submitLegacyForm(second.form, 'Confirm', second.modal);

		const row = rm.row(USER.jjanssen.name);
		await expect(row).toContainText('Complete');
		await expect(row).toContainText('Accept Submission');

		// The by-proxy recommendation is in the activity log.
		const log = new ActivityLogModal(page);
		await log.openFromWorkflow();
		await log.openHistoryTab();
		await expect(
			log.historyRow(/on behalf of the reviewer/).first(),
		).toBeVisible({timeout: 20_000});
		await log.close();

		// Revert Decision drops the row back to Review Submitted (rule 13).
		const revertDialog = await rm.clickRowPrimaryAction(
			USER.jjanssen.name,
			'Revert Decision',
			'Unconsider this Review',
		);
		await revertDialog.getByRole('button', {name: 'OK', exact: true}).click();
		await expect(revertDialog).toBeHidden({timeout: 15_000});
		await expect(rm.row(USER.jjanssen.name)).toContainText('Review Submitted');
	});

	test('s10: thanking the reviewer sends the acknowledgement and moves the row to Reviewer Thanked', async ({
		page,
		pkpApi,
		pkpMail,
	}) => {
		const tag = uniqueTag();
		// Seeded 'completed' is editor-confirmed → the row starts Complete.
		const {submission} = await pkpApi.createSubmission(
			inReviewSpec({
				tag,
				reviewers: [
					{
						user: 'jjanssen',
						method: 'anonymous',
						status: 'completed',
						recommendation: 'accept',
					},
				],
			}),
		);

		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id);
		await expect(rm.row(USER.jjanssen.name)).toContainText('Complete');

		const modal = await rm.clickRowPrimaryAction(
			USER.jjanssen.name,
			'Thank Reviewer',
			'Thank Reviewer',
		);
		const form = await rm.legacyForm(modal, 'sendThankYouForm');
		await rm.awaitRichTextContains(form, 'message', tag);
		await rm.submitLegacyForm(form, 'Thank Reviewer', modal);

		await expect(rm.row(USER.jjanssen.name)).toContainText('Reviewer Thanked');
		await pkpMail.find({
			to: USER.jjanssen.email,
			contains: tag,
			subject: 'Thank you for your review',
		});
	});

	test('s11: editing an in-flight assignment moves the due date and notifies the reviewer by email and task', async ({
		page,
		asUser,
		pkpApi,
		pkpMail,
	}) => {
		const tag = uniqueTag();
		const {submission} = await pkpApi.createSubmission(
			inReviewSpec({
				tag,
				reviewers: [{user: 'agallego', method: 'anonymous', status: 'accepted'}],
			}),
		);

		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id);

		const newDue = isoDate(42);
		const {modal, form} = await rm.openEditReviewModal(USER.agallego.name);
		await rm.setDatepickerDate(form, 'reviewDueDate', newDue);
		await rm.submitLegacyForm(form, 'OK', modal);

		// The row keeps rendering the review due date; the persisted
		// assignment carries the new date.
		await expect(rm.row(USER.agallego.name)).toContainText('Review due:');
		await expect
			.poll(async () => {
				const assignments = await rm.fetchReviewAssignments(submission.id);
				return assignments[0]?.dateDue ?? '';
			})
			.toContain(newDue);

		await pkpMail.find({
			to: USER.agallego.email,
			contains: tag,
			subject: 'Your review assignment has been changed',
		});
		await expectReviewTaskNotification(asUser, 'agallego', tag, {
			messageText: 'Review assignment updated.',
		});
	});

	test('s12: an overdue row\'s headline Send Reminder mails the reviewer and stamps the reminded date in History', async ({
		page,
		pkpApi,
		pkpMail,
	}) => {
		const tag = uniqueTag();
		const {submission} = await pkpApi.createSubmission(
			inReviewSpec({
				tag,
				reviewers: [
					{
						user: 'jjanssen',
						method: 'anonymous',
						status: 'accepted',
						reviewDueDate: isoDate(-5),
					},
				],
			}),
		);

		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id);
		await expect(rm.row(USER.jjanssen.name)).toContainText('Overdue');

		const modal = await rm.clickRowPrimaryAction(
			USER.jjanssen.name,
			'Send Reminder',
			'Review Reminder',
		);
		const form = await rm.legacyForm(modal, 'sendReminderForm');
		await rm.awaitRichTextContains(form, 'message', tag);
		await rm.submitLegacyForm(form, 'Send Reminder', modal);

		await pkpMail.find({
			to: USER.jjanssen.email,
			contains: tag,
			subject: 'A reminder to please complete your review',
		});

		// History shows the reminded milestone.
		const historyModal = await rm.openRowAction(
			USER.jjanssen.name,
			'History',
			'History',
		);
		await expect(
			historyModal.locator('.pkp_review_history'),
		).toContainText('Reminder', {timeout: 15_000});
	});

	test('s13: the author sees no reviewer panel until an open review completes, then a redacted read-only panel', async ({
		asUser,
		pkpApi,
	}) => {
		const tag = uniqueTag();

		// A: an accepted open review + a completed double-anonymous review
		// — nothing disclosable, no panel.
		const {submission: subA} = await pkpApi.createSubmission(
			inReviewSpec({
				tag: `${tag}a`,
				submitter: 'atester',
				reviewers: [
					{user: 'jjanssen', method: 'open', status: 'accepted'},
					{
						user: 'phudson',
						method: 'doubleAnonymous',
						status: 'completed',
						recommendation: 'accept',
					},
				],
			}),
		);
		// B: a completed open review — the redacted panel appears, listing
		// only that review.
		const {submission: subB} = await pkpApi.createSubmission(
			inReviewSpec({
				tag: `${tag}b`,
				submitter: 'atester',
				reviewers: [
					{
						user: 'jjanssen',
						method: 'open',
						status: 'completed',
						recommendation: 'accept',
						comments: {toAuthor: `<p>Open review comments ${tag}</p>`},
					},
					{
						user: 'phudson',
						method: 'doubleAnonymous',
						status: 'completed',
						recommendation: 'accept',
					},
				],
			}),
		);

		const authorCtx = await asUser('atester');
		const authorPage = await authorCtx.newPage();
		const rm = new ReviewerManagerPage(authorPage);

		// A — the review stage renders (discussions are the anchor) with
		// no reviewer panel.
		await authorPage.goto(
			`/index.php/${JOURNAL}/en/dashboard/mySubmissions?workflowSubmissionId=${subA.id}`,
			{waitUntil: 'commit'},
		);
		await expect(
			authorPage.locator('[data-cy="discussion-manager"]'),
		).toBeVisible({timeout: 20_000});
		await expect(authorPage.locator('[data-cy="reviewer-manager"]')).toBeHidden();

		// B — the redacted panel: the open reviewer with type + Read
		// Review; no anonymous reviewer, no Add Reviewer, no statuses.
		await rm.gotoAuthorWorkflow(subB.id);
		const row = rm.row(USER.jjanssen.name);
		await expect(row).toBeVisible();
		await expect(rm.reviewTypeLabel(USER.jjanssen.name, 'Open')).toBeVisible();
		await expect(rm.manager.getByText(USER.phudson.name)).toBeHidden();
		await expect(
			rm.manager.getByRole('button', {name: 'Add Reviewer', exact: true}),
		).toBeHidden();
		await expect(rm.manager.getByText('Complete', {exact: true})).toBeHidden();

		const {modal} = await rm.openReadReview(USER.jjanssen.name, {
			expectForm: false,
		});
		await expect(modal.getByText(`Open review comments ${tag}`)).toBeVisible({
			timeout: 15_000,
		});
	});
});
