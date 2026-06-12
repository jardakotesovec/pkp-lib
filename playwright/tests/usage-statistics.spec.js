// @ts-check
const {test, expect} = require('../support/base-test.js');
const submissionPublished = require('../../../../playwright/fixtures/scenarios/submission-published.js');

/**
 * Usage statistics — docs/e2e/plans/usage-statistics.md (placement
 * lib/pkp: the stats handlers, API controllers and Vue pages are shared
 * across OJS/OMP/OPS; only locale overrides — "Articles", "Journal" — and
 * the metrics scenario passthrough are app-side).
 *
 * Row 1 absorbs playwright/tests/article-statistics.spec.js (migration
 * row #36), moved here during this refit.
 *
 * Metrics seeding (rows 4–5) uses the OJS submission scenario's
 * `metrics: {views?, downloads?, months?}` passthrough
 * (classes/testing/bootstrap/Processor/MetricsProcessor.php): compiled
 * `metrics_submission` rows are written on the 1st of each monthly
 * bucket, spread backwards from the current month, and the inserted
 * rows are echoed back as `metrics.rows: [{date, assocType, metric}]` —
 * tests derive their date-range filters from that echo instead of
 * re-implementing the layout (run-date / timezone safe).
 */

test.use({user: 'dbarnes'});

/**
 * Worker- and run-scoped tag (whitespace-free; random suffix because
 * exact-count assertions on a long-lived DB must not pick up leftovers
 * from previous runs — patterns rule 10).
 */
function uniqueTag(suffix) {
	const rand = Math.random().toString(36).slice(2, 8);
	return `ust-w${test.info().parallelIndex}-${suffix}-${rand}`;
}

/**
 * Predicate for the publications detail-table items fetch (NOT the
 * timeline fetch, which shares the path prefix).
 *
 * @param {string=} containsParam substring that must appear in the URL query
 */
function publicationItemsResponse(containsParam) {
	return (/** @type {import('@playwright/test').Response} */ res) =>
		res.url().includes('/api/v1/stats/publications') &&
		!res.url().includes('/timeline') &&
		(containsParam === undefined || res.url().includes(containsParam)) &&
		res.ok();
}

/**
 * Type a search phrase into the stats detail-table title search and wait
 * for the filtered items fetch. The Search component reacts to keyup
 * with a 250ms debounce — fill() alone never fires it.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} phrase
 */
async function searchPublications(page, phrase) {
	const input = page.locator('.pkpStats__titleSearch input[type="search"]');
	const settled = page.waitForResponse(
		publicationItemsResponse(`searchPhrase=${encodeURIComponent(phrase)}`),
		{timeout: 15_000},
	);
	await input.pressSequentially(phrase);
	await settled;
}

/**
 * Apply a custom date range via the DateRange component and wait for the
 * re-queried items fetch.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} dateStart YYYY-MM-DD
 * @param {string} dateEnd   YYYY-MM-DD
 */
async function applyCustomDateRange(page, dateStart, dateEnd) {
	await page.locator('button.pkpDateRange__button').click();
	const options = page.locator('.pkpDateRange__options');
	await expect(options).toBeVisible();
	await options.locator('input.pkpDateRange__input--start').fill(dateStart);
	await options.locator('input.pkpDateRange__input--end').fill(dateEnd);
	const settled = page.waitForResponse(
		publicationItemsResponse(`dateStart=${dateStart}`),
		{timeout: 15_000},
	);
	await options.getByRole('button', {name: 'Apply'}).click();
	await settled;
}

/**
 * The detail-table row for a publication whose title carries the tag.
 * Cell order is fixed by PKPStatsHandler::getTableColumns(): title(0),
 * abstractViews(1), galleyViews/File Views(2), pdf(3), html(4),
 * other(5), total(6).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} tag
 */
function publicationRow(page, tag) {
	return page
		.getByRole('table', {name: 'Article Details'})
		.getByRole('row')
		.filter({hasText: tag});
}

