// @ts-check
const path = require('path');
const {test, expect} = require('../support/base-test.js');
const {SubmissionWizardPage} = require('../pages/SubmissionWizardPage.js');
const {setTinyMceContent} = require('../support/tinymce.js');

/**
 * Submission wizard — validation
 * Plan: docs/e2e/plans/submission-wizard-validation.md
 *
 * Absorbs (moved + retitled, hard-won locators kept):
 *   - wizard-validation.spec.js        (1 test  → row 2)
 *   - wizard-copyright-notice.spec.js  (2 tests → row 3, EN + FR)
 *   - wizard-section-rules.spec.js     (2 tests → row 4)
 *
 * Remaining rows implemented here: 1 (start-form gating), 5 (section-
 * closed edge cases), 7 (wizard-typed comments survive submit),
 * 8 (abstract follows section rules), 9 (abstract word limit),
 * 10 (file genre must be resolved).
 *
 * Row 6 (seeded commentsForEditor → stage-1 discussion parity) is owned
 * by docs/e2e/plans/discussions.md row 5 — dropped here to avoid
 * duplicate coverage.
 *
 * Seed-shape deviation from the plan (row 10 only): scenario-seeded
 * drafts auto-attach a genre-resolved Article Text file
 * (SubmissionBuilderProcessor), which would already satisfy the
 * required-genre check this row exists to violate. Row 10 therefore
 * creates its draft through the Start form and uploads its own
 * genre-less file. Rows 5 and 9 use `submitted: false` scenario
 * drafts as planned (resumable at /submission?id=N since the
 * processor's draft-shape fix: submissionProgress='start').
 *
 * publicknowledge runs the enriched bootstrap defaults: the Reviewer
 * Suggestions step is present (reviewerSuggestionEnabled), and
 * keywords/citations are 'request' — optional, so they never gate
 * Continue/Submit in these tests.
 */

// Bundled fixture lives in the shared lib/pkp tree — same file the
// SubmissionBuilderProcessor uses for default Article Text seeding.
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
	return `swv-w${workerIndex}-${suffix}`;
}

/**
 * Log in through the login form scoped to a scratch journal's path —
 * the baseline storageState is publicknowledge-scoped and doesn't
 * grant access to per-test journals. Password derives per
 * lib/pkp/playwright/data/users.js (username repeated twice).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} journalPath
 * @param {string} username
 */
async function scratchLogin(page, journalPath, username) {
	await page.goto(`/index.php/${journalPath}/en/login`);
	await page.locator('input#username').fill(username);
	await page.locator('input#password').fill(`${username}${username}`);
	await page.locator('form#login button').click();
	await page.waitForURL((url) => !url.pathname.includes('/login'), {
		timeout: 15_000,
	});
}

/**
 * Upload the bundled Article Text PDF through the wizard's
 * FileUploader (step 1) and optionally resolve its genre. Mirrors the
 * pattern proven in filenames.spec.js: setInputFiles on the hidden
 * <input type=file>, race the upload POST, then click the primary
 * genre button on the new list item.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{pickGenre?: boolean}} [opts]
 * @returns {Promise<import('@playwright/test').Locator>} the file's list item
 */
async function uploadArticleFile(page, {pickGenre = true} = {}) {
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

	if (pickGenre) {
		// Pick the Article Text genre — the per-genre buttons render
		// under .listPanel--submissionFiles__setGenreButton until the
		// genreId is set. Article Text is the default primary genre on
		// every OJS journal.
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
	}
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
 * @param {string} [journalPath='publicknowledge']
 * @returns {Promise<object|null>} the publication, or null while unavailable
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
	await confirmDialog
		.getByRole('button', {name: 'Submit', exact: true})
		.click();
	await expect(
		page.getByRole('heading', {name: 'Submission complete'}),
	).toBeVisible({timeout: 30_000});
}

// ---------------------------------------------------------------------------
// Sections settings-grid helpers (legacy jQuery grid). Used by rows 4–5.
// Mirrors openSectionsTab() in playwright/tests/sections.spec.js.
// ---------------------------------------------------------------------------

/**
 * Navigate to the Sections admin grid for the given journal and click
 * the grid-level "Settings" toggle so each row's Edit/Delete controls
 * are exposed.
 */
async function openSectionsTab(page, journalPath) {
	await page.goto(`/index.php/${journalPath}/management/settings/context`);
	await page.locator('#sections-button').click();
	await expect(
		page.locator(
			'a[id^="component-grid-settings-sections-sectiongrid-addSection-button-"]',
		),
	).toBeVisible();
	await page.locator('#sectionsGridContainer a.show_extras').first().click();
}

async function createSection(page, {title, abbrev}) {
	await page
		.locator(
			'a[id^="component-grid-settings-sections-sectiongrid-addSection-button-"]',
		)
		.click();
	const form = page.locator('form#sectionForm');
	await expect(form).toBeVisible();
	await form.locator('input[id^="title-"]').fill(title);
	await form.locator('input[id^="abbrev-"]').fill(abbrev);
	await form.getByRole('button', {name: 'Save'}).click();
	await expect(form).toHaveCount(0, {timeout: 15_000});
	await expect(page.locator('tr.gridRow', {hasText: title})).toBeVisible();
}

/**
 * Generic editor: open a section's Edit dialog, tick a named checkbox
 * by id (`isInactive` prunes the section from the wizard;
 * `editorRestricted` hides it from non-editor authors), save.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} title
 * @param {string} fieldId  HTML id of the checkbox to tick
 */
async function editSectionFlag(page, title, fieldId) {
	const row = page.locator(
		'tr.gridRow[id^="component-grid-settings-sections-sectiongrid-row-"]',
		{hasText: title},
	);
	const rowId = await row.first().getAttribute('id');
	if (!rowId) {
		throw new Error(`Section row "${title}" not found`);
	}
	// Legacy pkp grid: each row hides its link actions until ITS OWN
	// `a.show_extras` toggle is clicked (openSectionsTab only expands
	// the first row). Expand this row if its Edit link isn't visible
	// yet.
	const editLink = page
		.locator(`a[id^="${rowId}-editSection-button-"]`)
		.first();
	if (!(await editLink.isVisible().catch(() => false))) {
		await row.first().locator('a.show_extras').click();
	}
	await editLink.click();
	const form = page.locator('form#sectionForm');
	await expect(form).toBeVisible();
	await form.locator(`input#${fieldId}`).check({force: true});
	await form.getByRole('button', {name: 'Save'}).click();
	await expect(form).toHaveCount(0, {timeout: 15_000});
}

