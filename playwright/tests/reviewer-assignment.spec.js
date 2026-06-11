// @ts-check
const {test, expect} = require('../support/base-test.js');
const {waitForJQueryIdle} = require('../support/jquery.js');
const {ReviewerManagerPage} = require('../pages/ReviewerManagerPage.js');
const submissionInReview = require('../../../../playwright/fixtures/scenarios/submission-in-review.js');

/**
 * Reviewer assignment — docs/e2e/plans/reviewer-assignment.md (10 rows).
 *
 * The feature under test is the Reviewer Manager panel on the Review
 * stage of the editorial workflow page: assigning reviewers through the
 * Add Reviewer modal (search-select and create-new modes), editing an
 * assignment's method/dates, and the lifecycle row actions (unassign,
 * cancel, reinstate, resend request, manual reminder) with their
 * notification emails.
 *
 * Seeding: every test creates its own submission already in external
 * review via the submission scenario (`submissionInReview` fixture)
 * with a per-test `reviewers` override carrying the exact pre-state the
 * row needs (invited / accepted / declined / cancelled, due-date
 * passthrough). The UI is driven only for the behavior under test.
 *
 * Emails: action mails are asserted via Mailpit scoped by recipient +
 * the test's unique tag (the scenario appends the tag to the submission
 * title, and every reviewer-action email body carries
 * {$submissionTitle}) — charter principle 8. Scenario-side seeding mail
 * never reaches Mailpit (Mail::fake()).
 *
 * Absorbs the original single-test reviewer-assignment.spec.js (its
 * flow is row 1, rewritten onto the ReviewerManagerPage POM).
 *
 * Plan-vs-UI note (row 7): the plan said "reinstate a declined
 * reviewer", but the Reviewer Manager only offers Reinstate for
 * CANCELLED assignments (useReviewerManagerConfig.getItemActions);
 * declined assignments get Resend Request (row 8) instead. Row 7 is
 * implemented against a cancelled assignment — the state the UI
 * actually reinstates.
 */

/** Reviewer emails (lib/pkp/playwright/data/users.js). */
const EMAILS = {
	phudson: 'phudson@mailinator.com',
	jjanssen: 'jjanssen@mailinator.com',
};

/** reviewer.list.currentlyAssigned */
const CURRENTLY_ASSIGNED_NOTICE =
	'This reviewer has already been assigned to this review round.';

/** SUBMISSION_REVIEW_METHOD_* (ReviewAssignment.php) */
const METHOD_ANONYMOUS = 1;
const METHOD_DOUBLE_ANONYMOUS = 2;
const METHOD_OPEN = 3;

/** REVIEW_ASSIGNMENT_STATUS_* (ReviewAssignment.php:42-52) */
const STATUS_ACCEPTED = 5;
const STATUS_CANCELLED = 10;
const STATUS_REQUEST_RESEND = 11;

function uniqueTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

/** Alphanumeric-only variant of the tag, for usernames / name parts. */
function alnum(tag) {
	return tag.replace(/[^a-z0-9]/gi, '');
}

