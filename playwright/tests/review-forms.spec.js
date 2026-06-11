// @ts-check
const {test, expect} = require('../support/base-test.js');
const {ReviewFormSettingsPage} = require('../pages/ReviewFormSettingsPage.js');
const {ReviewerManagerPage} = require('../pages/ReviewerManagerPage.js');
const {ReviewerSubmissionPage} = require('../pages/ReviewerSubmissionPage.js');
const {waitForJQueryIdle} = require('../support/jquery.js');
const submissionInReview = require('../../../../playwright/fixtures/scenarios/submission-in-review.js');

/**
 * Review forms — docs/e2e/plans/review-forms.md (6 rows).
 *
 * Review forms are journal-level settings (Settings > Workflow >
 * Review > Review Forms legacy grid), so EVERY row runs on an E0
 * scratch journal (charter principle 1 — publicknowledge stays
 * read-only). Rows 2–6 seed their pre-existing forms through the
 * context scenario's `reviewForms[]` and (rows 4–6) attach them to the
 * seeded assignment via the submission scenario's per-reviewer
 * `reviewForm: "<title>"` key; only the behavior under test drives the
 * UI.
 *
 * Legacy-stack notes baked into the assertions:
 *  - New/copied forms start INACTIVE (ReviewFormForm/copyReviewForm
 *    parity); only active forms are offered in the Add Reviewer / Edit
 *    Review dropdowns (ReviewFormDAO::getActiveByAssocId).
 *  - A copy keeps the original's title — the duplicate is told apart
 *    by its new grid-row DOM id and its unchecked Active checkbox.
 *  - `canEdit` (Edit/Delete row actions + enabled edit tabs) requires
 *    zero complete AND zero incomplete assignments referencing the
 *    form; ANY undeclined assignment (even merely invited/accepted)
 *    counts as incomplete (ReviewFormDAO complete_count /
 *    incomplete_count subselects).
 *  - Required gating on the reviewer wizard is client-side end to end:
 *    free-text elements carry the HTML5 `required` attribute
 *    (jquery-validate attributeRules), and
 *    js/pages/reviewer/reviewStep3Required.js patches the validator to
 *    add a required rule per `fieldset[aria-required]` radio/checkbox
 *    group (placing the inline error inside the fieldset) and to show
 *    the #reviewStep3MessageBox error box, whose title IS the
 *    reviewer.submission.reviewFormResponse.form.responseRequired
 *    message ("Please fill in required fields."). A gated attempt
 *    never reaches saveStep — PKPReviewerReviewStep3Form's server-side
 *    responseRequired validator stays as a JS-off backstop — so the
 *    typed responses survive the rejected attempt.
 *
 * No Mailpit assertions in this spec; UI-triggered mail (review
 * request / review complete) is left untouched for other specs'
 * recipient+tag-scoped reads (charter principle 8).
 */

/** Worker-scoped unique tag — journals.urlPath is varchar(32). */
function uniqueTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

/**
 * The standard scratch-journal cast for rows that also run a
 * submission: dbarnes manages settings AND acts as the assigned
 * editor; rvaca submits; jjanssen reviews.
 */
function workflowUsers() {
	return [
		{username: 'dbarnes', roles: ['manager', 'editor']},
		{username: 'rvaca', roles: ['author']},
		{username: 'jjanssen', roles: ['reviewer']},
	];
}

test.use({user: 'dbarnes'});

