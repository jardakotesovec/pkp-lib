// @ts-check
const path = require('path');
const {test, expect} = require('../support/base-test.js');
const {ReviewerSubmissionPage} = require('../pages/ReviewerSubmissionPage.js');
const {EditorialWorkflowPage} = require('../../../../playwright/pages/EditorialWorkflowPage.js');
const {getTinyMceContent} = require('../support/tinymce.js');
const submissionInReview = require('../../../../playwright/fixtures/scenarios/submission-in-review.js');

/**
 * Reviewer response — docs/e2e/plans/reviewer-response.md (12 rows).
 *
 * Covers the reviewer's side of a review assignment (accept / decline /
 * complete / draft / read-only) and the editor-side actions that close
 * the loop (read review, confirm, revert, thank, log response).
 *
 * Absorbs lib/pkp/playwright/tests/reviewer-completes-review.spec.js
 * (its single test is row 1 here, refit onto ReviewerSubmissionPage).
 *
 * Isolation notes:
 *  - Rows asserting reviewer-side dashboard lists (2, 9, 12) seed into a
 *    scratch journal: the reviewerAssignments dashboard endpoint has no
 *    searchPhrase support, so a shared reviewer's accumulated
 *    publicknowledge assignments can push the row under test off the
 *    first page. A scratch journal scopes the list to exactly one row.
 *  - Row 4 needs `reviewerAccessKeysEnabled`, which is not in the
 *    context scenario schema — it is flipped through the Review Setup
 *    settings UI on a scratch journal (plan's one-off rule).
 *  - Mailpit reads are scoped recipient + tag (principle 8); all email
 *    assertions here are positive, so no positive-control plumbing is
 *    needed.
 */

const PKP_CONST = {
	REVIEW_ASSIGNMENT_STATUS_DECLINED: 1,
	REVIEW_ASSIGNMENT_STATUS_RESPONSE_OVERDUE: 4,
	REVIEW_ASSIGNMENT_STATUS_ACCEPTED: 5,
	REVIEW_ASSIGNMENT_STATUS_RECEIVED: 7,
	REVIEW_ASSIGNMENT_STATUS_COMPLETE: 8,
	REVIEW_ASSIGNMENT_STATUS_THANKED: 9,
	SUBMISSION_FILE_SUBMISSION: 2,
	SUBMISSION_FILE_REVIEW_FILE: 4,
};

