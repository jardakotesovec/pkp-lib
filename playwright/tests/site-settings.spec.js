// @ts-check
const {test, expect} = require('../support/base-test.js');
const {
	setTinyMceContent,
	getTinyMceContent,
} = require('../support/tinymce.js');
const {waitForJQueryIdle} = require('../support/jquery.js');

/**
 * Site settings — docs/e2e/plans/site-settings.md (all 3 rows).
 *
 * THE SITE IS A SINGLETON (charter principles 7 + 9). Rows 1 and 3
 * mutate visible site chrome (site title, site-level page footer); per
 * the plan's adjudication they:
 *   - read the ORIGINAL value first (one GET /api/v1/site as admin),
 *   - mutate through the real admin UI (the behavior under test),
 *   - restore the original value in a `finally` block via the same
 *     REST endpoint the form posts to, and VERIFY the restoration.
 * While they run, the chrome briefly carries test values — by plan
 * decree no other suite test asserts site-chrome text, and this spec
 * asserts only its own unique tokens (never counts, never untagged
 * text). Row 2 is strictly read-only.
 *
 * Tab availability note: most Site Setup side-tabs — including the
 * Settings form (site title) and the whole Appearance tab — only
 * render when the installation hosts ≠ 1 contexts
 * (AdminHandler::siteSettingsAvailability,
 * lib/pkp/pages/admin/AdminHandler.php:279-300). Rows 1 and 3 seed a
 * throwaway scratch journal first so the multi-context UI is
 * guaranteed even on a freshly bootstrapped DB (the scratch journal is
 * never asserted on and mutates nothing shared — the hosted-journals
 * list is additive-safe for parallel workers).
 *
 * Reauthentication: AdminHandler adds ReauthenticationRequiredPolicy,
 * but the test config leaves `security.password_timeout` unset, so
 * admin sessions are always elevated (PKPSessionGuard:331-334).
 *
 * Placement: lib/pkp — the admin site-settings page is shared
 * pkp-lib UI (OMP/OPS render the same forms; the only OJS-ism here is
 * `pkpApi.createJournal`, the same shared-client call announcement &
 * co. specs already use from this folder).
 */

test.use({user: 'admin'});

const SITE_API = '/index.php/index/api/v1/site';

