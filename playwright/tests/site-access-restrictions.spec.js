// @ts-check
const {test, expect} = require('../support/base-test.js');
const {LoginPage} = require('../pages/LoginPage.js');
const {SiteAccessSettingsPage} = require('../pages/SiteAccessSettingsPage.js');

/**
 * Site access restrictions — docs/e2e/plans/site-access-restrictions.md
 * rows 1, 2 and 4. Row 3 (restrictArticleAccess) is OJS-only and lives in
 * playwright/tests/article-access-restriction.spec.js.
 *
 * All three toggles are JOURNAL-level context settings, so every test
 * seeds its own scratch journal — publicknowledge is never touched. The
 * context scenario schema deliberately does NOT pass the toggles through
 * (adjudicated UI-FALLBACK, plan's Scenario-needs note): rows 1–2 flip
 * them through the Users & Roles → Site Access Options form
 * (SiteAccessSettingsPage POM), row 4 unchecks `enabled` on the admin
 * hosted-journal form.
 *
 * Enforcement points (verified in source):
 *   - restrictSiteAccess → RestrictedSiteAccessPolicy (installed by
 *     PKPHandler.php#317): anonymous DENY on every page except the
 *     exemptions ['user','login','help','header','sidebar','payment',
 *     'invitation']; page-router denial for anonymous users redirects to
 *     login (PKPPageRouter::handleAuthorizationFailure#384-386).
 *   - disableUserReg → RegistrationHandler::validate#217-232 renders
 *     frontend/pages/error.tpl with errorMsg
 *     'user.register.registrationDisabled' and a Login backLink; the
 *     Register nav item is hidden by PKPNavigationMenuService#185-187.
 *   - journal `enabled` → PKPPageRouter::route#177-185 bounces logged-out
 *     visitors of a disabled context to its login page; the anonymous
 *     site index lists enabled journals only (OJS IndexHandler#137,
 *     JournalDAO::getAll(true)).
 *
 * Throwaway users are seeded via the journal scenario's users[] with an
 * explicit password and logged in through LoginPage on explicitly
 * anonymous contexts (login.spec.js convention) — never via asUser, which
 * derives getPassword() and writes the shared .auth cache.
 *
 * Anonymous phases always open FRESH contexts with an explicit empty
 * storageState (patterns.md rule 8). Fresh contexts also dodge browser
 * caching of CACHEABLE_PUBLIC front-end pages between before/after
 * phases of a toggle.
 */

/** Explicit empty storage state — opts manual contexts out of any
 *  inherited `user` option (patterns.md parallel-load lesson 8). */
const EMPTY_STATE = {cookies: [], origins: []};

function uniqueTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

/**
 * Open a fresh, explicitly-anonymous context.
 *
 * @param {import('@playwright/test').Browser} browser
 * @param {string|undefined} baseURL
 */
async function openAnonymous(browser, baseURL) {
	const ctx = await browser.newContext({
		baseURL,
		storageState: EMPTY_STATE,
	});
	const page = await ctx.newPage();
	return {ctx, page};
}

