// @ts-check
const {test, expect} = require('../support/base-test.js');
const {execFileSync} = require('child_process');
const path = require('path');

/**
 * Jobs queue — row #45 in docs/e2e-playwright-migration.md.
 *
 * Cypress source: lib/pkp/cypress/tests/integration/Jobs.cy.js. The
 * Cypress suite exercises manual job dispatch + processing via
 * `cy.exec('php lib/pkp/tools/jobs.php ...')` shell-outs:
 *   - dispatchTestQueueJobs — enqueue N test jobs
 *   - runQueueJobs         — drain the queue, marking failable ones failed
 *   - purgeQueueJobs       — remove queued jobs
 *   - clearFailedJobs      — remove failed job rows
 * Each of those runs a CLI tool synchronously and asserts on the
 * resulting DOM row count in `/admin/jobs` and `/admin/failedJobs`.
 *
 * Rows 1–2 cover the structural shape of the two admin pages — they
 * render, show the right page title, carry a PkpTable landmark, and
 * the API routes feeding them resolve.
 *
 * Row 3 ports the manual-processing surface using Node's
 * `child_process` as the `cy.exec` equivalent: the Playwright
 * webServer is a local PHP dev server sharing the same test DB, so
 * shelling out to `APPLICATION_ENV=test php lib/pkp/tools/jobs.php`
 * dispatches/drains against exactly the state the browser sees.
 * Determinism notes that make this parallel-safe:
 *   - TestJobFailure is pinned to Job::TESTING_QUEUE ('queuedTestJob',
 *     TestJobFailure.php:46) and the end-of-request web JobRunner
 *     explicitly EXCLUDES that queue (PKPQueueProvider.php:57
 *     `notQueue(TESTING_QUEUE)` when no queue is forced), so only this
 *     test's explicit `jobs.php run --test` drains ever touches it —
 *     a parallel worker's web requests can't steal the job mid-test.
 *   - The failed-jobs list is global and shared; every assertion is
 *     scoped to ids discovered by diffing before/after snapshots of
 *     TestJobFailure rows, never to counts or "first row".
 *
 * Three tests:
 *   1. `/admin/jobs` renders with the queued-jobs table landmarks.
 *   2. `/admin/failedJobs` renders with the failed-jobs table landmarks.
 *   3. Failed-job lifecycle: dispatch a TestJobFailure + drain via the
 *      jobs.php CLI; the failed row surfaces on /admin/failedJobs; its
 *      details page shows exception + payload; "Try Again" redispatches
 *      it to the queued list; a second drain fails it again; Delete
 *      removes it for good.
 *
 * Reauthentication: AdminHandler gates admin routes through
 * ReauthenticationRequiredPolicy, which is a no-op when
 * `security.password_timeout` is 0 (the test config default — see
 * config.TEMPLATE.inc.php:330). No elevated-session dance needed.
 *
 * API-level sanity: we also hit `/index/api/v1/jobs/all` and
 * `/index/api/v1/jobs/failed/all` to verify the controller routes are
 * wired. A 200 body with the expected pagination shape proves the
 * Laravel routes + middleware stack resolve correctly regardless of
 * whether the Vue `<jobs-page>` component happened to hydrate.
 */
