// @ts-check
const path = require('path');
const base = require('@playwright/test');
const {createApiClient} = require('./api.js');
const {createMailClient} = require('./mail.js');
const {ensureAuthStateFor} = require('./auth.js');

/**
 * Resolve the running app's capability map. `process.cwd()` is the app
 * checkout root under Playwright (config-factory sets `testDir` to it), so
 * `<appRoot>/playwright/support/app.context.js` identifies the app without
 * any env plumbing — see MULTIAPP-PLAN §3 "App detection".
 *
 * Cached at module scope: the file is a plain object literal, and every
 * worker requires this module once.
 */
let appContextCache;
function loadAppContext() {
	if (appContextCache === undefined) {
		appContextCache = require(
			path.join(process.cwd(), 'playwright', 'support', 'app.context.js'),
		);
	}
	return appContextCache;
}

/**
 * First port of this app's PHP dev-server block — 8000 for OJS, 8100 for
 * OMP, 8200 for OPS (set per app via the `basePort` parameter of
 * lib/pkp/playwright/config-factory.js). Worker N talks to
 * basePort + N.
 *
 * Two independent sources, checked in order, so the fixture can never
 * disagree with the ports config-factory actually spawned:
 *   1. PLAYWRIGHT_BASE_PORT — the factory writes the resolved value into
 *      process.env, and every Playwright worker loads the config file
 *      before running fixtures, so it's set in-process here.
 *   2. The port of the project's configured baseURL (the factory sets it
 *      to the first spawned port) — a fallback for worker runtimes that
 *      might not re-evaluate the config.
 * Falls back to 8000, the historical single-fleet default.
 */
function resolveBasePort(testInfo) {
	const fromEnv = parseInt(process.env.PLAYWRIGHT_BASE_PORT ?? '', 10);
	if (Number.isFinite(fromEnv) && fromEnv > 0 && fromEnv < 65536) {
		return fromEnv;
	}
	const projectBaseURL = testInfo?.project?.use?.baseURL;
	if (typeof projectBaseURL === 'string') {
		const port = parseInt(new URL(projectBaseURL).port, 10);
		if (Number.isFinite(port) && port > 0) {
			return port;
		}
	}
	return 8000;
}

/**
 * Shared extended `test` — every spec (shared or app-specific) ultimately
 * derives from here. OJS's playwright/support/fixtures.js layers OJS-only
 * fixtures on top; OMP/OPS do the same in their own repos.
 *
 * Fixtures provided:
 *   appContext   — the running app's capability map, loaded from
 *                  <appRoot>/playwright/support/app.context.js. Shared
 *                  specs gate on CAPABILITIES, never app names:
 *                  `test.skip(!appContext.hasReviewStage, …)`. The
 *                  canonical `hasX` spellings live in
 *                  docs/product/APP-GLOSSARY.md §2; vocabulary and seed
 *                  names come from `appContext.vocab` / `.seed`.
 *   baseURL      — overrides Playwright's built-in fixture. Each parallel
 *                  worker gets its own dedicated PHP dev server on port
 *                  basePort + parallelIndex (see config-factory.js
 *                  webServer array; basePort is 8000 for OJS, 8100 for
 *                  OMP, 8200 for OPS). The default `use.baseURL` in the
 *                  config still points at basePort for the setup project + as a
 *                  fallback. PLAYWRIGHT_BASE_URL env var, if set, takes
 *                  priority — useful when targeting an external server
 *                  (e.g. for debugging against a manually-started PHP).
 *   pkpApi       — cross-app HTTP client (login, CSRF, context endpoints)
 *   pkpMail      — Mailpit HTTP API wrapper. Tests that assert on mail
 *                  sent during normal app requests destructure this
 *                  fixture and call `clearAll()` / `inboxFor(email)` /
 *                  `fullMessage(id)`. Scenario-seeding mail does NOT
 *                  reach Mailpit — Mail::fake() in the scenario
 *                  controllers discards it.
 *   user         — option fixture; specs declare `test.use({user: 'editor.diana'})`.
 *                  Omit or set to undefined for an anonymous context.
 *   storageState — overrides Playwright's built-in fixture. Looks up the
 *                  current `user`, lazily logs them in via auth.js on
 *                  first use, and returns the cached storage-state path.
 *                  Login happens once per user per DB lifetime — the file
 *                  on disk is the cache.
 *   asUser       — async (username) => BrowserContext. For multi-actor
 *                  tests that need more than the default-user context.
 *                  Shares auth.js's cache and auto-closes contexts at
 *                  test teardown.
 */
exports.test = base.test.extend({
	baseURL: async ({}, use, testInfo) => {
		// Per-worker routing: each parallel worker gets its own PHP
		// server on port basePort + parallelIndex (see resolveBasePort
		// above). The webServer array in config-factory.js spawns
		// matching ports.
		//
		// Defensive: PLAYWRIGHT_BASE_URL was historically a documented
		// knob in .env.playwright.example. It's been removed from the
		// example, but stale .env.playwright copies on developer
		// machines may still set it. We silently ignore those when
		// the value points at any 127.0.0.1/localhost host — that's
		// always the auto-spawn pattern, never an intentional
		// override. An explicitly external URL (named host, https,
		// non-loopback IP) is still honored for ad-hoc debug runs.
		const envOverride = process.env.PLAYWRIGHT_BASE_URL;
		if (envOverride && !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(envOverride)) {
			await use(envOverride);
			return;
		}
		await use(`http://127.0.0.1:${resolveBasePort(testInfo) + testInfo.parallelIndex}`);
	},

	appContext: async ({}, use, testInfo) => {
		const ctx = loadAppContext();
		// Cross-check against the Playwright project name (MULTIAPP-PLAN
		// §3). The 'setup' and 'serial' projects are app-neutral names, so
		// only the app project participates in the check. A mismatch means
		// the wrong app.context.js got loaded (e.g. a stray cwd), which
		// would silently flip capability gates — fail loudly instead.
		const projectName = testInfo?.project?.name;
		if (
			projectName &&
			!['setup', 'serial'].includes(projectName) &&
			ctx.app !== projectName
		) {
			throw new Error(
				`appContext mismatch: playwright/support/app.context.js declares app ` +
					`'${ctx.app}' but the Playwright project is '${projectName}'.`,
			);
		}
		await use(ctx);
	},

	pkpApi: async ({request, baseURL}, use) => {
		await use(createApiClient({request, baseURL}));
	},
	pkpMail: async ({request}, use) => {
		await use(createMailClient({request}));
	},

	user: [undefined, {option: true}],

	storageState: async ({user, browser, baseURL}, use) => {
		if (!user) {
			await use(undefined);
			return;
		}
		await use(await ensureAuthStateFor(browser, user, {baseURL}));
	},

	asUser: async ({browser, baseURL}, use) => {
		/** @type {import('@playwright/test').BrowserContext[]} */
		const opened = [];
		await use(async (username) => {
			const ctx = await browser.newContext({
				storageState: await ensureAuthStateFor(browser, username, {baseURL}),
				baseURL,
			});
			opened.push(ctx);
			return ctx;
		});
		// Teardown: close every context the test opened. Swallow errors —
		// a test may have closed one explicitly, which is fine.
		for (const ctx of opened) {
			await ctx.close().catch(() => {});
		}
	},
});

exports.expect = base.expect;
