// @ts-check
const {test, expect} = require('../support/base-test.js');
const {LoginPage} = require('../pages/LoginPage.js');

/**
 * Login-as (impersonation) — docs/e2e/plans/login-as.md rows 1–2
 * (row 1 was row #44 in docs/e2e-playwright-migration.md).
 *
 * Cypress source: AmwandengaSubmission.cy.js test 13 ("Logout as should
 * redirect to the same submission workflow"). That serial-suite test
 * drives the stage-participants `Login As` affordance on a specific
 * submission (legacy `StageParticipantGridRow` → side-modal OK) and
 * asserts a post-logout redirect that relies on the legacy `redirectUrl`
 * query param. The feature under test — per the roadmap cell — is
 * "admin logs in as user; logout returns to the admin session", i.e.
 * the site-level impersonation capability surfaced by
 * `PKPSessionGuard::signInAs` / `signOutAs` and wired from both the
 * Users & Roles admin grid (`UserGridRow` → `logInAs` link action) and
 * the stage-participant grid. This spec exercises that capability
 * through the canonical URL route both UI affordances invoke:
 *
 *   GET  /index.php/index/login/signInAsUser/{userId}   — start impersonation
 *   GET  /index.php/index/login/signOutAsUser           — end impersonation
 *
 * Driving impersonation through the URL rather than the legacy jQuery
 * grid's More Actions dropdown + RedirectConfirmationModal keeps the
 * spec anchored on the server-side state transition (the part that can
 * actually break) instead of the legacy grid UX. Verification of the
 * impersonation state is read directly from `window.pkp.currentUser`,
 * which `PKPTemplateManager::getJavaScriptData` injects on every
 * authenticated page and whose `isUserLoggedInAs` / `loggedInAsUser`
 * fields are the single source of truth for the TopNavActions
 * "Logged in as X / Log Out As X" UI affordance.
 *
 * Roadmap scope: "admin logs in as user; logout returns to the admin
 * session". Scope dropped vs. the Cypress source: the
 * `workflowSubmissionId` redirect round-trip (that's a legacy
 * stage-participant grid concern — impersonation of a submission
 * participant; the roadmap asks for the site-level capability).
 */
test.describe('Login-as (impersonation)', () => {
	test.use({user: 'admin'});

	test(
		'site admin impersonates a user; logout returns to the admin session',
		{tag: '@regression'},
		async ({page}) => {
			// Baseline assertion: logged in as admin. The user/profile
			// page is the smallest page that renders for any
			// authenticated user regardless of role (no dashboard role
			// gate), so it's safe to use here both pre- and
			// post-impersonation. Read pkp.currentUser to prove the
			// session belongs to admin at this point.
			await page.goto('/index.php/index/user/profile');

			// Resolve dbarnes's user id through the in-page `fetch`. The
			// Playwright `page.request` API is wired to a separate
			// APIRequestContext that doesn't always inherit the page's
			// session cookies in the expected way on context-scoped
			// routes, so we use the authenticated document's own
			// `fetch` — cookies ride along automatically. The route is
			// context-scoped (publicknowledge); site admin has read
			// access across contexts through the UserController's
			// ROLE_ID_SITE_ADMIN allow.
			const target = await page.evaluate(async () => {
				const r = await fetch(
					'/index.php/publicknowledge/api/v1/users?searchPhrase=dbarnes',
					{headers: {Accept: 'application/json'}},
				);
				if (!r.ok) {
					throw new Error(`GET users: ${r.status} ${await r.text()}`);
				}
				const j = await r.json();
				return (j.items ?? []).find((u) => u.userName === 'dbarnes');
			});
			expect(target, 'dbarnes user resolved via API').toBeTruthy();
			await expect(page).not.toHaveURL(/\/login/);
			let currentUser = await page.evaluate(() => window.pkp?.currentUser);
			expect(currentUser, 'pkp.currentUser injected').toBeTruthy();
			expect(currentUser.username).toBe('admin');
			expect(currentUser.isUserLoggedInAs).toBeFalsy();

			// Drive impersonation through the canonical URL. This is the
			// exact URL the Users & Roles "Log in as" link action and
			// the stage-participant "Login As" button both navigate to
			// after the RedirectConfirmationModal's OK click.
			const signInResp = await page.goto(
				`/index.php/index/login/signInAsUser/${target.id}`,
			);
			expect(signInResp?.status()).toBeLessThan(400);

			// Post-impersonation: the same profile page now reports
			// dbarnes as the active user and flags the impersonation
			// state. loggedInAsUser carries the original admin identity
			// (used by TopNavActions to render the "Logged in as admin
			// / Log Out As admin" notice). Use the context-scoped
			// user/profile route — dbarnes has a publicknowledge role,
			// but the site-level profile also resolves since they're a
			// site user.
			await page.goto('/index.php/index/user/profile');
			await expect(page).not.toHaveURL(/\/login/);
			currentUser = await page.evaluate(() => window.pkp?.currentUser);
			expect(currentUser).toBeTruthy();
			expect(currentUser.username).toBe('dbarnes');
			expect(currentUser.isUserLoggedInAs).toBe(true);
			expect(currentUser.loggedInAsUser, 'admin identity preserved').toMatchObject({
				username: 'admin',
			});

			// End impersonation via the canonical URL. The
			// LoginHandler::signOutAsUser path rolls the session back to
			// admin and redirects home.
			const signOutResp = await page.goto(
				'/index.php/index/login/signOutAsUser',
			);
			expect(signOutResp?.status()).toBeLessThan(400);

			// Session is back to admin. isUserLoggedInAs flipped off.
			await page.goto('/index.php/index/user/profile');
			await expect(page).not.toHaveURL(/\/login/);
			currentUser = await page.evaluate(() => window.pkp?.currentUser);
			expect(currentUser).toBeTruthy();
			expect(currentUser.username).toBe('admin');
			expect(currentUser.isUserLoggedInAs).toBeFalsy();
		},
	);
});

