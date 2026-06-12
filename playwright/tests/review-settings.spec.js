// @ts-check
const {test, expect} = require('../support/base-test.js');
const {ReviewerManagerPage} = require('../pages/ReviewerManagerPage.js');
const {ReviewerSubmissionPage} = require('../pages/ReviewerSubmissionPage.js');
const {SubmissionWizardPage} = require('../pages/SubmissionWizardPage.js');
const {setTinyMceContent, getTinyMceContent} = require('../support/tinymce.js');
const submissionInReview = require('../../../../playwright/fixtures/scenarios/submission-in-review.js');

/**
 * Review settings — docs/e2e/plans/review-settings.md rows 1–4.
 * (Row 5 — reviewer recommendation configuration — is backed by
 * lib/pkp/playwright/tests/reviewer-recommendations.spec.js.)
 *
 * Workflow Settings → Review: the Setup tab (PKPReviewSetupForm,
 * tab panel #reviewSetup) and the Reviewer Guidance tab
 * (PKPReviewGuidanceForm, tab panel #reviewerGuidance). Each test
 * mutates settings through the UI — the mutation is the behavior under
 * test (plan note) — so every test runs on its own scratch journal;
 * the bootstrapped publicknowledge journal stays read-only.
 *
 * Effects are asserted on the surface each setting actually gates:
 *   1. defaultReviewMode  → the Add Reviewer modal's review-type radio
 *   2. numWeeksPerResponse/Review → the Add Reviewer due-date prefill
 *   3. reviewGuidelines (+competingInterests) → the reviewer's own
 *      review wizard (Guidelines step / step-1 CI declaration)
 *   4. reviewerSuggestionEnabled → the submission wizard's step rail
 *
 * Date assertions use day-level tolerance (±1 day): the expected dates
 * are computed in Node while the prefill is computed in PHP
 * (HasReviewDueDate), and the two processes may sit in different
 * timezones either side of midnight.
 */

/** ReviewAssignment::SUBMISSION_REVIEW_METHOD_* */
const METHOD_ANONYMOUS = 1;
const METHOD_DOUBLE_ANONYMOUS = 2;
const METHOD_OPEN = 3;

function uniqueTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

/**
 * Open Workflow Settings → Review. The Setup side tab (#reviewSetup) is
 * the default-active panel. Safe to call after a reload too — clicking
 * an already-active top tab is a no-op.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} journalPath
 * @returns {Promise<import('@playwright/test').Locator>} the #reviewSetup tab panel
 */
async function openReviewSetup(page, journalPath) {
	await page.goto(`/index.php/${journalPath}/management/settings/workflow`);
	await page.locator('#review-button').click();
	const reviewSetup = page.locator('#reviewSetup');
	await expect(reviewSetup).toBeVisible({timeout: 15_000});
	return reviewSetup;
}

/**
 * Open Workflow Settings → Review → Reviewer Guidance.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} journalPath
 * @returns {Promise<import('@playwright/test').Locator>} the #reviewerGuidance tab panel
 */
async function openReviewerGuidance(page, journalPath) {
	await page.goto(`/index.php/${journalPath}/management/settings/workflow`);
	await page.locator('#review-button').click();
	await page.locator('#reviewerGuidance-button').click();
	const panel = page.locator('#reviewerGuidance');
	await expect(panel).toBeVisible({timeout: 15_000});
	return panel;
}

/**
 * Save a settings PkpForm and wait for the canonical inline "Saved"
 * confirmation ([role="status"] — patterns.md pitfall 13) before the
 * caller reloads or navigates.
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} panel  the tab panel hosting the form
 */
async function saveSettingsForm(page, panel) {
	await panel.getByRole('button', {name: 'Save', exact: true}).click();
	await expect(
		panel.locator('[role="status"]').filter({hasText: 'Saved'}),
	).toBeVisible({timeout: 15_000});
}

/**
 * Whole days from "today" (local) to a yyyy-mm-dd date. Date-only math
 * in UTC so DST shifts can't skew the diff.
 *
 * @param {string} isoDate yyyy-mm-dd
 */
function dayDiffFromToday(isoDate) {
	const [y, m, d] = isoDate.split('-').map(Number);
	const target = Date.UTC(y, m - 1, d);
	const now = new Date();
	const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
	return Math.round((target - today) / 86_400_000);
}

test.use({user: 'dbarnes'});