test.describe('Site access restrictions', () => {
	test(
		'login-wall journal: anonymous readers are forced through login (row 1)',
		{tag: '@regression'},
		async ({pkpApi, asUser, browser, baseURL}) => {
			const tag = uniqueTag('sar1');
			const clean = tag.replace(/[^a-z0-9]/gi, '');
			const reader = {username: `u${clean}r`, password: `pw-${tag}`};
			const journalName = `Login Wall ${tag}`;

			const {context} = await pkpApi.createJournal({
				tag,
				name: {en: journalName},
				users: [
					{username: 'dbarnes', roles: ['manager']},
					{
						username: reader.username,
						password: reader.password,
						roles: ['reader'],
					},
				],
			});

			// Manager turns the login wall on through the Site Access form.
			const managerCtx = await asUser('dbarnes');
			const managerPage = await managerCtx.newPage();
			const siteAccess = new SiteAccessSettingsPage(
				managerPage,
				context.path,
			);
			await siteAccess.goto();
			await siteAccess.setCheckbox('restrictSiteAccess', true);
			await siteAccess.save();

			const anon = await openAnonymous(browser, baseURL);
			try {
				const {page} = anon;

				// Reader-facing pages bounce anonymous visitors to login.
				// 'issue/archive' is the OJS issue surface named by the plan
				// row; the policy applies before any handler logic so the
				// probe list is data — OMP/OPS adopters swap in their own
				// catalog path.
				for (const probe of ['', 'about', 'issue/archive']) {
					await page.goto(`/index.php/${context.path}/${probe}`);
					await expect(
						page,
						`anonymous ${probe || 'homepage'} must bounce to login`,
					).toHaveURL(/\/login/);
				}
				// The bounce is Validation::redirectLogin() — it carries the
				// requested URL in ?source= for the post-login round-trip.
				const source = new URL(page.url()).searchParams.get('source');
				expect(source).toContain(`/index.php/${context.path}/`);
				expect(source).toContain('/issue/archive');
				await expect(page.locator('form#login')).toBeVisible();

				// Policy exemptions: /login and /user/register render their
				// forms instead of bouncing (pages 'login' and 'user' are in
				// RestrictedSiteAccessPolicy::_getLoginExemptions).
				await page.goto(`/index.php/${context.path}/login`);
				await expect(page).toHaveURL(/\/login/);
				await expect(page.locator('form#login')).toBeVisible();

				await page.goto(`/index.php/${context.path}/user/register`);
				await expect(page).toHaveURL(/\/user\/register/);
				await expect(page.locator('form#register')).toBeVisible();

				// After logging in, the same pages render. The throwaway
				// reader has no editorial role, so this is the plain-reader
				// experience, not a manager bypass.
				const login = new LoginPage(page);
				await login.login(reader.username, reader.password, context.path);
				await page.waitForURL((url) => !url.pathname.includes('/login'), {
					timeout: 15_000,
					waitUntil: 'commit',
				});

				await page.goto(`/index.php/${context.path}/`);
				await expect(page).not.toHaveURL(/\/login/);
				await expect(page.getByText(journalName).first()).toBeVisible();

				await page.goto(`/index.php/${context.path}/about`);
				await expect(page).not.toHaveURL(/\/login/);
				await expect(
					page.getByRole('heading', {name: /About the/}),
				).toBeVisible();

				await page.goto(`/index.php/${context.path}/issue/archive`);
				await expect(page).not.toHaveURL(/\/login/);
				await expect(
					page.getByRole('heading', {name: 'Archives'}),
				).toBeVisible();
			} finally {
				await anon.ctx.close();
			}
		},
	);

	test(
		'registration disabled: register surfaces close (row 2)',
		{tag: '@regression'},
		async ({pkpApi, asUser, browser, baseURL}) => {
			const tag = uniqueTag('sar2');
			const journalName = `No Reg ${tag}`;

			const {context} = await pkpApi.createJournal({
				tag,
				name: {en: journalName},
				users: [{username: 'dbarnes', roles: ['manager']}],
			});

			// Baseline (registration enabled — the scratch default): the
			// front end shows the Register nav item and /user/register
			// serves a live form. This is the positive control for the
			// hidden/closed assertions below.
			const before = await openAnonymous(browser, baseURL);
			try {
				const {page} = before;
				await page.goto(`/index.php/${context.path}/`);
				await expect(
					page.getByRole('link', {name: 'Register', exact: true}).first(),
				).toBeVisible();
				await page.goto(`/index.php/${context.path}/user/register`);
				await expect(page.locator('form#register')).toBeVisible();
			} finally {
				await before.ctx.close();
			}

			// Manager disables user registration via the Site Access form
			// (disableUserReg is a radio pair: enable=false / disable=true).
			const managerCtx = await asUser('dbarnes');
			const managerPage = await managerCtx.newPage();
			const siteAccess = new SiteAccessSettingsPage(
				managerPage,
				context.path,
			);
			await siteAccess.goto();
			await siteAccess.chooseRadio(/will register all user accounts/i);
			await siteAccess.save();

			// Fresh anonymous context (avoids any CACHEABLE_PUBLIC page
			// cache from the baseline phase).
			const after = await openAnonymous(browser, baseURL);
			try {
				const {page} = after;

				// /user/register renders the registration-disabled error
				// page (frontend/pages/error.tpl): "Register" title, the
				// disabled message, a Login backlink — and no form.
				await page.goto(`/index.php/${context.path}/user/register`);
				await expect(page).toHaveURL(/\/user\/register/);
				await expect(
					page.getByRole('heading', {level: 1, name: 'Register'}),
				).toBeVisible();
				await expect(
					page.getByText(/not accepting user registrations/i),
				).toBeVisible();
				await expect(page.locator('form#register')).toHaveCount(0);

				// The backlink (RegistrationHandler::validate backLink →
				// the journal login page) is a working Login link.
				const backLink = page.locator('.cmp_back_link a');
				await expect(backLink).toHaveText('Login');
				await backLink.click();
				await page.waitForURL(/\/login/, {
					timeout: 15_000,
					waitUntil: 'commit',
				});
				await expect(page.locator('form#login')).toBeVisible();

				// Register nav item is hidden on the front end
				// (NMI_TYPE_USER_REGISTER isDisplayed=false); Login remains
				// as the visible control that the user nav still renders.
				await page.goto(`/index.php/${context.path}/`);
				await expect(
					page.getByRole('link', {name: 'Login', exact: true}).first(),
				).toBeVisible();
				await expect(
					page.getByRole('link', {name: 'Register', exact: true}),
				).toHaveCount(0);
			} finally {
				await after.ctx.close();
			}
		},
	);

	test(
		'disabled journal is hidden from the public but reachable by admins (row 4)',
		{tag: '@regression'},
		async ({pkpApi, asUser, browser, baseURL}) => {
			const tag = uniqueTag('sar4');
			const journalName = `Disabled ${tag}`;

			// Acronym is seeded explicitly: the hosted-journal ContextForm
			// marks it required, and the edit-form save below round-trips
			// every field.
			const {context} = await pkpApi.createJournal({
				tag,
				name: {en: journalName},
				acronym: {en: `SA${tag.slice(-3).toUpperCase()}`},
			});

			// Baseline: the enabled scratch journal is publicly reachable
			// and listed on the anonymous site index.
			const before = await openAnonymous(browser, baseURL);
			try {
				const {page} = before;
				const resp = await page.goto(`/index.php/${context.path}/`);
				expect(resp?.status()).toBe(200);
				await expect(page.getByText(journalName).first()).toBeVisible();

				await page.goto('/index.php/index');
				await expect(
					page.locator(`.journals a[href*="/${context.path}"]`).first(),
				).toBeVisible();
			} finally {
				await before.ctx.close();
			}

			// Admin unchecks `enabled` through the hosted-journals grid's
			// Edit modal (admin/contexts → row → show_extras → Edit →
			// ContextForm in #editContext — the same surface the legacy
			// MultipleContexts.cy.js drove). The contexts grid has no
			// paging feature (ContextGridHandler::loadData returns all
			// contexts), so the row is locatable by its stable id suffix
			// even on a long-lived multi-journal DB.
			const adminCtx = await asUser('admin');
			const adminPage = await adminCtx.newPage();
			await adminPage.goto('/index.php/index/admin/contexts');
			const row = adminPage.locator(
				`#contextGridContainer tr[id$="-row-${context.id}"]`,
			);
			await expect(row).toBeVisible({timeout: 30_000});
			await row.locator('a.show_extras').click();
			await adminPage
				.locator(
					`#contextGridContainer tr[id$="-row-${context.id}-control-row"] a.pkp_linkaction_edit`,
				)
				.click();

			const editModal = adminPage.locator('#editContext');
			const enabledBox = editModal.locator('input[name="enabled"]');
			await expect(enabledBox).toBeVisible({timeout: 15_000});
			await expect(enabledBox).toBeChecked();
			await enabledBox.uncheck();
			{
				const saved = adminPage.waitForResponse(
					(res) =>
						/\/api\/v1\/contexts\/\d+/.test(res.url()) &&
						res.ok() &&
						['POST', 'PUT'].includes(res.request().method()),
					{timeout: 15_000},
				);
				await editModal
					.getByRole('button', {name: 'Save', exact: true})
					.click();
				await saved;
			}
			await expect(editModal.locator('[role="status"]')).toContainText(
				'Saved',
				{timeout: 15_000},
			);

			// Anonymous: the front end bounces to the journal's login page
			// (PKPPageRouter::route redirect for logged-out users on a
			// disabled context) and the site index no longer lists it.
			const during = await openAnonymous(browser, baseURL);
			try {
				const {page} = during;
				await page.goto(`/index.php/${context.path}/`);
				await expect(page).toHaveURL(/\/login/);
				await expect(page.locator('form#login')).toBeVisible();

				await page.goto('/index.php/index');
				// Control first: the enabled bootstrap journal is listed, so
				// the zero-count below means "absent", not "list not loaded".
				await expect(
					page.locator('.journals a[rel="bookmark"]', {
						hasText: 'Journal of Public Knowledge',
					}),
				).toBeVisible();
				await expect(
					page.locator(`.journals a[href*="/${context.path}"]`),
				).toHaveCount(0);
			} finally {
				await during.ctx.close();
			}

			// Admin still reaches the disabled journal: its front end (the
			// router's enabled check only bounces logged-out visitors) and
			// its Settings Wizard.
			const adminFrontResp = await adminPage.goto(
				`/index.php/${context.path}/`,
			);
			expect(adminFrontResp?.status()).toBe(200);
			await expect(adminPage).not.toHaveURL(/\/login/);
			await expect(adminPage.getByText(journalName).first()).toBeVisible();

			await adminPage.goto(`/index.php/index/admin/wizard/${context.id}`);
			await expect(
				adminPage.getByRole('heading', {name: /Settings Wizard/i, level: 1}),
			).toBeVisible({timeout: 15_000});

			// Re-enable from the wizard's hosted-journal form (same
			// FORM_CONTEXT, second admin surface) and confirm public access
			// is restored.
			const wizardEnabled = adminPage.locator(
				'#context input[name="enabled"]',
			);
			await expect(wizardEnabled).toBeVisible({timeout: 15_000});
			await expect(wizardEnabled).not.toBeChecked();
			await wizardEnabled.check();
			{
				const saved = adminPage.waitForResponse(
					(res) =>
						/\/api\/v1\/contexts\/\d+/.test(res.url()) &&
						res.ok() &&
						['POST', 'PUT'].includes(res.request().method()),
					{timeout: 15_000},
				);
				await adminPage
					.locator('#context')
					.getByRole('button', {name: 'Save', exact: true})
					.click();
				await saved;
			}

			const after = await openAnonymous(browser, baseURL);
			try {
				const {page} = after;
				const resp = await page.goto(`/index.php/${context.path}/`);
				expect(resp?.status()).toBe(200);
				await expect(page).not.toHaveURL(/\/login/);
				await expect(page.getByText(journalName).first()).toBeVisible();

				await page.goto('/index.php/index');
				await expect(
					page.locator(`.journals a[href*="/${context.path}"]`).first(),
				).toBeVisible();
			} finally {
				await after.ctx.close();
			}
		},
	);
});
