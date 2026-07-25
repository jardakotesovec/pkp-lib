// @ts-check
const os = require('os');
const path = require('path');
const {defineConfig, devices} = require('@playwright/test');

/**
 * Shared Playwright config factory for OJS / OMP / OPS.
 *
 * Each app's root playwright.config.js is a 3-line stub that calls this
 * factory with its own name ('ojs' / 'omp' / 'ops'). All real config
 * logic lives here so the three apps never drift.
 *
 * Parameters:
 *   app      — short app name; becomes the Playwright project name used
 *              on the CLI (e.g. `playwright test --project=ojs`).
 *   basePort — first TCP port of this app's PHP dev-server block
 *              (default 8000). Worker N gets basePort + N, so each app
 *              owns a 100-port block and the three fleets can run
 *              side-by-side on one machine:
 *                OJS 8000–8099 / OMP 8100–8199 / OPS 8200–8299.
 *              Overridable at runtime with PLAYWRIGHT_BASE_PORT (env or
 *              .env.playwright) — useful for a second checkout of the
 *              same app, or to dodge a port already in use.
 *   sharedTests — whether this app runs the SHARED feature specs in
 *              lib/pkp/playwright/tests/*.spec.js (default true).
 *              lib/pkp/playwright/tests/bootstrap.setup.js is always
 *              collected; only the feature specs are gated.
 *
 *              The shared suite was written against OJS and is
 *              OJS-flavoured below the payload level (section-keyed
 *              scenario specs, the `scenarios/journal` alias, stage
 *              labels, decision rosters — MULTIAPP-PLAN §5.6 and §7.3).
 *              Until the "shared-test purge probe" has demoted what
 *              doesn't generalize, an app that turns this on gets a wall
 *              of failures that says nothing about the app. OMP and OPS
 *              therefore start with `sharedTests: false` so a bare
 *              `npm run test:e2e` in those repos runs their own tree and
 *              stays meaningful. Flipping the flag to true IS the §5.6
 *              milestone — do it deliberately, per app, and demote the
 *              specs that fail.
 */
