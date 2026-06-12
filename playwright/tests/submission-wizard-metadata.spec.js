// @ts-check
const path = require('path');
const {test, expect} = require('../support/base-test.js');
const {SubmissionWizardPage} = require('../pages/SubmissionWizardPage.js');

/**
 * Submission wizard — metadata
 * Plan: docs/e2e/plans/submission-wizard-metadata.md (13 rows)
 *
 * Absorbs (relocated + refit): playwright/tests/wizard-config-reset.spec.js
 * — all 4 tests, behavior-identical, backing rows 5–8 (test 1 "keywords
 * Require → required marker" → row 5; test 2 "keywords Do-not-ask removed"
 * → row 7; test 3 "subjects Require in For-the-Editors" → row 8; test 4
 * "missing required keyword surfaces a validation error in Review" →
 * row 6). The spec moved from playwright/tests/ to lib/pkp/playwright/
 * because the plan's placement is lib/pkp: every surface it touches
 * (PKPMetadataSettingsForm, FieldMetadataSetting.vue, the wizard's
 * Details/ForTheEditors forms and review panels) is shared across
 * OJS/OMP/OPS — the original placement note only pointed at the OJS URL
 * prefix, which other lib/pkp specs already use freely. The only refit
 * beyond imports: bare `continueStep()` chains became `continueTo()`
 * (click + arrival check) — under parallel load a footer Continue click
 * can be swallowed by a re-render, the same failure mode gotoStep()
 * documents for rail pills. Assertions are unchanged.
 *
 * Rows implemented here beyond the absorbed four:
 *   1  keywords entry on the publicknowledge request-on default
 *   2  citations entry on the request-on default
 *   3  categories selection persists (nested breadcrumb on Review)
 *   4  categories config gate (submitWithCategories × category count)
 *   9  disciplines/agencies/coverage/type request-on via the settings UI
 *   11 vanilla journal: For-the-Editors shows only the comments form
 *   12 citations Require blocks at Review until references are provided
 *   13 request mode never blocks submit
 * Row 10 (data availability) stays in data-availability.spec.js.
 *
 * The metadata request/require flags are flipped through the Workflow →
 * Submission → Metadata settings form on scratch journals — deliberately
 * NOT a context-scenario passthrough, so the settings UI doubles as
 * coverage of the config surface (see the plan's Scenario needs note).
 *
 * publicknowledge runs the enriched bootstrap defaults relevant here:
 * keywords + citations 'request', submitWithCategories on with a nested
 * category tree, reviewerSuggestionEnabled (so its wizard has 6 steps;
 * scratch journals have 5).
 */

// Bundled fixture — same PDF the SubmissionBuilderProcessor attaches.
const ARTICLE_FIXTURE = path.resolve(
	__dirname,
	'..',
	'fixtures',
	'files',
	'default-article.pdf',
);

function uniqueTag() {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `swm-w${workerIndex}-${suffix}`;
}

/**
 * Navigate to the workflow settings page, activate the Submission tab +
 * Metadata sub-tab. The page uses nested `<tabs>` — outer tabs switch
 * between "Submission" / "Review" / "Library" / "Emails" / ..., and the
 * inner side-tabs under "Submission" switch between "Disable Submissions" /
 * "Instructions" / "Metadata" / "Components" / "Contributor Roles".
 *
 * Both outer + inner tab triggers carry id hooks of the form
 * `#{name}-button` (PkpTabs convention), so #submission-button opens the
 * outer tab and #metadata-button opens the inner one.
 */
async function openMetadataSettingsTab(page, journalPath) {
	await page.goto(`/index.php/${journalPath}/management/settings/workflow`);
	// Outer tab: Submission (the default, but click to make the state
	// deterministic — some runs land on a cached tab-history state).
	await page.locator('#submission-button').click();
	// Inner tab: Metadata.
	await page.locator('#metadata-button').click();
	// The Metadata form mounts a fieldset legend per field. Waiting for
	// the unique "Enable keyword metadata" label guarantees the form has
	// hydrated.
	await expect(
		page.locator('label', {hasText: 'Enable keyword metadata'}),
	).toBeVisible({timeout: 15_000});
}

/**
 * Save the Metadata settings form (the one containing `anchor`). The
 * form is a shared `<pkp-form>` — its Save button is the footer "Save"
 * whose click triggers a PUT on the context endpoint via
 * X-Http-Method-Override. Race the click with a waitForResponse on the
 * context PUT to know the round-trip is done.
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} anchor an element inside the form
 */
async function saveMetadataSettings(page, anchor) {
	const form = page.locator('form', {has: anchor});
	await Promise.all([
		page.waitForResponse(
			(res) =>
				res.request().method() === 'POST' &&
				/\/api\/v1\/contexts\/\d+/.test(res.url()) &&
				res.ok(),
			{timeout: 15_000},
		),
		form.getByRole('button', {name: 'Save', exact: true}).click(),
	]);
}

/**
 * Set a metadata field's mode on the open Metadata form. Each metadata
 * field is rendered by the same FieldMetadataSetting.vue, so the helper
 * scopes to the field's fieldset by its uniquely-named "Enable …
 * metadata" checkbox label and otherwise treats every field
 * identically.
 *
 * FieldMetadataSetting.vue renders as two layers: (a) an "Enable"
 * checkbox whose state is bound to isEnabled, and (b) a radio group of
 * submissionOptions (noRequest / request / require) that only appears
 * when isEnabled is true. Toggling the checkbox OFF sets value to the
 * disabledValue (METADATA_DISABLE = 0); toggling it ON sets value to
 * the enabledOnlyValue (METADATA_ENABLE = "enable"); picking a radio
 * sets value to the corresponding submissionOption.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Object} field                     Metadata field descriptor.
 * @param {string} field.enableLabel         The "Enable …" checkbox label
 *                                            text — uniquely identifies the
 *                                            field's fieldset on the form
 *                                            (e.g. "Enable keyword metadata").
 * @param {RegExp} [field.requestLabel]      Regex matching the field's
 *                                            "Ask the author …" radio label.
 * @param {RegExp} [field.requireLabel]      Regex matching the field's
 *                                            "Require the author …" radio
 *                                            label text.
 * @param {'request' | 'require' | 'disable'} mode
 * @param {{save?: boolean}} [opts]          save: false batches several
 *                                            field flips into one Save.
 */
