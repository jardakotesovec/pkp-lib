// @ts-check
const path = require('path');
const {test, expect} = require('../support/base-test.js');
const {setTinyMceContent} = require('../support/tinymce.js');
const {WebsiteSettingsPage} = require('../pages/WebsiteSettingsPage.js');

/**
 * Website appearance — docs/e2e/plans/website-appearance.md rows 1–3,
 * 5–6 (row 4, date formats, asserts OJS issue/article dates and lives
 * in the OJS tree: playwright/tests/website-appearance-dates.spec.js).
 *
 * Each test seeds its own scratch journal (the appearance forms are
 * journal-level singletons; publicknowledge stays read-only) and drives
 * the Settings > Website forms as dbarnes, then verifies the journal's
 * anonymous front end reflects the change:
 *
 *   1. (plan row 1) Logo upload (FieldUploadImage → dropzone →
 *      temporaryFiles API) persists through save + reload and renders
 *      in the public header (header.tpl `.pkp_site_name a.is_img img`)
 *      with the alt text; the file URL resolves 200.
 *   2. (plan row 2) homepageImage (Setup tab) + additionalHomeContent
 *      (Advanced tab) both render on the journal homepage
 *      (indexJournal.tpl `.homepage_image` / `.additional_content`).
 *   3. (plan row 3) Default-theme options: a custom `baseColour` (hex
 *      typed into the FieldColor chrome-picker input) + `typography`
 *      radio persist on reload; the anonymous front end's COMPILED
 *      LESS reflects both (computed background-color of
 *      .pkp_structure_head, computed font-family of body) — the
 *      contexts/{id}/theme PUT clears the CSS cache
 *      (PKPContextController::editTheme:518-519) so the next
 *      front-end hit recompiles.
 *   5. (plan row 5) Sidebar block round-trip: enabling the Information
 *      block renders it in the reader sidebar; disabling removes it
 *      (and with no blocks left, the has_sidebar wrapper class too).
 *   6. (plan row 6) A unique pageFooter renders on the homepage AND on
 *      /about — footer.tpl is included by every front-end page, so two
 *      distinct pages prove site-wide injection.
 *
 * Theme-option save note: PKPThemeForm's PUT goes to
 * /api/v1/contexts/{id}/theme; all other forms here PUT
 * /api/v1/contexts/{id}. WebsiteSettingsPage#saveForm's default
 * endpoint matches both; row 3 narrows to the /theme suffix.
 */

test.use({user: 'dbarnes'});

const IMAGE_FIXTURE = path.join(
	__dirname,
	'..',
	'fixtures',
	'files',
	'dependent-image.png',
);

