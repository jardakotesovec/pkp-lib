// @ts-check
const path = require('path');
const {test, expect} = require('../support/base-test.js');
const {SubmissionWizardPage} = require('../pages/SubmissionWizardPage.js');
const {
	setTinyMceContent,
	getTinyMceContent,
} = require('../support/tinymce.js');

/**
 * Submission wizard — language
 * Plan: docs/e2e/plans/submission-wizard-language.md
 *
 * Absorbs (moved + retitled, hard-won locators kept):
 *   - wizard-language.spec.js (2 tests → rows 2–3; ports
 *     cypress/tests/integration/SubmissionWizard.cy.js test 5's
 *     locale-re-render assertion, dropping its journal-config and
 *     file-upload baggage which belong to other plans)
 *
 * Remaining rows implemented here: 1 (start-form locale picker),
 * 4 (multilingual metadata entry), 5 (French submission end-to-end),
 * 6 (single-locale journal hides language choices).
 *
 * The bootstrapped publicknowledge journal declares both `en` and
 * `fr_CA` as supported submission locales
 * (playwright/fixtures/bootstrap.js), so only row 6 needs a scratch
 * journal. publicknowledge runs the enriched defaults: the Reviewer
 * Suggestions step is present, and keywords/citations are 'request'
 * (optional — never gates Continue/Submit).
 */

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
	return `swl-w${workerIndex}-${suffix}`;
}

/**
 * Upload the bundled Article Text PDF through the wizard's
 * FileUploader (step 1) and resolve its genre. Same pattern as
 * submission-wizard-validation.spec.js / filenames.spec.js.
 *
 * @param {import('@playwright/test').Page} page
 */
async function uploadArticleFile(page) {
	const fileInput = page.locator('input[type="file"]').first();
	await expect(fileInput).toBeAttached({timeout: 15_000});
	const [uploadResp] = await Promise.all([
		page.waitForResponse(
			(res) =>
				res.request().method() === 'POST' &&
				/\/api\/v1\/submissions\/\d+\/files$/.test(res.url()) &&
				res.ok(),
			{timeout: 30_000},
		),
		fileInput.setInputFiles(ARTICLE_FIXTURE),
	]);
	expect(uploadResp.ok()).toBeTruthy();

	const listItem = page.locator('.listPanel__item--submissionFile').first();
	await expect(listItem).toBeVisible({timeout: 15_000});

	const articleTextBtn = listItem
		.locator('.listPanel--submissionFiles__setGenreButton')
		.filter({hasText: 'Article Text'})
		.first();
	await Promise.all([
		page.waitForResponse(
			(res) =>
				res.request().method() === 'POST' &&
				/\/api\/v1\/submissions\/\d+\/files\/\d+/.test(res.url()) &&
				res.ok(),
			{timeout: 15_000},
		),
		articleTextBtn.click(),
	]);
	return listItem;
}

/**
 * Fetch the submission's current publication via REST (with the page's
 * session). Used with expect.poll to anchor "the wizard's autosave has
 * landed" deterministically — the wizard queues autosaves on step
 * changes AND on a 60-second idle timer, so waiting for a specific
 * response can miss a save that already happened; polling the stored
 * state can't.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} submissionId
 * @returns {Promise<object|null>} the publication, or null while unavailable
 */
async function fetchCurrentPublication(page, submissionId) {
	const subRes = await page.request.get(
		`/index.php/publicknowledge/api/v1/submissions/${submissionId}`,
	);
	if (!subRes.ok()) return null;
	const sub = await subRes.json();
	if (!sub.currentPublicationId) return null;
	const pubRes = await page.request.get(
		`/index.php/publicknowledge/api/v1/submissions/${submissionId}/publications/${sub.currentPublicationId}`,
	);
	if (!pubRes.ok()) return null;
	return await pubRes.json();
}