module.exports = function createPlaywrightConfig({
	app,
	basePort = 8000,
	sharedTests = true,
}) {
	const appRoot = process.cwd();
	require('dotenv').config({path: path.join(appRoot, '.env.playwright')});
	const isCI = !!process.env.CI;

	// Worker count resolution (in priority order):
	//   1. `--workers=N` CLI flag — Playwright's canonical knob, parsed
	//      out of process.argv so the spawn count below stays in sync
	//      (Playwright applies --workers AFTER this config evaluates,
	//      otherwise we'd just read it from the resolved config).
	//   2. PLAYWRIGHT_WORKERS env var — convenient for npm scripts /
	//      .env files where threading a CLI flag is awkward.
	//   3. CI: 3 (matches the historical default).
	//   4. Local: ceil(cpus / 2) — same heuristic Playwright's own
	//      default uses, with a floor of 1.
	//
	// The chosen count drives both the Playwright `workers` setting AND
	// the number of `php -S` instances spawned by `webServer` below.
	// Each Playwright worker is paired 1:1 with a dedicated PHP server
	// on a unique port (basePort, basePort+1, …). This avoids the
	// PHP_CLI_SERVER_WORKERS env var which is Unix-only — Windows PHP
	// ignores it, and the resulting single-process dev server deadlocks
	// on same-origin sub-requests (page loads fetching their own /api).
	const argvWorkers = (() => {
		const argv = process.argv;
		for (let i = 0; i < argv.length; i++) {
			if (argv[i] === '--workers' && argv[i + 1]) {
				const n = parseInt(argv[i + 1], 10);
				if (Number.isFinite(n) && n > 0) return n;
			}
			const m = argv[i].match(/^--workers=(\d+)$/);
			if (m) return parseInt(m[1], 10);
		}
		return null;
	})();
	const playwrightWorkers = (() => {
		if (argvWorkers) return argvWorkers;
		const override = parseInt(process.env.PLAYWRIGHT_WORKERS ?? '', 10);
		if (Number.isFinite(override) && override > 0) {
			return override;
		}
		if (isCI) return 3;
		return Math.max(1, Math.ceil(os.cpus().length / 2));
	})();
	// Base-port resolution: PLAYWRIGHT_BASE_PORT (env / .env.playwright)
	// wins over the app's compiled-in `basePort`, which defaults to 8000.
	const resolvedBasePort = (() => {
		const override = parseInt(process.env.PLAYWRIGHT_BASE_PORT ?? '', 10);
		if (Number.isFinite(override) && override > 0 && override < 65536) {
			return override;
		}
		return basePort;
	})();
	const phpPorts = Array.from(
		{length: playwrightWorkers},
		(_, i) => resolvedBasePort + i,
	);
	// Republish the resolved value so the per-worker `baseURL` fixture in
	// support/base-test.js computes `basePort + parallelIndex` off the same
	// number. Playwright worker processes re-require this config file
	// before any fixture runs, so this assignment is in effect there too —
	// no cross-process plumbing needed.
	process.env.PLAYWRIGHT_BASE_PORT = String(resolvedBasePort);

	// Shared FEATURE specs, gated by the `sharedTests` parameter above.
	// The shared bootstrap.setup.js is never gated — it is the harness,
	// not a feature spec, and every app depends on it.
	//
	// This has to be expressed as an IGNORE, not by dropping the glob from
	// testMatch: Playwright prefixes a relative pattern with `**/`, so
	// 'playwright/tests/**/*.spec.js' also matches
	// 'lib/pkp/playwright/tests/foo.spec.js' — the app-tree glob alone can
	// never exclude the shared tree. (The explicit lib/pkp entries in
	// testMatch have therefore always been redundant; they stay for
	// readability.) A pattern that starts at `lib/pkp/` is unambiguous
	// under the same `**/` prefixing, so the ignore is exact.
	const sharedSpecIgnores = sharedTests
		? []
		: ['lib/pkp/playwright/tests/**/*.spec.js'];

	return defineConfig({
		testDir: appRoot,
		testMatch: [
			'playwright/tests/**/*.spec.js',
			'playwright/tests/**/*.setup.js',
			'lib/pkp/playwright/tests/**/*.spec.js',
			'lib/pkp/playwright/tests/**/*.setup.js',
		],
		testIgnore: sharedSpecIgnores,
		fullyParallel: true,
		forbidOnly: isCI,
		retries: isCI ? 1 : 0,
		workers: playwrightWorkers,
		reporter: isCI
			? [['github'], ['html', {open: 'never'}]]
			: [['list'], ['html', {open: 'never'}]],
		outputDir: path.join(appRoot, 'test-results'),
		// Test-level timeout: hard cap on a single test's total runtime.
		// Catches genuine hangs (infinite loops, dead waits). Stays at
		// 60s — that's plenty for any single test's full UI flow.
		timeout: 60_000,
		// Expect / action timeouts absorb single-request latency tails.
		// With one PHP process per worker (no PHP_CLI_SERVER_WORKERS on
		// Windows), browser-driven parallel sub-requests serialize on
		// the dev server. Empirically ~2% of HTTP connections see a
		// 5-16s wait under heavy load (mostly dashboard mount API
		// calls + the static assets queued behind them). Bumping
		// per-action waits to 20s absorbs that tail; the test-level
		// 60s timeout still catches genuine hangs.
		expect: {timeout: 20_000},
		use: {
			// Default points at the first PHP server (the base port) — used
			// by the setup project (which runs single-worker on
			// parallelIndex=0) and as a fallback. The main project
			// overrides this per-worker via the baseURL fixture in
			// lib/pkp/playwright/support/base-test.js so each parallel
			// worker hits its own dedicated PHP server.
			baseURL: `http://127.0.0.1:${phpPorts[0]}`,
			actionTimeout: 20_000,
			navigationTimeout: 45_000,
			trace: 'retain-on-failure',
			video: isCI ? 'retain-on-failure' : 'off',
			screenshot: 'only-on-failure',
			// Force `prefers-reduced-motion: reduce` on every browser
			// context — both the default one Playwright creates for the
			// `page` fixture AND any manually-created context via
			// `browser.newContext(...)`. The lib/ui-library modal/dialog
			// styles collocate `@media (prefers-reduced-motion: reduce)`
			// blocks that nullify slide/fade animations, saving
			// ~300–450 ms per side-modal open or close (and removing
			// parallel-load flake from animation timing). Setting this
			// under `contextOptions` (rather than top-level
			// `use.reducedMotion`) is the propagating form — see
			// https://github.com/microsoft/playwright/issues/21133.
			//
			// `PLAYWRIGHT_KEEP_ANIMATIONS=1` opts out (debug only).
			contextOptions: process.env.PLAYWRIGHT_KEEP_ANIMATIONS
				? {}
				: {reducedMotion: 'reduce'},
		},
		// One PHP dev server per Playwright worker, each on its own port
		// starting at `basePort`. The 1:1 worker→server pairing — combined
		// with bumped expect/action timeouts above — replaces the
		// historical single-server + PHP_CLI_SERVER_WORKERS approach,
		// which was Unix-only (the env var is ignored on Windows
		// native).
		//
		// The launcher script `scripts/start-php-server.js` is a
		// cross-platform Node entry that:
		//   1. Seeds config.test.inc.php (idempotent — the helper in
		//      scripts/seed-test-config.js).
		//   2. Creates the per-port log dir.
		//   3. spawns `php -S 127.0.0.1:<port>` with stdout/stderr
		//      piped to temp/per-port-logs/<port>.log.
		//   4. Forwards SIGINT/SIGTERM to PHP so Playwright's webServer
		//      teardown actually stops the server.
		//
		// Doing this in Node — instead of the historical
		// `sh seed-test-config.sh && mkdir -p ... && exec php ... >>file`
		// shell command — means Windows users don't need Git Bash for
		// the seed step.
		//
		// `-d log_errors=On -d error_log=temp/per-port-logs/<port>.log`
		// (set inside start-php-server.js) doubles up the redirect: PHP
		// runtime fatals/warnings land in the same file via PHP's own
		// fopen, so even if stdio handling on some runner mangles the
		// piped streams, fatals still get captured. display_errors=Off
		// keeps errors from duplicating through stderr. memory_limit=512M
		// because publish-issue flows that fan out subscriber
		// notifications can blow past PHP's 128M default.
		webServer: phpPorts.map((port) => ({
			command: `node lib/pkp/playwright/scripts/start-php-server.js ${port}`,
			url: `http://127.0.0.1:${port}`,
			cwd: appRoot,
			// Reuse a server already listening on this port. Saves cold-boot
			// time on local iteration AND on CI re-runs where the prior
			// run's PHP servers might still be alive (e.g. a retried
			// job that didn't fully tear down). If the running server's
			// config has drifted from what this run expects, the
			// failures will surface as test errors rather than as
			// silent corruption — visible in the trace.
			reuseExistingServer: true,
			timeout: 60_000,
			// start-php-server.js pipes PHP's stdout/stderr into the
			// per-port log file directly via fs.openSync — Playwright sees
			// no useful streams from the Node launcher itself, so we
			// ignore them. This keeps `npx playwright test` output
			// readable while still preserving each server's full access
			// log in temp/per-port-logs/<port>.log for diagnosis.
			stdout: 'ignore',
			stderr: 'ignore',
			env: {
				...process.env,
				APPLICATION_ENV: 'test',
				// PHP_CLI_SERVER_WORKERS intentionally unset by
				// default. With one dedicated PHP server per
				// Playwright worker, raising the Playwright worker
				// count is the supported way to scale concurrency.
				// PHP_CLI_SERVER_WORKERS is Unix-only (Windows PHP
				// ignores it) and we want Unix and Windows to behave
				// the same so test stability investigations on Unix
				// translate directly to Windows.
				//
				// PLAYWRIGHT_PHP_WORKERS env var, if explicitly set,
				// is forwarded as PHP_CLI_SERVER_WORKERS for users
				// who want extra in-PHP concurrency on Unix as a
				// short-term workaround. Treat it as an escape hatch,
				// not the default — flakiness attributable to 1-wide
				// per-port concurrency should be addressed at the
				// test or app layer, not papered over here.
				...(process.env.PLAYWRIGHT_PHP_WORKERS
					? {PHP_CLI_SERVER_WORKERS: process.env.PLAYWRIGHT_PHP_WORKERS}
					: {}),
			},
		})),
		projects: [
			{
				name: 'setup',
				testMatch: /bootstrap\.setup\.js/,
				use: {...devices['Desktop Chrome']},
			},
			{
				name: app,
				dependencies: ['setup'],
				// retries: 1 — under 5-worker parallel load a handful of
				// specs occasionally flake on environmental races (dev-server
				// JSON-truncation, seq-ordering, media web/high-res linking);
				// each passes deterministically in isolation. One retry
				// absorbs the transient failure without masking a real
				// regression (a genuine bug fails both attempts). Added after
				// the third distinct flake surface was observed (see
				// PROGRESS.md watch-item). The serial project deliberately
				// keeps no retries — it runs single-worker and must stay
				// deterministic.
				retries: 1,
				testMatch: [
					'playwright/tests/**/*.spec.js',
					'lib/pkp/playwright/tests/**/*.spec.js',
				],
				// Serial specs (charter principle 9: globally-scanning
				// operations — scheduled tasks, site-level plugin toggles,
				// cache clears) must NEVER run inside this parallel
				// project; they live exclusively in the 'serial' project
				// below.
				testIgnore: [
					'playwright/tests/serial/**',
					'lib/pkp/playwright/tests/serial/**',
					...sharedSpecIgnores,
				],
				use: {...devices['Desktop Chrome']},
			},
			{
				// Serial project — charter principles 8–9
				// (docs/e2e/PRINCIPLES.md): specs whose effects span all
				// journals/workers (scheduled-task reminders, site-level
				// plugin toggles, cache clears, Mailpit clearAll) run here,
				// one at a time, with no parallel neighbors.
				//
				// Ordering semantics: depending on the parallel app project
				// (not just 'setup') means a full `playwright test` run
				// executes setup → <app> (parallel) → serial, so serial
				// specs are guaranteed to run ALONE at the END — Playwright
				// only starts a project once all its dependencies have
				// finished. Per principle 9 serial specs must not tolerate
				// parallel neighbors, so this ordering is enforced, not
				// merely documented. The trade-off: `--project=serial` also
				// runs the full parallel suite first; use
				// `--project=serial --no-deps` for local iteration on a
				// serial spec when the baseline is already bootstrapped.
				// `--project=<app>` (npm run test:e2e:ojs) is unaffected:
				// it pulls in only its own 'setup' dependency.
				//
				// workers: 1 caps this project to a single worker process
				// (supported per-project since Playwright 1.52) and
				// fullyParallel: false keeps tests in declaration order —
				// together they override the parallel-first defaults above.
				name: 'serial',
				dependencies: ['setup', app],
				fullyParallel: false,
				workers: 1,
				testMatch: [
					'playwright/tests/serial/**/*.spec.js',
					'lib/pkp/playwright/tests/serial/**/*.spec.js',
				],
				testIgnore: sharedSpecIgnores,
				use: {...devices['Desktop Chrome']},
			},
		],
	});
};