test.describe('Website appearance', () => {
	test(
		'logo upload renders in the public header',
		{tag: '@regression'},
		async ({page, pkpApi, browser, baseURL}) => {
			const tag = scratchTag('walogo');
			const {context} = await pkpApi.createJournal({
				tag,
				name: {en: `Appearance logo ${tag}`},
				users: [{username: 'dbarnes', roles: ['manager']}],
			});
			const altText = `Journal logo ${tag}`;

			const settings = new WebsiteSettingsPage(page, context.path);
			await settings.goto();
			const setupPanel = await settings.openAppearanceTab('appearance-setup');

			const altInput = await settings.uploadImage(
				'appearanceSetup',
				'pageHeaderLogoImage',
				IMAGE_FIXTURE,
			);
			await altInput.fill(altText);
			await settings.saveForm(setupPanel);

			// --- Persistence: reload the settings page; the saved value
			// renders the preview state (thumbnail + alt text input). ---
			await settings.goto();
			await settings.openAppearanceTab('appearance-setup');
			await expect(
				page.locator('#appearanceSetup-pageHeaderLogoImage-altText-en'),
			).toHaveValue(altText, {timeout: 15_000});

			// --- Anonymous public header renders the logo ---
			const anon = await anonContext(browser, baseURL);
			try {
				const reader = await anon.newPage();
				const resp = await reader.goto(`/index.php/${context.path}/`);
				expect(resp?.status()).toBe(200);

				const logo = reader.locator('.pkp_site_name a.is_img img');
				await expect(logo).toBeVisible();
				await expect(logo).toHaveAttribute('alt', altText);

				// The image URL (publicFilesDir/uploadName) resolves 200.
				const src = await logo.getAttribute('src');
				expect(src).toBeTruthy();
				const imgResp = await reader.request.get(String(src));
				expect(imgResp.status()).toBe(200);
				expect(imgResp.headers()['content-type']).toContain('image');
			} finally {
				await anon.close();
			}
		},
	);

	test(
		'homepage image and additional homepage content render on the journal homepage',
		{tag: '@regression'},
		async ({page, pkpApi, browser, baseURL}) => {
			const tag = scratchTag('wahome');
			const {context} = await pkpApi.createJournal({
				tag,
				name: {en: `Appearance homepage ${tag}`},
				users: [{username: 'dbarnes', roles: ['manager']}],
			});
			const altText = `Homepage banner ${tag}`;
			const contentMarker = `Extra homepage content ${tag}`;

			const settings = new WebsiteSettingsPage(page, context.path);
			await settings.goto();

			// --- Setup tab: homepageImage upload ---
			const setupPanel = await settings.openAppearanceTab('appearance-setup');
			const altInput = await settings.uploadImage(
				'appearanceSetup',
				'homepageImage',
				IMAGE_FIXTURE,
			);
			await altInput.fill(altText);
			await settings.saveForm(setupPanel);

			// --- Advanced tab: additionalHomeContent (TinyMCE) ---
			const advancedPanel = await settings.openAppearanceTab('advanced');
			await setTinyMceContent(
				page,
				'appearanceAdvanced-additionalHomeContent-control-en',
				`<p>${contentMarker}</p>`,
			);
			await settings.saveForm(advancedPanel);

			// --- Anonymous homepage renders both ---
			const anon = await anonContext(browser, baseURL);
			try {
				const reader = await anon.newPage();
				const resp = await reader.goto(`/index.php/${context.path}/`);
				expect(resp?.status()).toBe(200);

				// indexJournal.tpl renders the image only when the theme's
				// useHomepageImageAsHeader option is off (the default).
				const homepageImg = reader.locator('.homepage_image img');
				await expect(homepageImg).toBeVisible();
				await expect(homepageImg).toHaveAttribute('alt', altText);
				const src = await homepageImg.getAttribute('src');
				const imgResp = await reader.request.get(String(src));
				expect(imgResp.status()).toBe(200);

				await expect(reader.locator('.additional_content')).toContainText(
					contentMarker,
				);
			} finally {
				await anon.close();
			}
		},
	);

	test(
		'default theme options change the front-end presentation',
		{tag: '@regression'},
		async ({page, pkpApi, browser, baseURL}) => {
			const tag = scratchTag('watheme');
			const {context} = await pkpApi.createJournal({
				tag,
				name: {en: `Appearance theme ${tag}`},
				users: [{username: 'dbarnes', roles: ['manager']}],
			});

			// #8a1f2b: no 3-digit shorthand, dark (isColourDark keeps the
			// white header text), and never collides with the #1E6292
			// default. rgb(138, 31, 43) is its computed-style form.
			const baseColour = '8a1f2b';
			const baseColourRgb = 'rgb(138, 31, 43)';

			const settings = new WebsiteSettingsPage(page, context.path);
			await settings.goto();
			const themePanel = await settings.openAppearanceTab('theme');

			// --- typography: Lora (radio option of the default theme) ---
			const loraRadio = themePanel.locator(
				'input[name="typography"][value="lora"]',
			);
			await expect(loraRadio).toBeVisible({timeout: 15_000});
			await loraRadio.check();

			// --- baseColour: type the hex into the chrome-picker's hex
			// field (FieldColor wraps @lk77/vue3-color; the editable input
			// commits on Enter/change). ---
			const hexInput = themePanel
				.locator('.pkpFormField--color .vc-input__input')
				.first();
			await hexInput.fill(baseColour);
			await hexInput.press('Enter');

			await settings.saveForm(themePanel, {
				endpoint: /\/api\/v1\/contexts\/\d+\/theme/,
			});

			// --- Persistence on reload ---
			await settings.goto();
			const reloadedPanel = await settings.openAppearanceTab('theme');
			await expect(
				reloadedPanel.locator('input[name="typography"][value="lora"]'),
			).toBeChecked({timeout: 15_000});
			const reloadedHex = await reloadedPanel
				.locator('.pkpFormField--color .vc-input__input')
				.first()
				.inputValue();
			expect(reloadedHex.replace('#', '').toLowerCase()).toBe(baseColour);

			// --- Anonymous front end: the recompiled theme stylesheet
			// carries the new colour + font stack. Computed styles are
			// theme-pipeline-independent (no CSS-cache file paths). ---
			const anon = await anonContext(browser, baseURL);
			try {
				const reader = await anon.newPage();
				const resp = await reader.goto(`/index.php/${context.path}/`);
				expect(resp?.status()).toBe(200);

				const head = reader.locator('.pkp_structure_head');
				await expect(head).toBeVisible();
				await expect(head).toHaveCSS('background-color', baseColourRgb);

				// styles/body.less: `body { font-family: @font; }`; the
				// lora option sets `@font: Lora, serif`.
				const bodyFont = await reader
					.locator('body')
					.evaluate((el) => getComputedStyle(el).fontFamily);
				expect(bodyFont).toContain('Lora');
			} finally {
				await anon.close();
			}
		},
	);

	test(
		'sidebar block enable renders the block and disable removes it',
		{tag: '@regression'},
		async ({page, pkpApi, browser, baseURL}) => {
			const tag = scratchTag('waside');
			const {context} = await pkpApi.createJournal({
				tag,
				name: {en: `Appearance sidebar ${tag}`},
				users: [{username: 'dbarnes', roles: ['manager']}],
			});

			const settings = new WebsiteSettingsPage(page, context.path);
			await settings.goto();
			let setupPanel = await settings.openAppearanceTab('appearance-setup');

			// --- Enable the Information block (ships enabled via its
			// settings.xml, so it's always present in the options list;
			// new journals also carry the default reader/author/librarian
			// texts the block renders). ---
			const infoOption = setupPanel.locator(
				'input[name="sidebar"][value="informationblockplugin"]',
			);
			await expect(infoOption).toBeVisible({timeout: 15_000});
			await infoOption.check();
			await settings.saveForm(setupPanel);

			// Selection persists on reload.
			await settings.goto();
			setupPanel = await settings.openAppearanceTab('appearance-setup');
			await expect(
				setupPanel.locator(
					'input[name="sidebar"][value="informationblockplugin"]',
				),
			).toBeChecked({timeout: 15_000});

			// --- Anonymous homepage renders the block ---
			const anonOn = await anonContext(browser, baseURL);
			try {
				const reader = await anonOn.newPage();
				const resp = await reader.goto(`/index.php/${context.path}/`);
				expect(resp?.status()).toBe(200);
				const sidebar = reader.locator('.pkp_structure_sidebar');
				await expect(sidebar).toBeVisible();
				const infoBlock = sidebar.locator('.block_information');
				await expect(infoBlock).toBeVisible();
				await expect(infoBlock.locator('h2').first()).toContainText(
					'Information',
				);
			} finally {
				await anonOn.close();
			}

			// --- Disable and verify removal ---
			await setupPanel
				.locator('input[name="sidebar"][value="informationblockplugin"]')
				.uncheck();
			await settings.saveForm(setupPanel);

			const anonOff = await anonContext(browser, baseURL);
			try {
				const reader = await anonOff.newPage();
				const resp = await reader.goto(`/index.php/${context.path}/`);
				expect(resp?.status()).toBe(200);
				await expect(reader.locator('.block_information')).toHaveCount(0);
				// header.tpl only adds has_sidebar when the sidebar setting
				// is non-empty — with the only block removed, the wrapper
				// class goes too.
				await expect(
					reader.locator('.pkp_structure_content.has_sidebar'),
				).toHaveCount(0);
			} finally {
				await anonOff.close();
			}
		},
	);

	test(
		'page footer content renders on the homepage and the about page',
		{tag: '@regression'},
		async ({page, pkpApi, browser, baseURL}) => {
			const tag = scratchTag('wafoot');
			const {context} = await pkpApi.createJournal({
				tag,
				name: {en: `Appearance footer ${tag}`},
				users: [{username: 'dbarnes', roles: ['manager']}],
			});
			const footerMarker = `Journal footer marker ${tag}`;

			const settings = new WebsiteSettingsPage(page, context.path);
			await settings.goto();
			const setupPanel = await settings.openAppearanceTab('appearance-setup');

			await setTinyMceContent(
				page,
				'appearanceSetup-pageFooter-control-en',
				`<p>${footerMarker}</p>`,
			);
			await settings.saveForm(setupPanel);

			// --- Anonymous: footer.tpl injects pageFooter on every
			// front-end page; homepage + /about prove site-wide reach. ---
			const anon = await anonContext(browser, baseURL);
			try {
				const reader = await anon.newPage();

				const homeResp = await reader.goto(`/index.php/${context.path}/`);
				expect(homeResp?.status()).toBe(200);
				await expect(reader.locator('.pkp_footer_content')).toContainText(
					footerMarker,
				);

				const aboutResp = await reader.goto(
					`/index.php/${context.path}/about`,
				);
				expect(aboutResp?.status()).toBe(200);
				await expect(reader.locator('h1').first()).toContainText(
					/About the Journal/i,
				);
				await expect(reader.locator('.pkp_footer_content')).toContainText(
					footerMarker,
				);
			} finally {
				await anon.close();
			}
		},
	);
});

/**
 * Short worker-scoped tag with a random suffix. The journal scenario
 * derives the journal path as `j-<alnum(tag)>` and journals.path is
 * varchar(32), so tags stay short; the random suffix keeps re-runs on a
 * long-lived local DB from colliding on the path.
 *
 * @param {string} prefix
 */
function scratchTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

/**
 * Fresh anonymous context — explicit empty storageState because this
 * file sets `test.use({user: 'dbarnes'})` (patterns.md rule 8).
 *
 * @param {import('@playwright/test').Browser} browser
 * @param {string} [baseURL]
 */
async function anonContext(browser, baseURL) {
	return browser.newContext({
		baseURL,
		storageState: {cookies: [], origins: []},
	});
}