/** yyyy-mm-dd, `days` from today (negative for the past). */
function isoDaysFromNow(days) {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

test.use({user: 'dbarnes'});

test.describe('Reviewer assignment', () => {
	test('editor assigns a reviewer via Add Reviewer modal with anonymity + due dates; reviewer appears in the list', {tag: '@smoke'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('rasg');
		// Empty reviewer list — this test owns the first assignment.
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({tag, reviewers: []}),
		);

		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id);

		const modal = await rm.openAddReviewerModal();
		// The select-reviewer list panel renders inside the legacy form.
		await expect(rm.selectPanel(modal)).toBeVisible({timeout: 20_000});

		const form = await rm.selectReviewer(modal, 'Paul Hudson');

		// Anonymity — the form pre-selects the journal's defaultReviewMode
		// (double-anonymous on the bootstrap journal); switch to
		// "Anonymous Reviewer/Disclosed Author" (method 1). Radios render
		// as name="reviewMethod" with value="1|2|3" (ids are
		// fbv-uniqId-suffixed, so match on name+value).
		const doubleAnonymousRadio = form.locator(
			`input[name="reviewMethod"][value="${METHOD_DOUBLE_ANONYMOUS}"]`,
		);
		await expect(doubleAnonymousRadio).toBeChecked();
		const anonymousRadio = form.locator(
			`input[name="reviewMethod"][value="${METHOD_ANONYMOUS}"]`,
		);
		await anonymousRadio.check();
		await expect(anonymousRadio).toBeChecked();

		// Due dates are pre-filled from numWeeksPerResponse/numWeeksPerReview.
		await expect(form.locator('input[name="responseDueDate"]').last()).not.toHaveValue('');
		await expect(form.locator('input[name="reviewDueDate"]').last()).not.toHaveValue('');
		await rm.ensureDueDatesOrdered(form);

		await rm.submitLegacyForm(form, 'Add Reviewer', modal);

		// DOM: row appears with the anonymity label the type cell renders
		// for method 1 (sr-only text in ReviewMethodIcons).
		await expect(rm.manager).toContainText('Paul Hudson', {timeout: 20_000});
		await expect(rm.manager).toContainText('Anonymous Reviewer/Disclosed Author');

		// REST round-trip — the DB row, not an optimistic client list.
		const assignments = await rm.fetchReviewAssignments(submission.id);
		expect(assignments.length).toBe(1);
		expect(assignments[0].reviewerFullName).toMatch(/Paul Hudson/);
		expect(assignments[0].reviewMethod).toBe(METHOD_ANONYMOUS);
		expect(assignments[0].dateResponseDue).toBeTruthy();
		expect(assignments[0].dateDue).toBeTruthy();
	});

	test('Add Reviewer search filters candidates; already-assigned reviewer is flagged', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('rasg');
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				reviewers: [{user: 'jjanssen', method: 'anonymous', status: 'invited'}],
			}),
		);

		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id);
		const modal = await rm.openAddReviewerModal();
		const panel = rm.selectPanel(modal);
		await expect(panel).toBeVisible({timeout: 20_000});

		// jjanssen is already on this round: her candidate row carries the
		// currently-assigned notice and loses its Select button. Search
		// for her first — the candidate list accumulates created
		// reviewers across runs and paginates, so never trust page 1.
		await rm.searchSelectPanel(modal, 'Janssen');
		const janssenItem = panel
			.locator('.listPanel__item--reviewer')
			.filter({hasText: 'Julie Janssen'});
		await expect(janssenItem).toBeVisible({timeout: 20_000});
		await expect(janssenItem).toContainText(CURRENTLY_ASSIGNED_NOTICE);
		await expect(
			janssenItem.getByRole('button', {name: 'Select Julie Janssen', exact: true}),
		).toHaveCount(0);

		// Search narrows the panel to phudson, who is selectable.
		await rm.searchSelectPanel(modal, 'Hudson');
		await expect(
			panel.getByRole('button', {name: 'Select Paul Hudson', exact: true}),
		).toBeVisible({timeout: 20_000});
		await expect(panel.getByText('Julie Janssen')).toHaveCount(0, {
			timeout: 20_000,
		});
	});

	test('assigning a reviewer sends the review-request email; reviewer sees the invitation on their dashboard', {tag: '@regression'}, async ({page, pkpApi, pkpMail, asUser}) => {
		const tag = uniqueTag('rasg');
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({tag, reviewers: []}),
		);

		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id);
		const modal = await rm.openAddReviewerModal();
		const form = await rm.selectReviewer(modal, 'Paul Hudson');
		await rm.ensureDueDatesOrdered(form);

		// Capture the canonical yyyy-mm-dd the form will post — the
		// ReviewRequest email renders {$responseDueDate} with the
		// journal's short date format (default Y-m-d), so it must appear
		// verbatim in the body.
		const responseDueDate = await form
			.locator('input[name="responseDueDate"]')
			.last()
			.inputValue();

		await rm.submitLegacyForm(form, 'Add Reviewer', modal);
		await expect(rm.manager).toContainText('Paul Hudson', {timeout: 20_000});

		// Review-request email, scoped recipient + tag (the email body
		// carries the submission title, which carries the tag).
		const messages = await pkpMail.find({
			to: EMAILS.phudson,
			contains: tag,
			timeoutMs: 20_000,
		});
		expect(messages[0].Subject).toContain('Invitation to review');
		const full = await pkpMail.fullMessage(messages[0].ID);
		expect(full.HTML).toContain(responseDueDate);

		// The reviewer's own dashboard lists the new invitation. The
		// dashboard reads searchPhrase from the URL — filter to this
		// test's submission via the tag.
		const reviewerCtx = await asUser('phudson');
		const reviewerPage = await reviewerCtx.newPage();
		await reviewerPage.goto(
			`/index.php/publicknowledge/en/dashboard/reviewAssignments?searchPhrase=${tag}`,
		);
		await expect(
			reviewerPage.getByRole('row').filter({hasText: tag}).first(),
		).toBeVisible({timeout: 20_000});
	});

	test('editor edits a review assignment: review method and review due date', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('rasg');
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				reviewers: [{user: 'phudson', method: 'anonymous', status: 'invited'}],
			}),
		);

		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id);

		const modal = await rm.openRowAction('Paul Hudson', 'Edit', 'Edit Review');
		const form = await rm.legacyForm(modal, 'editReviewForm');

		// Seeded method is anonymous; flip to open review.
		await expect(
			form.locator(`input[name="reviewMethod"][value="${METHOD_ANONYMOUS}"]`),
		).toBeChecked();
		await form
			.locator(`input[name="reviewMethod"][value="${METHOD_OPEN}"]`)
			.check();

		// Push the review due date out to a distinct value (seeded
		// default is +4 weeks; +6 weeks keeps it >= response due).
		const newReviewDue = isoDaysFromNow(42);
		await rm.setDatepickerDate(form, 'reviewDueDate', newReviewDue);

		// The form hosts an AJAX-loaded review-files grid; let it settle
		// so the posted selectedFiles reflect the rendered checkboxes.
		await waitForJQueryIdle(page);
		await rm.submitLegacyForm(form, 'OK', modal);

		// The type cell now renders the open-review label.
		await expect(rm.row('Paul Hudson')).toContainText('Open', {
			timeout: 20_000,
		});

		const assignments = await rm.fetchReviewAssignments(submission.id);
		expect(assignments.length).toBe(1);
		expect(assignments[0].reviewMethod).toBe(METHOD_OPEN);
		expect(assignments[0].dateDue.slice(0, 10)).toBe(newReviewDue);
	});

	test('editor unassigns an invited reviewer with notification', {tag: '@regression'}, async ({page, pkpApi, pkpMail}) => {
		const tag = uniqueTag('rasg');
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				reviewers: [{user: 'phudson', method: 'anonymous', status: 'invited'}],
			}),
		);

		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id);
		await expect(rm.manager).toContainText('Paul Hudson', {timeout: 20_000});

		// Unconfirmed assignment → the row action is Unassign (Cancel is
		// reserved for confirmed assignments).
		const modal = await rm.openRowAction(
			'Paul Hudson',
			'Unassign Reviewer',
			'Unassign Reviewer',
		);
		const form = await rm.legacyForm(modal, 'unassignReviewerForm');
		// Email step: precompiled REVIEW_CANCEL body (carries the tagged
		// submission title). Leave "Do not send email" unchecked.
		await rm.awaitRichTextContains(form, 'personalMessage', tag);
		await rm.submitLegacyForm(form, 'Unassign Reviewer', modal);

		// Unconfirmed assignments are deleted outright — the row leaves
		// the list.
		await expect(rm.manager).not.toContainText('Paul Hudson', {
			timeout: 20_000,
		});
		const assignments = await rm.fetchReviewAssignments(submission.id);
		expect(assignments.length).toBe(0);

		const messages = await pkpMail.find({
			to: EMAILS.phudson,
			contains: tag,
			timeoutMs: 20_000,
		});
		expect(messages[0].Subject).toContain('Request for Review Cancelled');
	});

	test('editor cancels an accepted reviewer with notification', {tag: '@regression'}, async ({page, pkpApi, pkpMail}) => {
		const tag = uniqueTag('rasg');
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				reviewers: [{user: 'jjanssen', method: 'anonymous', status: 'accepted'}],
			}),
		);

		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id);
		await expect(rm.row('Julie Janssen')).toContainText('Request Accepted', {
			timeout: 20_000,
		});

		// Confirmed assignment → the same unassign op is offered as
		// Cancel Reviewer instead of Unassign.
		const modal = await rm.openRowAction(
			'Julie Janssen',
			'Cancel Reviewer',
			'Cancel Reviewer',
		);
		const form = await rm.legacyForm(modal, 'unassignReviewerForm');
		await rm.awaitRichTextContains(form, 'personalMessage', tag);
		await rm.submitLegacyForm(form, 'Cancel Reviewer', modal);

		// Confirmed assignments are flagged cancelled, not deleted — the
		// row stays with a cancelled status. (The submission payload's
		// reviewAssignments is a hand-rolled summary — statusId +
		// dateCancelled, no raw `cancelled` flag; see
		// PKPSubmissionMaps\Schema::getPropertyReviewAssignments.)
		await expect(rm.row('Julie Janssen')).toContainText('Request Cancelled', {
			timeout: 20_000,
		});
		const assignments = await rm.fetchReviewAssignments(submission.id);
		expect(assignments.length).toBe(1);
		expect(assignments[0].statusId).toBe(STATUS_CANCELLED);
		expect(assignments[0].dateCancelled).toBeTruthy();

		const messages = await pkpMail.find({
			to: EMAILS.jjanssen,
			contains: tag,
			timeoutMs: 20_000,
		});
		expect(messages[0].Subject).toContain('Request for Review Cancelled');
	});

	test('editor reinstates a cancelled reviewer', {tag: '@regression'}, async ({page, pkpApi, pkpMail}) => {
		const tag = uniqueTag('rasg');
		// Reinstate is offered only for cancelled assignments (see the
		// describe-level note); seed the cancelled state directly.
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				reviewers: [{user: 'phudson', method: 'anonymous', status: 'cancelled'}],
			}),
		);

		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id);
		await expect(rm.row('Paul Hudson')).toContainText('Request Cancelled', {
			timeout: 20_000,
		});

		const modal = await rm.openRowAction(
			'Paul Hudson',
			'Reinstate Reviewer',
			'Reinstate Reviewer',
		);
		const form = await rm.legacyForm(modal, 'reinstateReviewerForm');
		await rm.awaitRichTextContains(form, 'personalMessage', tag);
		await rm.submitLegacyForm(form, 'Reinstate Reviewer', modal);

		// The assignment is active again. The cancelled seed kept its
		// dateConfirmed (the reviewer had accepted before cancellation),
		// so it returns to the accepted state.
		await expect(rm.row('Paul Hudson')).toContainText('Request Accepted', {
			timeout: 20_000,
		});
		const assignments = await rm.fetchReviewAssignments(submission.id);
		expect(assignments.length).toBe(1);
		expect(assignments[0].statusId).toBe(STATUS_ACCEPTED);
		expect(assignments[0].dateCancelled).toBeFalsy();

		const messages = await pkpMail.find({
			to: EMAILS.phudson,
			contains: tag,
			timeoutMs: 20_000,
		});
		expect(messages[0].Subject).toContain('Can you still review');
	});

	test('editor resends the review request to a declined reviewer', {tag: '@regression'}, async ({page, pkpApi, pkpMail}) => {
		const tag = uniqueTag('rasg');
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				reviewers: [{user: 'phudson', method: 'anonymous', status: 'declined'}],
			}),
		);

		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id);
		await expect(rm.row('Paul Hudson')).toContainText('Request Declined', {
			timeout: 20_000,
		});

		const modal = await rm.openRowAction(
			'Paul Hudson',
			'Resend Review Request',
			'Resend Review Request',
		);
		const form = await rm.legacyForm(modal, 'resendRequestReviewerForm');
		await rm.awaitRichTextContains(form, 'personalMessage', tag);
		// The resend form re-prompts for fresh due dates (same colliding
		// 4+4-week defaults as Add Reviewer).
		await rm.ensureDueDatesOrdered(form);
		await rm.submitLegacyForm(form, 'Resend Review Request', modal);

		// The request returns to the reviewer's court — awaiting their
		// (re)response.
		await expect(rm.row('Paul Hudson')).toContainText('Request Resent', {
			timeout: 20_000,
		});
		const assignments = await rm.fetchReviewAssignments(submission.id);
		expect(assignments.length).toBe(1);
		expect(assignments[0].statusId).toBe(STATUS_REQUEST_RESEND);

		const messages = await pkpMail.find({
			to: EMAILS.phudson,
			contains: tag,
			timeoutMs: 20_000,
		});
		expect(messages[0].Subject).toContain('Requesting your review again');
	});

	test('editor sends a manual review reminder to an overdue reviewer', {tag: '@regression'}, async ({page, pkpApi, pkpMail}) => {
		const tag = uniqueTag('rasg');
		// Accepted + review due date in the past → REVIEW_OVERDUE, which
		// surfaces Send Reminder as the row's primary action.
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				reviewers: [
					{
						user: 'jjanssen',
						method: 'anonymous',
						status: 'accepted',
						reviewDueDate: `${isoDaysFromNow(-1)} 00:00:00`,
					},
				],
			}),
		);

		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id);
		await expect(rm.row('Julie Janssen')).toContainText('Overdue', {
			timeout: 20_000,
		});

		const modal = await rm.clickRowPrimaryAction(
			'Julie Janssen',
			'Send Reminder',
			'Review Reminder',
		);
		const form = await rm.legacyForm(modal, 'sendReminderForm');
		// The reminder message body is template-compiled (REVIEW_REMIND,
		// carries the tagged submission title); wait for the rich-text
		// field to settle before sending.
		await rm.awaitRichTextContains(form, 'message', tag);
		await rm.submitLegacyForm(form, 'Send Reminder', modal);

		const messages = await pkpMail.find({
			to: EMAILS.jjanssen,
			contains: tag,
			timeoutMs: 20_000,
		});
		expect(messages[0].Subject).toContain(
			'A reminder to please complete your review',
		);

		// The reminder is recorded on the assignment: the row's History
		// modal lists the reminder date ('<date> Reminder' — see
		// workflow/reviewHistory.tpl; the submission REST summary doesn't
		// expose dateReminded).
		const historyModal = await rm.openRowAction(
			'Julie Janssen',
			'History',
			'History',
		);
		await expect(historyModal.locator('.pkp_review_history')).toContainText(
			'Reminder',
			{timeout: 20_000},
		);
	});

	test('editor creates a new reviewer from the Add Reviewer modal', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('rasg');
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({tag, reviewers: []}),
		);
		// Unique identity — the journal's user pool is shared across
		// parallel workers and survives runs.
		const family = `Newrev${alnum(tag)}`;
		const username = `rev${alnum(tag)}`;
		const email = `${username}@mailinator.com`;

		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id);
		const modal = await rm.openAddReviewerModal();
		await expect(rm.selectPanel(modal)).toBeVisible({timeout: 20_000});

		const createForm = await rm.openCreateReviewerForm(modal);
		await createForm.locator('input[name="givenName[en]"]').fill('Riva');
		await createForm.locator('input[name="familyName[en]"]').fill(family);
		await createForm.locator('input[name="username"]').fill(username);
		await createForm.locator('input[name="email"]').fill(email);
		// Single reviewer user group renders as a hidden input; a select
		// only appears when the journal defines several.
		const userGroupSelect = createForm.locator('select[name="userGroupId"]');
		if (await userGroupSelect.isVisible().catch(() => false)) {
			await userGroupSelect.selectOption({label: 'Reviewer'});
		}
		// The review-request email isn't this row's concern — skip it so
		// the throwaway address doesn't accumulate unasserted mail.
		await createForm.locator('input[name="skipEmail"]').check();
		await rm.ensureDueDatesOrdered(createForm);
		await rm.submitLegacyForm(createForm, 'Add Reviewer', modal);

		// Created, enrolled and assigned in one step: the new reviewer
		// lands in this round's list.
		await expect(rm.manager).toContainText(`Riva ${family}`, {
			timeout: 20_000,
		});
		const assignments = await rm.fetchReviewAssignments(submission.id);
		expect(assignments.length).toBe(1);
		expect(assignments[0].reviewerFullName).toBe(`Riva ${family}`);
	});
});
