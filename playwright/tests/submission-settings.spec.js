// @ts-check
const path = require('path');
const {test, expect} = require('../support/base-test.js');
const {setTinyMceContent} = require('../support/tinymce.js');
const {waitForJQueryIdle} = require('../support/jquery.js');
const {SubmissionWizardPage} = require('../pages/SubmissionWizardPage.js');

/**
 * Submission settings
 * Plan: docs/e2e/plans/submission-settings.md
 *
 * Three tests, all on E0 scratch journals (journal-level settings are
 * the behavior under test, so every mutation is driven through the UI):
 *
 *   1. Workflow > Submission > Instructions: authorGuidelines +
 *      submissionChecklist + beginSubmissionHelp save through the
 *      SubmissionGuidanceSettings form; the public about/submissions
 *      page renders guidelines + checklist
 *      (lib/pkp/templates/frontend/pages/submissions.tpl) and the
 *      wizard Start form surfaces the custom before-you-begin help +
 *      checklist (StartSubmission::addIntroduction /
 *      addSubmissionChecklist read the same context settings).
 *   2. Workflow > Submission > Components: a custom genre added via
 *      the legacy GenreGridHandler grid persists across reload, shows
 *      up among the wizard upload step's file-kind buttons
 *      (SubmissionFilesListItem.vue renders every primary genre as a
 *      one-click prompt button), and deletes cleanly from the grid.
 *      Upload mechanics themselves are submission-wizard-core's scope.
 *   3. Workflow > Submission > Disable Submissions: the toggle saves
 *      through PKPDisableSubmissionsForm; settings pages render the
 *      not-accepting <notification> banner (workflow.tpl:22-26), the
 *      public about/submissions page switches to the not-accepting
 *      message and drops the "Make a new submission" link, and the
 *      dashboard side-nav loses its "Start A New Submission" entry
 *      (PKPTemplateManager.php:1166). Untoggling restores all three.
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
	return `sst-w${workerIndex}-${suffix}`;
}

/**
 * Open the Workflow settings page and activate the Submission outer tab
 * plus one of its inner side-tabs. PkpTabs id hooks: outer
 * `#submission-button`, inner `#{tabId}-button` (same convention the
 * wizard-config-reset spec uses for `#metadata-button`).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} journalPath
 * @param {string} innerTabId  e.g. 'instructions', 'components', 'disableSubmissions'
 */
async function openWorkflowSubmissionTab(page, journalPath, innerTabId) {
	await page.goto(`/index.php/${journalPath}/management/settings/workflow`);
	await page.locator('#submission-button').click();
	await page.locator(`#${innerTabId}-button`).click();
}

/**
 * Open Workflow > Submission > Components and wait for the legacy
 * jQuery genre grid (load_url_in_div) to arrive.
 */
async function openComponentsGrid(page, journalPath) {
	await openWorkflowSubmissionTab(page, journalPath, 'components');
	await expect(
		page.locator('#genresGridContainer a[id*="addGenre"]').first(),
	).toBeVisible({timeout: 15_000});
}

/**
 * Race a pkp-form Save click against the context settings round-trip.
 * Every form on the workflow/website settings pages PUTs to
 * /api/v1/contexts/{id} (tunneled through POST via
 * X-Http-Method-Override, so match either verb).
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} form
 */
async function saveContextForm(page, form) {
	await Promise.all([
		page.waitForResponse(
			(res) =>
				/\/api\/v1\/contexts\/\d+/.test(res.url()) &&
				res.ok() &&
				['POST', 'PUT'].includes(res.request().method()),
			{timeout: 15_000},
		),
		form.getByRole('button', {name: 'Save', exact: true}).click(),
	]);
}

/**
 * Fresh anonymous context — the explicit empty storageState matters:
 * contexts otherwise inherit the file-level storage state (patterns.md
 * parallel-load lesson 8).
 *
 * @param {import('@playwright/test').Browser} browser
 * @param {string} baseURL
 */
async function anonContext(browser, baseURL) {
	return browser.newContext({
		baseURL,
		storageState: {cookies: [], origins: []},
	});
}