test.describe('Reviewer response', () => {
	test('reviewer accepts the assignment and submits a review with a recommendation', async ({
		pkpApi,
		asUser,
	}) => {
		// Row 1 — absorbed from reviewer-completes-review.spec.js.
		const tag = uniqueTag('rv1');
		const spec = submissionInReview({
			tag,
			reviewers: [{user: 'phudson', method: 'anonymous', status: 'invited'}],
		});
		const {submission} = await pkpApi.createSubmission(spec);

		const reviewerCtx = await asUser('phudson');
		const reviewerPage = await reviewerCtx.newPage();
		const reviewer = new ReviewerSubmissionPage(reviewerPage);
		await reviewer.goto(submission.id);

		// 4-step wizard: privacy consent + accept, guidelines, comments,
		// recommendation + confirm dialog, "Review Submitted" landing.
		await reviewer.acceptInvitation();
		await reviewer.continueToStep3();
		await reviewer.fillStep3Comments({
			toAuthor: `<p>Solid contribution; minor wording suggestions inline. ${tag}</p>`,
			toEditor: `<p>For the editor: no competing interests. ${tag}</p>`,
		});
		await reviewer.selectRecommendation('Accept Submission');
		await reviewer.submitReview();

		// Editor-side REST verification: status RECEIVED (COMPLETE only
		// after editor confirmation) and the recommendation persisted.
		const editorCtx = await asUser('dbarnes');
		const editorPage = await editorCtx.newPage();
		const assignment = await fetchAssignment(
			editorPage,
			'publicknowledge',
			submission.id,
			'Paul Hudson',
		);
		expect([
			PKP_CONST.REVIEW_ASSIGNMENT_STATUS_RECEIVED,
			PKP_CONST.REVIEW_ASSIGNMENT_STATUS_COMPLETE,
		]).toContain(assignment.statusId);
		expect(assignment.reviewerRecommendationId).toBeGreaterThan(0);
		const recRes = await editorPage.request.get(
			`/index.php/publicknowledge/api/v1/reviewers/recommendations/${assignment.reviewerRecommendationId}`,
		);
		if (recRes.ok()) {
			const rec = await recRes.json();
			const matchesAccept =
				rec.defaultTranslationKey === 'reviewer.article.decision.accept' ||
				JSON.stringify(rec.title || rec.localizedTitle || {}).includes(
					'Accept Submission',
				);
			expect(matchesAccept, 'recommendation resolves to "Accept Submission"').toBe(
				true,
			);
		}
	});

	test('reviewer declines the invitation; editor is notified', async ({
		pkpApi,
		pkpMail,
		asUser,
	}) => {
		// Row 2. Scratch journal so phudson's reviewer dashboard holds
		// exactly this one assignment (no searchPhrase on the
		// reviewerAssignments endpoint — see header note).
		const tag = uniqueTag('rv2');
		const {context} = await pkpApi.createJournal({
			tag,
			users: [
				{username: 'dbarnes', roles: ['manager', 'editor']},
				{username: 'rvaca', roles: ['author']},
				{username: 'phudson', roles: ['reviewer']},
			],
		});
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				journal: context.path,
				reviewers: [{user: 'phudson', method: 'anonymous', status: 'invited'}],
			}),
		);

		// Reviewer declines from step 1 with a comment to the editor.
		const reviewerCtx = await asUser('phudson');
		const reviewerPage = await reviewerCtx.newPage();
		const reviewer = new ReviewerSubmissionPage(reviewerPage);
		await reviewer.goto(submission.id, {journalPath: context.path});
		await reviewer.declineInvitation(
			`<p>I am unable to take this review on. ${tag}</p>`,
		);

		// ReviewDecline email lands with the assigned editor; scoped by
		// recipient + the tag we typed into the regrets body.
		const messages = await pkpMail.find({
			to: 'dbarnes@mailinator.com',
			contains: tag,
			timeoutMs: 15_000,
		});
		expect(
			messages.some((m) => /Unable to Review/i.test(m.Subject)),
			'ReviewDecline email subject',
		).toBe(true);

		// Editor's reviewer list shows the declined state.
		const editorCtx = await asUser('dbarnes');
		const editorPage = await editorCtx.newPage();
		const workflow = new EditorialWorkflowPage(editorPage);
		await workflow.goto(submission.id, {journalPath: context.path});
		const row = reviewerRow(editorPage, 'Paul Hudson');
		await expect(row).toContainText('Request Declined', {timeout: 15_000});

		// Reviewer's dashboard lists the assignment under Declined.
		await reviewerPage.goto(
			`/index.php/${context.path}/dashboard/reviewAssignments?currentViewId=reviewer-assignments-declined`,
		);
		const table = reviewerPage.locator('table').first();
		await expect(table).toContainText(tag, {timeout: 15_000});
		await expect(table).toContainText('Request declined on');
	});

	test('reviewer attaches a file to the review; editors notified on completion', async ({
		pkpApi,
		pkpMail,
		asUser,
	}) => {
		// Row 3.
		const tag = uniqueTag('rv3');
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				reviewers: [{user: 'jjanssen', method: 'anonymous', status: 'accepted'}],
			}),
		);

		// Accepted reviewers resume on step 2 (production parity).
		const reviewerCtx = await asUser('jjanssen');
		const reviewerPage = await reviewerCtx.newPage();
		const reviewer = new ReviewerSubmissionPage(reviewerPage);
		await reviewer.goto(submission.id);
		await reviewer.continueToStep3();

		await reviewer.uploadAttachment(fixtureFile('dummy.pdf'), 'dummy.pdf');
		await reviewer.fillStep3Comments({
			toAuthor: `<p>See the attached annotated manuscript. ${tag}</p>`,
		});
		await reviewer.selectRecommendation('Revisions Required');
		await reviewer.submitReview();

		// ReviewCompleteNotifyEditors (REVIEW_COMPLETE) goes to the
		// assigned editor; subject carries the tagged submission title.
		const messages = await pkpMail.find({
			to: 'dbarnes@mailinator.com',
			contains: tag,
			timeoutMs: 15_000,
		});
		expect(
			messages.some((m) => /Review complete/i.test(m.Subject)),
			'REVIEW_COMPLETE email subject',
		).toBe(true);

		// Editor's Read Review modal lists the comments + the attachment.
		const editorCtx = await asUser('dbarnes');
		const editorPage = await editorCtx.newPage();
		const workflow = new EditorialWorkflowPage(editorPage);
		await workflow.goto(submission.id);
		const row = reviewerRow(editorPage, 'Julie Janssen');
		await row.getByRole('button', {name: 'Read Review', exact: true}).click();

		const readModal = editorPage.locator('form#readReviewForm');
		await expect(readModal).toBeVisible({timeout: 15_000});
		await expect(readModal).toContainText(
			`See the attached annotated manuscript. ${tag}`,
		);
		// EditorReviewAttachmentsGridHandler loads async inside the modal.
		await expect(readModal).toContainText('dummy.pdf', {timeout: 15_000});
	});

	test('one-click reviewer access via the email link', async ({
		pkpApi,
		pkpMail,
		asUser,
		browser,
		baseURL,
	}) => {
		// Row 4. reviewerAccessKeysEnabled is not in the context scenario
		// schema — enable it through the Review Setup settings UI on a
		// scratch journal, then send a real review request from the Add
		// Reviewer modal so the email carries the one-click key URL.
		const tag = uniqueTag('rv4');
		const suffix = tag.split('-').pop();
		const throwaway = {
			username: `ocr${suffix}`,
			password: `ocr${suffix}ocr${suffix}`,
			givenName: 'Octavia',
			familyName: `Reviewer${suffix}`,
			email: `ocr${suffix}@mailinator.com`,
		};
		const {context} = await pkpApi.createJournal({
			tag,
			users: [
				{username: 'dbarnes', roles: ['manager', 'editor']},
				{username: 'rvaca', roles: ['author']},
				{...throwaway, roles: ['reviewer']},
			],
		});

		const editorCtx = await asUser('dbarnes');
		const editorPage = await editorCtx.newPage();

		// Enable one-click reviewer access in Workflow → Review → Setup.
		await editorPage.goto(
			`/index.php/${context.path}/management/settings/workflow`,
		);
		await editorPage.locator('#review-button').click();
		const reviewSetup = editorPage.locator('#reviewSetup');
		await expect(reviewSetup).toBeVisible({timeout: 15_000});
		await reviewSetup
			.getByLabel(/secure link in the email invitation/i)
			.check();
		await reviewSetup.getByRole('button', {name: 'Save', exact: true}).click();
		await expect(
			editorPage.locator('[role="status"]').filter({hasText: 'Saved'}),
		).toBeVisible({timeout: 15_000});

		// Seed the submission with an empty round; the test owns the
		// assignment so the request email is sent for real (scenario-side
		// mail is suppressed by Mail::fake()).
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({tag, journal: context.path, reviewers: []}),
		);

		const workflow = new EditorialWorkflowPage(editorPage);
		await workflow.goto(submission.id, {journalPath: context.path});
		await addReviewerViaModal(
			editorPage,
			`${throwaway.givenName} ${throwaway.familyName}`,
		);

		// The review-request email contains the secure `key=` URL.
		const [message] = await pkpMail.find({
			to: throwaway.email,
			contains: tag,
			timeoutMs: 15_000,
		});
		const full = await pkpMail.fullMessage(message.ID);
		const html = full.HTML || full.Text;
		expect(html).toContain('key=');
		const hrefMatch = html.match(/href="([^"]*invitation\/accept[^"]*)"/i);
		expect(hrefMatch, 'one-click invitation URL in email body').toBeTruthy();
		const accessUrl = hrefMatch[1].replace(/&amp;/g, '&');
		expect(accessUrl).toContain('key=');

		// Opening the link in a logged-out browser lands directly on the
		// review wizard as that reviewer — no login form.
		const anonCtx = await browser.newContext({baseURL});
		try {
			const anonPage = await anonCtx.newPage();
			await anonPage.goto(accessUrl);
			await anonPage.waitForURL(/\/reviewer\/submission/, {timeout: 20_000});
			await expect(
				anonPage.locator('form#reviewStep1Form'),
			).toBeVisible({timeout: 15_000});
			await expect(anonPage.locator('form#login')).toHaveCount(0);
		} finally {
			await anonCtx.close();
		}
	});

	test('editor thanks a reviewer', async ({pkpApi, pkpMail, asUser}) => {
		// Row 5.
		const tag = uniqueTag('rv5');
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				reviewers: [
					{
						user: 'phudson',
						method: 'anonymous',
						status: 'completed',
						recommendation: 'accept',
					},
				],
			}),
		);

		const editorCtx = await asUser('dbarnes');
		const editorPage = await editorCtx.newPage();
		const workflow = new EditorialWorkflowPage(editorPage);
		await workflow.goto(submission.id);

		const row = reviewerRow(editorPage, 'Paul Hudson');
		await row
			.getByRole('button', {name: 'Thank Reviewer', exact: true})
			.click();

		// Legacy ThankReviewerForm modal with an editable, prefilled
		// REVIEW_ACK message (compiled with the tagged title).
		const thankForm = editorPage.locator('form#sendThankYouForm');
		await expect(thankForm).toBeVisible({timeout: 15_000});
		const messageId = await thankForm
			.locator('textarea[id^="message"]')
			.first()
			.getAttribute('id');
		if (!messageId) throw new Error('thank-reviewer message textarea not found');
		const prefilled = await getTinyMceContent(editorPage, messageId);
		expect(prefilled, 'prefilled acknowledgement references the submission').toContain(
			tag,
		);
		await thankForm
			.getByRole('button', {name: 'Thank Reviewer', exact: true})
			.click();
		await expect(thankForm).toBeHidden({timeout: 15_000});

		// Tag-scoped ReviewAcknowledgement email to phudson.
		const messages = await pkpMail.find({
			to: 'phudson@mailinator.com',
			contains: tag,
			timeoutMs: 15_000,
		});
		expect(
			messages.some((m) => /Thank you for your review/i.test(m.Subject)),
			'ReviewAcknowledgement subject',
		).toBe(true);

		// Acknowledged date recorded: the submission payload's embedded
		// reviewAssignments shape omits dateAcknowledged, but statusId
		// THANKED is derived only when dateAcknowledged is set
		// (ReviewAssignment::getStatus()), so it proves the stamp.
		await expect(row).toContainText('Reviewer Thanked', {timeout: 15_000});
		const assignment = await fetchAssignment(
			editorPage,
			'publicknowledge',
			submission.id,
			'Paul Hudson',
		);
		expect(assignment.statusId).toBe(PKP_CONST.REVIEW_ASSIGNMENT_STATUS_THANKED);
	});

	test('editor reads a submitted review, confirms it, and can revert the confirmation', async ({
		pkpApi,
		asUser,
	}) => {
		// Row 6. A scenario-`completed` review is already confirmed
		// (considered + dateConsidered set), so the UI round-trip is:
		// Review Details (recommendation + both comment streams) →
		// Revert Decision (status back to Review Submitted) →
		// Read Review + Confirm (status Complete again).
		const tag = uniqueTag('rv6');
		const toEditor = `Private note for the editors only. ${tag}`;
		const toAuthor = `Shared note for the authors. ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				reviewers: [
					{
						user: 'phudson',
						method: 'anonymous',
						status: 'completed',
						recommendation: 'accept',
						comments: {toEditor, toAuthor},
					},
				],
			}),
		);

		const editorCtx = await asUser('dbarnes');
		const editorPage = await editorCtx.newPage();
		const workflow = new EditorialWorkflowPage(editorPage);
		await workflow.goto(submission.id);

		const row = reviewerRow(editorPage, 'Paul Hudson');
		await expect(row).toContainText('Complete', {timeout: 15_000});

		// Review Details (More Actions) renders the readReview form with
		// the recommendation and both comment streams.
		await row.getByRole('button', {name: /More Actions/i}).click();
		await editorPage
			.getByRole('menuitem', {name: 'Review Details', exact: true})
			.click();
		const readModal = editorPage.locator('form#readReviewForm');
		await expect(readModal).toBeVisible({timeout: 15_000});
		await expect(readModal).toContainText(
			'Recommendation: Accept Submission',
		);
		await expect(readModal).toContainText(toAuthor);
		await expect(readModal).toContainText(toEditor);
		await editorPage
			.getByRole('dialog', {name: /Review Details/i})
			.getByRole('button', {name: 'Close'})
			.click({force: true});
		await expect(readModal).toBeHidden({timeout: 15_000});

		// Revert Decision → confirm — status returns to Review Submitted.
		await row
			.getByRole('button', {name: 'Revert Decision', exact: true})
			.click();
		const revertDialog = editorPage.locator(
			'[role="dialog"]:has-text("Unconsider this Review")',
		);
		await expect(revertDialog).toBeVisible({timeout: 10_000});
		await revertDialog.getByRole('button', {name: 'OK', exact: true}).click();
		await expect(row).toContainText('Review Submitted', {timeout: 15_000});

		// Read Review + Confirm — flips the assignment back to Complete.
		await row.getByRole('button', {name: 'Read Review', exact: true}).click();
		const confirmModal = editorPage.locator('form#readReviewForm');
		await expect(confirmModal).toBeVisible({timeout: 15_000});
		await confirmModal
			.getByRole('button', {name: 'Confirm', exact: true})
			.click();
		await expect(confirmModal).toBeHidden({timeout: 15_000});
		await expect(row).toContainText('Complete', {timeout: 15_000});
		const assignment = await fetchAssignment(
			editorPage,
			'publicknowledge',
			submission.id,
			'Paul Hudson',
		);
		expect(assignment.statusId).toBe(
			PKP_CONST.REVIEW_ASSIGNMENT_STATUS_COMPLETE,
		);
	});

	test('reviewer can view and download the review file during the request', async ({
		pkpApi,
		asUser,
	}) => {
		// Row 7. The scenario seeds the Article Text on the submission
		// stage; promote it to the review round the same way the Send for
		// Review decision page does (REST file copy), then assign the
		// reviewer through the Add Reviewer modal — its "Files To Be
		// Reviewed" list defaults to all round files, which is what
		// grants the reviewer file access (review_files row). Reviewers
		// only see round files granted to their assignment
		// (ReviewerReviewFilesGridDataProvider → ReviewFilesDAO::check),
		// so the assignment must come after the file lands on the round.
		const tag = uniqueTag('rv7');
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({tag, reviewers: []}),
		);

		const editorCtx = await asUser('dbarnes');
		const editorPage = await editorCtx.newPage();
		const filesRes = await editorPage.request.get(
			`/index.php/publicknowledge/api/v1/submissions/${submission.id}/files?fileStages[]=${PKP_CONST.SUBMISSION_FILE_SUBMISSION}`,
		);
		expect(filesRes.ok()).toBe(true);
		const filesBody = await filesRes.json();
		const items = filesBody.items || filesBody;
		expect(items.length).toBeGreaterThan(0);
		// Session-cookie API writes need the CSRF token; it ships on
		// every backend page as pkp.currentUser.csrfToken (there is no
		// REST endpoint exposing it).
		await editorPage.goto('/index.php/publicknowledge/user/profile');
		const csrfToken = await editorPage.evaluate(
			// @ts-ignore pkp is a page global
			() => window.pkp?.currentUser?.csrfToken,
		);
		expect(csrfToken, 'csrf token from page state').toBeTruthy();
		// stageId must match the SOURCE file's workflow stage (1 =
		// submission) — same param the decision page's copyFile sends;
		// SubmissionFileMatchesWorkflowStageIdPolicy denies otherwise.
		const copyRes = await editorPage.request.put(
			`/index.php/publicknowledge/api/v1/submissions/${submission.id}/files/${items[0].id}/copy?stageId=1`,
			{
				headers: {'X-Csrf-Token': csrfToken},
				data: {toFileStage: PKP_CONST.SUBMISSION_FILE_REVIEW_FILE},
			},
		);
		expect(copyRes.ok(), `file copy: ${copyRes.status()}`).toBe(true);

		// Assign phudson through the Add Reviewer modal (grants the round
		// file to the assignment via the default file selection).
		const workflow = new EditorialWorkflowPage(editorPage);
		await workflow.goto(submission.id);
		await addReviewerViaModal(editorPage, 'Paul Hudson');

		// Step 1 shows the request details and the review file.
		const reviewerCtx = await asUser('phudson');
		const reviewerPage = await reviewerCtx.newPage();
		const reviewer = new ReviewerSubmissionPage(reviewerPage);
		await reviewer.goto(submission.id);
		await expect(reviewer.step1Form).toBeVisible({timeout: 15_000});
		await expect(reviewer.step1Form).toContainText(tag);
		await expect(reviewer.step1Form).toContainText('Review Schedule');

		const filesGrid = reviewerPage.locator('#reviewFilesStep1');
		const fileLink = filesGrid.getByText(/default-article\.pdf/).first();
		await expect(fileLink).toBeVisible({timeout: 15_000});

		// DownloadFileLinkAction = POST recordDownload + browser redirect
		// to the downloadFile URL; a successful (2xx, attachment) response
		// surfaces as a Playwright download event.
		const downloadPromise = reviewerPage.waitForEvent('download', {
			timeout: 15_000,
		});
		await fileLink.click();
		const download = await downloadPromise;
		// The served filename is the system-generated download name
		// (e.g. jpk-review-assignment-{id}-article-text-{fileId}.pdf),
		// not the original upload name.
		expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
	});

	test('reviewer saves a draft review for later and resumes', async ({
		pkpApi,
		asUser,
	}) => {
		// Row 8.
		const tag = uniqueTag('rv8');
		const draft = `<p>Draft thoughts to finish tomorrow. ${tag}</p>`;
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				reviewers: [{user: 'jjanssen', method: 'anonymous', status: 'accepted'}],
			}),
		);

		const reviewerCtx = await asUser('jjanssen');
		const reviewerPage = await reviewerCtx.newPage();
		const reviewer = new ReviewerSubmissionPage(reviewerPage);
		await reviewer.goto(submission.id);
		await reviewer.continueToStep3();
		await reviewer.fillStep3Comments({toAuthor: draft});
		await reviewer.saveForLater();

		// Reopen the assignment: the wizard resumes on step 3 with the
		// saved comment intact.
		await reviewer.goto(submission.id);
		await expect(reviewer.step3Form).toBeVisible({timeout: 15_000});
		const commentsId = await reviewer.step3Form
			.locator('textarea[id^="comments-"]')
			.first()
			.getAttribute('id');
		if (!commentsId) throw new Error('comments textarea not found on resume');
		const restored = await getTinyMceContent(reviewerPage, commentsId);
		expect(restored).toContain(`Draft thoughts to finish tomorrow. ${tag}`);
	});

	test('due dates surface to the reviewer; overdue response flagged to the editor', async ({
		pkpApi,
		asUser,
	}) => {
		// Row 9. Scratch journal so phudson's reviewer dashboard holds
		// only this assignment (see header note). Past responseDueDate →
		// REVIEW_ASSIGNMENT_STATUS_RESPONSE_OVERDUE.
		const tag = uniqueTag('rv9');
		const pastResponseDue = '2025-01-15 00:00:00';
		const {context} = await pkpApi.createJournal({
			tag,
			users: [
				{username: 'dbarnes', roles: ['manager', 'editor']},
				{username: 'rvaca', roles: ['author']},
				{username: 'phudson', roles: ['reviewer']},
			],
		});
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				journal: context.path,
				reviewers: [
					{
						user: 'phudson',
						method: 'anonymous',
						status: 'invited',
						responseDueDate: pastResponseDue,
					},
				],
			}),
		);

		// Reviewer sees both due dates on step 1.
		const reviewerCtx = await asUser('phudson');
		const reviewerPage = await reviewerCtx.newPage();
		const reviewer = new ReviewerSubmissionPage(reviewerPage);
		await reviewer.goto(submission.id, {journalPath: context.path});
		await expect(reviewer.step1Form).toBeVisible({timeout: 15_000});
		await expect(
			reviewer.step1Form.locator('input[id^="responseDue"]'),
		).toHaveValue(/2025-01-15/);
		await expect(
			reviewer.step1Form.locator('input[id^="dateDue"]'),
		).not.toHaveValue('');

		// ... and the overdue alert on the dashboard row.
		await reviewerPage.goto(
			`/index.php/${context.path}/dashboard/reviewAssignments?currentViewId=reviewer-action-required`,
		);
		const table = reviewerPage.locator('table').first();
		await expect(table).toContainText(tag, {timeout: 15_000});
		await expect(table).toContainText(
			'Deadline for responding to this request has passed',
		);

		// Editor's reviewer list flags the response-overdue state.
		const editorCtx = await asUser('dbarnes');
		const editorPage = await editorCtx.newPage();
		const workflow = new EditorialWorkflowPage(editorPage);
		await workflow.goto(submission.id, {journalPath: context.path});
		const row = reviewerRow(editorPage, 'Paul Hudson');
		await expect(row).toContainText('Overdue', {timeout: 15_000});
		await expect(row).toContainText('Response due');
		await expect(
			row.getByRole('button', {name: 'Send Reminder', exact: true}),
		).toBeVisible();
		const assignment = await fetchAssignment(
			editorPage,
			context.path,
			submission.id,
			'Paul Hudson',
		);
		expect(assignment.statusId).toBe(
			PKP_CONST.REVIEW_ASSIGNMENT_STATUS_RESPONSE_OVERDUE,
		);
	});

	test('editor logs a response on the reviewer behalf', async ({
		pkpApi,
		asUser,
	}) => {
		// Row 10.
		const tag = uniqueTag('rv10');
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				reviewers: [{user: 'phudson', method: 'anonymous', status: 'invited'}],
			}),
		);

		const editorCtx = await asUser('dbarnes');
		const editorPage = await editorCtx.newPage();
		const workflow = new EditorialWorkflowPage(editorPage);
		await workflow.goto(submission.id);

		const row = reviewerRow(editorPage, 'Paul Hudson');
		await row.getByRole('button', {name: /More Actions/i}).click();
		await editorPage
			.getByRole('menuitem', {name: 'Log Response', exact: true})
			.click();

		// WorkflowLogResponseModal: radio accept/decline + Log Response.
		// Both the workflow page and this side modal are role=dialog —
		// disambiguate by the modal's accessible name (its title slot).
		const logModal = editorPage.getByRole('dialog', {
			name: /Log Response for/i,
		});
		await expect(logModal).toBeVisible({timeout: 15_000});
		await logModal
			.getByLabel('Reviewer has accepted the invitation to review')
			.check();
		await logModal
			.getByRole('button', {name: 'Log Response', exact: true})
			.click();
		await expect(logModal).toBeHidden({timeout: 15_000});

		// Reviewer list status flips to accepted.
		await expect(row).toContainText('Request Accepted', {timeout: 15_000});
		const assignment = await fetchAssignment(
			editorPage,
			'publicknowledge',
			submission.id,
			'Paul Hudson',
		);
		expect(assignment.statusId).toBe(
			PKP_CONST.REVIEW_ASSIGNMENT_STATUS_ACCEPTED,
		);
	});

	test('reviewer cannot open an assignment that is not theirs', async ({
		pkpApi,
		asUser,
	}) => {
		// Row 11. amccrae is a publicknowledge reviewer with no assignment
		// on this submission: SubmissionAccessPolicy denies and the page
		// router redirects to user/authorizationDenied.
		const tag = uniqueTag('rv11');
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				reviewers: [{user: 'phudson', method: 'anonymous', status: 'invited'}],
			}),
		);

		const intruderCtx = await asUser('amccrae');
		const intruderPage = await intruderCtx.newPage();
		await intruderPage.goto(
			`/index.php/publicknowledge/en/reviewer/submission/${submission.id}`,
		);
		await intruderPage.waitForURL(/authorizationDenied/, {timeout: 15_000});
		await expect(intruderPage.locator('form#reviewStep1Form')).toHaveCount(0);
		await expect(intruderPage.locator('form#reviewStep3Form')).toHaveCount(0);
	});

	test('completed assignment is read-only for the reviewer', async ({
		pkpApi,
		asUser,
	}) => {
		// Row 12. Scratch journal so jjanssen's Completed dashboard view
		// holds exactly this assignment (see header note).
		const tag = uniqueTag('rv12');
		const {context} = await pkpApi.createJournal({
			tag,
			users: [
				{username: 'dbarnes', roles: ['manager', 'editor']},
				{username: 'rvaca', roles: ['author']},
				{username: 'jjanssen', roles: ['reviewer']},
			],
		});
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				journal: context.path,
				reviewers: [
					{
						user: 'jjanssen',
						method: 'anonymous',
						status: 'completed',
						recommendation: 'accept',
						comments: {toAuthor: `Final review text. ${tag}`},
					},
				],
			}),
		);

		// Reopening the assignment lands on the completion view.
		const reviewerCtx = await asUser('jjanssen');
		const reviewerPage = await reviewerCtx.newPage();
		const reviewer = new ReviewerSubmissionPage(reviewerPage);
		await reviewer.goto(submission.id, {journalPath: context.path});
		await expect(reviewer.completedHeading).toBeVisible({timeout: 15_000});

		// Earlier steps stay reachable but read-only: comments readonly,
		// submit/save disabled (reviewIsClosed).
		await reviewerPage
			.getByRole('link', {name: '3. Download & Review'})
			.click();
		await expect(reviewer.step3Form).toBeVisible({timeout: 15_000});
		await expect(
			reviewer.step3Form.locator('textarea[id^="comments-"]').first(),
		).toHaveAttribute('readonly', /.*/);
		await expect(
			reviewer.step3Form.getByRole('button', {name: /^Submit Review$/i}),
		).toBeDisabled();
		await expect(
			reviewer.step3Form.getByRole('button', {
				name: 'Save for Later',
				exact: true,
			}),
		).toBeDisabled();

		// Dashboard lists it under Completed.
		await reviewerPage.goto(
			`/index.php/${context.path}/dashboard/reviewAssignments?currentViewId=reviewer-assignments-completed`,
		);
		const table = reviewerPage.locator('table').first();
		await expect(table).toContainText(tag, {timeout: 15_000});
		await expect(table).toContainText('Review submitted on');
	});
});

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/**
 * Short worker-scoped unique tag. Kept compact because the journal
 * scenario derives `urlPath` (varchar 32) from it, and whitespace-free
 * because searchPhrase OR-splits on spaces.
 *
 * @param {string} prefix
 */
function uniqueTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

/**
 * Resolve a bundled fixture file.
 *
 * @param {string} name basename under lib/pkp/playwright/fixtures/files
 */
function fixtureFile(name) {
	return path.resolve(__dirname, '..', 'fixtures', 'files', name);
}

/**
 * Row in the ReviewerManager panel for the named reviewer.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} fullName
 */
function reviewerRow(page, fullName) {
	return page
		.locator('[data-cy="reviewer-manager"]')
		.locator('tr', {hasText: fullName});
}

/**
 * Fetch the named reviewer's assignment from the submission payload
 * (editor-scoped REST read).
 *
 * @param {import('@playwright/test').Page} page authenticated editor page
 * @param {string} journalPath
 * @param {number} submissionId
 * @param {string} reviewerFullName
 */
async function fetchAssignment(page, journalPath, submissionId, reviewerFullName) {
	const res = await page.request.get(
		`/index.php/${journalPath}/api/v1/submissions/${submissionId}`,
	);
	if (!res.ok()) {
		throw new Error(
			`GET submission ${submissionId} failed: ${res.status()} ${await res.text()}`,
		);
	}
	const body = await res.json();
	const assignment = (body.reviewAssignments || []).find((a) =>
		(a.reviewerFullName || '').includes(reviewerFullName),
	);
	if (!assignment) {
		throw new Error(
			`No review assignment for ${reviewerFullName} on submission ${submissionId}`,
		);
	}
	return assignment;
}

/**
 * Drive the Add Reviewer side-modal: pick the named reviewer from the
 * SelectReviewerListPanel, verify the assignment form populated its due
 * dates (bumping the review due date when the journal's defaults make
 * the pair collide), and submit.
 *
 * Spec-local on purpose — the editor-side reviewer manager belongs to
 * another plan's POM surface.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} reviewerFullName
 */
async function addReviewerViaModal(page, reviewerFullName) {
	const reviewerManager = page.locator('[data-cy="reviewer-manager"]');
	await expect(reviewerManager).toBeVisible({timeout: 15_000});
	await reviewerManager
		.getByRole('button', {name: 'Add Reviewer', exact: true})
		.click();

	const modal = page.getByRole('dialog', {name: 'Add Reviewer', exact: true});
	await expect(modal).toBeVisible({timeout: 15_000});
	const selectPanel = modal.locator('.listPanel--selectReviewer').last();
	await expect(selectPanel).toBeVisible({timeout: 20_000});
	await modal
		.getByRole('button', {name: `Select ${reviewerFullName}`, exact: true})
		.first()
		.click();

	const regularForm = modal.locator('#regularReviewerForm').last();
	await expect(regularForm).toBeVisible({timeout: 15_000});
	await expect(regularForm.locator('#selectedReviewerName')).toContainText(
		reviewerFullName,
	);
	const reviewerForm = regularForm.locator('#advancedSearchReviewerForm');

	// Due dates prefill from numWeeksPerResponse/numWeeksPerReview (or
	// the 3/4-week defaults). If they collide, the legacy validator
	// disables submit — push the review due date out a day via the
	// datepicker API so all bound fields observe the change.
	const responseDueHidden = reviewerForm.locator('input[name="responseDueDate"]');
	const reviewDueHidden = reviewerForm.locator('input[name="reviewDueDate"]');
	await expect(responseDueHidden).not.toHaveValue('');
	await expect(reviewDueHidden).not.toHaveValue('');
	const responseDueValue = await responseDueHidden.inputValue();
	const reviewDueValue = await reviewDueHidden.inputValue();
	if (responseDueValue === reviewDueValue) {
		const bumped = new Date(responseDueValue);
		bumped.setUTCDate(bumped.getUTCDate() + 1);
		const bumpedIso = bumped.toISOString().slice(0, 10);
		await page.evaluate((nextDate) => {
			const altField = document.querySelector('input[name="reviewDueDate"]');
			if (!altField) throw new Error('reviewDueDate alt-field not found');
			const visibleId = altField.id.replace(/-altField$/, '');
			const visible = document.getElementById(visibleId);
			if (!visible) throw new Error(`visible input ${visibleId} not found`);
			const $ = window.jQuery || window.$;
			$(visible).datepicker('setDate', nextDate);
			$(visible).trigger('change');
			$(visible).datepicker('hide');
			visible.blur();
		}, bumpedIso);
		await expect(reviewDueHidden).toHaveValue(bumpedIso);
	}

	const submitButton = reviewerForm.getByRole('button', {
		name: 'Add Reviewer',
		exact: true,
	});
	await expect(submitButton).toBeEnabled({timeout: 5_000});
	await submitButton.click();
	await expect(modal).toBeHidden({timeout: 20_000});
	await expect(reviewerManager).toContainText(reviewerFullName, {
		timeout: 15_000,
	});
}