test.describe('Jobs queue', () => {
	test.use({user: 'admin'});

	test(
		'site admin views the queued jobs page and API',
		{tag: '@regression'},
		async ({page}) => {
			await page.goto('/index.php/index/admin/jobs');
			await expect(page).not.toHaveURL(/\/login/);
			await expect(page).not.toHaveURL(/\/admin\/confirmAccess/);

			// Page title — the h1 uses `navigation.tools.jobs` which
			// renders as "Jobs". Match case-insensitively so any future
			// label tweak doesn't false-positive.
			await expect(
				page.getByRole('heading', {name: /^Jobs$/i, level: 1}),
			).toBeVisible({timeout: 10_000});

			// The `<jobs-page>` Vue component renders a PkpTable once the
			// API call resolves. Assert the `app__contentPanel` wrapper
			// (inherent to backend.tpl) and the `<table>` element the
			// component mounts.
			await expect(page.locator('.app__contentPanel')).toBeVisible();
			await expect(page.locator('table')).toBeVisible({timeout: 15_000});

			// Controller API sanity: the Vue component feeds from
			// /index/api/v1/jobs/all. A 200 response with `items` and
			// `pagination` shape proves the middleware chain + repo
			// resolve. Use in-page fetch so cookies ride along.
			const payload = await page.evaluate(async () => {
				const r = await fetch('/index.php/index/api/v1/jobs/all', {
					headers: {Accept: 'application/json'},
				});
				return {status: r.status, body: await r.json()};
			});
			expect(payload.status).toBe(200);
			expect(payload.body).toHaveProperty('data');
			expect(payload.body).toHaveProperty('total');
		},
	);

	test(
		'site admin views the failed jobs page and API',
		{tag: '@regression'},
		async ({page}) => {
			await page.goto('/index.php/index/admin/failedJobs');
			await expect(page).not.toHaveURL(/\/login/);
			await expect(page).not.toHaveURL(/\/admin\/confirmAccess/);

			// Page title — navigation.tools.jobs.failed renders as
			// "Failed Jobs".
			await expect(
				page.getByRole('heading', {name: /Failed Jobs/i, level: 1}),
			).toBeVisible({timeout: 10_000});

			await expect(page.locator('.app__contentPanel')).toBeVisible();
			await expect(page.locator('table')).toBeVisible({timeout: 15_000});

			const payload = await page.evaluate(async () => {
				const r = await fetch('/index.php/index/api/v1/jobs/failed/all', {
					headers: {Accept: 'application/json'},
				});
				return {status: r.status, body: await r.json()};
			});
			expect(payload.status).toBe(200);
			expect(payload.body).toHaveProperty('data');
			expect(payload.body).toHaveProperty('total');
		},
	);

	test(
		'failed job lifecycle: fail, details, redispatch, delete',
		{tag: '@regression'},
		async ({page}) => {
			// 3 CLI shell-outs each cold-boot the PHP app (~2-4 s) on top
			// of the UI flow — give the test more headroom than the 60 s
			// default without disabling the hang guard entirely.
			test.setTimeout(120_000);

			// Establish the admin session + a page to fetch from (the
			// jobs API is admin-gated; in-page fetch rides the cookies).
			await page.goto('/index.php/index/admin/failedJobs');
			await expect(page).not.toHaveURL(/\/login/);
			await expect(
				page.getByRole('heading', {name: /Failed Jobs/i, level: 1}),
			).toBeVisible({timeout: 10_000});

			// ---- 1. Dispatch + drain via the jobs.php CLI ----
			// Snapshot BEFORE so the new failed row can be identified by
			// id-diff. Only TestJobFailure rows matter — anything else on
			// the shared list belongs to other tests/runs.
			const failedBefore = (await fetchFailedTestJobRows(page)).map(
				(r) => r.id,
			);

			const dispatchOut = jobsCli('test', '--only=failed');
			expect(
				dispatchOut,
				'jobs.php test --only=failed dispatches a TestJobFailure',
			).toContain('Dispatched test job that is bound to failed');

			// `run --test` targets Job::TESTING_QUEUE explicitly
			// (jobs.php:321-323) and drains synchronously. TestJobFailure
			// has $tries = 1, so the single attempt marks it failed and
			// the row lands in failed_jobs before the CLI returns.
			const drainOut = jobsCli('run', '--test');
			expect(
				drainOut,
				'jobs.php run --test drains the testing queue',
			).toContain('Completed running');

			const afterDrain = await fetchFailedTestJobRows(page);
			const newFailed = afterDrain.filter(
				(r) => !failedBefore.includes(r.id),
			);
			expect(
				newFailed.length,
				`exactly one new TestJobFailure failed row expected, got ids=${JSON.stringify(newFailed.map((r) => r.id))}`,
			).toBe(1);
			const failedJobId = newFailed[0].id;

			// ---- 2. The failed row surfaces on /admin/failedJobs ----
			// The list paginates at 50/page in API (insertion) order. New
			// rows append at the end, so when our row's index is < 50 it
			// is guaranteed onto page 1 regardless of churn. A deeper
			// position means an unexpectedly polluted DB — walk Next
			// pages from the known index instead of failing blind.
			await gotoFailedJobsPageContaining(page, failedJobId);
			const failedRow = failedJobRow(page, failedJobId);
			await expect(failedRow).toBeVisible({timeout: 15_000});
			await expect(failedRow).toContainText('queuedTestJob');

			// ---- 3. Details page shows the exception + payload ----
			await failedRow.getByRole('link', {name: 'Details'}).click();
			await expect(
				page.getByRole('heading', {name: /Failed Job Details/i, level: 1}),
			).toBeVisible({timeout: 15_000});
			// AdminHandler::failedJobDetails renders attribute/value rows;
			// the exception value carries the thrown message
			// (TestJobFailure.php:56) and the payload row carries the
			// serialized job, including its FQN. Scope each <pre> to its
			// attribute row — 'TestJobFailure' also appears in the
			// Display Name value and the exception's stack trace.
			const detailsRow = (attribute) =>
				page.getByRole('row').filter({
					has: page.getByRole('cell', {name: attribute, exact: true}),
				});
			await expect(detailsRow('Exception').locator('pre')).toContainText(
				'Test failure job',
			);
			await expect(detailsRow('Payload').locator('pre')).toContainText(
				'TestJobFailure',
			);

			// ---- 4. Redispatch returns it to the queued list ----
			await gotoFailedJobsPageContaining(page, failedJobId);
			const queuedBefore = (await fetchQueuedTestJobRows(page)).map(
				(r) => r.id,
			);
			const redispatchResponse = page.waitForResponse(
				(r) =>
					r.url().includes(`/jobs/redispatch/${failedJobId}`) &&
					r.request().method() === 'POST',
			);
			await failedJobRow(page, failedJobId)
				.getByRole('button', {name: 'Try Again'})
				.click();
			expect((await redispatchResponse).status()).toBe(200);
			// The Vue page drops the row client-side on success…
			await expect(failedJobRow(page, failedJobId)).toHaveCount(0);
			// …and the API agrees: the failed row is gone, while a fresh
			// queued TestJobFailure row (new autoincrement id —
			// FailedJob::redispatchToQueue inserts a new jobs row) exists.
			const failedAfterRedispatch = (
				await fetchFailedTestJobRows(page)
			).map((r) => r.id);
			expect(failedAfterRedispatch).not.toContain(failedJobId);
			const requeued = (await fetchQueuedTestJobRows(page)).filter(
				(r) => !queuedBefore.includes(r.id),
			);
			expect(
				requeued.length,
				`exactly one requeued TestJobFailure expected, got ids=${JSON.stringify(requeued.map((r) => r.id))}`,
			).toBe(1);
			// The queued list UI shows the redispatched row too. Queued
			// rows from other workers' web requests are transient but
			// only ever APPEND (and drain from the front), so a row in
			// the first 50 stays on page 1 for the lifetime of this
			// assertion. The testing queue itself is excluded from the
			// web runner, so nothing can drain our row underneath us.
			const queuedAll = await fetchQueuedTestJobRows(page, {all: true});
			const queuedIdx = queuedAll.findIndex(
				(r) => r.id === requeued[0].id,
			);
			if (queuedIdx > -1 && queuedIdx < 50) {
				await page.goto('/index.php/index/admin/jobs');
				const queuedRow = page
					.getByRole('row')
					.filter({hasText: 'TestJobFailure'})
					.filter({
						has: page.getByRole('cell', {
							name: String(requeued[0].id),
							exact: true,
						}),
					});
				await expect(queuedRow).toBeVisible({timeout: 15_000});
				await expect(queuedRow).toContainText('queuedTestJob');
			}

			// ---- 5. Second drain fails it again ----
			const drain2Out = jobsCli('run', '--test');
			expect(drain2Out).toContain('Completed running');
			const afterDrain2 = await fetchFailedTestJobRows(page);
			const refailed = afterDrain2.filter(
				(r) =>
					!failedBefore.includes(r.id) && r.id !== failedJobId,
			);
			expect(
				refailed.length,
				`exactly one re-failed TestJobFailure expected, got ids=${JSON.stringify(refailed.map((r) => r.id))}`,
			).toBe(1);
			const secondFailedId = refailed[0].id;

			// ---- 6. Delete removes the row for good ----
			await gotoFailedJobsPageContaining(page, secondFailedId);
			const secondRow = failedJobRow(page, secondFailedId);
			await expect(secondRow).toBeVisible({timeout: 15_000});
			const deleteResponse = page.waitForResponse(
				(r) =>
					r.url().includes(`/jobs/failed/delete/${secondFailedId}`) &&
					r.request().method() === 'POST',
			);
			await secondRow.getByRole('button', {name: 'Delete'}).click();
			expect((await deleteResponse).status()).toBe(200);
			await expect(failedJobRow(page, secondFailedId)).toHaveCount(0);

			// Gone from the backend too — and nothing of ours is left on
			// the shared list (parallel-hygiene: the test cleans up the
			// only row it created).
			const failedFinal = (await fetchFailedTestJobRows(page)).map(
				(r) => r.id,
			);
			expect(failedFinal).not.toContain(secondFailedId);
			expect(
				failedFinal.filter((id) => !failedBefore.includes(id)),
			).toEqual([]);
		},
	);
});