/**
 * Row 2 — the Users-list affordance + permission gating
 * (docs/e2e/plans/login-as.md row 2).
 *
 * The Users & Roles table (UserAccessManager) offers a per-row
 * "Login As" action only when the row's `canLoginAs` is true
 * (useUserAccessManagerConfig.js#24-30). The serializer
 * (lib/pkp/classes/user/maps/Schema.php#269 getPropertyCanLoginAs +
 * Repository.php#455 permissionMapForManager) computes it:
 *   - false for the requester's own row (currentUserId check; the Vue
 *     config additionally hides the whole gated block for `user.id ===
 *     getCurrentUserId()`),
 *   - false for any target holding a group in a context the requester
 *     does not manage — a site admin's site-level group (context_id
 *     NULL) can never match a journal manager's groups, so the admin
 *     row is gated off,
 *   - true for users wholly contained in the requester's journals.
 *
 * Clicking the action opens a confirm dialog (grid.action.logInAs /
 * grid.user.confirmLogInAs) whose OK navigates to
 * `login/signInAsUser/{id}` — the same canonical URL row 1 drives
 * directly. The impersonation indicator lives in the user-nav dropdown
 * (TopNavActions.vue#83-99): "You are currently logged in as
 * {username}" + a "Logout as {username}" link to signOutAsUser.
 *
 * Isolation: the impersonation TARGET is a throwaway `users[]` user —
 * `PKPSessionGuard::signInAs/signOutAs` migrate the acting session, so
 * impersonating a shared seeded user would invalidate that user's
 * cached auth state for parallel tests. The impersonating MANAGER is a
 * throwaway too, logged in through a fresh context via the LoginPage
 * POM: session migration then touches a session no other worker (or
 * the .auth cache) shares. The site admin only lends his row to the
 * gating assertion — he is never impersonated, and his scratch-journal
 * role mutates nothing on publicknowledge.
 */
