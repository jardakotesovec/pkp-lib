// @ts-check
const {test, expect} = require('../support/base-test.js');
const {ReviewerManagerPage} = require('../pages/ReviewerManagerPage.js');
const {ReviewerSubmissionPage} = require('../pages/ReviewerSubmissionPage.js');
const submissionInReview = require('../../../../playwright/fixtures/scenarios/submission-in-review.js');

/**
 * Review anonymity — docs/e2e/plans/review-anonymity.md (5 rows).
 *
 * The feature under test is how the per-assignment review method
 * (anonymous / double-anonymous / open) gates identity disclosure on
 * three surfaces:
 *
 *   - Reviewer side: the submission Schema map anonymizes publication
 *     authors ONLY when the current user's own assignment is
 *     double-anonymous (lib/pkp/classes/submission/maps/Schema.php:471);
 *     the legacy review wizard mirrors that in the step-1 "Review Type"
 *     notice (ReviewAssignment::getReviewMethodKey) and the "View All
 *     Submission Details" modal (ViewSubmissionMetadataHandler assigns
 *     `authors` for every method EXCEPT double-anonymous).
 *   - Author side: the API anonymizes reviewer identity on every
 *     non-open assignment (api/v1/submissions/AnonymizeData.php), and
 *     the author's review stage mounts the redacted ReviewerManager
 *     only when open+completed assignments exist
 *     (workflowConfigAuthorOJS.js:162-178). Open completed reviews are
 *     readable by the author via the AuthorReviewerGridHandler
 *     readReview modal (REVIEWER_READ_REVIEW_BY_AUTHOR action).
 *   - Editor side: never redacted — every row shows the reviewer's
 *     full name plus the per-assignment ReviewMethodIcons label, and
 *     the legacy Edit Review modal can switch the method.
 *
 * Method labels (lib/pkp/locale/en/editor.po):
 *   open            → "Open"
 *   anonymous       → "Anonymous Reviewer/Disclosed Author"
 *   doubleAnonymous → "Anonymous Reviewer/Anonymous Author"
 *
 * Seeding: per-reviewer `method` / `status` / `recommendation` /
 * `comments` on the submission-in-review fixture (ReviewRoundProcessor
 * METHOD_MAP). Rows needing an author actor route the submitter through
 * `atester` — the only seeded user where author-side gates are
 * meaningful (skill users.md).
 */

const METHOD = {
	ANONYMOUS: 1, // ReviewAssignment::SUBMISSION_REVIEW_METHOD_ANONYMOUS
	DOUBLE_ANONYMOUS: 2, // ReviewAssignment::SUBMISSION_REVIEW_METHOD_DOUBLEANONYMOUS
	OPEN: 3, // ReviewAssignment::SUBMISSION_REVIEW_METHOD_OPEN
};

const METHOD_LABEL = {
	open: 'Open',
	anonymous: 'Anonymous Reviewer/Disclosed Author',
	doubleAnonymous: 'Anonymous Reviewer/Anonymous Author',
};

function uniqueTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

/** The author's workflow surface for a submission. */
function authorWorkflowUrl(submissionId) {
	return `/index.php/publicknowledge/en/dashboard/mySubmissions?workflowSubmissionId=${submissionId}`;
}

/** The workflow page's hosting side-modal. */
function workflowModal(page) {
	return page.locator('[data-cy="active-modal"]').first();
}

/**
 * Open the review wizard's step 1 ("1. Request") regardless of which
 * step the assignment resumes on (accepted resumes step 2, completed
 * lands on the completion view) and wait for the step-1 form.
 *
 * @param {import('@playwright/test').Page} reviewerPage
 * @returns {Promise<import('@playwright/test').Locator>} the step-1 form
 */