/**
 * Run lib/pkp/tools/jobs.php synchronously with the test environment.
 * Mirrors the legacy `cy.exec('php lib/pkp/tools/jobs.php …')` pattern:
 * cwd is the app root (the CLI chdir()s there anyway — jobs.php:41) and
 * APPLICATION_ENV=test routes Config at config.test.inc.php
 * (lib/pkp/includes/bootstrap.php:39), i.e. the same DB the PHP dev
 * servers use.
 *
 * @param {...string} args jobs.php arguments, e.g. 'test', '--only=failed'
 * @returns {string} combined stdout
 */
function jobsCli(...args) {
	return execFileSync('php', ['lib/pkp/tools/jobs.php', ...args], {
		cwd: path.resolve(__dirname, '..', '..', '..', '..'),
		env: {...process.env, APPLICATION_ENV: 'test'},
		encoding: 'utf8',
		timeout: 60_000,
		// Capture stderr instead of inheriting it: Queue::failing()
		// error_log()s the full exception when the TestJobFailure is
		// drained (PKPQueueProvider.php:158), which would otherwise spew
		// an expected 20-line stack trace into the reporter output.
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}

/**
 * Fetch every TestJobFailure row from the failed-jobs API, walking all
 * pages (50 rows/page, BaseRepository::$perPage). In-page fetch so the
 * admin session cookies ride along.
 *
 * @param {import('@playwright/test').Page} page admin-authenticated page
 * @returns {Promise<Array<{id: number, displayName: string}>>}
 */
async function fetchFailedTestJobRows(page) {
	return fetchJobRows(page, '/index.php/index/api/v1/jobs/failed/all');
}

/**
 * Fetch every queued TestJobFailure row from the jobs API. With
 * `{all: true}`, returns ALL queued rows instead (used to compute the
 * row's page index on the shared queued list).
 *
 * @param {import('@playwright/test').Page} page
 * @param {{all?: boolean}} [opts]
 */
async function fetchQueuedTestJobRows(page, {all = false} = {}) {
	return fetchJobRows(page, '/index.php/index/api/v1/jobs/all', {all});
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} url
 * @param {{all?: boolean}} [opts]
 */
async function fetchJobRows(page, url, {all = false} = {}) {
	return page.evaluate(
		async ({url, all}) => {
			const rows = [];
			let pageNum = 1;
			let lastPage = 1;
			do {
				const r = await fetch(`${url}?page=${pageNum}`, {
					headers: {Accept: 'application/json'},
				});
				if (!r.ok) {
					throw new Error(`${url} page ${pageNum} -> ${r.status}`);
				}
				const j = await r.json();
				lastPage = j.pagination?.lastPage ?? 1;
				for (const row of j.data || []) {
					if (all || (row.displayName || '').includes('TestJobFailure')) {
						rows.push({id: row.id, displayName: row.displayName});
					}
				}
				pageNum++;
			} while (pageNum <= lastPage);
			return rows;
		},
		{url, all},
	);
}

/**
 * Locator for the failed-jobs table row carrying the given job id.
 * Filtered on the TestJobFailure displayName too so a numeric
 * coincidence in another row's cells can't match.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} jobId
 */
function failedJobRow(page, jobId) {
	return page
		.getByRole('row')
		.filter({hasText: 'TestJobFailure'})
		.filter({
			has: page.getByRole('cell', {name: String(jobId), exact: true}),
		});
}

/**
 * Navigate to /admin/failedJobs and, when the target row sits beyond
 * the first API page (50/page), click Next until its page is shown.
 * The page index is computed from the unfiltered API list — the failed
 * list only mutates through this very test, so the index is stable
 * across the navigation.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} jobId
 */
async function gotoFailedJobsPageContaining(page, jobId) {
	await page.goto('/index.php/index/admin/failedJobs');
	await expect(
		page.getByRole('heading', {name: /Failed Jobs/i, level: 1}),
	).toBeVisible({timeout: 15_000});
	const allRows = await fetchJobRows(
		page,
		'/index.php/index/api/v1/jobs/failed/all',
		{all: true},
	);
	const idx = allRows.findIndex((r) => r.id === jobId);
	expect(idx, `failed job ${jobId} present in jobs/failed/all`).toBeGreaterThan(
		-1,
	);
	const targetPage = Math.floor(idx / 50) + 1;
	for (let i = 1; i < targetPage; i++) {
		const loaded = page.waitForResponse(
			(r) =>
				r.url().includes('/jobs/failed/all') &&
				r.request().method() === 'GET',
		);
		// The Pagination nav carries the localized aria-label
		// "View additional pages" (common.pagination.label) — scoping by
		// it keeps the locator unique against the page's other navs.
		await page
			.getByRole('navigation', {name: 'View additional pages'})
			.getByRole('button', {name: 'Next'})
			.click();
		await loaded;
	}
}