test.describe('Login-as from the Users list', () => {
	test(
		'manager impersonates a throwaway user from the Users list; the affordance is permission-gated',
		{tag: '@regression'},
		async ({pkpApi, browser, baseURL}) => {
			const tag = uniqueTag('la2');
			const suffix = tag.split('-').pop();
			const manager = {
				username: `lam${suffix}`,
				password: `lam${suffix}lam${suffix}`,
				givenName: 'Mira',
				familyName: `Manager${suffix}`,
				email: `lam${suffix}@mailinator.com`,
			};
			const reviewer = {
				username: `lar${suffix}`,
				password: `lar${suffix}lar${suffix}`,
				givenName: 'Rolf',
				familyName: `Reviewer${suffix}`,
				email: `lar${suffix}@mailinator.com`,
			};
			const {context} = await pkpApi.createJournal({
				tag,
				users: [
					{...manager, roles: ['manager']},
					{...reviewer, roles: ['reviewer']},
					// The site admin needs a context role to appear in
					// THIS journal's Users list at all; the row exists
					// purely so the canLoginAs gating is observable.
					{username: 'admin', roles: ['author']},
				],
			});

			// Fresh, private session for the throwaway manager. NOT
			// asUser: impersonation migrates the acting session, and the
			// .auth storage-state cache must never hold a migrated (dead)
			// session for a user other tests share.
			const ctx = await browser.newContext({
				baseURL,
				storageState: {cookies: [], origins: []},
			});
			try {
				const page = await ctx.newPage();
				const loginPage = new LoginPage(page);
				await loginPage.login(manager.username, manager.password, context.path);
				await page.waitForURL((url) => !url.pathname.includes('/login'), {
					timeout: 20_000,
					waitUntil: 'commit',
				});

				const accessUrl = `/index.php/${context.path}/management/settings/access`;
				await page.goto(accessUrl);
				await expect(
					page.getByRole('heading', {name: 'Users & Roles'}),
				).toBeVisible();

				// ----- Impersonate the throwaway reviewer -----
				const reviewerRow = page.locator('tr', {
					hasText: `${reviewer.givenName} ${reviewer.familyName}`,
				});
				await expect(reviewerRow).toBeVisible();
				// Row actions are a headlessui menu (portaled items) —
				// anchor the trigger by attribute, the items by role at
				// page scope.
				await reviewerRow.locator('button[aria-haspopup="menu"]').click();
				await page
					.getByRole('menuitem', {name: 'Login As', exact: true})
					.click();

				// Confirm dialog (grid.action.logInAs title + the
				// attribution warning) — OK navigates to signInAsUser.
				const confirmDialog = page.getByRole('dialog', {name: 'Login As'});
				await expect(confirmDialog).toBeVisible({timeout: 15_000});
				await expect(confirmDialog).toContainText(/Log in as this user/);
				await confirmDialog
					.getByRole('button', {name: 'OK', exact: true})
					.click();

				// signInAsUser redirects home for the target. Don't assert
				// the landing page (role-dependent); sync on leaving the
				// access page, then read the state from a backend page.
				await page.waitForURL(
					(url) => !url.pathname.includes('/management/settings/access'),
					{timeout: 20_000, waitUntil: 'commit'},
				);
				await page.goto(`/index.php/${context.path}/user/profile`);
				let currentUser = await page.evaluate(
					() => window.pkp?.currentUser,
				);
				expect(currentUser?.username).toBe(reviewer.username);
				expect(currentUser?.isUserLoggedInAs).toBe(true);
				expect(
					currentUser?.loggedInAsUser,
					'manager identity preserved while impersonating',
				).toMatchObject({username: manager.username});

				// The "Logged in as" indicator lives in the user-nav
				// dropdown. "Logout as {username}" appears twice while
				// impersonating (notice block + action list) — both point
				// at signOutAsUser; click the first.
				await page.locator('[data-cy="app-user-nav"] button').first().click();
				await expect(
					page.getByText(
						`You are currently logged in as ${reviewer.username}`,
					),
				).toBeVisible();
				await page
					.getByRole('link', {name: `Logout as ${reviewer.username}`})
					.first()
					.click();

				// "Log Out As" returns to the manager's own session.
				await page.goto(`/index.php/${context.path}/user/profile`);
				currentUser = await page.evaluate(() => window.pkp?.currentUser);
				expect(currentUser?.username).toBe(manager.username);
				expect(currentUser?.isUserLoggedInAs).toBeFalsy();

				// ----- Gating: no "Login As" on the own row -----
				await page.goto(accessUrl);
				await expect(
					page.getByRole('heading', {name: 'Users & Roles'}),
				).toBeVisible();
				const ownRow = page.locator('tr', {
					hasText: `${manager.givenName} ${manager.familyName}`,
				});
				await expect(ownRow).toBeVisible();
				await ownRow.locator('button[aria-haspopup="menu"]').click();
				// "Edit" always renders — its visibility proves the menu
				// is open, so the absence assertion below is bounded.
				await expect(
					page.getByRole('menuitem', {name: 'Edit', exact: true}),
				).toBeVisible();
				await expect(
					page.getByRole('menuitem', {name: 'Login As', exact: true}),
				).toHaveCount(0);
				await page.keyboard.press('Escape');
				await expect(
					page.getByRole('menuitem', {name: 'Edit', exact: true}),
				).toHaveCount(0);

				// ----- Gating: no "Login As" on the site-admin row -----
				// Resolve admin's visible identity via REST (his display
				// name is install-defined, his email is stable data).
				const usersRes = await page.request.get(
					`/index.php/${context.path}/api/v1/users?searchPhrase=admin&status=all`,
				);
				expect(usersRes.ok()).toBeTruthy();
				const usersBody = await usersRes.json();
				const adminUser = (usersBody.items ?? []).find(
					(u) => u.userName === 'admin',
				);
				expect(adminUser, 'site admin enrolled in the scratch journal').toBeTruthy();
				const adminRow = page.locator('tr', {hasText: adminUser.email});
				await expect(adminRow).toBeVisible();
				await adminRow.locator('button[aria-haspopup="menu"]').click();
				await expect(
					page.getByRole('menuitem', {name: 'Edit', exact: true}),
				).toBeVisible();
				await expect(
					page.getByRole('menuitem', {name: 'Login As', exact: true}),
				).toHaveCount(0);
				await page.keyboard.press('Escape');
			} finally {
				await ctx.close();
			}
		},
	);
});

function uniqueTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}