test.describe('Submission settings', () => {
	test(
		'submission guidance texts surface on about/submissions and the wizard start form',
		{tag: '@regression'},
		async ({pkpApi, asUser, browser, baseURL}) => {
			const tag = uniqueTag();
			const guidelinesText = `Guidelines ${tag}: include a structured abstract.`;
			const checklistText = `Checklist ${tag}: the manuscript is anonymized.`;
			const beforeStartText = `BeforeStart ${tag}: read the section policies first.`;

			const {context} = await pkpApi.createJournal({
				tag,
				name: {en: `Guidance scratch ${tag}`},
				users: [{username: 'dbarnes', roles: ['manager']}],
			});
			const ctx = await asUser('dbarnes');
			const page = await ctx.newPage();

			// Set the three guidance texts on the Instructions form. The
			// SubmissionGuidanceSettings form id is
			// `submissionGuidanceSettings`; its FieldRichTextarea control
			// ids follow `{formId}-{field}-control-{locale}`.
			await openWorkflowSubmissionTab(page, context.path, 'instructions');
			await setTinyMceContent(
				page,
				'submissionGuidanceSettings-authorGuidelines-control-en',
				`<p>${guidelinesText}</p>`,
			);
			await setTinyMceContent(
				page,
				'submissionGuidanceSettings-beginSubmissionHelp-control-en',
				`<p>${beforeStartText}</p>`,
			);
			await setTinyMceContent(
				page,
				'submissionGuidanceSettings-submissionChecklist-control-en',
				`<p>${checklistText}</p>`,
			);
			await saveContextForm(page, page.locator('#instructions form').first());

			// Anonymous reader: about/submissions renders the guidelines
			// and checklist sections with the saved texts.
			const anon = await anonContext(browser, baseURL);
			try {
				const reader = await anon.newPage();
				const resp = await reader.goto(
					`/index.php/${context.path}/about/submissions`,
				);
				expect(resp?.status()).toBe(200);
				await expect(
					reader.getByRole('heading', {name: 'Author Guidelines'}),
				).toBeVisible();
				await expect(reader.getByText(guidelinesText)).toBeVisible();
				await expect(
					reader.getByRole('heading', {
						name: 'Submission Preparation Checklist',
					}),
				).toBeVisible();
				await expect(reader.getByText(checklistText)).toBeVisible();
			} finally {
				await anon.close();
			}

			// Wizard Start form: the custom before-you-begin help renders
			// as the StartSubmission introduction, and the checklist text
			// is the description of the must-confirm checkbox.
			await page.goto(`/index.php/${context.path}/submission`);
			await expect(
				page.getByRole('heading', {name: 'Make a Submission'}),
			).toBeVisible({timeout: 15_000});
			await expect(page.getByText(beforeStartText)).toBeVisible();
			await expect(page.getByText(checklistText)).toBeVisible();
			await expect(
				page.locator('label', {
					hasText:
						'Yes, my submission meets all of these requirements.',
				}),
			).toBeVisible();
		},
	);

	test(
		'custom file component appears in the wizard upload choices and deletes from the grid',
		{tag: '@regression'},
		async ({pkpApi, asUser}) => {
			const tag = uniqueTag();
			const genreName = `Component ${tag}`;

			const {context} = await pkpApi.createJournal({
				tag,
				name: {en: `Components scratch ${tag}`},
				users: [{username: 'dbarnes', roles: ['manager']}],
			});
			const ctx = await asUser('dbarnes');
			const page = await ctx.newPage();

			// --- Create the genre via the Components grid modal ---
			await openComponentsGrid(page, context.path);
			await page
				.locator('#genresGridContainer a[id*="addGenre"]')
				.first()
				.click();
			const form = page.locator('form#genreForm');
			await expect(form).toBeVisible({timeout: 15_000});
			// fbvElement ids are runtime-suffixed; target by name. The
			// dependent/supplementary checkboxes stay off so the new
			// genre is a primary one (only primary genres are offered as
			// one-click file-kind buttons in the wizard).
			await form.locator('input[name="name[en]"]').fill(genreName);
			await form.getByRole('button', {name: 'Save'}).click();
			// AjaxFormHandler closes the modal + refreshes the grid.
			await waitForJQueryIdle(page);
			await expect(form).toHaveCount(0, {timeout: 15_000});

			// Reload the page → the genre persisted into the grid.
			await openComponentsGrid(page, context.path);
			const row = page.locator('#genresGridContainer tr.gridRow', {
				hasText: genreName,
			});
			await expect(row).toBeVisible();

			// --- Wizard upload step offers it as a file-kind choice ---
			const wizard = new SubmissionWizardPage(page, context.path);
			await wizard.goto();
			await wizard.start({title: `Component wizard ${tag}`});
			await wizard.expectStep('Upload Files');
			const item = await wizard.uploadFile(ARTICLE_FIXTURE);
			// The "What kind of file is this?" prompt lists every primary
			// genre as a button; the custom one must be among them. Do
			// NOT assign it — a genre with assigned files refuses
			// deletion (GenreGridHandler::deleteGenre).
			await expect(
				item.locator('.listPanel--submissionFiles__setGenreButton', {
					hasText: genreName,
				}),
			).toBeVisible();
			await expect(
				item.locator('.listPanel--submissionFiles__setGenreButton', {
					hasText: 'Article Text',
				}),
			).toBeVisible();

			// --- Delete from the grid → gone ---
			await openComponentsGrid(page, context.path);
			const rowAgain = page.locator('#genresGridContainer tr.gridRow', {
				hasText: genreName,
			});
			await expect(rowAgain).toBeVisible();
			const rowId = await rowAgain.getAttribute('id');
			expect(rowId).toBeTruthy();
			// Row controls hide until the row's show_extras toggle is
			// expanded (patterns.md pitfall 9).
			await rowAgain.locator('a.show_extras').click();
			await page
				.locator(`a[id^="${rowId}-deleteGenre-button-"]`)
				.first()
				.click();
			const confirm = page.locator('[role="dialog"]', {
				hasText: /wish to delete this item/i,
			});
			await expect(confirm).toBeVisible({timeout: 10_000});
			await confirm.getByRole('button', {name: 'OK'}).click();
			await waitForJQueryIdle(page);
			await expect(
				page.locator('#genresGridContainer tr.gridRow', {
					hasText: genreName,
				}),
			).toHaveCount(0, {timeout: 15_000});
		},
	);

	test(
		'disable submissions blocks new-submission entry points journal-wide',
		{tag: '@regression'},
		async ({pkpApi, asUser, browser, baseURL}) => {
			const tag = uniqueTag();
			const {context} = await pkpApi.createJournal({
				tag,
				name: {en: `Disable scratch ${tag}`},
				users: [{username: 'dbarnes', roles: ['manager']}],
			});
			const ctx = await asUser('dbarnes');
			const page = await ctx.newPage();

			// Positive controls while submissions are open: the public
			// about/submissions page offers "Make a new submission" to a
			// logged-in user, and the dashboard side-nav carries the
			// "Start A New Submission" entry.
			await page.goto(`/index.php/${context.path}/about/submissions`);
			await expect(
				page.getByRole('link', {name: 'Make a new submission'}),
			).toBeVisible({timeout: 15_000});

			await page.goto(`/index.php/${context.path}/dashboard/editorial`);
			const nav = page.locator('nav#app-nav');
			await expect(nav).toBeVisible({timeout: 20_000});
			await expect(
				nav.getByText('Start A New Submission'),
			).toBeVisible({timeout: 15_000});

			// --- Toggle Disable Submissions on ---
			await openWorkflowSubmissionTab(
				page,
				context.path,
				'disableSubmissions',
			);
			const toggle = page
				.locator('#disableSubmissions input[name="disableSubmissions"]')
				.first();
			await expect(toggle).toBeVisible({timeout: 15_000});
			await toggle.check();
			await saveContextForm(
				page,
				page.locator('#disableSubmissions form').first(),
			);

			// Settings pages render the not-accepting banner after reload
			// (workflow.tpl renders it server-side from the saved flag).
			await page.goto(
				`/index.php/${context.path}/management/settings/workflow`,
			);
			await expect(
				page.getByText(/not accepting submissions at this time/i).first(),
			).toBeVisible({timeout: 15_000});

			// Dashboard side-nav: "Start A New Submission" is gone. The
			// dashboards group label renders as "Editor Dashboard" —
			// wait for it as the positive landmark bounding the negative
			// assertion.
			await page.goto(`/index.php/${context.path}/dashboard/editorial`);
			await expect(nav).toBeVisible({timeout: 20_000});
			await expect(nav.getByText('Editor Dashboard').first()).toBeVisible({
				timeout: 15_000,
			});
			await expect(nav.getByText('Start A New Submission')).toHaveCount(0);

			// Logged-in about/submissions: not-accepting message replaces
			// the new-submission link.
			await page.goto(`/index.php/${context.path}/about/submissions`);
			await expect(
				page.getByText(/not accepting submissions at this time/i),
			).toBeVisible();
			await expect(
				page.getByRole('link', {name: 'Make a new submission'}),
			).toHaveCount(0);

			// Anonymous reader sees the same not-accepting message.
			const anon = await anonContext(browser, baseURL);
			try {
				const reader = await anon.newPage();
				const resp = await reader.goto(
					`/index.php/${context.path}/about/submissions`,
				);
				expect(resp?.status()).toBe(200);
				await expect(
					reader.getByText(/not accepting submissions at this time/i),
				).toBeVisible();
			} finally {
				await anon.close();
			}

			// --- Untoggle → entry points return ---
			await openWorkflowSubmissionTab(
				page,
				context.path,
				'disableSubmissions',
			);
			const toggleAgain = page
				.locator('#disableSubmissions input[name="disableSubmissions"]')
				.first();
			await expect(toggleAgain).toBeChecked();
			await toggleAgain.uncheck();
			await saveContextForm(
				page,
				page.locator('#disableSubmissions form').first(),
			);

			await page.goto(
				`/index.php/${context.path}/management/settings/workflow`,
			);
			// Wait for the page heading before the negative assertion so
			// the banner's absence is checked on a rendered page.
			await expect(
				page.getByRole('heading', {name: 'Workflow Settings'}),
			).toBeVisible({timeout: 15_000});
			await expect(
				page.getByText(/not accepting submissions at this time/i),
			).toHaveCount(0);

			await page.goto(`/index.php/${context.path}/about/submissions`);
			await expect(
				page.getByRole('link', {name: 'Make a new submission'}),
			).toBeVisible();

			await page.goto(`/index.php/${context.path}/dashboard/editorial`);
			await expect(nav).toBeVisible({timeout: 20_000});
			await expect(
				nav.getByText('Start A New Submission'),
			).toBeVisible({timeout: 15_000});
		},
	);
});