async function openRequestStep(reviewerPage) {
	const step1Form = reviewerPage.locator('form#reviewStep1Form');
	if (!(await step1Form.isVisible().catch(() => false))) {
		await reviewerPage.getByRole('link', {name: '1. Request'}).click();
	}
	await expect(step1Form).toBeVisible({timeout: 15_000});
	return step1Form;
}

/**
 * Open the "View All Submission Details" modal from step 1
 * (ReviewerViewMetadataLinkAction → ViewSubmissionMetadataHandler) and
 * return the rendered metadata container.
 *
 * @param {import('@playwright/test').Page} reviewerPage
 * @returns {Promise<import('@playwright/test').Locator>}
 */
async function openSubmissionDetailsModal(reviewerPage) {
	await reviewerPage
		.getByRole('link', {name: 'View All Submission Details'})
		.first()
		.click();
	// Side-modal wrappers can report visibility:hidden during the open
	// transition — anchor on the server-rendered metadata container.
	const metadata = reviewerPage.locator('#viewSubmissionMetadata').last();
	await expect(metadata).toBeVisible({timeout: 15_000});
	return metadata;
}

/**
 * Fetch the submission as the context behind `page` (the caller picks
 * whose anonymization perspective is exercised).
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} submissionId
 * @returns {Promise<object>}
 */
async function fetchSubmissionAs(page, submissionId) {
	const res = await page.request.get(
		`/index.php/publicknowledge/api/v1/submissions/${submissionId}`,
	);
	expect(res.ok(), `GET submission ${submissionId}: ${res.status()}`).toBe(true);
	return res.json();
}

test.use({user: 'dbarnes'});