async function setMetadataFieldMode(
	page,
	{enableLabel, requestLabel, requireLabel},
	mode,
	{save = true} = {},
) {
	const fieldset = page.locator('fieldset.pkpFormField--metadata', {
		has: page.locator('label', {hasText: enableLabel}),
	});
	await expect(fieldset).toBeVisible();

	const enableCheckbox = fieldset
		.locator('input.pkpFormField--options__input[type="checkbox"]')
		.first();

	if (mode === 'disable') {
		// Schema defaults vary by field — keywords ships request,
		// subjects ships noRequest (i.e. disabled). Only flip if
		// currently enabled.
		if (await enableCheckbox.isChecked()) {
			await enableCheckbox.uncheck();
		}
	} else if (mode === 'require' || mode === 'request') {
		// Make sure the field is enabled so the submissionOptions
		// radios render. (FieldMetadataSetting.vue keeps the radios
		// unmounted when isEnabled is false.)
		if (!(await enableCheckbox.isChecked())) {
			await enableCheckbox.check();
		}
		const radioLabel = mode === 'require' ? requireLabel : requestLabel;
		if (!radioLabel) {
			throw new Error(`No ${mode} radio label configured for this field`);
		}
		const target = fieldset.locator('label', {hasText: radioLabel});
		await expect(target).toBeVisible();
		await target.click();
	} else {
		throw new Error(`Unknown mode: ${mode}`);
	}

	if (save) {
		await saveMetadataSettings(page, fieldset);
	}
}

// Field descriptors for the Metadata settings form. Labels verified
// against lib/pkp/locale/en/manager.po.
const KEYWORDS = {
	enableLabel: 'Enable keyword metadata',
	requestLabel: /Ask the author to suggest keywords/,
	requireLabel: /Require the author to suggest keywords/,
};
const SUBJECTS = {
	enableLabel: 'Enable subject metadata',
	requireLabel: /Require the author to provide subjects/,
};
const CITATIONS = {
	enableLabel: 'Enable references metadata',
	requestLabel: /Ask the author to provide references/,
	requireLabel: /Require the author to provide references/,
};
const DISCIPLINES = {
	enableLabel: 'Enable disciplines metadata',
	requestLabel: /Ask the author to provide disciplines/,
};
const AGENCIES = {
	enableLabel: 'Enable supporting agencies metadata',
	requestLabel: /Ask the author to disclose any supporting agencies/,
};
const COVERAGE = {
	enableLabel: 'Enable coverage metadata',
	requestLabel: /Ask the author to suggest coverage metadata/,
};
const TYPE = {
	enableLabel: 'Enable type metadata',
	requestLabel: /Ask the author to provide the type/,
};

/**
 * Click the footer Continue button and verify the wizard actually
 * arrived on `stepName`, retrying the click once. Under parallel load a
 * Continue click can be swallowed while the footer re-renders — the
 * same failure mode SubmissionWizardPage#gotoStep documents (and
 * retries) for the Steps-rail pills. Step transitions are client-side
 * (openStep just swaps currentStepId), so a registered click reflects
 * in the rail within milliseconds; a 10s arrival window cleanly
 * separates "slow render" from "swallowed click".
 *
 * @param {SubmissionWizardPage} wizard
 * @param {string} stepName step expected AFTER the click, e.g. 'Details'
 */
async function continueTo(wizard, stepName) {
	for (let attempt = 0; ; attempt++) {
		await wizard.continueStep();
		try {
			await wizard.expectStep(stepName, {timeout: 10_000});
			return;
		} catch (err) {
			if (attempt >= 1) {
				throw err;
			}
		}
	}
}

/**
 * Commit one entry into a FieldControlledVocab autosuggest (type +
 * Enter), then wait for its removable chip — the deterministic signal
 * the entry registered client-side.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} controlId e.g. 'titleAbstract-keywords-control-en'
 * @param {string} term
 */
async function addVocabEntry(page, controlId, term) {
	const input = page.locator(`#${controlId}`);
	await expect(input).toBeVisible({timeout: 15_000});
	await input.fill(term);
	await input.press('Enter');
	await expect(page.getByRole('button', {name: `Remove ${term}`})).toBeVisible({
		timeout: 10_000,
	});
}

/**
 * Fetch the submission's current publication via REST (with the page's
 * session). Used with expect.poll to anchor "the wizard's autosave has
 * landed" deterministically — the wizard queues autosaves on step
 * changes AND on a 60-second idle timer, so waiting for a specific
 * response can miss a save that already happened; polling the stored
 * state can't. (Same pattern as submission-wizard-validation.spec.js.)
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} submissionId
 * @param {string} [journalPath='publicknowledge']
 * @returns {Promise<any|null>} the publication, or null while unavailable
 */
async function fetchCurrentPublication(
	page,
	submissionId,
	journalPath = 'publicknowledge',
) {
	const subRes = await page.request.get(
		`/index.php/${journalPath}/api/v1/submissions/${submissionId}`,
	);
	if (!subRes.ok()) return null;
	const sub = await subRes.json();
	if (!sub.currentPublicationId) return null;
	const pubRes = await page.request.get(
		`/index.php/${journalPath}/api/v1/submissions/${submissionId}/publications/${sub.currentPublicationId}`,
	);
	if (!pubRes.ok()) return null;
	return await pubRes.json();
}

/** Controlled-vocab values round-trip as `{name}` objects — flatten. */
function vocabNames(entries) {
	return (entries ?? []).map((k) => (typeof k === 'string' ? k : k?.name));
}

/**
 * Footer Submit button — scoped to the wizard footer so no stray
 * "Submit" match elsewhere in the page chrome wins.
 *
 * @param {import('@playwright/test').Page} page
 */
function footerSubmitButton(page) {
	return page
		.locator('.submissionWizard__footer')
		.getByRole('button', {name: 'Submit'});
}