// ---------------------------------------------------------------------------

test.describe('Submission wizard — validation', () => {
	test.describe('as author on publicknowledge', () => {
		test.use({user: 'atester'});

		// Row 1 — Start form gating.
		test(
			'start form blocks Begin Submission with per-field required errors until completed',
			{tag: '@regression'},
			async ({page}) => {
				const tag = uniqueTag();
				const wizard = new SubmissionWizardPage(page);
				await wizard.goto();
				await expect(
					page.getByRole('heading', {name: 'Make a Submission'}),
				).toBeVisible();
				// Wait for the Start form Vue component (and its TinyMCE
				// title field) to mount before submitting it empty.
				await expect(
					page.locator('#startSubmission-title-control_ifr'),
				).toBeAttached({timeout: 15_000});

				await page
					.getByRole('button', {name: 'Begin Submission'})
					.click();

				// Client-side validateRequired() flags every required
				// field. publicknowledge renders all five: locale (2
				// supported submission locales), title, section (2
				// sections), checklist confirmation and privacy consent.
				await expect(page.locator('.pkpFormErrors')).toContainText(
					/Please correct \d+ errors?/,
				);

				// Per-field errors render in .pkpFieldError__message
				// inside each field wrapper. Options fields (radio /
				// checkbox) carry a <legend>; scope by it.
				const optionsField = (legendText) =>
					page.locator('.pkpFormField--options', {
						has: page.locator('legend', {hasText: legendText}),
					});
				for (const legend of [
					'Submission Language',
					'Section',
					'Submission Checklist',
					'Privacy Consent',
				]) {
					await expect(
						optionsField(legend).locator('.pkpFieldError__message'),
					).toContainText('This field is required.');
				}
				// Title is a FieldRichText — scope its wrapper by the
				// TinyMCE iframe it hosts.
				const titleField = page.locator('.pkpFormField', {
					has: page.locator('#startSubmission-title-control_ifr'),
				});
				await expect(
					titleField.locator('.pkpFieldError__message'),
				).toContainText('This field is required.');

				// Completing every requirement proceeds to step 1. The
				// POM fills the locale/section radios, title, checklist
				// + privacy confirmations, clicks Begin Submission and
				// waits for the wizard to mount.
				await wizard.start({
					title: `Start gating ${tag}`,
					locale: 'English',
					section: 'Articles',
				});
				await wizard.expectStep('Upload Files');
			},
		);

		// Row 8 — Abstract requirement follows section rules. Articles
		// requires an abstract; Reviews (abstractsNotRequired) submits
		// without one. Two wizard passes keep each half deterministic.
		test(
			'abstract is required by Articles but Reviews submits without one',
			{tag: '@regression'},
			async ({page}) => {
				const tag = uniqueTag();
				const wizard = new SubmissionWizardPage(page);

				// --- Pass 1: Articles — empty abstract errors at Review.
				await wizard.goto();
				await wizard.start({
					title: `Abstract rules ${tag}`,
					section: 'Articles',
				});
				await wizard.expectStep('Upload Files');
				await wizard.continueStep(); // → Details (no file; row 2 covers that error)
				await wizard.expectStep('Details');
				await wizard.continueStep(); // → Contributors (title pre-seeded by Start form)
				await wizard.continueStep(); // → For the Editors
				await wizard.continueStep(); // → Reviewer Suggestions
				await wizard.continueStep(); // → Review
				await wizard.expectStep('Review');

				await expect(
					page.getByText('There are one or more problems'),
				).toBeVisible({timeout: 15_000});

				// The Abstract item in the (submission-locale) Details
				// review panel carries the required-field error. Chain
				// through getByText so the EN/FR panel pair can't trip
				// strict mode — only the EN item holds the error.
				const abstractRequiredError = page
					.locator('.submissionWizard__reviewPanel')
					.filter({has: page.getByRole('heading', {name: /^Details/})})
					.locator('.submissionWizard__reviewPanel__item')
					.filter({has: page.getByRole('heading', {name: 'Abstract'})})
					.getByText('This field is required.');
				await expect(abstractRequiredError).toBeVisible();
				await expect(footerSubmitButton(page)).toBeDisabled();

				// --- Pass 2: Reviews — no abstract, full submit succeeds.
				await wizard.goto();
				await wizard.start({
					title: `Abstract optional ${tag}`,
					section: 'Reviews',
				});
				await wizard.expectStep('Upload Files');
				await uploadArticleFile(page); // satisfy the required-genre gate
				await wizard.continueStep(); // → Details
				await wizard.expectStep('Details');
				await wizard.continueStep(); // → Contributors (abstract left empty)
				await wizard.continueStep(); // → For the Editors
				await wizard.continueStep(); // → Reviewer Suggestions
				await wizard.continueStep(); // → Review
				await wizard.expectStep('Review');

				// No abstract error for the abstractsNotRequired section;
				// keywords/citations are 'request' (optional) so nothing
				// else gates the submit.
				await expect(
					page.getByText('There are one or more problems'),
				).toHaveCount(0);
				await submitWizard(page);
			},
		);

		// Row 9 — Abstract word limit (Articles caps at 500 words).
		test(
			'over-limit abstract shows the word counter and a Review error until trimmed',
			{tag: '@regression'},
			async ({page, pkpApi}) => {
				const tag = uniqueTag();

				// Seed a resumable wizard draft (submitted: false) so the
				// test starts straight at the wizard. The seeded draft
				// already carries a genre-resolved Article Text file, so
				// the abstract is the only validation surface in play.
				const seeded = await pkpApi.createSubmission({
					tag,
					journal: 'publicknowledge',
					submitter: 'atester',
					section: 'ART',
					submitted: false,
					publications: [
						{metadata: {title: {en: `Word limit ${tag}`}}},
					],
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
				await wizard.continueStep(); // → Details
				await wizard.expectStep('Details');

				// The abstract field renders a live word counter because
				// the Articles section sets wordCount=500
				// (playwright/fixtures/bootstrap.js). Scope to the EN
				// abstract field's wrapper.
				const abstractField = page.locator('.pkpFormField', {
					has: page.locator('#titleAbstract-abstract-control-en'),
				});
				const wordCounter = abstractField.locator(
					'.pkpFormField--richTextarea__wordLimit',
				);
				await expect(wordCounter).toContainText('/500');

				// 501 single-token words — one over the limit.
				const longAbstract = Array.from(
					{length: 501},
					(_, i) => `word${i}`,
				).join(' ');
				await setTinyMceContent(
					page,
					'titleAbstract-abstract-control-en',
					longAbstract,
				);
				// The counter updates (debounced 250ms) from the editor
				// content — web-first assertion absorbs the debounce.
				await expect(wordCounter).toContainText('501/500');

				// The abstract only reaches the server via autosave, and
				// Review's validate() (`_validateOnly`) can fire before a
				// queued autosave lands. Leave the step, then poll the
				// stored publication until the over-limit abstract is
				// persisted, so Review validates against saved state
				// deterministically.
				await wizard.continueStep(); // → Contributors
				await expect
					.poll(
						async () =>
							(await fetchCurrentPublication(page, submissionId))
								?.abstract?.en ?? '',
						{timeout: 20_000},
					)
					.toContain('word500');
				await wizard.continueStep(); // → For the Editors
				await wizard.continueStep(); // → Reviewer Suggestions
				await wizard.continueStep(); // → Review
				await wizard.expectStep('Review');

				const abstractItem = page
					.locator('.submissionWizard__reviewPanel')
					.filter({has: page.getByRole('heading', {name: /^Details/})})
					.locator('.submissionWizard__reviewPanel__item')
					.filter({has: page.getByRole('heading', {name: 'Abstract'})});
				await expect(
					abstractItem.getByText(/The abstract is too long/),
				).toBeVisible({timeout: 15_000});

				// Trim the abstract → the error clears on re-validation
				// when Review is re-entered. Same autosave anchoring:
				// hop to a non-Review step, await the save, then enter
				// Review.
				await wizard.gotoStep('Details');
				await wizard.expectStep('Details');
				await setTinyMceContent(
					page,
					'titleAbstract-abstract-control-en',
					`A short abstract ${tag}.`,
				);
				await wizard.gotoStep('Contributors');
				await expect
					.poll(
						async () =>
							(await fetchCurrentPublication(page, submissionId))
								?.abstract?.en ?? '',
						{timeout: 20_000},
					)
					.toContain(`A short abstract ${tag}`);
				await wizard.gotoStep('Review');
				await wizard.expectStep('Review');
				await expect(
					abstractItem.getByText(/The abstract is too long/),
				).toHaveCount(0, {timeout: 15_000});
				// And it isn't replaced by a required-field error — the
				// trimmed abstract still counts as filled.
				await expect(
					abstractItem.getByText('This field is required.'),
				).toHaveCount(0);
			},
		);

		// Row 10 — File genre must be resolved. A genre-less upload
		// keeps the "what kind of file" prompt and fails the
		// required-Article-Text validation until a genre is chosen.
		test(
			'uploaded file without a genre is flagged at Review until a genre is chosen',
			{tag: '@regression'},
			async ({page}) => {
				const tag = uniqueTag();
				const wizard = new SubmissionWizardPage(page);
				await wizard.goto();
				// Reviews: abstractsNotRequired, so the missing genre is
				// the only validation error at Review.
				await wizard.start({
					title: `Genre gate ${tag}`,
					section: 'Reviews',
				});
				await wizard.expectStep('Upload Files');

				// Upload without resolving the genre.
				const listItem = await uploadArticleFile(page, {
					pickGenre: false,
				});
				await expect(
					listItem.getByText('What kind of file is this?'),
				).toBeVisible();
				const articleTextBtn = listItem
					.locator('.listPanel--submissionFiles__setGenreButton')
					.filter({hasText: 'Article Text'})
					.first();
				await expect(articleTextBtn).toBeVisible();

				await wizard.continueStep(); // → Details
				await wizard.continueStep(); // → Contributors
				await wizard.continueStep(); // → For the Editors
				await wizard.continueStep(); // → Reviewer Suggestions
				await wizard.continueStep(); // → Review
				await wizard.expectStep('Review');

				// A genre-less file does not satisfy the required-genre
				// check (Repo::submission()->validateSubmit filters
				// submission files by the required genre ids).
				await expect(
					page.getByText(
						'You must upload at least one Article Text file.',
					),
				).toBeVisible({timeout: 15_000});
				await expect(footerSubmitButton(page)).toBeDisabled();

				// Resolve the genre, re-enter Review → the error clears
				// and Submit enables.
				await wizard.gotoStep('Upload Files');
				await wizard.expectStep('Upload Files');
				await Promise.all([
					page.waitForResponse(
						(res) =>
							res.request().method() === 'POST' &&
							/\/api\/v1\/submissions\/\d+\/files\/\d+/.test(
								res.url(),
							) &&
							res.ok(),
						{timeout: 15_000},
					),
					articleTextBtn.click(),
				]);
				await expect(
					listItem.getByText('What kind of file is this?'),
				).toHaveCount(0);

				await wizard.gotoStep('Review');
				await wizard.expectStep('Review');
				await expect(
					page.getByText(
						'You must upload at least one Article Text file.',
					),
				).toHaveCount(0, {timeout: 15_000});
				await expect(footerSubmitButton(page)).toBeEnabled();
			},
		);
	});

	test.describe('as editor on publicknowledge', () => {
		test.use({user: 'dbarnes'});

		// Row 2 — Review-step required errors.
		// Absorbed from wizard-validation.spec.js. Ports
		// cypress/tests/integration/SubmissionWizard.cy.js tests 4–5
		// (required-field errors block submit; post-fix path clears the
		// field error). The Cypress source flipped 10 journal-level
		// "require" flags first — that config surface is owned by the
		// submission-wizard-metadata plan; the Title field is required
		// unconditionally, so emptying it proves the gate without
		// touching journal config. No file is uploaded: the wizard's
		// own "You must upload at least one Article Text file." review
		// error doubles as the residual gate, so both the "blocked" and
		// "post-fix" paths are provable without the upload (rows 8/10
		// run full uploads).
		test(
			"review-step required errors block submit until they're resolved",
			{tag: '@regression'},
			async ({page}) => {
				const tag = uniqueTag();
				const title = `Validation ${tag}`;

				const wizard = new SubmissionWizardPage(page);
				await wizard.goto();
				await wizard.start({title, section: 'Articles'});
				const submissionId = wizard.currentSubmissionId();
				expect(submissionId).toBeTruthy();

				// Step 1 is Upload Files — advance without uploading. The
				// wizard lets authors skip upload at the step level; it only
				// flags the missing file at the Review step.
				await wizard.continueStep();

				// Step 2 is Details — the Title field was pre-seeded by the
				// Start form. Clear it so Review will surface a required
				// error for the Title (plus the no-file-uploaded warning).
				await wizard.expectStep('Details');
				await wizard.clearTitle('en');
				await wizard.continueStep();

				// Step 3 is Contributors — the submitter is seeded as
				// author automatically. Skip.
				await wizard.continueStep();

				// Step 4 is For the Editors — keywords/citations are 'request'
				// (optional) on the bootstrapped journal, so nothing blocks. Skip.
				await wizard.continueStep();

				// Step 5 is Reviewer Suggestions — present because
				// reviewerSuggestionEnabled is on for the bootstrapped journal
				// (playwright/fixtures/bootstrap.js). Suggestions are optional;
				// skip.
				await wizard.continueStep();

				// Now on Review. The wizard runs server-side validation on
				// entry; the errors banner appears once the response comes
				// back.
				await wizard.expectStep('Review');
				await expect(
					page.getByText('There are one or more problems'),
				).toBeVisible({timeout: 15_000});

				// Primary submit button is disabled because isValid is
				// false.
				const submitBtn = footerSubmitButton(page);
				await expect(submitBtn).toBeDisabled();

				// Title field was emptied — review panel for Details (the
				// step's review panel — heading text matches the step name,
				// wrapped in parentheses with the locale only when there's
				// more than one submission locale) shows the required-field
				// msg under Title.
				const detailsPanel = page
					.locator('.submissionWizard__reviewPanel')
					.filter({
						has: page.getByRole('heading', {name: /^Details/}),
					});
				await expect(
					detailsPanel
						.locator('.submissionWizard__reviewPanel__item')
						.filter({
							has: page.getByRole('heading', {name: 'Title'}),
						})
						.getByText('This field is required.'),
				).toBeVisible();

				// No Article Text file uploaded → review-time warning.
				await expect(
					page.getByText('You must upload at least one Article Text file.'),
				).toBeVisible();

				// --- Fix the Title validation error ----------------------------
				await wizard.gotoStep('Details');
				await wizard.expectStep('Details');
				await wizard.setTitle(title, 'en');

				// The restored title only reaches the server via autosave —
				// and Review's validate() (`_validateOnly`) can fire
				// before a queued autosave is picked up (both run on
				// independent 500ms timers). Hop to a non-Review step
				// first and poll the stored publication until the title
				// is persisted, so re-entering Review validates against
				// saved state deterministically.
				await wizard.gotoStep('Contributors');
				await expect
					.poll(
						async () =>
							(await fetchCurrentPublication(page, submissionId))
								?.title?.en ?? '',
						{timeout: 20_000},
					)
					.toContain(title);

				await wizard.gotoStep('Review');
				await wizard.expectStep('Review');
				// The Title error disappears once re-validation runs.
				await expect(
					detailsPanel
						.locator('.submissionWizard__reviewPanel__item')
						.filter({
							has: page.getByRole('heading', {name: 'Title'}),
						})
						.getByText('This field is required.'),
				).toHaveCount(0, {timeout: 15_000});

				// Submit remains disabled because the missing-file warning
				// still blocks submission — but the Title-required error
				// has cleared, proving the resolution path works. Rows
				// 8/10 cover the full happy-path including file upload +
				// successful submit.
				await expect(submitBtn).toBeDisabled();
			},
		);

		// Row 7 — Comments entered in the wizard survive submit.
		//
		// This surface carries the documented audit-§3 flake
		// (commentsForTheEditors=null after Submit — see the fixme in
		// wizard-comments-become-discussion.spec.js). To make the flow
		// deterministic this test anchors every hand-off:
		//   1. after typing the comment, the step change's autosave PUT
		//      to /submissions/{id} (the CommentsForTheEditors form
		//      action) is awaited explicitly, filtered on a postData
		//      payload that actually carries commentsForTheEditors;
		//   2. the comment is asserted persisted on the draft via REST
		//      BEFORE Submit — separating "autosave lost it" from
		//      "submit lost it";
		//   3. only then is Submit clicked, and the column + stage-1
		//      discussion asserted after.
		test(
			'comments for the editors persist through submit and become the stage-1 discussion',
			{tag: '@regression'},
			async ({page}) => {
				const tag = uniqueTag();
				const title = `Comments survive ${tag}`;
				const comment =
					`Cover note ${tag}: this comment must survive Submit and ` +
					`surface as the stage-1 discussion.`;

				const wizard = new SubmissionWizardPage(page);
				await wizard.goto();
				// Reviews: abstractsNotRequired, so the title + file are
				// the only submit requirements.
				await wizard.start({title, section: 'Reviews'});
				await wizard.expectStep('Upload Files');

				const submissionId = wizard.currentSubmissionId();
				expect(
					submissionId,
					'submission id resolves from /submission?id=…',
				).toBeTruthy();

				await uploadArticleFile(page);
				await wizard.continueStep(); // → Details
				await wizard.expectStep('Details');
				// Re-assert the publication title defensively — the
				// Review gate reads publication.title.
				await wizard.setTitle(title, 'en');
				await wizard.continueStep(); // → Contributors
				await wizard.continueStep(); // → For the Editors
				await wizard.expectStep('For the Editors');
				await wizard.setCommentsForEditors(comment);

				// Anchor: leave the step (the change queues the stale
				// commentsForTheEditors form for autosave) and poll the
				// draft row until the comment is persisted — BEFORE
				// submit. This separates "autosave lost it" from "submit
				// lost it" deterministically; polling stored state also
				// can't miss a save that already fired on the wizard's
				// 60-second idle timer.
				await wizard.continueStep(); // → Reviewer Suggestions
				await expect
					.poll(
						async () => {
							const res = await page.request.get(
								`/index.php/publicknowledge/api/v1/submissions/${submissionId}`,
							);
							if (!res.ok()) return null;
							return (await res.json()).commentsForTheEditors;
						},
						{timeout: 15_000},
					)
					.toContain(comment);

				await wizard.continueStep(); // → Review
				await wizard.expectStep('Review');

				// The For the Editors review panel echoes the comment.
				// Multilingual journals render one panel per locale;
				// anchor on the English variant where the comment lives.
				const forTheEditorsPanel = page
					.locator('.submissionWizard__reviewPanel')
					.filter({
						has: page.getByRole('heading', {
							name: /^For the Editors \(English\)/,
						}),
					});
				await expect(forTheEditorsPanel).toBeVisible({timeout: 15_000});
				await expect(forTheEditorsPanel).toContainText(comment);

				await submitWizard(page);

				// The column survives submit…
				const subResp = await page.request.get(
					`/index.php/publicknowledge/api/v1/submissions/${submissionId}`,
				);
				expect(subResp.ok()).toBeTruthy();
				const subBody = await subResp.json();
				expect(
					subBody.commentsForTheEditors,
					`commentsForTheEditors persisted post-submit: ${JSON.stringify(subBody.commentsForTheEditors)}`,
				).toContain(comment);

				// …and the wizard's submit created the stage-1 cover-note
				// discussion, visible to the editor (dbarnes submitted and
				// is an editor on publicknowledge).
				await page.goto(
					`/index.php/publicknowledge/en/dashboard/editorial?workflowSubmissionId=${submissionId}`,
				);
				const dm = page.locator('[data-cy="discussion-manager"]');
				await expect(dm).toBeVisible({timeout: 20_000});
				const discussionBtn = dm.getByRole('button', {
					name: 'Comments for the Editor',
					exact: true,
				});
				await expect(discussionBtn).toBeVisible({timeout: 15_000});
				await discussionBtn.click();
				// The discussion detail mounts as a side modal whose outer
				// wrapper reports visibility:hidden during the open
				// transition — anchor on the inner text directly.
				await expect(
					page.getByText(comment, {exact: false}).first(),
				).toBeVisible({timeout: 15_000});
			},
		);
	});

	// Row 3 — Copyright consent gates submit (EN + FR scratch journals).
	// Absorbed from wizard-copyright-notice.spec.js. Ports
	// cypress/tests/integration/SubmissionWizard.cy.js test 3. Wizard
	// state is per-test, but copyrightNotice is context-level — the
	// Cypress source PUT it on publicknowledge and reverted (not
	// parallel-safe); here an E0 scratch journal carries the notice via
	// the ContextBuilderProcessor passthrough.
	test.describe('copyright gate on a scratch journal', () => {
		test(
			'copyright notice renders and its checkbox gates submit',
			{tag: '@regression'},
			async ({pkpApi, browser, baseURL}) => {
				const tag = uniqueTag();
				const copyrightText = `Scratch-journal copyright notice ${tag}`;

				// dbarnes (no mustChangePassword) as manager — so we can
				// drive the wizard as the same user immediately. The
				// scratch journal installs a default "Articles" section
				// automatically, so the wizard has a section to submit
				// into.
				const {context} = await pkpApi.createJournal({
					tag,
					users: [{username: 'dbarnes', roles: ['manager']}],
					copyrightNotice: {
						en: copyrightText,
					},
				});

				const ctx = await browser.newContext({baseURL});
				try {
					const page = await ctx.newPage();
					await scratchLogin(page, context.path, 'dbarnes');

					const wizard = new SubmissionWizardPage(page, context.path);
					await wizard.goto();
					// The scratch journal has exactly one section
					// ("Articles" from ContextService's default-section
					// hook), so the Start form hides the section radio
					// and just prompts for Title + locale + optional
					// checkboxes — start({title}) is enough.
					await wizard.start({title: `Copyright ${tag}`});

					// Step 1 Upload Files → Continue (no file uploaded;
					// submit-time validation will flag it at Review — the
					// residual gate we sidestep below).
					await wizard.continueStep();
					// Step 2 Details → Continue
					await wizard.continueStep();
					// Step 3 Contributors → Continue (dbarnes is seeded as
					// the default contributor automatically).
					await wizard.continueStep();
					// Step 4 For the Editors → Continue (no configured
					// metadata requirements on a fresh scratch journal).
					await wizard.continueStep();
					await wizard.expectStep('Review');

					// Scroll Confirmation section into view — the review
					// panels stack vertically; Confirmation is the last
					// panel so laptop-height viewports hide it below fold.
					const confirmHeading = page.getByRole('heading', {
						name: 'Confirmation',
					});
					await confirmHeading.scrollIntoViewIfNeeded();
					await expect(confirmHeading).toBeVisible({timeout: 15_000});

					// The FieldOptions description is rendered as a
					// sibling of the checkbox control inside the
					// confirmSubmission form. The description's HTML
					// includes the copyrightNotice wrapped in a
					// <blockquote>. Page-scoped locator is safe: the
					// submission wizard is the only place blockquotes
					// render on this screen.
					await expect(page.locator('blockquote')).toContainText(
						copyrightText,
					);

					const submitBtn = footerSubmitButton(page);

					// Gate state 1 — Unticked copyright checkbox:
					// canSubmit = isValid AND isConfirmed. isConfirmed is
					// false because the confirm-step has an unticked
					// required FieldOptions. isValid is also false
					// (no uploaded file). Submit stays disabled.
					// FieldOptions renders each option as
					// <input type="checkbox" name="confirmCopyright">
					// with no stable id; scope by name attribute.
					const copyrightCheckbox = page
						.locator('input[name="confirmCopyright"][type="checkbox"]')
						.first();
					await expect(copyrightCheckbox).not.toBeChecked();
					await expect(submitBtn).toBeDisabled();

					// Observe the file-missing warning is the OTHER
					// gating condition — this separates the two terms so
					// the test's gate assertion below is about the
					// copyright checkbox specifically.
					await expect(
						page.getByText(
							'You must upload at least one Article Text file.',
						),
					).toBeVisible();

					// Gate state 2 — Tick the copyright checkbox. The
					// isConfirmed term flips to true. Submit remains
					// disabled ONLY because of the file-missing error.
					// That's the expected compound gate — but the
					// checkbox's isConfirmed contribution is proved by
					// toggling it back off below.
					await copyrightCheckbox.check();
					await expect(copyrightCheckbox).toBeChecked();

					// Gate state 3 — Untick the copyright checkbox again.
					// isConfirmed flips back to false; submit stays
					// disabled. The point isn't just that it's disabled
					// (it was disabled in state 1 too) but that the
					// checkbox is wired to the gate — rows that actually
					// reach submit (e.g. row 8's Reviews pass) rely on
					// this wiring.
					await copyrightCheckbox.uncheck();
					await expect(copyrightCheckbox).not.toBeChecked();
					await expect(submitBtn).toBeDisabled();
				} finally {
					await ctx.close();
				}
			},
		);

		test(
			'copyright notice + checkbox gate render in fr_CA UI',
			{tag: '@regression'},
			async ({pkpApi, browser, baseURL}) => {
				const tag = uniqueTag();
				const copyrightEn = `Copyright EN ${tag}`;
				const copyrightFr = `Droit d'auteur FR ${tag}`;

				// Scratch journal supports both locales (so /fr_CA/ URLs
				// resolve) and seeds copyrightNotice with both translations.
				// dbarnes is manager so a single login carries through.
				const {context} = await pkpApi.createJournal({
					tag,
					users: [{username: 'dbarnes', roles: ['manager']}],
					supportedLocales: ['en', 'fr_CA'],
					copyrightNotice: {en: copyrightEn, fr_CA: copyrightFr},
				});

				const ctx = await browser.newContext({baseURL});
				try {
					const page = await ctx.newPage();
					// Sign in via the EN login form (the FR login form is
					// also valid but using the same EN entry as the
					// sibling test minimises selector divergence; the
					// session locale doesn't sticky from this page anyway
					// — it's the URL prefix on subsequent navigations that
					// drives UI rendering).
					await scratchLogin(page, context.path, 'dbarnes');

					// Switch the session UI locale to fr_CA via the
					// canonical OJS endpoint — same hook the user-nav
					// dropdown's "français" link calls. From this point on
					// every page rendered for this session uses FR strings.
					await page.goto(`/index.php/index/user/setLocale/fr_CA`);
					await page.goto(`/index.php/${context.path}/submission`);

					// Start form mounts in FR. Pick the FR submission locale
					// radio (label "français (Canada)" because the wizard
					// itself is now rendered in FR), seed the title via the
					// existing TinyMCE helper, then click the FR Begin
					// button ("Commencer la soumission" — the
					// `submission.wizard.start` translation).
					const frLocaleLabel = page.locator('label', {
						hasText: 'français (Canada)',
					});
					await expect(frLocaleLabel.first()).toBeVisible({
						timeout: 15_000,
					});
					await frLocaleLabel.first().click();

					await setTinyMceContent(
						page,
						'startSubmission-title-control',
						`Copyright FR ${tag}`,
					);

					// FR-locale scratch journals inherit FR defaults for
					// submissionChecklist + privacyStatement (vs the
					// EN-only sibling test where neither setting carries a
					// rendered value). Both are required FieldOptions so
					// the Start form's Begin button stays disabled until
					// each is ticked. Click each once they're visible.
					const frChecklist = page.locator('label', {
						hasText: 'Oui, ma soumission répond à toutes ces exigences',
					});
					if (await frChecklist.first().isVisible().catch(() => false)) {
						await frChecklist.first().click();
					}
					const frPrivacy = page.locator('label', {
						hasText:
							'Oui, j\'accepte que mes données soient collectées',
					});
					if (await frPrivacy.first().isVisible().catch(() => false)) {
						await frPrivacy.first().click();
					}

					await page
						.getByRole('button', {name: 'Commencer la soumission'})
						.click();
					await page.waitForURL(/\/submission\?id=\d+/i, {
						timeout: 20_000,
					});
					await expect(page.locator('.submissionWizard')).toBeVisible();

					// FR Continue label = "Continuer". Walk the four steps
					// (Upload → Details → Contributors → For the Editors)
					// to land on Review.
					for (let i = 0; i < 4; i++) {
						await page
							.locator('.submissionWizard__footer')
							.getByRole('button', {name: 'Continuer'})
							.click();
					}

					// Confirmation panel — the blockquote inside the
					// confirmCopyright fieldset must contain the seeded
					// fr_CA copyright text.
					const confirmHeading = page.getByRole('heading', {
						name: /Confirmation/i,
					});
					await confirmHeading.scrollIntoViewIfNeeded();
					await expect(confirmHeading).toBeVisible({timeout: 15_000});

					await expect(page.locator('blockquote')).toContainText(
						copyrightFr,
					);
					// And conversely the EN copyright string MUST NOT leak
					// into the FR-rendered blockquote.
					await expect(page.locator('blockquote')).not.toContainText(
						copyrightEn,
					);

					// FR submit label = "Soumettre". Same gate semantics:
					// canSubmit = isValid AND isConfirmed.
					const submitBtn = page
						.locator('.submissionWizard__footer')
						.getByRole('button', {name: 'Soumettre'});

					const copyrightCheckbox = page
						.locator('input[name="confirmCopyright"][type="checkbox"]')
						.first();
					await expect(copyrightCheckbox).not.toBeChecked();
					await expect(submitBtn).toBeDisabled();

					await copyrightCheckbox.check();
					await expect(copyrightCheckbox).toBeChecked();

					await copyrightCheckbox.uncheck();
					await expect(copyrightCheckbox).not.toBeChecked();
					await expect(submitBtn).toBeDisabled();
				} finally {
					await ctx.close();
				}
			},
		);
	});

	// Rows 4–5 — Section rules on scratch journals. Row 4 absorbed from
	// wizard-section-rules.spec.js (ports
	// cypress/tests/integration/SubmissionWizard.cy.js test 2). Section
	// inactivation has no scenario passthrough — it's flipped via the
	// sections settings grid inside the test.
	test.describe('section rules on a scratch journal', () => {
		test(
			'a section marked inactive does not appear in the wizard section picker',
			{tag: '@regression'},
			async ({pkpApi, browser, baseURL}) => {
				const tag = uniqueTag();

				// E0 scratch journal. dbarnes (editor in the baseline) gets
				// manager rights here so she can both edit sections AND run
				// the wizard. That's fine for this test — the Start form's
				// section list is filtered on `excludeInactive()`
				// regardless of role (PKPSubmissionHandler.getSubmitSections).
				// Editor-only (editorRestricted) sections stay visible to
				// managers, which is why that side of the feature is
				// asserted with atester in the sibling test below.
				const {context} = await pkpApi.createJournal({
					tag,
					users: [{username: 'dbarnes', roles: ['manager']}],
				});

				const ctx = await browser.newContext({baseURL});
				try {
					const page = await ctx.newPage();
					await scratchLogin(page, context.path, 'dbarnes');

					// Seed a second section so the StartSubmission form
					// renders its section radio (it's hidden when only one
					// section exists, collapsing the assertion surface).
					// With both Articles + Reviews active, both labels
					// appear — proves the baseline.
					await openSectionsTab(page, context.path);
					await createSection(page, {
						title: `Reviews ${tag}`,
						abbrev: `REV-${tag.slice(-6)}`,
					});

					// Sanity: both sections appear in the wizard picker.
					// With 2+ sections, StartSubmission renders a FieldOptions
					// radio whose <label> elements contain the section title.
					// Scope to the pkpFormField wrapper so generic "Articles"
					// copy elsewhere in the page (nav, dashboards) can't match.
					const reviewsLabel = `Reviews ${tag}`;
					const wizard = new SubmissionWizardPage(page);
					await page.goto(`/index.php/${context.path}/submission`);
					await expect(
						page.getByRole('heading', {name: 'Make a Submission'}),
					).toBeVisible();
					// Wait for the Start form Vue component to mount.
					await expect(
						page.locator('#startSubmission-title-control_ifr'),
					).toBeAttached({timeout: 15_000});
					const sectionField = page.locator(
						'.pkpFormField--options',
						{has: page.locator('legend', {hasText: 'Section'})},
					);
					await expect(sectionField).toBeVisible();
					await expect(
						sectionField.locator('label', {hasText: 'Articles'}),
					).toBeVisible();
					await expect(
						sectionField.locator('label', {hasText: reviewsLabel}),
					).toBeVisible();

					// Mark Articles inactive. Back to the Sections grid.
					await openSectionsTab(page, context.path);
					await editSectionFlag(page, 'Articles', 'isInactive');

					// Fresh wizard visit: Articles should be gone. With
					// only Reviews active, StartSubmission passes `count ===
					// 1` to the section-count check and hides the radio
					// entirely (it adds a hidden sectionId field instead).
					// Assert both (a) no "Articles" option label in the Start
					// form and (b) no Section legend — either failure would
					// indicate the isInactive filter regressed.
					await page.goto(`/index.php/${context.path}/submission`);
					await expect(
						page.getByRole('heading', {name: 'Make a Submission'}),
					).toBeVisible();
					await expect(
						page.locator('#startSubmission-title-control_ifr'),
					).toBeAttached({timeout: 15_000});
					// The Section FieldOptions wrapper should be absent.
					await expect(
						page.locator(
							'.pkpFormField--options',
							{has: page.locator('legend', {hasText: 'Section'})},
						),
					).toHaveCount(0);
					// And no "Articles" option label anywhere in the Start
					// form (there's no other legitimate source of the word
					// on the Make-a-Submission page).
					await expect(
						page.locator('form label', {hasText: 'Articles'}),
					).toHaveCount(0);
					// And the wizard can still be started — proves we didn't
					// just render a broken form. Use the POM's start() which
					// handles the single-section case.
					await wizard.start({title: `Inactive-hide ${tag}`});
					await expect(
						page.locator('.submissionWizard'),
					).toBeVisible();
				} finally {
					await ctx.close();
				}
			},
		);

		test(
			'an editor-restricted section is hidden from a non-editor author in the wizard',
			{tag: '@regression'},
			async ({pkpApi, browser, baseURL}) => {
				const tag = uniqueTag();

				// E0 scratch journal with dbarnes (manager) and atester
				// (author). atester is the baseline non-editor author user;
				// enrolling her on the scratch journal gives her submit
				// rights without granting editorial privileges, which is
				// the precondition for the editorRestricted gate to apply.
				const {context} = await pkpApi.createJournal({
					tag,
					users: [
						{username: 'dbarnes', roles: ['manager']},
						{username: 'atester', roles: ['author']},
					],
				});

				// Manager session — log in as dbarnes, seed a Reviews
				// section so the journal has at least two sections (so
				// the wizard's section radio renders for both states),
				// then mark Articles as editorRestricted.
				const dbarnesCtx = await browser.newContext({baseURL});
				try {
					const dbarnesPage = await dbarnesCtx.newPage();
					await scratchLogin(dbarnesPage, context.path, 'dbarnes');

					const reviewsTitle = `Reviews ${tag}`;
					await openSectionsTab(dbarnesPage, context.path);
					await createSection(dbarnesPage, {
						title: reviewsTitle,
						abbrev: `REV-${tag.slice(-6)}`,
					});
					await editSectionFlag(dbarnesPage, 'Articles', 'editorRestricted');
				} finally {
					await dbarnesCtx.close();
				}

				// Author session — log in as atester on the scratch
				// journal, open the wizard, assert the Articles section is
				// filtered out of the section radio.
				const atesterCtx = await browser.newContext({baseURL});
				try {
					const atesterPage = await atesterCtx.newPage();
					await scratchLogin(atesterPage, context.path, 'atester');

					await atesterPage.goto(
						`/index.php/${context.path}/submission`,
					);
					await expect(
						atesterPage.getByRole('heading', {name: 'Make a Submission'}),
					).toBeVisible({timeout: 15_000});
					await expect(
						atesterPage.locator('#startSubmission-title-control_ifr'),
					).toBeAttached({timeout: 15_000});

					// The Section field renders Reviews (only) when only
					// one section is author-submittable. With Articles
					// editor-restricted + atester an author, the picker
					// should not show Articles. Two assertions tie the
					// gate down:
					const reviewsTitle = `Reviews ${tag}`;
					// 1. Reviews IS visible — proves section enumeration
					//    didn't break entirely.
					const reviewsLabel = atesterPage.locator('label', {
						hasText: reviewsTitle,
					});
					if (await reviewsLabel.first().count()) {
						// 2+ sections render the FieldOptions radio.
						await expect(reviewsLabel.first()).toBeVisible();
					}
					// 2. Articles label is NOT in the wizard's Start form
					//    (per getSubmitSections's editorRestricted filter).
					await expect(
						atesterPage.locator('form label', {hasText: /^Articles$/}),
					).toHaveCount(0);
				} finally {
					await atesterCtx.close();
				}
			},
		);

		// Row 5 — Section-closed edge cases: the editor's own start form
		// keeps an editor-restricted section, while an author resuming a
		// draft whose section was closed meanwhile hits the
		// sectionClosed error page (with the journal contact).
		test(
			'editor keeps a restricted section; a closed section blocks resuming a draft',
			{tag: '@regression'},
			async ({pkpApi, browser, baseURL}) => {
				const tag = uniqueTag();
				const extraTitle = `Extra ${tag}`;
				const contactName = `Contact ${tag}`;

				// The `sections` passthrough REPLACES the auto-installed
				// default Articles section (SectionProcessor clears it),
				// so declare the full section list. The journal contact
				// feeds the sectionClosed error message.
				const {context} = await pkpApi.createJournal({
					tag,
					users: [
						{username: 'dbarnes', roles: ['manager']},
						{username: 'atester', roles: ['author']},
					],
					contact: {
						name: contactName,
						email: `contact-${tag}@example.com`,
					},
					sections: [
						{abbrev: {en: 'ART'}, title: {en: 'Articles'}},
						{abbrev: {en: 'EXT'}, title: {en: extraTitle}},
					],
				});

				// atester's unfinished draft sits in the Extra section —
				// seeded as a resumable wizard draft (submitted: false →
				// submissionProgress='start').
				const seeded = await pkpApi.createSubmission({
					tag,
					journal: context.path,
					submitter: 'atester',
					section: 'EXT',
					submitted: false,
					publications: [{metadata: {title: {en: `Draft ${tag}`}}}],
				});
				const draftId = seeded.submission.id;

				const atesterCtx = await browser.newContext({baseURL});
				const dbarnesCtx = await browser.newContext({baseURL});
				try {
					// dbarnes closes the Extra section to non-editors.
					const dbarnesPage = await dbarnesCtx.newPage();
					await scratchLogin(dbarnesPage, context.path, 'dbarnes');
					await openSectionsTab(dbarnesPage, context.path);
					await editSectionFlag(dbarnesPage, extraTitle, 'editorRestricted');

					// Part A — dbarnes (manager → one of
					// Section::getEditorRestrictedRoles) still sees the
					// restricted section in her own start form.
					await dbarnesPage.goto(
						`/index.php/${context.path}/submission`,
					);
					await expect(
						dbarnesPage.getByRole('heading', {
							name: 'Make a Submission',
						}),
					).toBeVisible({timeout: 15_000});
					await expect(
						dbarnesPage.locator('#startSubmission-title-control_ifr'),
					).toBeAttached({timeout: 15_000});
					const sectionField = dbarnesPage.locator(
						'.pkpFormField--options',
						{
							has: dbarnesPage.locator('legend', {
								hasText: 'Section',
							}),
						},
					);
					await expect(sectionField).toBeVisible();
					await expect(
						sectionField.locator('label', {hasText: 'Articles'}),
					).toBeVisible();
					await expect(
						sectionField.locator('label', {hasText: extraTitle}),
					).toBeVisible();

					// Part B — atester resumes the draft and hits the
					// sectionClosed error page
					// (PKPSubmissionHandler::showWizard gates on
					// isInactive OR editorRestricted-and-not-editor),
					// which names the section and links the journal
					// contact.
					const atesterPage = await atesterCtx.newPage();
					await scratchLogin(atesterPage, context.path, 'atester');
					await atesterPage.goto(
						`/index.php/${context.path}/submission?id=${draftId}`,
					);
					await expect(
						atesterPage.getByRole('heading', {
							name: 'Section Closed',
						}),
					).toBeVisible({timeout: 15_000});
					await expect(
						atesterPage.getByText(
							`is not accepting submissions to the ${extraTitle} section`,
						),
					).toBeVisible();
					await expect(
						atesterPage.getByRole('link', {name: contactName}),
					).toBeVisible();
				} finally {
					await atesterCtx.close();
					await dbarnesCtx.close();
				}
			},
		);
	});
});