test.describe('Submission wizard — language', () => {
	test.describe('as author on publicknowledge', () => {
		test.use({user: 'atester'});

		// Row 1 — Start form locale picker.
		test(
			'start form offers en + fr_CA and French starts a FR-first wizard',
			{tag: '@regression'},
			async ({page}) => {
				const tag = uniqueTag();
				const frenchTitle = `Titre ${tag}`;

				const wizard = new SubmissionWizardPage(page);
				await wizard.goto();
				await expect(
					page.getByRole('heading', {name: 'Make a Submission'}),
				).toBeVisible();
				await expect(
					page.locator('#startSubmission-title-control_ifr'),
				).toBeAttached({timeout: 15_000});

				// The Submission Language radio renders because the
				// journal supports 2 submission locales; both locale
				// names appear as options (EN UI display names).
				const languageField = page.locator('.pkpFormField--options', {
					has: page.locator('legend', {
						hasText: 'Submission Language',
					}),
				});
				await expect(languageField).toBeVisible();
				await expect(
					languageField.locator('label', {hasText: 'English'}),
				).toBeVisible();
				await expect(
					languageField.locator('label', {hasText: 'French (Canada)'}),
				).toBeVisible();

				// Pick French and begin.
				await wizard.start({
					title: frenchTitle,
					locale: 'French (Canada)',
					section: 'Articles',
				});
				await wizard.expectStep('Upload Files');

				// The wizard caption reflects the chosen locale.
				const configSection = page.locator('#submission-configuration');
				await expect(configSection).toContainText(/French \(Canada\)/);

				// Details mounts with fr_CA as the primary metadata
				// locale: the FR title control is the visible one and
				// carries the Start form's title
				// (StartSubmissionForm.success saves the title under
				// submission.locale), the EN control stays hidden behind
				// the form-locales toggle, and the form-locales widget
				// marks French as primary. Read the value through
				// TinyMCE — the backing <textarea> only mirrors editor
				// content on editor.save(), so a server-rendered value
				// lives in the editor alone.
				await wizard.continueStep();
				await wizard.expectStep('Details');
				await expect(
					page.locator('#titleAbstract-title-control-fr_CA_ifr'),
				).toBeVisible();
				await expect(
					page.locator('#titleAbstract-title-control-en_ifr'),
				).toBeHidden();
				await expect
					.poll(() =>
						getTinyMceContent(
							page,
							'titleAbstract-title-control-fr_CA',
						),
					)
					.toContain(frenchTitle);
				await expect(
					page
						.locator(
							'.pkpFormLocales__locale--isPrimary',
							{hasText: 'French (Canada)'},
						)
						.first(),
				).toBeVisible();
			},
		);

		// Row 4 — Multilingual metadata entry: secondary-locale (EN)
		// fields revealed via the form-locale toggle; title + abstract
		// entered in both locales persist and survive save/reload.
		test(
			'title and abstract entered in both locales survive save and reload',
			{tag: '@regression'},
			async ({page, pkpApi}) => {
				const tag = uniqueTag();
				const frTitle = `Titre ${tag}`;
				const enTitle = `Title EN ${tag}`;
				const frAbstract = `Résumé ${tag}`;
				const enAbstract = `Abstract EN ${tag}`;

				// Seed a resumable fr_CA wizard draft (submitted: false →
				// submissionProgress='start') so the test starts straight
				// at the wizard with French as the primary form locale.
				const seeded = await pkpApi.createSubmission({
					tag,
					journal: 'publicknowledge',
					submitter: 'atester',
					section: 'ART',
					locale: 'fr_CA',
					submitted: false,
				});
				const submissionId = seeded.submission.id;

				const wizard = new SubmissionWizardPage(page);
				await page.goto(
					`/index.php/publicknowledge/submission?id=${submissionId}`,
				);
				await expect(page.locator('.submissionWizard')).toBeVisible({
					timeout: 15_000,
				});
				await wizard.expectStep('Upload Files');

				await wizard.continueStep();
				await wizard.expectStep('Details');

				// FR is the primary form locale; the EN fields are
				// rendered but stay visually hidden until the
				// form-locales toggle reveals them (assert via the
				// TinyMCE iframes — the backing textareas are always
				// hidden). Scope the toggle to the Details step's
				// form-locales widget, mirroring the reconfigure test's
				// `.pkpStep` anchoring.
				await expect(
					page.locator('#titleAbstract-title-control-fr_CA_ifr'),
				).toBeVisible();
				await expect(
					page.locator('#titleAbstract-title-control-en_ifr'),
				).toBeHidden();
				const detailsStep = page
					.locator('.pkpStep:has(.pkpFormLocales__locale)')
					.first();
				await detailsStep
					.locator('.pkpFormLocales__locale', {hasText: 'English'})
					.first()
					.click();
				await expect(
					page.locator('#titleAbstract-title-control-en_ifr'),
				).toBeVisible();

				// Enter title + abstract in both locales.
				await wizard.setTitle(frTitle, 'fr_CA');
				await wizard.setTitle(enTitle, 'en');
				await setTinyMceContent(
					page,
					'titleAbstract-abstract-control-fr_CA',
					frAbstract,
				);
				await setTinyMceContent(
					page,
					'titleAbstract-abstract-control-en',
					enAbstract,
				);

				// The step change queues the stale titleAbstract form for
				// autosave (one payload carries all four values). Poll
				// the stored publication until every value is persisted
				// so the reload below can't race an in-flight save.
				await wizard.continueStep(); // → Contributors
				await expect
					.poll(
						async () => {
							const pub = await fetchCurrentPublication(
								page,
								submissionId,
							);
							return Boolean(
								pub?.title?.fr_CA?.includes(frTitle) &&
									pub?.title?.en?.includes(enTitle) &&
									pub?.abstract?.fr_CA?.includes(frAbstract) &&
									pub?.abstract?.en?.includes(enAbstract),
							);
						},
						{timeout: 20_000},
					)
					.toBe(true);

				await wizard.continueStep(); // → For the Editors
				await wizard.continueStep(); // → Reviewer Suggestions
				await wizard.continueStep(); // → Review
				await wizard.expectStep('Review');

				// The per-locale Details review panels carry each
				// locale's values.
				const frPanel = page
					.locator('.submissionWizard__reviewPanel')
					.filter({
						has: page.getByRole('heading', {
							name: 'Details (French (Canada))',
						}),
					});
				const enPanel = page
					.locator('.submissionWizard__reviewPanel')
					.filter({
						has: page.getByRole('heading', {
							name: 'Details (English)',
						}),
					});
				await expect(frPanel).toContainText(frTitle);
				await expect(frPanel).toContainText(frAbstract);
				await expect(enPanel).toContainText(enTitle);
				await expect(enPanel).toContainText(enAbstract);

				// Reload the wizard cold (no #step hash → it reopens at
				// step 1) and walk back to Review: all four values
				// survived the round-trip through the API.
				await page.goto(
					`/index.php/publicknowledge/submission?id=${submissionId}`,
				);
				await expect(page.locator('.submissionWizard')).toBeVisible();
				await wizard.expectStep('Upload Files');
				await wizard.continueStep(); // → Details
				await wizard.continueStep(); // → Contributors
				await wizard.continueStep(); // → For the Editors
				await wizard.continueStep(); // → Reviewer Suggestions
				await wizard.continueStep(); // → Review
				await wizard.expectStep('Review');

				await expect(frPanel).toContainText(frTitle);
				await expect(frPanel).toContainText(frAbstract);
				await expect(enPanel).toContainText(enTitle);
				await expect(enPanel).toContainText(enAbstract);
			},
		);

		// Row 5 — French submission end-to-end: the wizard completes in
		// fr_CA, the editor sees the FR title, and the submission locale
		// is recorded on the submission row.
		test(
			'a French submission completes and surfaces FR metadata to the editor',
			{tag: '@regression'},
			async ({page, asUser}) => {
				const tag = uniqueTag();
				const frTitle = `Titre ${tag}`;

				const wizard = new SubmissionWizardPage(page);
				await wizard.goto();
				// Reviews: abstractsNotRequired, so title + file are the
				// only submit requirements.
				await wizard.start({
					title: frTitle,
					locale: 'French (Canada)',
					section: 'Reviews',
				});
				await wizard.expectStep('Upload Files');
				const submissionId = wizard.currentSubmissionId();
				expect(submissionId).toBeTruthy();

				await uploadArticleFile(page);
				await wizard.continueStep(); // → Details
				await wizard.expectStep('Details');
				// The FR title came over from the Start form; re-set it
				// defensively (the Review gate reads publication.title in
				// the submission locale).
				await wizard.setTitle(frTitle, 'fr_CA');
				await wizard.continueStep(); // → Contributors
				await wizard.expectStep('Contributors');
				// validateSubmit requires the contributor's data in the
				// submission locale (fr_CA). The given name is auto-copied
				// from the user's default locale (newAuthorFromUser), but
				// the migrated AFFILIATION only carries an EN name —
				// without an fr_CA translation, Review raises "The
				// affiliation name is missing in French (Canada)…" and
				// blocks Submit. Translate it through the contributor
				// edit modal, the same path a real author follows.
				const contributorItem = page
					.locator('.listPanel__item')
					.filter({hasText: 'Tester'})
					.first();
				await expect(contributorItem).toBeVisible({timeout: 15_000});
				await contributorItem
					.getByRole('button', {name: /Edit/})
					.first()
					.click();
				const modal = page.locator('[data-cy="active-modal"]');
				// The affiliations table shows a per-row translations
				// toggle ("1 of 2 languages completed") that expands one
				// text input per supported locale.
				const translationToggle = modal
					.locator('a', {hasText: 'languages completed'})
					.first();
				await expect(translationToggle).toBeVisible({timeout: 15_000});
				await translationToggle.click();
				const frAffiliationInput = modal.getByLabel(
					'Type the institution name in French (Canada)',
				);
				await expect(frAffiliationInput).toBeVisible();
				await frAffiliationInput.fill(`Affiliation FR ${tag}`);
				// Blur commits the FieldText change into the affiliations
				// field value before the form serializes it.
				await frAffiliationInput.press('Tab');
				await Promise.all([
					page.waitForResponse(
						(res) =>
							res.request().method() === 'POST' &&
							/\/contributors\/\d+/.test(res.url()) &&
							res.ok(),
						{timeout: 15_000},
					),
					modal
						.getByRole('button', {name: 'Save', exact: true})
						.click(),
				]);
				// The contributor save closes the side modal; anchor on
				// the toggle disappearing (the wrapper itself reports
				// visibility quirks during transitions).
				await expect(translationToggle).toBeHidden({timeout: 15_000});

				await wizard.continueStep(); // → For the Editors
				await wizard.continueStep(); // → Reviewer Suggestions
				await wizard.continueStep(); // → Review
				await wizard.expectStep('Review');

				// Submit + confirm. Scroll first — the Review layout
				// shifts while the Confirmation block hydrates.
				const submitBtn = page
					.locator('.submissionWizard__footer')
					.getByRole('button', {name: 'Submit'});
				await expect(submitBtn).toBeVisible({timeout: 15_000});
				await submitBtn.scrollIntoViewIfNeeded();
				await expect(submitBtn).toBeEnabled({timeout: 15_000});
				await submitBtn.click();
				const confirmDialog = page.getByRole('dialog');
				await expect(confirmDialog).toBeVisible({timeout: 10_000});
				await confirmDialog
					.getByRole('button', {name: 'Submit', exact: true})
					.click();
				await expect(
					page.getByRole('heading', {name: 'Submission complete'}),
				).toBeVisible({timeout: 30_000});

				// The editor's workflow view shows the FR title, and the
				// submission row records the fr_CA locale.
				const dbarnesCtx = await asUser('dbarnes');
				const dbarnesPage = await dbarnesCtx.newPage();
				await dbarnesPage.goto(
					`/index.php/publicknowledge/en/dashboard/editorial?workflowSubmissionId=${submissionId}`,
				);
				await expect(
					dbarnesPage.getByText(frTitle).first(),
				).toBeVisible({timeout: 20_000});

				const subResp = await dbarnesPage.request.get(
					`/index.php/publicknowledge/api/v1/submissions/${submissionId}`,
				);
				expect(subResp.ok()).toBeTruthy();
				const subBody = await subResp.json();
				expect(subBody.locale).toBe('fr_CA');
			},
		);
	});

	test.describe('as editor on publicknowledge', () => {
		test.use({user: 'dbarnes'});

		// Row 2 — Reconfigure modal changes language and section
		// mid-wizard. Absorbed from wizard-language.spec.js (test 1).
		test(
			'reconfigure modal changes language and section mid-wizard',
			{tag: '@regression'},
			async ({page}) => {
				const tag = uniqueTag();
				const title = `Language ${tag}`;

				const wizard = new SubmissionWizardPage(page);
				await wizard.goto();
				await wizard.start({title, section: 'Articles'});

				// After Begin Submission, the wizard caption reads
				// "Submitting to the Articles section in English."
				// Scope to the submission-configuration container so any
				// other copy hosting the word "English" can't match.
				const configSection = page.locator('#submission-configuration');
				await expect(configSection).toContainText(/Articles/);
				await expect(configSection).toContainText(/English/);

				// Open the reconfigure modal and pick French (Canada) +
				// Reviews. Reviews is the second seeded section on
				// publicknowledge (see playwright/fixtures/bootstrap.js);
				// picking it in the same action proves both radios re-bind
				// the caption, not just the locale one.
				await wizard.openReconfigureModal();
				await wizard.changeReconfigureSettings({
					localeLabel: 'French (Canada)',
					sectionLabel: 'Reviews',
				});

				// Caption re-renders to reflect the new submission state.
				await expect(configSection).toContainText(/Reviews/);
				await expect(configSection).toContainText(/French \(Canada\)/);

				// Step 1 is Upload Files. Advance to Details to verify the
				// metadata controls rendered under French (fr_CA) ids — the
				// wizard stores the primary form locale in step state, and
				// the Details step's Title/Abstract fields switch their
				// `control-{locale}` id suffix accordingly. This is the
				// load-bearing assertion: without it, the caption change
				// could be cosmetic.
				await wizard.continueStep();
				await wizard.expectStep('Details');

				// The Title control for French is `titleAbstract-title-control-fr_CA`.
				// The English control (`-en`) should not be the primary /
				// initially-visible field anymore. TinyMCE's visible iframe
				// is the one whose `control-` prefix matches the current
				// step locale; assert the French iframe is present.
				await expect(
					page.locator('textarea#titleAbstract-title-control-fr_CA'),
				).toBeAttached();

				// The pkpFormLocales__locale widget — the secondary-locale
				// row at the top of a multilingual form — should show the
				// locale label "French (Canada)" highlighted as the primary.
				// Scope to the current step (Details) because subsequent
				// steps render their own copies of the widget.
				const detailsStep = page.locator(
					'.pkpStep:has(.pkpFormLocales__locale)',
				).first();
				await expect(
					detailsStep
						.locator('.pkpFormLocales__locale', {hasText: 'French (Canada)'})
						.first(),
				).toBeVisible();

				// Type a short French-locale title into the new fr_CA
				// control. The assertion that follows (the value populates
				// the backing <textarea> via editor.save()) proves the field
				// is bound to the new locale's state — not just that the
				// caption changed.
				const frenchTitle = `Titre ${tag}`;
				await wizard.setTitle(frenchTitle, 'fr_CA');

				// setTinyMceContent invokes editor.save() which mirrors the
				// editor's HTML content into the backing <textarea>. Check
				// the textarea value directly rather than reloading the
				// wizard — the wizard's `:started-steps` guard only lets the
				// user click back to steps they've completed, and a reload
				// wipes that set, so reloading and re-clicking "Details"
				// through the stepper isn't viable. The Details step's
				// autosave pipeline is covered by submission-wizard-language
				// row 4 and isn't the feature under test here; the feature
				// is the locale re-render. Checking the textarea value
				// proves the fr_CA-suffixed control is the one receiving
				// the keystrokes.
				const titleFrTextarea = page.locator(
					'textarea#titleAbstract-title-control-fr_CA',
				);
				await expect(titleFrTextarea).toHaveValue(
					new RegExp(frenchTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
				);
			},
		);

		// Row 3 — Review-step errors render in the new locale. Absorbed
		// from wizard-language.spec.js (test 2).
		test(
			'review-step validation errors render under FR-locale panels when submission locale is fr_CA',
			{tag: '@regression'},
			async ({page}) => {
				const tag = uniqueTag();

				const wizard = new SubmissionWizardPage(page);
				await wizard.goto();
				// Start with a tiny title so we can clear it and reach the
				// Review step with a known required-field error. Picking
				// Articles (the section with no extra metadata gates) keeps
				// the only error path the Title field's required validation.
				await wizard.start({title: `Lang-errors ${tag}`, section: 'Articles'});

				// Switch the submission locale to fr_CA. After this, the
				// Details step's primary form locale flips, and Review
				// will render the locale-specific review panels keyed off
				// "Details (French (Canada))" / "Details (English)".
				await wizard.openReconfigureModal();
				await wizard.changeReconfigureSettings({
					localeLabel: 'French (Canada)',
				});

				// Walk to Details + clear the FR Title to force a
				// required-field error at Review. The wizard auto-seeds the
				// FR Title from the Start form's initial value because
				// reconfigure with a single supported locale sets the
				// primary form locale; clearing it gives Review a deterministic
				// "missing in fr_CA" assertion.
				await wizard.continueStep();
				await wizard.expectStep('Details');
				await wizard.clearTitle('fr_CA');

				// Walk through Contributors + For the Editors + Reviewer
				// Suggestions to Review. The wizard's required-field validation
				// runs only when Continue lands on Review; intermediate steps
				// don't gate missing fr_CA title. (Validation row 2 already
				// exercises EN-side validation; this test's value is the
				// locale-prefixed review-panel headings.) The Reviewer
				// Suggestions step exists because reviewerSuggestionEnabled
				// is on for the bootstrapped journal
				// (playwright/fixtures/bootstrap.js); suggestions are
				// optional, so it advances freely.
				await wizard.continueStep(); // Details → Contributors
				await wizard.continueStep(); // Contributors → For the Editors
				await wizard.continueStep(); // For the Editors → Reviewer Suggestions
				await wizard.continueStep(); // Reviewer Suggestions → Review
				await wizard.expectStep('Review');

				// Top-level errors banner mirrors the EN flow but in the
				// same UI locale (English; UI locale wasn't switched —
				// only the submission's primary form locale changed). The
				// per-panel review headings use the SUBMISSION locale's
				// label as the suffix, so we anchor on
				// "Details (French (Canada))".
				await expect(page.getByText(/There are one or more problems/i)).toBeVisible({
					timeout: 15_000,
				});

				const frDetailsPanel = page
					.locator('.submissionWizard__reviewPanel')
					.filter({has: page.getByRole('heading', {name: /Details \(French \(Canada\)\)/})});
				await expect(frDetailsPanel).toHaveCount(1);
				await expect(frDetailsPanel).toContainText('This field is required.');

				// Conversely, the EN-locale review panel — which exists when
				// supportedLocales includes en alongside fr_CA — must NOT
				// carry the missing-title warning, since the EN title was
				// never required (submission locale is fr_CA). Anchor by
				// asserting the EN panel does not contain the same warning
				// label. The bootstrap publicknowledge journal has
				// supportedSubmissionLocales=['en','fr_CA'], so the EN
				// panel will be present.
				const enDetailsPanel = page
					.locator('.submissionWizard__reviewPanel')
					.filter({has: page.getByRole('heading', {name: /Details \(English\)/})});
				if (await enDetailsPanel.count()) {
					await expect(enDetailsPanel.first()).not.toContainText(
						'This field is required.',
					);
				}
			},
		);
	});

	// Row 6 — Single-locale journal hides language choices: no language
	// radio on the start form, no locale field in the reconfigure
	// modal. A second section is seeded so the reconfigure entry point
	// (the "Change" button renders when 2+ sections OR 2+ locales
	// exist) is still reachable.
	test(
		'a single-locale journal offers no language choice in start form or reconfigure modal',
		{tag: '@regression'},
		async ({pkpApi, browser, baseURL}) => {
			const tag = uniqueTag();
			const secondTitle = `Second ${tag}`;

			// EN-only scratch journal (supportedLocales defaults to the
			// primary locale). The `sections` passthrough replaces the
			// auto-installed default Articles section, so declare both.
			const {context} = await pkpApi.createJournal({
				tag,
				users: [{username: 'dbarnes', roles: ['manager']}],
				sections: [
					{abbrev: {en: 'ART'}, title: {en: 'Articles'}},
					{abbrev: {en: 'SEC'}, title: {en: secondTitle}},
				],
			});

			const ctx = await browser.newContext({baseURL});
			try {
				const page = await ctx.newPage();
				// Scratch-journal login — baseline storageState is
				// publicknowledge-scoped.
				await page.goto(`/index.php/${context.path}/en/login`);
				await page.locator('input#username').fill('dbarnes');
				await page.locator('input#password').fill('dbarnesdbarnes');
				await page.locator('form#login button').click();
				await page.waitForURL(
					(url) => !url.pathname.includes('/login'),
					{timeout: 15_000},
				);

				const wizard = new SubmissionWizardPage(page, context.path);
				await wizard.goto();
				await expect(
					page.getByRole('heading', {name: 'Make a Submission'}),
				).toBeVisible({timeout: 15_000});
				await expect(
					page.locator('#startSubmission-title-control_ifr'),
				).toBeAttached({timeout: 15_000});

				// The Section radio renders (2 sections)…
				const sectionField = page.locator('.pkpFormField--options', {
					has: page.locator('legend', {hasText: 'Section'}),
				});
				await expect(sectionField).toBeVisible();
				// …but the Submission Language radio does not
				// (StartSubmission::addLanguage bails below 2 locales).
				await expect(
					page.locator('legend', {hasText: 'Submission Language'}),
				).toHaveCount(0);

				// Begin a submission so the reconfigure modal is
				// reachable.
				await wizard.start({
					title: `Single locale ${tag}`,
					section: secondTitle,
				});
				await wizard.expectStep('Upload Files');

				// The reconfigure modal offers the section radio but no
				// locale field (ReconfigureSubmission only adds it for
				// 2+ supported submission locales).
				await wizard.openReconfigureModal();
				const modal = page.locator('[data-cy="active-modal"]');
				await expect(
					modal.locator('label', {hasText: secondTitle}).first(),
				).toBeVisible();
				await expect(
					modal.locator('legend', {hasText: 'Submission Language'}),
				).toHaveCount(0);
			} finally {
				await ctx.close();
			}
		},
	);
});
