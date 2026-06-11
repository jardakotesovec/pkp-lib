// @ts-check
// NOTE: split during the submission-stage-actions refit — the stage-1
// initial-decline test moved to submission-stage-actions.spec.js; this
// file keeps only the post-review decline (review-decisions plan).
const {test, expect} = require('../../../../playwright/support/fixtures.js');
const {EditorialWorkflowPage} = require('../../../../playwright/pages/EditorialWorkflowPage.js');
const submissionInReview = require('../../../../playwright/fixtures/scenarios/submission-in-review.js');

/**
 * Playwright port of the "decline after review" decision assertion
 * scattered across the Cypress submission fixture specs (Decline,
 * DECISION_DECLINE=6). The decision wizard has a single "Notify
 * Authors" email step, so the interaction shape is: click decision →
 * wait for template → Record Decision → success dialog → assert
 * submission status flips to STATUS_DECLINED.
 */
test.describe('Decision — decline', () => {
	test('editor declines a submission after review', async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag(test.info(), 'decline-review');
		const spec = submissionInReview({tag});
		const {submission} = await pkpApi.createSubmission(spec);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		// Review-stage decline lives inside the review-round action
		// items. The review tab is auto-selected for an in-review
		// submission. Seeded reviewers are in 'invited' and 'accepted'
		// states, so no completed reviews — Decline has a single
		// notifyAuthors step with no notifyReviewers step appended (see
		// lib/pkp/classes/decision/types/Decline.php#163 — reviewer
		// notification only on REVIEW_ASSIGNMENT_COMPLETED).
		await expect(
			page
				.getByRole('button', {name: 'Decline Submission', exact: true})
				.first(),
		).toBeVisible();

		await workflow.clickDecision('Decline Submission');
		await workflow.recordDecision('has been declined and sent to the archives');
		await workflow.viewSubmissionFromCompletionDialog(submission.id);

		const after = await workflow.fetchSubmission(submission.id);
		expect(after.status).toBe(pkpConst.STATUS_DECLINED);

		const decisions = await page.request.get(
			`/index.php/publicknowledge/api/v1/submissions/${submission.id}/decisions`,
		);
		expect(decisions.ok()).toBe(true);
		const body = await decisions.json();
		const items = body.items || body;
		expect(items.some((d) => d.decision === pkpConst.DECISION_DECLINE)).toBe(
			true,
		);
	});
});

// Matches lib/pkp/classes/submission/PKPSubmission.php + Decision\Decision.php.
const pkpConst = {
	STATUS_DECLINED: 4,
	DECISION_DECLINE: 6,
};

/**
 * Build a tag scoped to this worker + test title so parallel workers
 * don't collide on the shared submissions list.
 *
 * @param {import('@playwright/test').TestInfo} info
 * @param {string} suffix
 */
function uniqueTag(info, suffix) {
	const slug = info.title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.slice(0, 16);
	return `t-w${info.parallelIndex}-${suffix}-${slug}`;
}
