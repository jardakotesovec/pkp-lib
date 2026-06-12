// @ts-check
const {test, expect} = require('../support/base-test.js');
const {LoginPage} = require('../pages/LoginPage.js');

/**
 * Login & sessions — docs/e2e/plans/registration-login.md rows 4–8.
 *
 * Row 6 (the original shared login smoke) proves three things end-to-end:
 *   - bootstrap seeded playwright/.auth/admin.json with a valid session
 *   - the running PHP server accepts that session cookie
 *   - our storageState plumbing skips the /login round-trip
 *
 * Rows 4, 5, 7 and 8 exercise the login lifecycle itself (role-based
 * landing, failure handling, the ?source= round-trip, and the
 * already-authenticated redirects). They use THROWAWAY users seeded via
 * the journal scenario's `users[]` (with an explicit `password`) on
 * per-test scratch journals — NEVER the 16 shared baseline users, whose
 * cached storage states (playwright/.auth/<user>.json) would be put at
 * risk by UI login/logout churn. Throwaway logins are driven through
 * LoginPage on explicitly-anonymous contexts; `asUser()` is off-limits
 * for them because it (a) derives the password via getPassword() and
 * (b) persists a storage-state file into the shared .auth cache dir.
 *
 * Tag convention (filter on the CLI with `--grep @smoke`):
 *   @smoke      — minimal coverage, must-pass on every PR
 *   @regression — broader coverage, typically scheduled / nightly
 *   @slow       — opt-out for fast local runs
 *   @flaky      — quarantined; excluded from default runs
 * Tests can carry multiple tags: {tag: ['@smoke', '@critical']}.
 */

function uniqueTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

/** Explicit empty storage state — opts manual contexts out of any
 *  inherited `user` option (patterns.md parallel-load lesson 8). */
const EMPTY_STATE = {cookies: [], origins: []};

const LOGIN_ERROR = 'Invalid username/email or password';

test.describe('cached-session smoke (row 6)', () => {
	test.use({user: 'admin'});

	test(
		'admin visits site root without being redirected to /login',
		{tag: '@smoke'},
		async ({page}) => {
			await page.goto('/');
			// If the session cookie is valid, OJS serves an authenticated page.
			// If it's not, OJS redirects to the login form — the cheapest and
			// most robust failure signal for "our auth pipeline is broken".
			await expect(page).not.toHaveURL(/\/login/);
		},
	);
});