/**
 * Click Submit + confirm the modal, then wait for the "Submission
 * complete" page. Inline (rather than POM submit()) so we can scroll
 * the button into view first — the Review panel layout shifts while
 * the Confirmation block hydrates and the click can otherwise race
 * element stability.
 *
 * @param {import('@playwright/test').Page} page
 */
async function submitWizard(page) {
	const submitBtn = footerSubmitButton(page);
	await expect(submitBtn).toBeVisible({timeout: 15_000});
	await submitBtn.scrollIntoViewIfNeeded();
	await expect(submitBtn).toBeEnabled({timeout: 15_000});
	await submitBtn.click();
	const confirmDialog = page.getByRole('dialog');
	await expect(confirmDialog).toBeVisible({timeout: 10_000});
	await confirmDialog.getByRole('button', {name: 'Submit', exact: true}).click();
	await expect(
		page.getByRole('heading', {name: 'Submission complete'}),
	).toBeVisible({timeout: 30_000});
}

/**
 * Locate one review-panel item by its h4 header inside a review panel.
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} panel from wizard.reviewPanel()
 * @param {string} header the item's visible header, e.g. 'Keywords'
 */
function reviewItem(page, panel, header) {
	return panel
		.locator('.submissionWizard__reviewPanel__item')
		.filter({has: page.getByRole('heading', {name: header, exact: true})});
}

// ---------------------------------------------------------------------------