test.describe('Review anonymity', () => {
	// Row 1
	test('double-anonymous: reviewer cannot see author identity', {tag: '@smoke'}, async ({pkpApi, asUser}) => {
		const tag = uniqueTag('anon1');
		// Default submitter is rvaca (Ramiro Vaca) — the identity that
		// must never leak to the double-anonymous reviewer.
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				reviewers: [
					{user: 'jjanssen', method: 'doubleAnonymous', status: 'accepted'},
				],
			}),
		);

		const reviewerCtx = await asUser('jjanssen');
		const reviewerPage = await reviewerCtx.newPage();
		const reviewer = new ReviewerSubmissionPage(reviewerPage);
		await reviewer.goto(submission.id);

		// Accepted assignments resume on step 2; the request step stays
		// reachable and carries the review-type notice.
		const step1Form = await openRequestStep(reviewerPage);
		await expect(step1Form).toContainText('Review Type');
		await expect(step1Form).toContainText(METHOD_LABEL.doubleAnonymous);
		await expect(step1Form).toContainText(tag); // title renders…
		await expect(step1Form).not.toContainText('Vaca'); // …author never

		// "View All Submission Details" renders title/abstract/keywords
		// but ViewSubmissionMetadataHandler withholds `authors` for
		// double-anonymous assignments.
		const metadata = await openSubmissionDetailsModal(reviewerPage);
		await expect(metadata).toContainText(tag);
		await expect(metadata).not.toContainText('Vaca');

		// Schema-map anonymization (Schema.php:471): the reviewer's own
		// API view of the submission carries no author strings.
		const sub = await fetchSubmissionAs(reviewerPage, submission.id);
		expect(sub.publications.length).toBeGreaterThan(0);
		for (const publication of sub.publications) {
			expect(publication.authorsString).toBe('');
			expect(publication.authorsStringShort).toBe('');
		}
	});

	// Row 2
	test('anonymous (one-way): reviewer sees authors, author sees no reviewer', {tag: '@regression'}, async ({pkpApi, asUser}) => {
		const tag = uniqueTag('anon2');
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				submitter: 'atester',
				reviewers: [
					{
						user: 'jjanssen',
						method: 'anonymous',
						status: 'completed',
						recommendation: 'accept',
						comments: {toAuthor: `Anonymous reviewer remarks. ${tag}`},
					},
				],
			}),
		);

		// --- Reviewer side: author identity IS disclosed (one-way). ----
		const reviewerCtx = await asUser('jjanssen');
		const reviewerPage = await reviewerCtx.newPage();
		const reviewer = new ReviewerSubmissionPage(reviewerPage);
		await reviewer.goto(submission.id);
		await expect(reviewer.completedHeading).toBeVisible({timeout: 15_000});

		const step1Form = await openRequestStep(reviewerPage);
		await expect(step1Form).toContainText(METHOD_LABEL.anonymous);
		const metadata = await openSubmissionDetailsModal(reviewerPage);
		await expect(metadata).toContainText('Author Tester');

		const reviewerView = await fetchSubmissionAs(reviewerPage, submission.id);
		expect(reviewerView.publications[0].authorsString).toContain('Tester');

		// --- Author side: no reviewer listing, no reviewer identity. ----
		// The review stage mounts ReviewerManager for authors only when
		// open+completed assignments exist — an anonymous completed
		// review is not one (workflowConfigAuthorOJS.js:162-178).
		const authorCtx = await asUser('atester');
		const authorPage = await authorCtx.newPage();
		await authorPage.goto(authorWorkflowUrl(submission.id));
		await expect(
			authorPage.getByRole('heading', {name: 'Round 1 Status'}),
		).toBeVisible({timeout: 20_000});
		await expect(
			workflowModal(authorPage).locator('[data-cy="reviewer-manager"]'),
		).toHaveCount(0);
		await expect(workflowModal(authorPage).getByText(/Janssen/)).toHaveCount(0);

		// API view as the author: AnonymizeData redacts every non-open
		// assignment for authors — id fields are nulled/emptied.
		const authorView = await fetchSubmissionAs(authorPage, submission.id);
		expect(authorView.reviewAssignments).toHaveLength(1);
		expect(authorView.reviewAssignments[0].reviewerFullName).toBe('');
		expect(authorView.reviewAssignments[0].reviewerId).toBeNull();
	});

	// Row 3
	test('open review: author sees the completed review with reviewer identity', {tag: '@regression'}, async ({page, pkpApi, asUser}) => {
		const tag = uniqueTag('anon3');
		const openRemarks = `Open review remarks for the author. ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				submitter: 'atester',
				reviewers: [
					{
						user: 'jjanssen',
						method: 'open',
						status: 'completed',
						recommendation: 'accept',
						comments: {toAuthor: openRemarks},
					},
				],
			}),
		);

		// --- Author side: redacted ReviewerManager lists the open review.
		const authorCtx = await asUser('atester');
		const authorPage = await authorCtx.newPage();
		await authorPage.goto(authorWorkflowUrl(submission.id));
		const authorManager = new ReviewerManagerPage(authorPage);
		await expect(authorManager.manager).toBeVisible({timeout: 20_000});

		// Open review ⇒ identity disclosed to the author, with the
		// method label; the redacted view drops the editor controls
		// (no Add Reviewer top action, no More Actions column).
		await expect(authorManager.row('Julie Janssen')).toBeVisible();
		await expect(
			authorManager.reviewTypeLabel('Julie Janssen', METHOD_LABEL.open),
		).toBeVisible();
		await expect(
			authorManager.manager.getByRole('button', {name: 'Add Reviewer'}),
		).toHaveCount(0);
		await expect(
			authorManager.manager.getByRole('button', {name: 'More Actions'}),
		).toHaveCount(0);

		// API view as the author: the OPEN assignment is NOT anonymized.
		const authorView = await fetchSubmissionAs(authorPage, submission.id);
		expect(authorView.reviewAssignments[0].reviewerFullName).toBe(
			'Julie Janssen',
		);

		// Read Review (REVIEWER_READ_REVIEW_BY_AUTHOR) opens the legacy
		// authorReadReview modal: reviewer name + recommendation + the
		// author-visible comment stream.
		await authorManager
			.row('Julie Janssen')
			.getByRole('button', {name: 'Read Review', exact: true})
			.click();
		const readForm = authorPage.locator('form#readReviewForm');
		await expect(readForm).toBeVisible({timeout: 15_000});
		await expect(readForm).toContainText('Julie Janssen');
		await expect(readForm).toContainText('Recommendation: Accept Submission');
		await expect(readForm).toContainText(openRemarks);

		// --- Editor side unaffected: full identity + controls. ---------
		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id);
		await expect(rm.row('Julie Janssen')).toContainText('Complete', {
			timeout: 15_000,
		});
		await expect(
			rm.manager.getByRole('button', {name: 'Add Reviewer', exact: true}),
		).toBeVisible();
	});

	// Row 4
	test('editor changes review method on an existing assignment', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('anon4');
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				reviewers: [
					{user: 'jjanssen', method: 'doubleAnonymous', status: 'invited'},
				],
			}),
		);

		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id);
		await expect(
			rm.reviewTypeLabel('Julie Janssen', METHOD_LABEL.doubleAnonymous),
		).toBeVisible({timeout: 15_000});

		// Edit Review: current method pre-selected, due dates prefilled
		// (the hidden Y-m-d altFields are the canonical values — both
		// inputs share the name, .last() is the altField).
		const {modal, form} = await rm.openEditReviewModal('Julie Janssen');
		await expect(
			rm.reviewMethodRadio(form, METHOD.DOUBLE_ANONYMOUS),
		).toBeChecked();
		await expect(
			form.locator('input[name="responseDueDate"]').last(),
		).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
		await expect(
			form.locator('input[name="reviewDueDate"]').last(),
		).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);

		// Switch to open and save (fbvFormButtons default submit "OK").
		await rm.reviewMethodRadio(form, METHOD.OPEN).check();
		await rm.submitLegacyForm(form, 'OK', modal);

		// The manager refetches on modal close (triggerDataChange) — the
		// row's ReviewMethodIcons label flips to Open…
		await expect(
			rm.reviewTypeLabel('Julie Janssen', METHOD_LABEL.open),
		).toBeVisible({timeout: 15_000});
		// …and the change persisted.
		const assignments = await rm.fetchReviewAssignments(submission.id);
		expect(assignments).toHaveLength(1);
		expect(assignments[0].reviewMethod).toBe(METHOD.OPEN);
	});

	// Row 5
	test('editor list distinguishes all three methods on one submission', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('anon5');
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				reviewers: [
					{user: 'phudson', method: 'doubleAnonymous', status: 'invited'},
					{user: 'jjanssen', method: 'anonymous', status: 'accepted'},
					{user: 'amccrae', method: 'open', status: 'invited'},
				],
			}),
		);

		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id);

		// Each assignment renders with full reviewer identity and the
		// matching review-type label — anonymity modes never redact the
		// editor view.
		const expectations = [
			{name: 'Paul Hudson', label: METHOD_LABEL.doubleAnonymous},
			{name: 'Julie Janssen', label: METHOD_LABEL.anonymous},
			{name: 'Aisla McCrae', label: METHOD_LABEL.open},
		];
		for (const {name, label} of expectations) {
			await expect(rm.row(name)).toBeVisible({timeout: 15_000});
			await expect(rm.reviewTypeLabel(name, label)).toBeVisible();
		}

		// API round-trip as the editor: all three methods persisted and
		// no identity field is redacted.
		const assignments = await rm.fetchReviewAssignments(submission.id);
		expect(assignments).toHaveLength(3);
		expect(assignments.map((a) => a.reviewMethod).sort()).toEqual([
			METHOD.ANONYMOUS,
			METHOD.DOUBLE_ANONYMOUS,
			METHOD.OPEN,
		]);
		for (const assignment of assignments) {
			expect(assignment.reviewerFullName).not.toBe('');
			expect(assignment.reviewerId).not.toBeNull();
		}
	});
});