test.describe('Review forms', () => {
	// Row 1
	test('manager creates a review form with elements and previews it', {tag: ['@regression', '@slow']}, async ({page, pkpApi}) => {
		// Create-form modal + two element modals (one with a listbuilder
		// round-trip per option) + three AJAX tab loads — give the legacy
		// stack the slow budget under parallel load.
		test.slow();
		const tag = uniqueTag('rf1');
		const {context} = await pkpApi.createJournal({
			tag,
			users: [{username: 'dbarnes', roles: ['manager']}],
		});

		const formTitle = `Quality Rubric ${tag}`;
		const formDescription = `Assess the manuscript against this rubric ${tag}`;
		const textQuestion = `How sound is the methodology? ${tag}`;
		const radioQuestion = `Overall verdict ${tag}`;
		const radioOptions = ['Strong contribution', 'Needs more work'];

		const settings = new ReviewFormSettingsPage(page);
		await settings.goto(context.path);

		// Create the form (title + description). ReviewFormForm parity:
		// the new row lands at the bottom of the grid, inactive.
		const createForm = await settings.openCreateForm();
		await settings.fillFormBasics(createForm, {
			title: formTitle,
			description: formDescription,
		});
		await settings.saveAjaxForm(createForm);
		await expect(settings.rows(formTitle)).toHaveCount(1, {timeout: 15_000});
		const [rowId] = await settings.rowIds(formTitle);
		await expect(settings.activeCheckbox(rowId)).not.toBeChecked();

		// Add elements through the Form Items grid: a required extended
		// text box and a radio-buttons item with two listbuilder options.
		const tabs = await settings.openEditModal(rowId);
		await settings.openFormItemsTab(tabs);
		await settings.addElement({
			question: textQuestion,
			typeLabel: 'Extended text box',
			required: true,
		});
		await settings.addElement({
			question: radioQuestion,
			typeLabel: 'Radio buttons (you can only choose one)',
			options: radioOptions,
		});

		// Preview renders the assembled form: title heading, description,
		// both questions, a free-text textarea and one radio per option.
		const preview = await settings.openPreviewTab(tabs);
		await expect(
			preview.getByRole('heading', {name: formTitle}),
		).toBeVisible();
		await expect(preview.getByText(formDescription)).toBeVisible();
		await expect(preview.getByText(textQuestion)).toBeVisible();
		await expect(preview.getByText(radioQuestion)).toBeVisible();
		await expect(
			preview.locator('textarea[name^="reviewFormResponses"]'),
		).toBeVisible();
		await expect(
			preview.locator('input[type="radio"][name^="reviewFormResponses"]'),
		).toHaveCount(radioOptions.length);
		for (const option of radioOptions) {
			await expect(preview.getByText(option)).toBeVisible();
		}

		// Activate from the grid (a fresh page load sidesteps closing the
		// stacked edit modal); the checkbox state flips after the
		// row refresh — the gate that makes the form assignable.
		await settings.goto(context.path);
		await settings.toggleActive(rowId);
		await expect(settings.activeCheckbox(rowId)).toBeChecked({
			timeout: 15_000,
		});
	});

	// Row 2
	test('copy, deactivate and delete review forms; deactivated form not offered at assignment', {tag: ['@regression', '@slow']}, async ({page, pkpApi}) => {
		// Three confirm round-trips on the grid plus a workflow page +
		// Add Reviewer modal load.
		test.slow();
		const tag = uniqueTag('rf2');
		const titleA = `Alpha ${tag}`;
		const titleB = `Beta ${tag}`;
		const {context} = await pkpApi.createJournal({
			tag,
			users: workflowUsers(),
			reviewForms: [
				{
					title: titleA,
					elements: [
						{type: 'textarea', question: `Alpha question ${tag}`, required: true},
					],
				},
				{
					title: titleB,
					elements: [
						{type: 'textarea', question: `Beta question ${tag}`},
					],
				},
			],
		});
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({tag, journal: context.path, reviewers: []}),
		);

		const settings = new ReviewFormSettingsPage(page);
		await settings.goto(context.path);

		// --- Copy: the duplicate keeps the title but starts inactive
		// and (being unused) carries Edit + Delete actions.
		const [originalId] = await settings.rowIds(titleA);
		await settings.clickRowAction(originalId, 'copy');
		await settings.confirmOk();
		await expect(settings.rows(titleA)).toHaveCount(2, {timeout: 15_000});
		const copyId = (await settings.rowIds(titleA)).find(
			(id) => id !== originalId,
		);
		if (!copyId) throw new Error('copied review form row not found');
		await expect(settings.activeCheckbox(originalId)).toBeChecked();
		await expect(settings.activeCheckbox(copyId)).not.toBeChecked();
		await settings.expandRowExtras(copyId);
		await expect(settings.rowActionLink(copyId, 'edit').first()).toBeVisible();
		await expect(
			settings.rowActionLink(copyId, 'delete').first(),
		).toBeVisible();

		// --- Deactivate the original (Active checkbox → confirm).
		await settings.toggleActive(originalId);
		await expect(settings.activeCheckbox(originalId)).not.toBeChecked({
			timeout: 15_000,
		});

		// --- Delete the unused copy.
		await settings.clickRowAction(copyId, 'delete');
		await settings.confirmOk();
		await expect(settings.rows(titleA)).toHaveCount(1, {timeout: 15_000});

		// --- The Add Reviewer modal's review-form dropdown offers only
		// active forms: Beta remains, the deactivated Alpha is gone
		// (bounded negative — same select).
		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id, {journalPath: context.path});
		const modal = await rm.openAddReviewerModal();
		const assignForm = await rm.selectReviewer(modal, 'Julie Janssen');
		const reviewFormSelect = assignForm.locator('select[name="reviewFormId"]');
		await expect(reviewFormSelect).toBeVisible({timeout: 15_000});
		await expect(
			reviewFormSelect.locator('option', {hasText: titleB}),
		).toHaveCount(1);
		await expect(
			reviewFormSelect.locator('option', {hasText: titleA}),
		).toHaveCount(0);
		await expect(
			reviewFormSelect.locator('option', {
				hasText: 'None / Free Form Review',
			}),
		).toHaveCount(1);
	});

	// Row 3
	test('editor attaches a review form when assigning a reviewer and can switch it later', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('rf3');
		const titleA = `Alpha ${tag}`;
		const titleB = `Beta ${tag}`;
		const {context, reviewForms} = await pkpApi.createJournal({
			tag,
			users: workflowUsers(),
			reviewForms: [
				{
					title: titleA,
					elements: [{type: 'textarea', question: `Alpha question ${tag}`}],
				},
				{
					title: titleB,
					elements: [{type: 'textarea', question: `Beta question ${tag}`}],
				},
			],
		});
		const formA = reviewForms.find((f) => f.title === titleA);
		const formB = reviewForms.find((f) => f.title === titleB);
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({tag, journal: context.path, reviewers: []}),
		);

		// Assign jjanssen with form Alpha picked in the Add Reviewer
		// modal's review-form select (reviewerFormFooter.tpl — rendered
		// only because the journal has active forms).
		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id, {journalPath: context.path});
		const addModal = await rm.openAddReviewerModal();
		const assignForm = await rm.selectReviewer(addModal, 'Julie Janssen');
		await assignForm
			.locator('select[name="reviewFormId"]')
			.selectOption({label: titleA});
		await rm.ensureDueDatesOrdered(assignForm);
		await rm.submitLegacyForm(assignForm, 'Add Reviewer', addModal);
		await expect(rm.manager).toContainText('Julie Janssen', {
			timeout: 15_000,
		});

		// Edit Review shows the stored form and lets the editor switch it
		// while the review is incomplete (EditReviewForm::execute writes
		// the validated reviewFormId onto the assignment).
		let editModal = await rm.openRowAction(
			'Julie Janssen',
			'Edit',
			'Edit Review',
		);
		let editForm = await rm.legacyForm(editModal, 'editReviewForm');
		await expect(editForm.locator('select[name="reviewFormId"]')).toHaveValue(
			String(formA.id),
		);
		await editForm
			.locator('select[name="reviewFormId"]')
			.selectOption({label: titleB});
		await rm.submitLegacyForm(editForm, 'OK', editModal);
		await waitForJQueryIdle(page);

		// Reopen: the switch persisted.
		editModal = await rm.openRowAction('Julie Janssen', 'Edit', 'Edit Review');
		editForm = await rm.legacyForm(editModal, 'editReviewForm');
		await expect(editForm.locator('select[name="reviewFormId"]')).toHaveValue(
			String(formB.id),
		);
	});

	// Row 4
	test('reviewer fills the review form; required elements gate submission', {tag: ['@regression', '@slow']}, async ({pkpApi, asUser}) => {
		// Three submit attempts (one client-gated, one server-gated, one
		// successful) on the legacy wizard.
		test.slow();
		const tag = uniqueTag('rf4');
		const formTitle = `Gated Rubric ${tag}`;
		const textQuestion = `Methodology assessment ${tag}`;
		const radioQuestion = `Verdict ${tag}`;
		const {context, reviewForms} = await pkpApi.createJournal({
			tag,
			users: workflowUsers(),
			reviewForms: [
				{
					title: formTitle,
					elements: [
						{type: 'textarea', question: textQuestion, required: true},
						{
							type: 'radiobuttons',
							question: radioQuestion,
							required: true,
							options: ['Sound', 'Unsound'],
						},
					],
				},
			],
		});
		const [textElementId, radioElementId] = reviewForms[0].elementIds;
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				journal: context.path,
				reviewers: [
					{
						user: 'jjanssen',
						method: 'anonymous',
						status: 'accepted',
						reviewForm: formTitle,
					},
				],
			}),
		);

		// Accepted reviewers resume on step 2; step 3 renders the review
		// form elements INSTEAD of the free-text comment editors.
		const reviewerCtx = await asUser('jjanssen');
		const reviewerPage = await reviewerCtx.newPage();
		const reviewer = new ReviewerSubmissionPage(reviewerPage);
		await reviewer.goto(submission.id, {journalPath: context.path});
		await reviewer.continueToStep3();
		await expect(
			reviewer.step3Form.getByRole('heading', {name: formTitle}),
		).toBeVisible({timeout: 15_000});
		await expect(reviewer.step3Form.getByText(textQuestion)).toBeVisible();
		await expect(reviewer.step3Form.getByText(radioQuestion)).toBeVisible();
		await expect(
			reviewer.step3Form.locator('textarea[id^="comments-"]'),
		).toHaveCount(0);

		// Attempt 1 — everything empty. jquery-validate blocks the submit
		// client-side: inline "This field is required." on the required
		// textarea plus the message box carrying the responseRequired
		// message. No saveStep request fires; the wizard stays on step 3.
		await reviewer.attemptSubmitReview();
		await expect(
			reviewer.step3Form.getByText('This field is required.').first(),
		).toBeVisible({timeout: 10_000});
		await expect(
			reviewer.step3Form.getByText('Please fill in required fields.'),
		).toBeVisible();
		await expect(
			reviewer.step3Form.getByText(
				'Some required fields are not filled in',
				{exact: false},
			),
		).toBeVisible();
		await expect(reviewer.completedHeading).toHaveCount(0);

		// Attempt 2 — text + recommendation filled, required radio still
		// empty. reviewStep3Required.js gives the radio group its own
		// required rule and parks the error inside the group's fieldset;
		// the gate is still client-side, so the typed answer survives.
		const answer = `The methodology is sound. ${tag}`;
		await reviewer.reviewFormTextResponse(textElementId).fill(answer);
		await reviewer.selectRecommendation('Revisions Required');
		await reviewer.attemptSubmitReview();
		await expect(
			reviewer.step3Form
				.locator(`fieldset#reviewFormResponses-${radioElementId}`)
				.getByText('This field is required.'),
		).toBeVisible({timeout: 10_000});
		await expect(reviewer.completedHeading).toHaveCount(0);
		await expect(reviewer.reviewFormTextResponse(textElementId)).toHaveValue(
			answer,
		);

		// Attempt 3 — both required elements filled: the review submits
		// and completes. Reload first: after two validation-rejected
		// confirm cycles the legacy Submit button's confirmation modal
		// stops opening (LinkActionHandler/ButtonConfirmationModal
		// re-arm defect — reported in the wave ledger notes; a real
		// user recovers the same way). Responses were client-side only,
		// so re-enter them; the wizard reopens directly on step 3
		// (step already advanced by the step-2 save).
		await reviewerPage.reload();
		await expect(reviewer.step3Form).toBeVisible({timeout: 15_000});
		await reviewer.reviewFormTextResponse(textElementId).fill(answer);
		await reviewer.checkReviewFormOption(radioElementId, 0);
		await reviewer.selectRecommendation('Revisions Required');
		await reviewer.submitReview();
	});

	// Row 5
	test('editor reads submitted review-form responses', {tag: '@regression'}, async ({page, pkpApi, asUser}) => {
		const tag = uniqueTag('rf5');
		const formTitle = `Readback Rubric ${tag}`;
		const textQuestion = `Strengths and weaknesses ${tag}`;
		const radioQuestion = `Verdict ${tag}`;
		const radioOptions = ['Accept as is', 'Revise first'];
		const {context, reviewForms} = await pkpApi.createJournal({
			tag,
			users: workflowUsers(),
			reviewForms: [
				{
					title: formTitle,
					elements: [
						{type: 'textarea', question: textQuestion, required: true},
						{
							type: 'radiobuttons',
							question: radioQuestion,
							options: radioOptions,
						},
					],
				},
			],
		});
		const [textElementId, radioElementId] = reviewForms[0].elementIds;
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				journal: context.path,
				reviewers: [
					{
						user: 'jjanssen',
						method: 'anonymous',
						status: 'accepted',
						reviewForm: formTitle,
					},
				],
			}),
		);

		// Reviewer fills the form and submits with a recommendation.
		const answer = `Strong core idea, thin evaluation. ${tag}`;
		const pickedOption = 1; // 'Revise first'
		const reviewerCtx = await asUser('jjanssen');
		const reviewerPage = await reviewerCtx.newPage();
		const reviewer = new ReviewerSubmissionPage(reviewerPage);
		await reviewer.goto(submission.id, {journalPath: context.path});
		await reviewer.continueToStep3();
		await reviewer.reviewFormTextResponse(textElementId).fill(answer);
		await reviewer.checkReviewFormOption(radioElementId, pickedOption);
		await reviewer.selectRecommendation('Revisions Required');
		await reviewer.submitReview();

		// Editor's Read Review modal renders the responses read-only:
		// each question with the reviewer's value, plus the
		// recommendation line (readReview.tpl includes
		// reviewFormResponse.tpl with disabled=true).
		const rm = new ReviewerManagerPage(page);
		await rm.gotoWorkflow(submission.id, {journalPath: context.path});
		const row = rm.row('Julie Janssen');
		await expect(row).toContainText('Review Submitted', {timeout: 20_000});
		await row.getByRole('button', {name: 'Read Review', exact: true}).click();

		const readForm = page.locator('form#readReviewForm').last();
		await expect(readForm).toBeVisible({timeout: 15_000});
		await expect(readForm).toContainText(
			'Recommendation: Revisions Required',
		);
		await expect(readForm.getByText(textQuestion)).toBeVisible();
		await expect(readForm.getByText(radioQuestion)).toBeVisible();
		await expect(
			readForm.locator(`textarea[name="reviewFormResponses[${textElementId}]"]`),
		).toHaveValue(answer);
		const pickedRadio = readForm.locator(
			`input#reviewFormResponses-${radioElementId}-${pickedOption}`,
		);
		await expect(pickedRadio).toBeChecked();
		await expect(pickedRadio).toBeDisabled();
		// The unpicked option stayed unchecked — the modal shows the
		// reviewer's actual selection, not just any.
		await expect(
			readForm.locator(`input#reviewFormResponses-${radioElementId}-0`),
		).not.toBeChecked();
	});

	// Row 6
	test('a review form in use is locked in the manager grid', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('rf6');
		const titleInUse = `Locked ${tag}`;
		const titleUnused = `Spare ${tag}`;
		const {context} = await pkpApi.createJournal({
			tag,
			users: workflowUsers(),
			reviewForms: [
				{
					title: titleInUse,
					elements: [{type: 'textarea', question: `Locked question ${tag}`}],
				},
				{
					title: titleUnused,
					elements: [{type: 'textarea', question: `Spare question ${tag}`}],
				},
			],
		});
		// An accepted (not yet completed) assignment referencing the form
		// counts as incomplete (date_completed IS NULL, not declined) —
		// enough to flip canEdit off.
		await pkpApi.createSubmission(
			submissionInReview({
				tag,
				journal: context.path,
				reviewers: [
					{
						user: 'jjanssen',
						method: 'anonymous',
						status: 'accepted',
						reviewForm: titleInUse,
					},
				],
			}),
		);

		const settings = new ReviewFormSettingsPage(page);
		await settings.goto(context.path);

		// In-use form: "In Review" column counts the incomplete
		// assignment; Edit and Delete are withheld while Copy and
		// Preview remain.
		const [inUseRowId] = await settings.rowIds(titleInUse);
		await expect(
			settings.rowById(inUseRowId).locator('td').nth(1),
		).toHaveText('1');
		await settings.expandRowExtras(inUseRowId);
		await expect(
			settings.rowActionLink(inUseRowId, 'copy').first(),
		).toBeVisible();
		await expect(
			settings.rowActionLink(inUseRowId, 'preview').first(),
		).toBeVisible();
		await expect(settings.rowActionLink(inUseRowId, 'edit')).toHaveCount(0);
		await expect(settings.rowActionLink(inUseRowId, 'delete')).toHaveCount(0);

		// The unused form keeps its full action set.
		const [unusedRowId] = await settings.rowIds(titleUnused);
		await expect(
			settings.rowById(unusedRowId).locator('td').nth(1),
		).toHaveText('0');
		await settings.expandRowExtras(unusedRowId);
		await expect(
			settings.rowActionLink(unusedRowId, 'edit').first(),
		).toBeVisible();
		await expect(
			settings.rowActionLink(unusedRowId, 'delete').first(),
		).toBeVisible();
		await expect(
			settings.rowActionLink(unusedRowId, 'copy').first(),
		).toBeVisible();
		await expect(
			settings.rowActionLink(unusedRowId, 'preview').first(),
		).toBeVisible();
	});
});