test.describe('Site settings', () => {
	test(
		'admin edits the site title and it renders on the anonymous site index, then restores it',
		{tag: '@regression'},
		async ({page, browser, baseURL, pkpApi}) => {
			const token = tag('sstitle');
			const newTitle = `Site ${token}`;

			// Guarantee the multi-context availability gate (see header).
			await pkpApi.createJournal({tag: token});

			// Read the original value BEFORE any mutation. NOTE: a
			// fresh install leaves the site title EMPTY ({en: '',
			// fr_CA: ''}) — the form marks the field required but the
			// site schema is `nullable`, so empty is a legitimate
			// original state and restores cleanly through the API.
			const originalSite = await getSite(page);
			const originalTitle = originalSite.title ?? {en: ''};

			let mutated = false;
			try {
				// --- Mutate via the Site Setup > Settings form ---
				await page.goto('/index.php/index/admin/settings');
				// Outer "Site Setup" tab and its "Settings" side-tab are
				// the defaults; the siteConfig form mounts in #settings.
				const settingsPanel = page.locator('#settings');
				const titleInput = settingsPanel.locator(
					'input[name="title-en"]',
				);
				await expect(titleInput).toBeVisible({timeout: 15_000});
				await titleInput.fill(newTitle);

				mutated = true;
				await Promise.all([
					page.waitForResponse(
						(res) =>
							/\/api\/v1\/site(\?|$)/.test(res.url()) &&
							res.ok() &&
							['POST', 'PUT'].includes(res.request().method()),
						{timeout: 15_000},
					),
					settingsPanel
						.getByRole('button', {name: 'Save', exact: true})
						.click(),
				]);
				await expect(
					settingsPanel.locator('[role="status"]', {hasText: 'Saved'}),
				).toBeVisible({timeout: 15_000});

				// --- Anonymous site index renders the new title ---
				const anon = await anonContext(browser, baseURL);
				try {
					const reader = await anon.newPage();
					const resp = await reader.goto('/index.php/index');
					expect(resp?.status()).toBe(200);
					// The default skin renders the site title as the
					// text site-name anchor when no site logo is set
					// (header.tpl; displayPageHeaderTitle =
					// $site->getLocalizedTitle() for context-less pages).
					await expect(
						reader.locator('.pkp_site_name a.is_text'),
					).toContainText(newTitle, {timeout: 15_000});
				} finally {
					await anon.close();
				}
			} finally {
				if (mutated) {
					// --- Restore the singleton + verify ---
					await putSite(page, {title: originalTitle});
					const restored = await getSite(page);
					expect(restored.title).toEqual(originalTitle);
				}
			}

			// Restoration is user-visible again (outside the finally so
			// a failure here reads as an assertion, not a cleanup error).
			const anon = await anonContext(browser, baseURL);
			try {
				const reader = await anon.newPage();
				const resp = await reader.goto('/index.php/index');
				expect(resp?.status()).toBe(200);
				// The banner no longer carries the test token…
				const banner = reader.locator('.pkp_structure_head');
				await expect(banner).toBeVisible();
				await expect(banner).not.toContainText(token);
				if (originalTitle.en) {
					// …and the original title is back.
					await expect(
						reader.locator('.pkp_site_name a.is_text'),
					).toContainText(String(originalTitle.en), {timeout: 15_000});
				} else {
					// Empty original: the default skin falls back to the
					// application logo instead of a text site name.
					await expect(
						reader.locator('.pkp_site_name a.is_text'),
					).toHaveCount(0);
				}
			} finally {
				await anon.close();
			}
		},
	);

	test(
		'site languages tab lists the installed locales non-destructively',
		{tag: '@regression'},
		async ({page}) => {
			// Plan row 2 — read-only render of the admin languages grid
			// (AdminLanguageGridHandler). The test installer installs
			// en + fr_CA at the site level (tools/installTest.php:61-62).
			//
			// Column-shape note vs the plan's wording: the UI/Forms/
			// Submissions toggles are *management* columns that the
			// grid only renders on single-context installs where the
			// request has a context (AdminLanguageGridHandler::initialize
			// + _canManage); the site-level grid shows Enable / Locale /
			// Code / Primary. The journal-level grid's toggles are
			// covered by site-administration row 7 (settings wizard
			// languages tab).
			await page.goto('/index.php/index/admin/settings');
			// The Languages side-tab lives under the default outer
			// "Site Setup" tab; its grid loads via load_url_in_div.
			await page.locator('#languages-button').click();
			const grid = page.locator('#languageGridContainer');
			await expect(grid).toBeVisible({timeout: 15_000});
			await waitForJQueryIdle(page);

			// Column headers.
			await expect(grid.getByText('Enable', {exact: true})).toBeVisible();
			await expect(
				grid.getByText('Primary locale', {exact: true}),
			).toBeVisible();

			// Both installed locales render with code cells.
			const enRow = grid.locator('tr.gridRow', {hasText: 'English'});
			const frRow = grid.locator('tr.gridRow', {hasText: 'fr_CA'});
			await expect(enRow).toBeVisible();
			await expect(enRow).toContainText('en');
			await expect(frRow).toBeVisible();

			// en is the site primary locale (radio checked) and both
			// rows expose their enable toggles. NOTHING is clicked —
			// installing/uninstalling/re-prioritizing locales is
			// explicitly out of scope (plan round-2 note: it breaks
			// parallel workers mid-flight).
			await expect(
				enRow.locator('input[type="radio"]').first(),
			).toBeChecked();
			await expect(
				enRow.locator('input[type="checkbox"]').first(),
			).toBeVisible();
			await expect(
				frRow.locator('input[type="checkbox"]').first(),
			).toBeVisible();
		},
	);

	test(
		'admin sets the site-level page footer and it renders publicly, then restores it',
		{tag: '@regression'},
		async ({page, browser, baseURL, pkpApi}) => {
			const token = tag('ssfoot');
			const footerMarker = `Site footer marker ${token}`;

			// Multi-context gate for the Appearance tab (see header).
			await pkpApi.createJournal({tag: token});

			const originalSite = await getSite(page);
			const originalFooter = originalSite.pageFooter;

			let mutated = false;
			try {
				// --- Mutate via Appearance > Setup ---
				await page.goto('/index.php/index/admin/settings');
				await page.locator('#appearance-button').click();
				// Nested tab trap (patterns.md pitfall 2): the outer
				// "Site Setup" tab and Appearance's inner "Setup" tab
				// share the id `setup`; scope the inner button to the
				// appearance panel.
				await page.locator('#appearance #setup-button').click();

				const setupPanel = page.locator('#appearance #setup');
				// Sidebar block options are part of the same form
				// (PKPSiteAppearanceForm `sidebar` FieldOptions) — the
				// plan asserts their presence, nothing is toggled.
				await expect(
					setupPanel.locator('input[name="sidebar"]').first(),
				).toBeVisible({timeout: 15_000});

				await setTinyMceContent(
					page,
					'siteAppearance-pageFooter-control-en',
					`<p>${footerMarker}</p>`,
				);

				mutated = true;
				await Promise.all([
					page.waitForResponse(
						(res) =>
							/\/api\/v1\/site(\?|$)/.test(res.url()) &&
							res.ok() &&
							['POST', 'PUT'].includes(res.request().method()),
						{timeout: 15_000},
					),
					setupPanel
						.getByRole('button', {name: 'Save', exact: true})
						.click(),
				]);
				await expect(
					setupPanel.locator('[role="status"]', {hasText: 'Saved'}),
				).toBeVisible({timeout: 15_000});

				// --- Anonymous site index renders the footer markup ---
				const anon = await anonContext(browser, baseURL);
				try {
					const reader = await anon.newPage();
					const resp = await reader.goto('/index.php/index');
					expect(resp?.status()).toBe(200);
					await expect(
						reader.locator('.pkp_footer_content'),
					).toContainText(footerMarker, {timeout: 15_000});
				} finally {
					await anon.close();
				}
			} finally {
				if (mutated) {
					// --- Restore the singleton + verify ---
					// pageFooter may legitimately be null/empty on a
					// fresh site; write back exactly what was read.
					await putSite(page, {pageFooter: originalFooter ?? {en: ''}});
					const restored = await getSite(page);
					const normalize = (v) => v?.en || '';
					expect(normalize(restored.pageFooter)).toEqual(
						normalize(originalFooter),
					);
				}
			}

			// Restored state is user-visible: the marker is gone from
			// the public footer (and the original footer, if any, is
			// back).
			const anon = await anonContext(browser, baseURL);
			try {
				const reader = await anon.newPage();
				const resp = await reader.goto('/index.php/index');
				expect(resp?.status()).toBe(200);
				const footer = reader.locator('.pkp_structure_footer');
				await expect(footer).toBeVisible();
				await expect(footer).not.toContainText(token);
				if (originalFooter?.en) {
					await expect(
						reader.locator('.pkp_footer_content'),
					).toContainText(stripHtml(originalFooter.en).slice(0, 40));
				}
			} finally {
				await anon.close();
			}
		},
	);
});