test.describe('login lifecycle on scratch journals (rows 4, 5, 7, 8)', () => {
	/**
	 * Seed a scratch journal carrying throwaway login users. Usernames
	 * embed the unique tag so parallel workers and re-runs on a
	 * long-lived DB never collide on UNIQUE(username); passwords are
	 * deliberately NOT the getPassword() derivation so an accidental
	 * asUser() shortcut would fail loudly instead of half-working.
	 *
	 * @param {ReturnType<import('../support/api.js').createApiClient>} pkpApi
	 * @param {string} tag
	 * @param {Array<{marker: string, roles: string[]}>} userSpecs
	 */
	async function seedJournalWithUsers(pkpApi, tag, userSpecs) {
		const clean = tag.replace(/[^a-z0-9]/gi, '');
		const users = userSpecs.map(({marker, roles}) => ({
			username: `u${clean}${marker}`,
			password: `pw-${tag}`,
			roles,
		}));
		const {context} = await pkpApi.createJournal({
			tag,
			name: {en: `Login flows ${tag}`},
			users,
		});
		return {context, users};
	}

	/**
	 * Open a fresh, explicitly-anonymous context and drive the
	 * journal-scoped login form as a throwaway user. Returns the context
	 * (caller closes it in a finally) and the page mid-redirect — the
	 * caller asserts the landing URL.
	 *
	 * @param {import('@playwright/test').Browser} browser
	 * @param {string} baseURL
	 */
	async function openAnonymous(browser, baseURL) {
		const ctx = await browser.newContext({
			baseURL,
			storageState: EMPTY_STATE,
		});
		const page = await ctx.newPage();
		return {ctx, page, login: new LoginPage(page)};
	}

	test(
		'login lands on the role-appropriate dashboard; logout invalidates the session',
		{tag: '@smoke'},
		async ({browser, baseURL, pkpApi}) => {
			const tag = uniqueTag('lgn4');
			const {context, users} = await seedJournalWithUsers(pkpApi, tag, [
				{marker: 'a', roles: ['author']},
				{marker: 'r', roles: ['reviewer']},
			]);
			const [author, reviewer] = users;

			const authorSession = await openAnonymous(browser, baseURL);
			const reviewerSession = await openAnonymous(browser, baseURL);
			try {
				// Author-only login → dashboard/mySubmissions
				// (PKPPageRouter::getHomeUrl routes the AUTHOR-only role
				// list there after LoginHandler::_redirectAfterLogin sends
				// the user to the bare /dashboard page).
				await authorSession.login.login(
					author.username,
					author.password,
					context.path,
				);
				await authorSession.page.waitForURL(/\/dashboard\/mySubmissions/, {
					timeout: 15_000,
					waitUntil: 'commit',
				});
				await expect(
					authorSession.page.locator('[data-cy="app-user-nav"]'),
				).toBeVisible({timeout: 15_000});

				// Reviewer-only login → dashboard/reviewAssignments.
				await reviewerSession.login.login(
					reviewer.username,
					reviewer.password,
					context.path,
				);
				await reviewerSession.page.waitForURL(
					/\/dashboard\/reviewAssignments/,
					{timeout: 15_000, waitUntil: 'commit'},
				);
				await expect(
					reviewerSession.page.locator('[data-cy="app-user-nav"]'),
				).toBeVisible({timeout: 15_000});

				// Logout via the user menu (TopNavActions → login/signOut).
				// LoginHandler::signOut destroys the session and redirects
				// back to the requested page's public face — the journal's
				// frontend /login form.
				const userNav = authorSession.page.locator(
					'[data-cy="app-user-nav"]',
				);
				await userNav.getByRole('button').first().click();
				await authorSession.page
					.getByRole('link', {name: 'Logout', exact: true})
					.click();
				await authorSession.page.waitForURL(/\/login/, {
					timeout: 15_000,
					waitUntil: 'commit',
				});
				await expect(
					authorSession.page.locator('form#login'),
				).toBeVisible();

				// The session is gone server-side: revisiting the dashboard
				// in the same (now cookie-less-session) context bounces to
				// /login instead of rendering.
				await authorSession.page.goto(
					`/index.php/${context.path}/en/dashboard/mySubmissions`,
				);
				await expect(authorSession.page).toHaveURL(/\/login/);
			} finally {
				await authorSession.ctx.close();
				await reviewerSession.ctx.close();
			}
		},
	);

	test(
		'failed login shows an error and a correct retry succeeds',
		{tag: '@regression'},
		async ({browser, baseURL, pkpApi}) => {
			const tag = uniqueTag('lgn5');
			const {context, users} = await seedJournalWithUsers(pkpApi, tag, [
				{marker: 'a', roles: ['author']},
			]);
			const [user] = users;

			const session = await openAnonymous(browser, baseURL);
			try {
				const {page, login} = session;

				// Wrong password → server re-renders the form with the
				// generic error; the typed username is retained.
				await login.login(user.username, 'wrong-password', context.path);
				await expect(login.error).toContainText(LOGIN_ERROR);
				await expect(login.username).toHaveValue(user.username);

				// Unknown username → same generic error (no user enumeration).
				await login.login(`ghost-${tag}`, 'whatever-pass', context.path);
				await expect(login.error).toContainText(LOGIN_ERROR);

				// Neither failure minted a session: a protected URL still
				// bounces to /login.
				await page.goto(
					`/index.php/${context.path}/en/dashboard/mySubmissions`,
				);
				await expect(page).toHaveURL(/\/login/);

				// Correct retry on the bounced form (which carries
				// ?source=) logs in normally and lands on the dashboard.
				await login.submitCredentials(user.username, user.password);
				await page.waitForURL(/\/dashboard\/mySubmissions/, {
					timeout: 15_000,
					waitUntil: 'commit',
				});
				await expect(
					page.locator('[data-cy="app-user-nav"]'),
				).toBeVisible({timeout: 15_000});
			} finally {
				await session.ctx.close();
			}
		},
	);

	test(
		'anonymous request to a protected URL round-trips through login back to the target',
		{tag: '@regression'},
		async ({browser, baseURL, pkpApi}) => {
			const tag = uniqueTag('lgn7');
			// author + reviewer: the DEFAULT post-login landing for this
			// role mix is dashboard/reviewAssignments (REVIEWER wins in
			// PKPPageRouter::getHomeUrl), so arriving on mySubmissions
			// proves the ?source= round-trip drove the redirect — not the
			// role-based default.
			const {context, users} = await seedJournalWithUsers(pkpApi, tag, [
				{marker: 'b', roles: ['author', 'reviewer']},
			]);
			const [user] = users;
			const target = `/index.php/${context.path}/en/dashboard/mySubmissions`;

			const session = await openAnonymous(browser, baseURL);
			try {
				const {page, login} = session;

				// Anonymous hit on a protected dashboard URL →
				// Validation::redirectLogin() appends the REQUEST_URI as
				// ?source=... Scratch journals are single-locale, so the
				// router 302s the /en/-prefixed goto to the bare URL
				// before the auth bounce — assert on the parts, not the
				// exact string.
				await page.goto(target);
				await expect(page).toHaveURL(/\/login/);
				const source = new URL(page.url()).searchParams.get('source');
				expect(source).toContain(`/index.php/${context.path}/`);
				expect(source).toContain('/dashboard/mySubmissions');

				// The form carries the source through its hidden field…
				await expect(login.sourceField).toHaveValue(source ?? '');

				// …and a successful login redirects to the original target.
				await login.submitCredentials(user.username, user.password);
				await page.waitForURL(/\/dashboard\/mySubmissions/, {
					timeout: 15_000,
					waitUntil: 'commit',
				});
				await expect(
					page.locator('[data-cy="app-user-nav"]'),
				).toBeVisible({timeout: 15_000});
			} finally {
				await session.ctx.close();
			}
		},
	);

	test(
		'already-authenticated users are redirected away from /login and /user/register',
		{tag: '@regression'},
		async ({browser, baseURL, pkpApi}) => {
			const tag = uniqueTag('lgn8');
			const {context, users} = await seedJournalWithUsers(pkpApi, tag, [
				{marker: 'a', roles: ['author']},
			]);
			const [user] = users;

			const session = await openAnonymous(browser, baseURL);
			try {
				const {page, login} = session;
				await login.login(user.username, user.password, context.path);
				await page.waitForURL(/\/dashboard\/mySubmissions/, {
					timeout: 15_000,
					waitUntil: 'commit',
				});

				// GET /login while logged in → LoginHandler::index sees
				// Validation::isLoggedIn() and sendHome()s to the
				// role-appropriate dashboard.
				await page.goto(`/index.php/${context.path}/en/login`);
				await expect(page).toHaveURL(/\/dashboard\/mySubmissions/);

				// GET /user/register while logged in → the handler serves
				// the registration-complete view (RegistrationHandler::register,
				// isLoggedIn branch) instead of the blank form.
				await page.goto(`/index.php/${context.path}/en/user/register`);
				await expect(page).toHaveURL(/\/user\/register/);
				await expect(
					page.getByRole('heading', {name: 'Registration complete'}),
				).toBeVisible();
				await expect(page.locator('form#register')).toHaveCount(0);
			} finally {
				await session.ctx.close();
			}
		},
	);
});