test.describe('Submission wizard — metadata', () => {
	// Rows 1–3 + 13: the publicknowledge request-on defaults, driven as
	// the baseline author. Drafts are seeded with `submitted: false` so
	// each test starts inside its own resumable wizard.
	test.describe('request-on defaults as author on publicknowledge', () => {
		test.use({user: 'atester'});

		/** Minimal resumable-draft spec on publicknowledge. */
		function draftSpec({tag, title, abstract}) {
			return {
				tag,
				journal: 'publicknowledge',
				submitter: 'atester',
				section: 'ART',
				locale: 'en',
				submitted: false,
				publications: [
					{
						metadata: {
							title: {en: title},
							...(abstract ? {abstract: {en: abstract}} : {}),
						},
					},
				],
			};
		}

		// Row 1 — Keywords entry (request-on default). The seeded draft
		// carries an abstract + genre-resolved Article Text file so the
		// final submit has no other gate; keywords are the only surface
		// this test drives.
		test(
			'optional keywords persist across save, show on Review and survive submit',
			{tag: '@regression'},
			async ({page, pkpApi}) => {
				const tag = uniqueTag();
				const kw1 = `vision-${tag}`;
				const kw2 = `robotics-${tag}`;
				const {submission} = await pkpApi.createSubmission(
					draftSpec({
						tag,
						title: `Keywords ${tag}`,
						abstract: `<p>Abstract for keyword persistence ${tag}.</p>`,
					}),
				);

				const wizard = new SubmissionWizardPage(page);
				await page.goto(
					`/index.php/publicknowledge/submission?id=${submission.id}`,
				);
				await expect(page.locator('.submissionWizard')).toBeVisible({
					timeout: 20_000,
				});
				await wizard.expectStep('Upload Files');
				await continueTo(wizard, 'Details');

				// The Keywords field renders per the publicknowledge
				// 'request' default — present but WITHOUT the required
				// marker (isRequired only tracks METADATA_REQUIRE).
				const keywordsLabel = page.locator(
					'label[for="titleAbstract-keywords-control-en"]',
				);
				await expect(keywordsLabel).toBeVisible({timeout: 15_000});
				await expect(
					keywordsLabel.locator('.pkpFormFieldLabel__required'),
				).toHaveCount(0);

				await addVocabEntry(page, 'titleAbstract-keywords-control-en', kw1);
				await addVocabEntry(page, 'titleAbstract-keywords-control-en', kw2);

				// Leaving the step queues the autosave; poll the stored
				// publication until both keywords are persisted.
				await continueTo(wizard, 'Contributors');
				await expect
					.poll(
						async () =>
							vocabNames(
								(await fetchCurrentPublication(page, submission.id))
									?.keywords?.en,
							),
						{timeout: 20_000},
					)
					.toEqual(expect.arrayContaining([kw1, kw2]));

				// Chips persist across save: a full reload re-renders them
				// from the stored value. NOTE: step changes never persist
				// submissionProgress (only Save-for-Later does — see
				// SubmissionWizardPage.vue's saveForLater), so the reload
				// resumes at Upload Files with later steps unstarted —
				// walk forward with Continue, not gotoStep.
				await page.goto(
					`/index.php/publicknowledge/submission?id=${submission.id}`,
				);
				await expect(page.locator('.submissionWizard')).toBeVisible({
					timeout: 20_000,
				});
				await wizard.expectStep('Upload Files');
				await continueTo(wizard, 'Details');
				await expect(
					page.getByRole('button', {name: `Remove ${kw1}`}),
				).toBeVisible({timeout: 15_000});
				await expect(
					page.getByRole('button', {name: `Remove ${kw2}`}),
				).toBeVisible();

				// Walk to Review (publicknowledge has 6 steps incl.
				// Reviewer Suggestions).
				await continueTo(wizard, 'Contributors');
				await continueTo(wizard, 'For the Editors');
				await continueTo(wizard, 'Reviewer Suggestions');
				await continueTo(wizard, 'Review');

				// The Details review panel (EN — multilingual journal
				// renders one panel per metadata locale) lists both
				// keywords, comma-joined.
				const detailsPanel = wizard.reviewPanel(/^Details \(English\)/);
				const keywordsItem = reviewItem(page, detailsPanel, 'Keywords');
				await expect(keywordsItem).toContainText(kw1);
				await expect(keywordsItem).toContainText(kw2);

				await submitWizard(page);

				// Post-submit, the publication metadata still carries the
				// keywords (the author retains read access to their own
				// submission via REST).
				const pub = await fetchCurrentPublication(page, submission.id);
				expect(vocabNames(pub?.keywords?.en)).toEqual(
					expect.arrayContaining([kw1, kw2]),
				);
			},
		);

		// Row 2 — Citations entry (request-on default). The citations
		// textarea is a separate PKPCitationsForm section appended to the
		// Details step when the context's `citations` is request/require.
		test(
			'pasted references persist and render line-by-line on Review',
			{tag: '@regression'},
			async ({page, pkpApi}) => {
				const tag = uniqueTag();
				const ref1 = `Smith, J. (2025). Parallel testing at scale. (${tag})`;
				const ref2 = `Doe, A. (2024). Wizard metadata coverage. (${tag})`;
				const {submission} = await pkpApi.createSubmission(
					draftSpec({tag, title: `Citations ${tag}`}),
				);

				const wizard = new SubmissionWizardPage(page);
				await page.goto(
					`/index.php/publicknowledge/submission?id=${submission.id}`,
				);
				await expect(page.locator('.submissionWizard')).toBeVisible({
					timeout: 20_000,
				});
				await wizard.expectStep('Upload Files');
				await continueTo(wizard, 'Details');

				// citationsRaw is a plain FieldTextarea on the `citations`
				// form (id: {formId}-{name}-control, non-multilingual).
				const citationsInput = page.locator(
					'#citations-citationsRaw-control',
				);
				await expect(citationsInput).toBeVisible({timeout: 15_000});
				await citationsInput.fill(`${ref1}\n${ref2}`);

				// Step change queues the autosave; poll persisted state.
				await continueTo(wizard, 'Contributors');
				await expect
					.poll(
						async () =>
							String(
								(await fetchCurrentPublication(page, submission.id))
									?.citationsRaw ?? '',
							),
						{timeout: 20_000},
					)
					.toContain(ref1);

				await continueTo(wizard, 'For the Editors');
				await continueTo(wizard, 'Reviewer Suggestions');
				await continueTo(wizard, 'Review');

				// review-details.tpl renders the citations item only in
				// the submission-locale panel, splitting citationsRaw on
				// newlines into one .submissionWizard__reviewPanel__citation
				// per reference. Header is "References" (submission.citations).
				const detailsPanel = wizard.reviewPanel(/^Details \(English\)/);
				const referencesItem = reviewItem(page, detailsPanel, 'References');
				await expect(
					referencesItem.locator(
						'.submissionWizard__reviewPanel__citation',
					),
				).toHaveCount(2);
				await expect(referencesItem).toContainText(ref1);
				await expect(referencesItem).toContainText(ref2);
			},
		);

		// Row 3 — Categories selection persists, incl. the nested
		// breadcrumb on Review. publicknowledge seeds submitWithCategories
		// + a nested tree (Applied Science > Computer Science > Computer
		// Vision). categories.spec.js (plans/categories.md) owns the
		// admin-side CRUD; this row drives only the wizard field on the
		// shared journal.
		test(
			'category selections persist and Review shows nested breadcrumbs',
			{tag: '@regression'},
			async ({page, pkpApi}) => {
				const tag = uniqueTag();
				const NESTED_BREADCRUMB =
					'Applied Science > Computer Science > Computer Vision';
				const TOP_LEVEL = 'Social Sciences';
				const {submission} = await pkpApi.createSubmission(
					draftSpec({tag, title: `Categories ${tag}`}),
				);

				const wizard = new SubmissionWizardPage(page);
				await page.goto(
					`/index.php/publicknowledge/submission?id=${submission.id}`,
				);
				await expect(page.locator('.submissionWizard')).toBeVisible({
					timeout: 20_000,
				});
				await wizard.expectStep('Upload Files');
				await continueTo(wizard, 'Details');
				await continueTo(wizard, 'Contributors');
				await continueTo(wizard, 'For the Editors');

				// FieldAutosuggestPreset renders a "Select Categories"
				// button opening the vocabulary tree picker. Parents with
				// children are auto-expanded (vocabularyModalStore), so the
				// nested leaf is clickable immediately.
				const selectBtn = page.getByRole('button', {
					name: 'Select Categories',
				});
				await expect(selectBtn).toBeVisible({timeout: 15_000});
				await selectBtn.click();

				const selectModal = page
					.locator('[data-cy="active-modal"]')
					.filter({
						has: page.getByRole('heading', {name: 'Select Categories'}),
					});
				await expect(
					selectModal.getByRole('heading', {name: 'Select Categories'}),
				).toBeVisible({timeout: 15_000});
				await selectModal
					.locator('label', {hasText: 'Computer Vision'})
					.first()
					.click();
				await selectModal
					.locator('label', {hasText: TOP_LEVEL})
					.first()
					.click();
				await selectModal.getByRole('button', {name: 'Save'}).click();
				await expect(
					page.getByRole('heading', {name: 'Select Categories'}),
				).toHaveCount(0, {timeout: 10_000});

				// The field's chips carry the FULL breadcrumb labels —
				// the options bound by ForTheEditors::addCategoryField are
				// Repo::category()->getBreadcrumbs() strings.
				await expect(
					page.getByRole('button', {name: `Remove ${NESTED_BREADCRUMB}`}),
				).toBeVisible();
				await expect(
					page.getByRole('button', {name: `Remove ${TOP_LEVEL}`}),
				).toBeVisible();

				// Leave the step → autosave; poll the stored selection.
				await continueTo(wizard, 'Reviewer Suggestions');
				await expect
					.poll(
						async () =>
							(await fetchCurrentPublication(page, submission.id))
								?.categoryIds?.length ?? 0,
						{timeout: 20_000},
					)
					.toBe(2);

				// Selection persists into a fresh page load. Step changes
				// never persist submissionProgress (only Save-for-Later
				// does), so the reload resumes at Upload Files — walk
				// forward with Continue, not gotoStep.
				await page.goto(
					`/index.php/publicknowledge/submission?id=${submission.id}`,
				);
				await expect(page.locator('.submissionWizard')).toBeVisible({
					timeout: 20_000,
				});
				await wizard.expectStep('Upload Files');
				await continueTo(wizard, 'Details');
				await continueTo(wizard, 'Contributors');
				await continueTo(wizard, 'For the Editors');
				await expect(
					page.getByRole('button', {name: `Remove ${NESTED_BREADCRUMB}`}),
				).toBeVisible({timeout: 15_000});
				await expect(
					page.getByRole('button', {name: `Remove ${TOP_LEVEL}`}),
				).toBeVisible();

				// Review echoes both breadcrumbs (categories render only in
				// the submission-locale panel).
				await continueTo(wizard, 'Reviewer Suggestions');
				await continueTo(wizard, 'Review');
				const editorsPanel = wizard.reviewPanel(
					/^For the Editors \(English\)/,
				);
				const categoriesItem = reviewItem(page, editorsPanel, 'Categories');
				await expect(categoriesItem).toContainText(NESTED_BREADCRUMB);
				await expect(categoriesItem).toContainText(TOP_LEVEL);
			},
		);

		// Row 13 — Request mode never blocks submit. Keywords, citations
		// and categories all left empty on the shared journal's request-on
		// defaults; the Review step shows "None provided"/"None selected"
		// instead of errors and the submission completes.
		test(
			'keywords, citations and categories left empty never block submit',
			{tag: '@regression'},
			async ({page}) => {
				const tag = uniqueTag();
				const wizard = new SubmissionWizardPage(page);
				await wizard.goto();
				// Reviews: abstractsNotRequired, so nothing besides the
				// title + file gates the submit.
				await wizard.start({
					title: `Optional-empty ${tag}`,
					section: 'Reviews',
				});
				await wizard.expectStep('Upload Files');
				const fileItem = await wizard.uploadFile(ARTICLE_FIXTURE);
				await wizard.assignPrimaryGenre(fileItem, 'Article Text');

				await continueTo(wizard, 'Details');
				// Both request-on fields render — and stay empty.
				await expect(
					page.locator('#titleAbstract-keywords-control-en'),
				).toBeVisible({timeout: 15_000});
				await expect(
					page.locator('#citations-citationsRaw-control'),
				).toBeVisible();

				await continueTo(wizard, 'Contributors');
				await continueTo(wizard, 'For the Editors');
				await expect(
					page.getByRole('button', {name: 'Select Categories'}),
				).toBeVisible({timeout: 15_000});

				await continueTo(wizard, 'Reviewer Suggestions');
				await continueTo(wizard, 'Review');

				// Wait until validation settles (Submit enables) before
				// asserting the banner's absence — entry-time validation is
				// async and an early negative assertion could pass vacuously.
				await expect(footerSubmitButton(page)).toBeEnabled({
					timeout: 15_000,
				});
				await expect(
					page.getByText('There are one or more problems'),
				).toHaveCount(0);

				// The empty optional fields render as "None provided" /
				// "None selected" — not as errors.
				const detailsPanel = wizard.reviewPanel(/^Details \(English\)/);
				await expect(
					reviewItem(page, detailsPanel, 'Keywords'),
				).toContainText('None provided');
				await expect(
					reviewItem(page, detailsPanel, 'References'),
				).toContainText('None provided');
				const editorsPanel = wizard.reviewPanel(
					/^For the Editors \(English\)/,
				);
				await expect(
					reviewItem(page, editorsPanel, 'Categories'),
				).toContainText('None selected');

				await submitWizard(page);
			},
		);
	});

	// Rows 5–8 — absorbed from playwright/tests/wizard-config-reset.spec.js
	// (behavior-identical; see the spec header). Metadata-field config on
	// the journal Submission > Metadata tab (PKPMetadataSettingsForm)
	// flows through to the wizard's Details step via the Details form's
	// `in_array($context->getData('keywords'), [METADATA_REQUEST,
	// METADATA_REQUIRE])` gate and `isRequired` prop. Toggling "Require"
	// in settings on a fresh session turns the wizard's Keywords field
	// into a required one (asterisk label via FormFieldLabel.vue's
	// pkpFormFieldLabel__required span); toggling it to "Do not ask"
	// (METADATA_DISABLE) removes the field entirely.
	test.describe('field-config reset on scratch journals', () => {
		// Row 5 (absorbed test 1).
		test(
			'toggling keywords to Require surfaces it as required in the wizard',
			{tag: '@regression'},
			async ({pkpApi, asUser}) => {
				const tag = uniqueTag();

				// E0 scratch journal, dbarnes = manager. Editor-cum-manager is
				// the right role for a capability assertion about wizard field
				// config — the Details form's `keywords` gate is
				// role-agnostic; it only checks the context's setting.
				const {context} = await pkpApi.createJournal({
					tag,
					users: [{username: 'dbarnes', roles: ['manager']}],
				});

				const ctx = await asUser('dbarnes');
				const page = await ctx.newPage();

				// Flip keywords → require via the Metadata settings form.
				await openMetadataSettingsTab(page, context.path);
				await setMetadataFieldMode(page, KEYWORDS, 'require');

				// New wizard session. The Keywords field is rendered by
				// publication/Details.php only when keywords is REQUEST
				// or REQUIRE, and its isRequired prop tracks REQUIRE
				// specifically. FormFieldLabel.vue adds a
				// pkpFormFieldLabel__required span when isRequired is
				// truthy — this span is absent by default (keywords
				// defaults to REQUEST, not REQUIRE).
				const wizard = new SubmissionWizardPage(page, context.path);
				await wizard.goto();
				await wizard.start({title: `Require-keywords ${tag}`});

				// Step 1 Upload Files → Continue (skip file upload, not
				// the feature under test here).
				await continueTo(wizard, 'Details');

				// On Details. The Keywords control id is
				// `titleAbstract-keywords-control-{locale}` — the label
				// wraps it via for=controlId. Assert the label carries
				// the required-asterisk marker.
				const keywordsLabel = page.locator(
					'label[for="titleAbstract-keywords-control-en"]',
				);
				await expect(keywordsLabel).toBeVisible({timeout: 15_000});
				await expect(
					keywordsLabel.locator('.pkpFormFieldLabel__required'),
				).toBeVisible();
			},
		);

		// Row 7 (absorbed test 2).
		test(
			'toggling keywords to Do-not-ask removes it from the wizard Details step',
			{tag: '@regression'},
			async ({pkpApi, asUser}) => {
				const tag = uniqueTag();

				const {context} = await pkpApi.createJournal({
					tag,
					users: [{username: 'dbarnes', roles: ['manager']}],
				});

				const ctx = await asUser('dbarnes');
				const page = await ctx.newPage();

				// Flip keywords → disabled (METADATA_DISABLE = 0).
				await openMetadataSettingsTab(page, context.path);
				await setMetadataFieldMode(page, KEYWORDS, 'disable');

				const wizard = new SubmissionWizardPage(page, context.path);
				await wizard.goto();
				await wizard.start({title: `No-keywords ${tag}`});

				await continueTo(wizard, 'Details');

				// On Details. With keywords disabled, the Details form
				// doesn't add the `keywords` field at all
				// (Details.php#L48 gate), so the control + label are
				// absent.
				await expect(
					page.locator('label[for="titleAbstract-keywords-control-en"]'),
				).toHaveCount(0);
				await expect(
					page.locator('#titleAbstract-keywords-control-en'),
				).toHaveCount(0);

				// Sanity: the Details form itself did render — the Title
				// control (which isn't config-gated) is present.
				await expect(
					page.locator('textarea#titleAbstract-title-control-en'),
				).toBeAttached();
			},
		);

		// Row 8 (absorbed test 3).
		test(
			'toggling subjects to Require surfaces it as required in the For-the-Editors step',
			{tag: '@regression'},
			async ({pkpApi, asUser}) => {
				const tag = uniqueTag();

				const {context} = await pkpApi.createJournal({
					tag,
					users: [{username: 'dbarnes', roles: ['manager']}],
				});

				const ctx = await asUser('dbarnes');
				const page = await ctx.newPage();

				// Flip subjects → require. subjects renders inside the
				// ForTheEditors form (Step 4) rather than Details — proves
				// the FieldMetadataSetting wiring is general across the two
				// host forms (titleAbstract for keywords, forTheEditors for
				// subjects). Same FieldMetadataSetting component, same
				// PKPMetadataSettingsForm submit, same context schema gate.
				await openMetadataSettingsTab(page, context.path);
				await setMetadataFieldMode(page, SUBJECTS, 'require');

				const wizard = new SubmissionWizardPage(page, context.path);
				await wizard.goto();
				await wizard.start({title: `Require-subjects ${tag}`});

				// Walk past Upload + Details + Contributors to land on
				// "For the Editors" — Step 4. The subjects control id
				// follows `forTheEditors-subjects-control-{locale}`.
				await continueTo(wizard, 'Details');
				await continueTo(wizard, 'Contributors');
				await continueTo(wizard, 'For the Editors');

				const subjectsLabel = page.locator(
					'label[for="forTheEditors-subjects-control-en"]',
				);
				await expect(subjectsLabel).toBeVisible({timeout: 15_000});
				await expect(
					subjectsLabel.locator('.pkpFormFieldLabel__required'),
				).toBeVisible();
			},
		);

		// Row 6 (absorbed test 4).
		test(
			'missing required keyword surfaces a validation error in Review',
			{tag: '@regression'},
			async ({pkpApi, asUser}) => {
				const tag = uniqueTag();

				const {context} = await pkpApi.createJournal({
					tag,
					users: [{username: 'dbarnes', roles: ['manager']}],
				});

				const ctx = await asUser('dbarnes');
				const page = await ctx.newPage();

				// Same setup as row 5: keywords flipped to require. This
				// time the wizard advances all the way to Review without
				// supplying a keyword, and the assertion is on Review's
				// validation panel surfacing the missing-keyword error.
				await openMetadataSettingsTab(page, context.path);
				await setMetadataFieldMode(page, KEYWORDS, 'require');

				const wizard = new SubmissionWizardPage(page, context.path);
				await wizard.goto();
				await wizard.start({title: `Require-review-error ${tag}`});

				// Walk to Review (keywords required, but the step gate
				// doesn't validate until Review).
				await continueTo(wizard, 'Details');
				await continueTo(wizard, 'Contributors');
				await continueTo(wizard, 'For the Editors');
				await continueTo(wizard, 'Review');

				// Wizard's top-level errors banner appears once at least
				// one required field is missing across the steps. Anchor
				// on its localized phrase rather than a CSS class.
				await expect(
					page.getByText(/There are one or more problems/i),
				).toBeVisible({timeout: 15_000});

				// The Review panel's Details section reports per-field
				// validation. On a single-locale scratch journal the
				// heading reads simply "Details" (the "(English)" suffix
				// only appears when supportedSubmissionLocales has 2+
				// entries). The Keywords entry must carry the localized
				// "This field is required." string. Scope to the Details
				// review panel by heading so an error elsewhere on the
				// page can't fool us.
				const detailsPanel = page
					.locator('.submissionWizard__reviewPanel')
					.filter({
						has: page.getByRole('heading', {name: /^Details$/i}),
					});
				await expect(detailsPanel).toHaveCount(1);
				await expect(detailsPanel).toContainText('Keywords');
				await expect(detailsPanel).toContainText('This field is required.');
			},
		);
	});

	// Rows 4, 9, 11, 12 — configuration gates driven as a manager on
	// scratch journals (publicknowledge stays read-only).
	test.describe('metadata configuration gates on scratch journals', () => {
		// Row 4 — Categories config gate. ForTheEditors::addCategoryField
		// bails when `!submitWithCategories || !categories->count()`; both
		// branches are asserted, and the setting is flipped through the
		// Metadata settings UI (categories.spec.js seeds the flag via the
		// scenario passthrough instead — different surface).
		test(
			'categories field is gated by submitWithCategories and category existence',
			{tag: '@regression'},
			async ({pkpApi, asUser}) => {
				const tag = uniqueTag();
				const parentTitle = `Parent ${tag}`;
				const childTitle = `Child ${tag}`;

				// Journal A: a category tree exists but the flag is off
				// (schema default false).
				const {context: journalA} = await pkpApi.createJournal({
					tag,
					users: [{username: 'dbarnes', roles: ['manager']}],
					categories: [
						{
							path: `parent-${tag.slice(-6)}`,
							title: {en: parentTitle},
							children: [
								{path: `child-${tag.slice(-6)}`, title: {en: childTitle}},
							],
						},
					],
				});
				// Journal B: flag on but the journal has no categories.
				const {context: journalB} = await pkpApi.createJournal({
					tag: `${tag}b`,
					users: [{username: 'dbarnes', roles: ['manager']}],
					submitWithCategories: true,
				});

				const ctx = await asUser('dbarnes');
				const page = await ctx.newPage();

				// A1 — flag off + categories present → field absent.
				const wizardA = new SubmissionWizardPage(page, journalA.path);
				await wizardA.goto();
				await wizardA.start({title: `Gate-off ${tag}`});
				await continueTo(wizardA, 'Details');
				await continueTo(wizardA, 'Contributors');
				await continueTo(wizardA, 'For the Editors');
				await expect(
					page.getByRole('button', {name: 'Select Categories'}),
				).toHaveCount(0);
				await expect(
					page.locator('label[for^="forTheEditors-categoryIds-"]'),
				).toHaveCount(0);
				// Positive control: the step itself rendered (comments form).
				await expect(
					page.locator(
						'#commentsForTheEditors-commentsForTheEditors-control_ifr',
					),
				).toBeAttached({timeout: 15_000});

				// A2 — enable the setting through the Metadata settings UI
				// (FieldOptions radio at the bottom of the form).
				await openMetadataSettingsTab(page, journalA.path);
				const yesLabel = page.locator('label', {
					hasText: 'Yes, add a categories field to the submission wizard.',
				});
				await expect(yesLabel).toBeVisible();
				await yesLabel.click();
				await saveMetadataSettings(page, yesLabel);

				// Fresh wizard session → the field renders and the picker
				// offers the seeded tree (parent + nested child).
				const wizardA2 = new SubmissionWizardPage(page, journalA.path);
				await wizardA2.goto();
				await wizardA2.start({title: `Gate-on ${tag}`});
				await continueTo(wizardA2, 'Details');
				await continueTo(wizardA2, 'Contributors');
				await continueTo(wizardA2, 'For the Editors');
				const selectBtn = page.getByRole('button', {
					name: 'Select Categories',
				});
				await expect(selectBtn).toBeVisible({timeout: 15_000});
				await selectBtn.click();
				const selectModal = page
					.locator('[data-cy="active-modal"]')
					.filter({
						has: page.getByRole('heading', {name: 'Select Categories'}),
					});
				await expect(
					selectModal.getByRole('heading', {name: 'Select Categories'}),
				).toBeVisible({timeout: 15_000});
				await expect(
					selectModal.locator('label', {hasText: parentTitle}).first(),
				).toBeVisible();
				await expect(
					selectModal.locator('label', {hasText: childTitle}).first(),
				).toBeVisible();

				// B — flag on + zero categories → field absent (the
				// navigation away also disposes the open picker).
				const wizardB = new SubmissionWizardPage(page, journalB.path);
				await wizardB.goto();
				await wizardB.start({title: `Gate-no-cats ${tag}`});
				await continueTo(wizardB, 'Details');
				await continueTo(wizardB, 'Contributors');
				await continueTo(wizardB, 'For the Editors');
				await expect(
					page.getByRole('button', {name: 'Select Categories'}),
				).toHaveCount(0);
				await expect(
					page.locator('label[for^="forTheEditors-categoryIds-"]'),
				).toHaveCount(0);
			},
		);

		// Row 9 — Disciplines, agencies, coverage and type are off by
		// default; requesting all four through the settings UI (one Save)
		// renders them in For-the-Editors, and entered values persist to
		// the Review step.
		test(
			'disciplines, agencies, coverage and type render once requested and persist to Review',
			{tag: '@regression'},
			async ({pkpApi, asUser}) => {
				const tag = uniqueTag();
				const disc = `Computer vision ${tag}`;
				const agency = `Funding agency ${tag}`;
				const coverage = `Northern hemisphere ${tag}`;
				const typeVal = `Case study ${tag}`;

				const {context} = await pkpApi.createJournal({
					tag,
					users: [{username: 'dbarnes', roles: ['manager']}],
				});

				const ctx = await asUser('dbarnes');
				const page = await ctx.newPage();

				// Flip all four to "request" in one Save — the form PUTs
				// the whole settings payload at once.
				await openMetadataSettingsTab(page, context.path);
				await setMetadataFieldMode(page, DISCIPLINES, 'request', {
					save: false,
				});
				await setMetadataFieldMode(page, AGENCIES, 'request', {save: false});
				await setMetadataFieldMode(page, COVERAGE, 'request', {save: false});
				await setMetadataFieldMode(page, TYPE, 'request');

				const wizard = new SubmissionWizardPage(page, context.path);
				await wizard.goto();
				await wizard.start({title: `Request-four ${tag}`});
				const submissionId = wizard.currentSubmissionId();
				expect(submissionId).toBeTruthy();
				await continueTo(wizard, 'Details');
				await continueTo(wizard, 'Contributors');
				await continueTo(wizard, 'For the Editors');

				// All four render inside the forTheEditors metadata form.
				// disciplines + supportingAgencies are controlled-vocab
				// autosuggests; coverage + type are plain text inputs.
				await addVocabEntry(page, 'forTheEditors-disciplines-control-en', disc);
				await addVocabEntry(
					page,
					'forTheEditors-supportingAgencies-control-en',
					agency,
				);
				const coverageInput = page.locator(
					'#forTheEditors-coverage-control-en',
				);
				await expect(coverageInput).toBeVisible({timeout: 15_000});
				await coverageInput.fill(coverage);
				const typeInput = page.locator('#forTheEditors-type-control-en');
				await expect(typeInput).toBeVisible();
				await typeInput.fill(typeVal);

				// Step change queues the autosave; anchor on stored state
				// before asserting the Review render.
				await continueTo(wizard, 'Review');
				await expect
					.poll(
						async () => {
							const pub = await fetchCurrentPublication(
								page,
								submissionId,
								context.path,
							);
							if (!pub) return false;
							return (
								vocabNames(pub.disciplines?.en).includes(disc) &&
								vocabNames(pub.supportingAgencies?.en).includes(agency) &&
								(pub.coverage?.en ?? '') === coverage &&
								(pub.type?.en ?? '') === typeVal
							);
						},
						{timeout: 20_000},
					)
					.toBe(true);

				// Single-locale journal → the panel heading is exactly
				// "For the Editors". Each field renders as its own item.
				const editorsPanel = wizard.reviewPanel(/^For the Editors$/);
				await expect(
					reviewItem(page, editorsPanel, 'Disciplines'),
				).toContainText(disc);
				await expect(
					reviewItem(page, editorsPanel, 'Supporting Agencies'),
				).toContainText(agency);
				await expect(
					reviewItem(page, editorsPanel, 'Coverage'),
				).toContainText(coverage);
				await expect(reviewItem(page, editorsPanel, 'Type')).toContainText(
					typeVal,
				);
			},
		);

		// Row 11 — Empty metadata form omitted. On a vanilla scratch
		// journal nothing populates the ForTheEditors metadata form, so
		// PKPSubmissionHandler::getEditorsStep's
		// `count($metadataForm->fields)` gate drops the section entirely
		// and the step holds only the comments form.
		test(
			'a journal with no optional metadata shows only the comments form in For-the-Editors',
			{tag: '@regression'},
			async ({pkpApi, asUser}) => {
				const tag = uniqueTag();

				const {context} = await pkpApi.createJournal({
					tag,
					users: [{username: 'dbarnes', roles: ['manager']}],
				});

				const ctx = await asUser('dbarnes');
				const page = await ctx.newPage();

				const wizard = new SubmissionWizardPage(page, context.path);
				await wizard.goto();
				await wizard.start({title: `Vanilla-editors ${tag}`});
				await continueTo(wizard, 'Details');
				await continueTo(wizard, 'Contributors');
				await continueTo(wizard, 'For the Editors');

				// The comments form is the one and only section: its
				// TinyMCE control mounts…
				await expect(
					page.locator(
						'#commentsForTheEditors-commentsForTheEditors-control_ifr',
					),
				).toBeAttached({timeout: 15_000});
				// …and not a single forTheEditors-form field rendered (the
				// metadata section was omitted server-side, not just empty).
				await expect(page.locator('[id^="forTheEditors-"]')).toHaveCount(0);
				await expect(
					page.getByRole('button', {name: 'Select Categories'}),
				).toHaveCount(0);
				// The data-availability section is likewise absent on a
				// vanilla journal (separate gate, same step).
				await expect(page.locator('[id^="dataAvailability-"]')).toHaveCount(
					0,
				);
			},
		);

		// Row 12 — Citations Require blocks at Review. With citations on
		// Require and the textarea left empty, validateSubmit reports
		// errors.citationsRaw ("This field is required.") in the Details
		// review panel and Submit stays disabled; providing references
		// clears the error and the submission completes.
		test(
			'citations on Require block at Review until references are provided',
			{tag: '@regression'},
			async ({pkpApi, asUser}) => {
				const tag = uniqueTag();

				const {context} = await pkpApi.createJournal({
					tag,
					users: [{username: 'dbarnes', roles: ['manager']}],
				});

				const ctx = await asUser('dbarnes');
				const page = await ctx.newPage();

				await openMetadataSettingsTab(page, context.path);
				await setMetadataFieldMode(page, CITATIONS, 'require');

				const wizard = new SubmissionWizardPage(page, context.path);
				await wizard.goto();
				await wizard.start({title: `Require-citations ${tag}`});
				const submissionId = wizard.currentSubmissionId();
				expect(submissionId).toBeTruthy();
				await wizard.expectStep('Upload Files');
				// Upload + resolve the genre so the missing references are
				// the only gate left at Review.
				const fileItem = await wizard.uploadFile(ARTICLE_FIXTURE);
				await wizard.assignPrimaryGenre(fileItem, 'Article Text');

				await continueTo(wizard, 'Details');
				// The citations textarea now carries the required marker.
				const citationsLabel = page.locator(
					'label[for="citations-citationsRaw-control"]',
				);
				await expect(citationsLabel).toBeVisible({timeout: 15_000});
				await expect(
					citationsLabel.locator('.pkpFormFieldLabel__required'),
				).toBeVisible();
				// Fill the abstract (required by the default Articles
				// section) so the empty references are the ONLY validation
				// error at Review. Citations stay empty.
				await wizard.setDetailsField(
					'abstract',
					`<p>Abstract for required citations ${tag}.</p>`,
				);

				await continueTo(wizard, 'Contributors');
				await continueTo(wizard, 'For the Editors');
				await continueTo(wizard, 'Review');

				await expect(
					page.getByText(/There are one or more problems/i),
				).toBeVisible({timeout: 15_000});
				// The References item in the (single-locale) Details panel
				// carries the required-field notification
				// (review-details.tpl renders errors.citationsRaw inline).
				const detailsPanel = wizard.reviewPanel(/^Details$/);
				const referencesItem = reviewItem(page, detailsPanel, 'References');
				await expect(referencesItem).toContainText('This field is required.');
				await expect(footerSubmitButton(page)).toBeDisabled();

				// Provide references → the error clears and submit proceeds.
				await wizard.gotoStep('Details');
				await wizard.expectStep('Details');
				await page
					.locator('#citations-citationsRaw-control')
					.fill(`Reference A (${tag})\nReference B (${tag})`);
				// Hop to a non-Review step and poll the stored publication
				// so re-entering Review validates against saved state.
				await wizard.gotoStep('Contributors');
				await expect
					.poll(
						async () =>
							String(
								(
									await fetchCurrentPublication(
										page,
										submissionId,
										context.path,
									)
								)?.citationsRaw ?? '',
							),
						{timeout: 20_000},
					)
					.toContain(`Reference A (${tag})`);

				await wizard.gotoStep('Review');
				await wizard.expectStep('Review');
				await expect(
					referencesItem.getByText('This field is required.'),
				).toHaveCount(0, {timeout: 15_000});
				// And the provided references render line-by-line.
				await expect(
					referencesItem.locator('.submissionWizard__reviewPanel__citation'),
				).toHaveCount(2);

				await submitWizard(page);
			},
		);
	});
});