/**
 * Read the full site settings object via the admin session carried by
 * the page's request context. The canonical "read the original value
 * first" step for singleton-restoring tests.
 *
 * @param {import('@playwright/test').Page} page
 */
async function getSite(page) {
	const res = await page.request.get(SITE_API);
	if (!res.ok()) {
		throw new Error(`GET site failed: ${res.status()} ${await res.text()}`);
	}
	return res.json();
}

/**
 * Restore site settings through the same endpoint the admin forms
 * submit to (PUT /api/v1/site). Cookie-session API writes need the
 * CSRF token in the X-Csrf-Token header; the token lives in the
 * `<meta name="csrf-token">` tag every rendered page carries (there is
 * NO /api/v1/_csrf endpoint — pkpApi.getCsrfToken references one but
 * it 404s; flagged in the wave report).
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} data partial site props to write back
 */
async function putSite(page, data) {
	let token = await page
		.evaluate(() =>
			document
				.querySelector('meta[name="csrf-token"]')
				?.getAttribute('content'),
		)
		.catch(() => null);
	if (!token) {
		// The page may be blank if the test failed before its first
		// navigation; any backend page carries the meta tag.
		await page.goto('/index.php/index/admin/settings');
		token = await page.evaluate(() =>
			document
				.querySelector('meta[name="csrf-token"]')
				?.getAttribute('content'),
		);
	}
	if (!token) {
		throw new Error('could not resolve a CSRF token for the site restore');
	}
	const res = await page.request.put(SITE_API, {
		headers: {'X-Csrf-Token': String(token)},
		data,
	});
	if (!res.ok()) {
		throw new Error(
			`site restore PUT failed: ${res.status()} ${await res.text()}`,
		);
	}
	return res.json();
}

/**
 * Worker-scoped whitespace-free token (tag conventions, patterns.md):
 * doubles as the scenario tag and the unique content marker asserted
 * on shared surfaces.
 *
 * @param {string} prefix
 */
function tag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

/**
 * Fresh anonymous context — explicit empty storageState because this
 * file sets `test.use({user: 'admin'})` (patterns.md rule 8).
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

/**
 * Crude tag-stripper for comparing a rich-text original footer against
 * its rendered form.
 *
 * @param {string} html
 */
function stripHtml(html) {
	return String(html)
		.replace(/<[^>]*>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}