test.describe('Review settings', () => {
	test('default review mode persists and preselects the review type in Add Reviewer', {tag: '@regression'}, async ({page, pkpApi}) => {
		// Row 1. Scratch journal starts at the schema default
		// (double-anonymous, defaultReviewMode=2); flipping it to Open
		// must persist AND become the Add Reviewer modal's preselected
		// review-type radio (ReviewerForm initData reads
		// defaultReviewMode).
		const tag = uniqueTag('rvs1');
		const {context} = await pkpApi.createJournal({
			tag,
			users: [
				{username: 'dbarnes', roles: ['manager', 'editor']},
				{username: 'rvaca', roles: ['author']},
				{username: 'phudson', roles: ['reviewer']},
			],
		});
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({tag, journal: context.path, reviewers: []}),
		);

		let reviewSetup = await openReviewSetup(page, context.path);
		// Baseline sanity: the scratch journal ships the schema default.
		await expect(
			reviewSetup.locator(
				`input[name="defaultReviewMode"][value="${METHOD_DOUBLE_ANONYMOUS}"]`,
			),
		).toBeChecked();
		await reviewSetup
			.locator(`input[name="defaultReviewMode"][value="${METHOD_OPEN}"]`)
			.check({force: true});
		await saveSettingsForm(page, reviewSetup);

		// Persistence: a full reload re-renders the form from the DB.
		reviewSetup = await openReviewSetup(page, context.path);
		await expect(
			reviewSetup.locator(
				`input[name="defaultReviewMode"][value="${METHOD_OPEN}"]`,
			),
		).toBeChecked();

		// Effect: the Add Reviewer assignment form defaults to Open.
		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id, {journalPath: context.path});
		const modal = await rm.openAddReviewerModal();
		await expect(rm.selectPanel(modal)).toBeVisible({timeout: 20_000});
		const form = await rm.selectReviewer(modal, 'Paul Hudson');
		await expect(
			form.locator(`input[name="reviewMethod"][value="${METHOD_OPEN}"]`),
		).toBeChecked();
		await expect(
			form.locator(
				`input[name="reviewMethod"][value="${METHOD_DOUBLE_ANONYMOUS}"]`,
			),
		).not.toBeChecked();
		await expect(
			form.locator(`input[name="reviewMethod"][value="${METHOD_ANONYMOUS}"]`),
		).not.toBeChecked();
	});

	test('response and review deadlines persist and prefill the reviewer due dates', {tag: '@regression'}, async ({page, pkpApi}) => {
		// Row 2. numWeeksPerResponse=2 / numWeeksPerReview=6 (schema
		// defaults are 4/4) round-trip the Setup form, and the Add
		// Reviewer modal prefills response due ≈ today+2w and review due
		// ≈ today+6w (HasReviewDueDate). ±1 day for Node-vs-PHP TZ skew.
		const tag = uniqueTag('rvs2');
		const {context} = await pkpApi.createJournal({
			tag,
			users: [
				{username: 'dbarnes', roles: ['manager', 'editor']},
				{username: 'rvaca', roles: ['author']},
				{username: 'phudson', roles: ['reviewer']},
			],
		});
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({tag, journal: context.path, reviewers: []}),
		);

		let reviewSetup = await openReviewSetup(page, context.path);
		await reviewSetup.locator('input[name="numWeeksPerResponse"]').fill('2');
		await reviewSetup.locator('input[name="numWeeksPerReview"]').fill('6');
		await saveSettingsForm(page, reviewSetup);

		reviewSetup = await openReviewSetup(page, context.path);
		await expect(
			reviewSetup.locator('input[name="numWeeksPerResponse"]'),
		).toHaveValue('2');
		await expect(
			reviewSetup.locator('input[name="numWeeksPerReview"]'),
		).toHaveValue('6');

		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id, {journalPath: context.path});
		const modal = await rm.openAddReviewerModal();
		await expect(rm.selectPanel(modal)).toBeVisible({timeout: 20_000});
		const form = await rm.selectReviewer(modal, 'Paul Hudson');

		// The fbv datepickers pair a visible display input with a hidden
		// altField (both share the name; .last() is the canonical
		// yyyy-mm-dd altField — see ReviewerManagerPage).
		const responseDue = await form
			.locator('input[name="responseDueDate"]')
			.last()
			.inputValue();
		const reviewDue = await form
			.locator('input[name="reviewDueDate"]')
			.last()
			.inputValue();
		expect(responseDue).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(reviewDue).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		const responseDiff = dayDiffFromToday(responseDue);
		const reviewDiff = dayDiffFromToday(reviewDue);
		expect(
			Math.abs(responseDiff - 14),
			`response due ${responseDue} is ~2 weeks out (got +${responseDiff}d)`,
		).toBeLessThanOrEqual(1);
		expect(
			Math.abs(reviewDiff - 42),
			`review due ${reviewDue} is ~6 weeks out (got +${reviewDiff}d)`,
		).toBeLessThanOrEqual(1);
	});

	test('reviewer guidance text persists and reaches the reviewer wizard', {tag: '@regression'}, async ({page, pkpApi, asUser}) => {
		// Row 3. reviewGuidelines + competingInterests round-trip the
		// Reviewer Guidance form; the guidelines render verbatim on the
		// reviewer's Guidelines step (step 2 — PKPReviewerReviewStep2Form
		// assigns the context's reviewGuidelines), and the CI declaration
		// controls appear on step 1 only because competingInterests is
		// set (step1.tpl gates the radios on the context setting).
		const tag = uniqueTag('rvs3');
		const guidelines = `Custom guidelines ${tag}: weigh the methodology before the prose.`;
		const ciPolicy = `Competing interests policy ${tag}: declare any funding overlap.`;
		const {context} = await pkpApi.createJournal({
			tag,
			users: [
				{username: 'dbarnes', roles: ['manager', 'editor']},
				{username: 'rvaca', roles: ['author']},
				{username: 'jjanssen', roles: ['reviewer']},
			],
		});
		// jjanssen accepted → her wizard resumes on step 2 (Guidelines).
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				journal: context.path,
				reviewers: [
					{user: 'jjanssen', method: 'anonymous', status: 'accepted'},
				],
			}),
		);

		let guidancePanel = await openReviewerGuidance(page, context.path);
		await setTinyMceContent(
			page,
			'reviewerGuidance-reviewGuidelines-control-en',
			`<p>${guidelines}</p>`,
		);
		await setTinyMceContent(
			page,
			'reviewerGuidance-competingInterests-control-en',
			`<p>${ciPolicy}</p>`,
		);
		await saveSettingsForm(page, guidancePanel);

		// Persistence after a full reload.
		guidancePanel = await openReviewerGuidance(page, context.path);
		expect(
			await getTinyMceContent(
				page,
				'reviewerGuidance-reviewGuidelines-control-en',
			),
		).toContain(guidelines);
		expect(
			await getTinyMceContent(
				page,
				'reviewerGuidance-competingInterests-control-en',
			),
		).toContain(ciPolicy);

		// Reviewer side: the Guidelines step shows the custom text.
		const reviewerCtx = await asUser('jjanssen');
		const reviewerPage = await reviewerCtx.newPage();
		const reviewer = new ReviewerSubmissionPage(reviewerPage);
		await reviewer.goto(submission.id, {journalPath: context.path});
		await expect(reviewer.step2Form).toBeVisible({timeout: 15_000});
		await expect(reviewer.step2Form).toContainText(guidelines);

		// ... and step 1 renders the competing-interest declaration
		// (radio pair), which only mounts when the context has a
		// competingInterests disclosure configured.
		await reviewerPage
			.getByRole('link', {name: '1. Request', exact: true})
			.click();
		await expect(reviewer.step1Form).toBeVisible({timeout: 15_000});
		await expect(
			reviewer.step1Form.locator('input[name="competingInterestOption"]'),
		).toHaveCount(2);
	});

	test('reviewer-suggestions toggle gates the submission wizard step', {tag: '@regression'}, async ({page, pkpApi}) => {
		// Row 4. reviewerSuggestionEnabled is unset on a scratch journal;
		// enabling it adds the Reviewer Suggestions step to the wizard's
		// rail, disabling it removes the step again — two wizard starts
		// on the same scratch journal (drafts; never submitted). This
		// plan owns the toggle round-trip incl. the no-step assertion;
		// suggestion content flows live in reviewer-suggestions.spec.js.
		const tag = uniqueTag('rvs4');
		const {context} = await pkpApi.createJournal({
			tag,
			users: [{username: 'dbarnes', roles: ['manager', 'editor']}],
		});
		const suggestionsCheckbox = (panel) =>
			panel.locator('input[name="reviewerSuggestionEnabled"]');
		const railLabels = page.locator('.pkpSteps__step__label');

		// Enable + persistence check.
		let reviewSetup = await openReviewSetup(page, context.path);
		await expect(suggestionsCheckbox(reviewSetup)).not.toBeChecked();
		await suggestionsCheckbox(reviewSetup).check({force: true});
		await saveSettingsForm(page, reviewSetup);
		reviewSetup = await openReviewSetup(page, context.path);
		await expect(suggestionsCheckbox(reviewSetup)).toBeChecked();

		// ON → the wizard rail includes the Suggest Reviewers step.
		const wizard = new SubmissionWizardPage(page, context.path);
		await wizard.goto();
		await wizard.start({title: `Suggestions on ${tag}`});
		await expect(railLabels.first()).toBeVisible({timeout: 15_000});
		await expect(
			railLabels.filter({hasText: 'Reviewer Suggestions'}),
		).toHaveCount(1);

		// Disable, then start a second submission: the step is absent.
		reviewSetup = await openReviewSetup(page, context.path);
		await suggestionsCheckbox(reviewSetup).uncheck({force: true});
		await saveSettingsForm(page, reviewSetup);

		await wizard.goto();
		await wizard.start({title: `Suggestions off ${tag}`});
		await expect(railLabels.first()).toBeVisible({timeout: 15_000});
		await expect(
			railLabels.filter({hasText: 'Reviewer Suggestions'}),
		).toHaveCount(0);
	});
});