test.describe('Usage statistics', () => {
	// Plan row 1 — absorbed from playwright/tests/article-statistics.spec.js
	// (Cypress migration row #36). Structural "page renders on empty
	// metrics" contract for /stats/publications.
	test(
		'editor views article statistics landmarks on a published submission',
		async ({page, pkpApi}) => {
			const tag = uniqueTag('land');
			// submissionPublished attaches `${tag}` to every title locale
			// (PublicationsProcessor), so the full title written to disk
			// is `Published article ${tag}`.
			const spec = submissionPublished({tag});
			await pkpApi.createSubmission(spec);

			const resp = await page.goto(
				'/index.php/publicknowledge/stats/publications',
			);
			expect(resp?.status()).toBe(200);

			// Page-level landmark: h1 renders the localized
			// common.publications string, which OJS overrides to "Articles".
			const h1 = page.getByRole('heading', {level: 1, name: 'Articles'});
			await expect(h1).toBeVisible();

			// The stats timeline graph mounts as `.pkpStats__graph` — the
			// abstract-views chart + timeline-type toggle buttons live here.
			const graph = page.locator('.pkpStats__graph');
			await expect(graph).toBeVisible();

			// Abstracts/Files timeline-type toggles — structural proof that
			// the page's interactive counters surface is mounted. Always
			// present whether or not metrics have been seeded.
			const selectors = graph.locator('.pkpStats__graphSelectors');
			await expect(
				selectors.getByRole('button', {name: 'Abstracts', exact: true}),
			).toBeVisible();
			await expect(
				selectors.getByRole('button', {name: 'Files', exact: true}),
			).toBeVisible();

			// Date-range picker — always rendered, even with no data.
			await expect(page.locator('button.pkpDateRange__button')).toBeVisible();

			// Article Details detail-table landmark (h2 id from
			// publications.tpl; "Article Details" via OJS's manager.po).
			const detailsHeading = page.locator('h2#publicationDetailTableLabel');
			await expect(detailsHeading).toBeVisible();
			await expect(detailsHeading).toContainText('Article Details');

			// The table mounts with its column headers even with zero
			// metrics — usage rows are gated on non-zero counters, which
			// is exactly the structural contract this row protects.
			const detailsTable = page.getByRole('table', {name: 'Article Details'});
			await expect(detailsTable).toBeVisible();
			await expect(
				detailsTable.getByRole('columnheader', {name: /Abstract Views/i}),
			).toBeVisible();
			await expect(
				detailsTable.getByRole('columnheader', {name: /^File Views$/i}),
			).toBeVisible();
		},
	);

	// Plan row 2
	test(
		'editorial activity page reflects seeded workflow data',
		{tag: '@regression'},
		async ({page, pkpApi}) => {
			const tag = uniqueTag('edi');

			// Baseline BEFORE seeding: totals only grow on the shared
			// journal, so `final >= baseline + seeded` is parallel-safe
			// and strictly stronger than the bare `>= seeded` bound.
			const baselineResp = await page.request.get(
				'/index.php/publicknowledge/api/v1/stats/editorial',
			);
			expect(baselineResp.ok()).toBeTruthy();
			/** @type {Array<{key: string, value: number}>} */
			const baseline = await baselineResp.json();
			const baselineOf = (key) =>
				baseline.find((row) => row.key === key)?.value ?? 0;
			const receivedBefore = baselineOf('submissionsReceived');
			const declinedBefore = baselineOf('submissionsDeclined');

			// One submitted + one desk-declined submission, mirroring the
			// real intake the page counts (Repo::submission()->submit()
			// and a recorded INITIAL_DECLINE decision).
			const base = {
				journal: 'publicknowledge',
				submitter: 'atester',
				section: 'ART',
				locale: 'en',
			};
			await pkpApi.createSubmission({
				...base,
				tag: `${tag}-rcv`,
				submitted: true,
				publications: [{metadata: {title: {en: `Received ${tag}`}}}],
			});
			await pkpApi.createSubmission({
				...base,
				tag: `${tag}-dcl`,
				participants: [{user: 'dbarnes', role: 'editor'}],
				decisions: [{type: 'initialDecline', by: 'dbarnes'}],
				publications: [{metadata: {title: {en: `Declined ${tag}`}}}],
			});

			const resp = await page.goto(
				'/index.php/publicknowledge/stats/editorial',
			);
			expect(resp?.status()).toBe(200);

			// Date-range control + the trends table are the page's
			// interactive landmarks.
			await expect(page.locator('button.pkpDateRange__button')).toBeVisible();
			const table = page.locator('.pkpTable--editorialStats');
			await expect(table).toBeVisible();

			// Named metric rows. The "Total" cell may carry a yearly
			// average suffix — `{count} ({avg}/year)` — so parse the
			// leading integer.
			const totalFor = async (rowName) => {
				const row = table.getByRole('row').filter({
					has: page.getByRole('cell', {name: rowName, exact: true}),
				});
				await expect(row).toBeVisible();
				const text = (await row.getByRole('cell').nth(2).innerText()).trim();
				const value = parseInt(text, 10);
				expect(Number.isFinite(value), `${rowName} total parses`).toBe(true);
				return value;
			};

			expect(await totalFor('Submissions Received')).toBeGreaterThanOrEqual(
				receivedBefore + 2,
			);
			expect(await totalFor('Submissions Declined')).toBeGreaterThanOrEqual(
				declinedBefore + 1,
			);

			// Days-to-decision row renders by name (derived number — the
			// value itself is unit-test territory). The cell embeds a
			// tooltip, so match by text rather than exact accessible name.
			await expect(
				table
					.getByRole('row')
					.filter({hasText: 'Days to First Editorial Decision'}),
			).toBeVisible();
		},
	);

	// Plan row 3
	test(
		'users stats page shows exact per-role counts on a scratch journal',
		{tag: '@regression'},
		async ({page, pkpApi}) => {
			const tag = uniqueTag('usr');
			// Known role mix. On a scratch journal the DEFAULT user groups
			// apply (registry/userGroups.xml): the `editor` group carries
			// roleId 0x10 = ROLE_ID_MANAGER (line 18), so minoue counts
			// under "Journal Manager", NOT "Section Editor" — only the
			// sectionEditor/guestEditor groups are ROLE_ID_SUB_EDITOR.
			// layoutEditor maps to ROLE_ID_ASSISTANT.
			const {context} = await pkpApi.createJournal({
				tag,
				users: [
					{username: 'dbarnes', roles: ['manager']},
					{username: 'minoue', roles: ['editor']},
					{username: 'dbuskins', roles: ['sectionEditor']},
					{username: 'jjanssen', roles: ['reviewer']},
					{username: 'phudson', roles: ['reviewer']},
					{username: 'gcox', roles: ['layoutEditor']},
					{username: 'atester', roles: ['author']},
					{username: 'amccrae', roles: ['reader']},
				],
			});

			const resp = await page.goto(
				`/index.php/${context.path}/stats/users`,
			);
			expect(resp?.status()).toBe(200);

			await expect(
				page.getByRole('heading', {name: 'Registered users'}),
			).toBeVisible();

			const expectRoleCount = async (roleName, count) => {
				const row = page.getByRole('row').filter({
					has: page.getByRole('cell', {name: roleName, exact: true}),
				});
				await expect(row, `${roleName} row`).toBeVisible();
				await expect(row.getByRole('cell').nth(1)).toHaveText(String(count));
			};

			// 8 seeded users + admin, who is auto-enrolled as Journal
			// manager on every scratch journal (patterns rule 13:
			// PKPContextService::add parity) — hence Journal Manager =
			// dbarnes (manager) + minoue (editor group → ROLE_ID_MANAGER)
			// + admin = 3.
			await expectRoleCount('All Users', 9);
			await expectRoleCount('Journal Manager', 3);
			await expectRoleCount('Section Editor', 1);
			await expectRoleCount('Reviewer', 2);
			await expectRoleCount('Assistant', 1);
			await expectRoleCount('Author', 1);
			await expectRoleCount('Reader', 1);
			// admin's site-admin group is site-level (context_id NULL →
			// COALESCE 0) and never counts inside a journal context.
			await expectRoleCount('Site Administrator', 0);
			await expectRoleCount('Subscription Manager', 0);
		},
	);

	// Plan row 4
	test(
		'date-range filter re-queries the publications detail table',
		{tag: '@regression'},
		async ({page, pkpApi}) => {
			const tag = uniqueTag('rng');
			// 30 abstract views + 15 file views over 3 monthly buckets →
			// exact spread of 10/10/10 and 5/5/5 (most recent first). The
			// PDF galley gives the download rows real representation ids.
			const spec = submissionPublished({tag});
			spec.publications[0].galleys = [{label: 'PDF'}];
			spec.metrics = {views: 30, downloads: 15, months: 3};
			const created = await pkpApi.createSubmission(spec);

			// Bucket dates straight from the processor's echo — never
			// recomputed client-side (server clock owns the layout).
			const viewRows = created.metrics.rows.filter(
				(r) => r.assocType === 'submission',
			);
			const fileRows = created.metrics.rows.filter(
				(r) => r.assocType === 'submissionFile',
			);
			const bucketDates = [...new Set(viewRows.map((r) => r.date))].sort();
			expect(bucketDates).toHaveLength(3);
			const [oldest, middle] = bucketDates; // ascending: d-2, d-1, d0

			const sumInRange = (rows, from, to) =>
				rows
					.filter((r) => r.date >= from && r.date <= to)
					.reduce((acc, r) => acc + r.metric, 0);
			const expectedViews = sumInRange(viewRows, oldest, middle); // 20
			const expectedFiles = sumInRange(fileRows, oldest, middle); // 10

			await page.goto('/index.php/publicknowledge/stats/publications');
			await expect(
				page.locator('h2#publicationDetailTableLabel'),
			).toBeVisible();

			// Scope the shared table to this test's submission first.
			await searchPublications(page, tag);
			const row = publicationRow(page, tag);
			await expect(row).toBeVisible();

			// Custom range covering the two older buckets only → the row
			// shows exactly the in-range sums, proving a real re-query
			// (the initial last-30-days range showed different numbers).
			await applyCustomDateRange(page, oldest, middle);
			await expect(row.getByRole('cell').nth(1)).toHaveText(
				String(expectedViews),
			);
			await expect(row.getByRole('cell').nth(2)).toHaveText(
				String(expectedFiles),
			);

			// Range strictly before every seeded bucket → the submission
			// drops out of the table entirely (rows are gated on non-zero
			// in-range counters).
			const outYear = parseInt(oldest.slice(0, 4), 10) - 2;
			await applyCustomDateRange(page, `${outYear}-01-01`, `${outYear}-12-31`);
			await expect(row).toHaveCount(0);
			await expect(
				page.getByText(
					'No articles were found with usage statistics matching these parameters.',
				),
			).toBeVisible();
		},
	);

	// Plan row 5
	test(
		'publications usage report CSV contains the seeded row',
		{tag: '@regression'},
		async ({page, pkpApi}) => {
			const tag = uniqueTag('csv');
			// Two monthly buckets; the report targets the PREVIOUS-month
			// bucket via an explicit custom range so the test is
			// independent of the run date (the current-month bucket lands
			// on the 1st of this month, which on the 1st itself is past
			// the dateEnd<=yesterday validator and unreachable; and the
			// "All Dates" quick option is unusable on this seed data —
			// with no dateStart the API substitutes the context's
			// earliest datePublished, which is TODAY on a freshly seeded
			// test journal, producing the inverted range
			// `date BETWEEN today AND yesterday` → always empty
			// (PKPStatsPublicationController.php#802-810 +
			// PKPStatsPublicationService.php#292-293)).
			//
			// spread(42, 2) = [21, 21], spread(18, 2) = [9, 9] → the
			// previous-month bucket holds 21 abstract + 9 file views.
			const spec = submissionPublished({tag});
			spec.publications[0].galleys = [{label: 'PDF'}];
			spec.metrics = {views: 42, downloads: 18, months: 2};
			const created = await pkpApi.createSubmission(spec);
			const bucketDates = [
				...new Set(created.metrics.rows.map((r) => r.date)),
			].sort();
			expect(bucketDates).toHaveLength(2);
			const previousMonthBucket = bucketDates[0];

			await page.goto('/index.php/publicknowledge/stats/publications');
			await expect(
				page.locator('h2#publicationDetailTableLabel'),
			).toBeVisible();

			// Scope to this test's submission, then narrow onto the
			// previous-month bucket.
			await searchPublications(page, tag);
			await applyCustomDateRange(
				page,
				previousMonthBucket,
				previousMonthBucket,
			);

			const row = publicationRow(page, tag);
			await expect(row.getByRole('cell').nth(1)).toHaveText('21');
			await expect(row.getByRole('cell').nth(2)).toHaveText('9');

			// Download Report → Download Articles. The page fetches the
			// CSV via AJAX and triggers a Blob download; Playwright's
			// download event captures it.
			await page.getByRole('button', {name: 'Download Report'}).click();
			const downloadPromise = page.waitForEvent('download');
			await page
				.getByRole('button', {name: 'Download Articles'})
				.click();
			const download = await downloadPromise;
			const csv = require('fs').readFileSync(await download.path(), 'utf8');

			// The CSV carries the seeded title and its in-range counts.
			// Row shape (PKPStatsPublicationController::getItemForCSV):
			// id, title, authors, datePublished, total, abstract, galley,
			// pdf, html, other → total 30 = 21 + 9; all file views are
			// PDF (the seeded galley file).
			// The client prepends parameter header rows (date range,
			// filters, search phrase) before the API's CSV — the search
			// phrase header also carries the tag, so anchor the data line
			// on the title text.
			expect(csv).toContain(tag);
			const line = csv
				.split('\n')
				.find((l) => l.includes(tag) && l.includes('Published article'));
			expect(line, 'CSV data row with the seeded title').toBeTruthy();
			// Trailing `,0` = the JATS views column appended when the JATS
			// plugin is available (OJS overrides getItemForCSV).
			expect(line).toMatch(/,30,21,9,9,0,0(,0)?\s*$/);
		},
	);

	// Plan row 6
	test(
		'journal-level stats page mounts with date range on empty metrics',
		{tag: '@regression'},
		async ({page, pkpApi}) => {
			const tag = uniqueTag('ctx');
			// Scratch journal → genuinely zero usage metrics (the shared
			// publicknowledge journal accumulates metrics from parallel
			// seeding, so "empty" is only deterministic here).
			const {context} = await pkpApi.createJournal({
				tag,
				name: {en: `Context Stats ${tag}`},
				users: [{username: 'dbarnes', roles: ['manager']}],
			});

			const resp = await page.goto(
				`/index.php/${context.path}/stats/context`,
			);
			expect(resp?.status()).toBe(200);

			// Heading (context.context — "Journal" in OJS), date-range
			// control and the total-views panel all mount without error.
			await expect(
				page.getByRole('heading', {name: 'Journal', exact: true}),
			).toBeVisible();
			await expect(page.locator('button.pkpDateRange__button')).toBeVisible();
			const viewsHeading = page.locator('h2#contextDetailTableLabel');
			await expect(viewsHeading).toBeVisible();
			await expect(viewsHeading).toContainText('Views');

			// The detail table lists exactly one row — this journal —
			// with a zero total (StatsContextPage::setItems maps the
			// stats/contexts/{id} payload onto a single row).
			const journalRow = page
				.getByRole('row')
				.filter({hasText: `Context Stats ${tag}`});
			await expect(journalRow).toBeVisible({timeout: 15_000});
			await expect(journalRow.getByRole('cell').nth(1)).toHaveText('0');
		},
	);
});
