// @ts-check
const {test, expect} = require('../support/base-test.js');
const {PluginsGridPage} = require('../pages/PluginsGridPage.js');
const {waitForJQueryIdle} = require('../support/jquery.js');

/**
 * Plugin management — docs/e2e/plans/plugin-management.md rows 1, 2, 4, 5
 * (row 3, the site-level toggle, lives in the dedicated serial project:
 * tests/serial/site-plugin-toggle.spec.js — charter principle 9).
 *
 * All four tests drive the legacy installed-plugins grid
 * (SettingsPluginGridHandler on Settings → Website → Plugins) through
 * the shared PluginsGridPage POM, each on its own scratch journal —
 * plugin enablement is a journal-level setting and publicknowledge is
 * read-only (principle 1).
 *
 * Plugin-state baseline worth knowing (verified live): generic plugins
 * install their settings.xml defaults on EVERY context creation
 * (Plugin.php:131 hooks Context::add → installContextSpecificSettings),
 * and webFeed ships `enabled=true` (plugins/generic/webFeed/settings.xml)
 * — so a fresh scratch journal starts with webFeed ENABLED and its
 * homepage already carries the three feed <link rel="alternate"> head
 * tags. Tests below start from that reality (the plan rows were written
 * assuming fresh journals start disabled; the seed notes in the plan
 * record the correction).
 *
 * Toast note: enable/disable creates a trivial notification, but toast
 * assertions are parallel-unsafe (the notification fetch drains a
 * shared per-user queue — patterns.md "Parallel-load lessons" #2), so
 * success is asserted via persistence-on-reload + the front-end effect
 * instead.
 */

/**
 * Count the webFeed <link rel="alternate"> head tags on a journal's
 * homepage via an anonymous server-rendered GET (TemplateManager::
 * addHeader on frontend-index — no JS needed). The `request` fixture
 * carries no storageState in this file (no test.use({user})), so the
 * probe is genuinely anonymous. Scratch journals are single-locale and
 * serve the BARE URL directly (patterns.md lesson 9).
 *
 * @param {import('@playwright/test').APIRequestContext} request
 * @param {string} contextPath
 * @returns {Promise<number>} 0 when disabled; 3 (atom/rss/rss2) when enabled
 */
async function feedLinkCount(request, contextPath) {
	const res = await request.get(`/index.php/${contextPath}/`);
	expect(res.status()).toBe(200);
	const html = await res.text();
	return (
		html.match(/<link rel="alternate"[^>]*WebFeedGatewayPlugin/g) ?? []
	).length;
}

test.describe('Plugin management', () => {
	// Plan row 1.
	test(
		'manager toggles the webFeed plugin and the toggle gates the homepage feed tags both directions',
		{tag: '@regression'},
		async ({pkpApi, asUser, request}) => {
			const tag = uniqueTag(test.info(), 'tgl');
			const {context} = await pkpApi.createJournal({
				tag,
				users: [{username: 'dbarnes', roles: ['manager']}],
				issues: [{volume: 1, number: 1, year: 2026, published: true}],
			});

			// Fresh journal baseline: webFeed enabled by default → the
			// anonymous homepage <head> advertises all three feed flavours.
			expect(await feedLinkCount(request, context.path)).toBe(3);

			const ctx = await asUser('dbarnes');
			const page = await ctx.newPage();
			const grid = new PluginsGridPage(page);
			await grid.gotoJournalGrid(context.path);
			await expect(grid.enabledCheckbox('webfeedplugin')).toBeChecked();

			// Direction 1: disable via the grid → state persists across a
			// full page reload AND the homepage head loses the feed tags.
			await grid.disable('webfeedplugin');
			await grid.gotoJournalGrid(context.path);
			await expect(
				grid.enabledCheckbox('webfeedplugin'),
			).not.toBeChecked();
			expect(await feedLinkCount(request, context.path)).toBe(0);

			// Direction 2: re-enable → the head tags come back.
			await grid.enable('webfeedplugin');
			await grid.gotoJournalGrid(context.path);
			await expect(grid.enabledCheckbox('webfeedplugin')).toBeChecked();
			expect(await feedLinkCount(request, context.path)).toBe(3);
		},
	);

	// Plan row 2.
	test(
		'manager edits the CSL plugin settings through the grid Settings modal and they persist',
		{tag: '@regression'},
		async ({pkpApi, asUser}) => {
			const tag = uniqueTag(test.info(), 'csl');
			// CSL enabled via the scenario plugins passthrough — the
			// Settings row action only renders for enabled plugins
			// (GenericPlugin::getActions gates on getEnabled()).
			const {context} = await pkpApi.createJournal({
				tag,
				users: [{username: 'dbarnes', roles: ['manager']}],
				plugins: {citationstylelanguageplugin: {enabled: true}},
			});

			const ctx = await asUser('dbarnes');
			const page = await ctx.newPage();
			const grid = new PluginsGridPage(page);
			await grid.gotoJournalGrid(context.path);
			await expect(
				grid.enabledCheckbox('citationstylelanguageplugin'),
			).toBeChecked();

			// Open the per-row Settings AjaxModal → the plugin's own
			// settings form (templates/settings.tpl).
			const form = page.locator('form#citationStyleLanguageSettingsForm');
			await grid.openSettingsModal('citationstylelanguageplugin', form);

			// Change the primary citation style (radio group; fbv ids are
			// uniqid-suffixed so anchor on name+value — patterns pitfall 8)
			// and stamp the publisher-location text field for a second
			// persisted value.
			const ieeeRadio = form.locator(
				'input[name="primaryCitationStyle"][value="ieee"]',
			);
			await ieeeRadio.check();
			const location = `Location ${tag}`;
			await form.locator('input[name^="publisherLocation"]').fill(location);

			// Save: the AjaxFormHandler chain closes the modal and fires a
			// notification; wait for jQuery to settle then for the form to
			// leave the DOM (same pattern as subscription-config.spec.js).
			await form.locator('button[name="submitFormButton"]').click();
			await waitForJQueryIdle(page);
			await expect(form).toHaveCount(0, {timeout: 15_000});

			// Reopen the modal — the saved values are re-read from
			// plugin_settings by SettingsForm::initData.
			const reopened = page.locator(
				'form#citationStyleLanguageSettingsForm',
			);
			await grid.openSettingsModal('citationstylelanguageplugin', reopened);
			await expect(
				reopened.locator(
					'input[name="primaryCitationStyle"][value="ieee"]',
				),
			).toBeChecked();
			await expect(
				reopened.locator('input[name^="publisherLocation"]'),
			).toHaveValue(location);
		},
	);

	// Plan row 4.
	test(
		'plugin enablement is journal-scoped: toggling webFeed in one journal does not leak into another',
		{tag: '@regression'},
		async ({pkpApi, asUser, request}) => {
			const tag = uniqueTag(test.info(), 'scope');
			// Journal A keeps the installed default (webFeed enabled);
			// journal B seeds it disabled via the plugins passthrough.
			const {context: journalA} = await pkpApi.createJournal({
				tag: `${tag}a`,
				users: [{username: 'dbarnes', roles: ['manager']}],
			});
			const {context: journalB} = await pkpApi.createJournal({
				tag: `${tag}b`,
				users: [{username: 'dbarnes', roles: ['manager']}],
				plugins: {webfeedplugin: {enabled: false}},
			});

			// Seeded contrast: same plugin, same installation, opposite
			// per-journal state.
			expect(await feedLinkCount(request, journalA.path)).toBe(3);
			expect(await feedLinkCount(request, journalB.path)).toBe(0);

			const ctx = await asUser('dbarnes');
			const page = await ctx.newPage();
			const grid = new PluginsGridPage(page);

			await grid.gotoJournalGrid(journalA.path);
			await expect(grid.enabledCheckbox('webfeedplugin')).toBeChecked();
			await grid.gotoJournalGrid(journalB.path);
			await expect(
				grid.enabledCheckbox('webfeedplugin'),
			).not.toBeChecked();

			// Enable in B, then disable in A — each toggle must only move
			// its own journal's state.
			await grid.enable('webfeedplugin'); // still on B's grid
			expect(await feedLinkCount(request, journalB.path)).toBe(3);

			await grid.gotoJournalGrid(journalA.path);
			await grid.disable('webfeedplugin');
			expect(await feedLinkCount(request, journalA.path)).toBe(0);
			// B keeps the state it was given on ITS grid — A's disable
			// did not leak across contexts.
			expect(await feedLinkCount(request, journalB.path)).toBe(3);
			await grid.gotoJournalGrid(journalB.path);
			await expect(grid.enabledCheckbox('webfeedplugin')).toBeChecked();
		},
	);

	// Plan row 5.
	test(
		'manager filters the installed-plugins grid by name and category and restores the full listing',
		{tag: '@regression'},
		async ({pkpApi, asUser}) => {
			const tag = uniqueTag(test.info(), 'flt');
			const {context} = await pkpApi.createJournal({
				tag,
				users: [{username: 'dbarnes', roles: ['manager']}],
			});

			const ctx = await asUser('dbarnes');
			const page = await ctx.newPage();
			const grid = new PluginsGridPage(page);
			await grid.gotoJournalGrid(context.path);

			// Unfiltered baseline: rows from at least two categories
			// (generic + themes) are listed.
			await expect(grid.row('webfeedplugin')).toBeVisible();
			await expect(grid.row('googlescholarplugin')).toBeVisible();
			await expect(grid.row('defaultthemeplugin')).toBeVisible();

			// Name filter: substring match on the display name
			// (PluginGridHandler::loadCategoryData stristr) narrows every
			// category to matching plugins only.
			await grid.filter({name: 'Web Feed'});
			await expect(grid.row('webfeedplugin')).toBeVisible();
			await expect(grid.row('googlescholarplugin')).toHaveCount(0);
			await expect(grid.row('defaultthemeplugin')).toHaveCount(0);

			// Category filter: only the selected category's tbody is
			// rendered (loadData returns the single category).
			await grid.filter({name: '', category: 'themes'});
			await expect(grid.row('defaultthemeplugin')).toBeVisible();
			await expect(grid.row('webfeedplugin')).toHaveCount(0);

			// Clearing the filter (all categories, empty name) restores
			// the full grouped listing.
			await grid.filter({name: '', category: 'all'});
			await expect(grid.row('webfeedplugin')).toBeVisible();
			await expect(grid.row('googlescholarplugin')).toBeVisible();
			await expect(grid.row('defaultthemeplugin')).toBeVisible();
		},
	);
});

/**
 * Build a tag scoped to this worker + test title + a per-run random
 * component (patterns.md tag conventions; journals.urlPath is
 * varchar(32) so keep it short).
 *
 * @param {import('@playwright/test').TestInfo} info
 * @param {string} suffix
 */
function uniqueTag(info, suffix) {
	const rand = Math.random().toString(36).slice(2, 6);
	return `pm-w${info.parallelIndex}-${suffix}-${rand}`;
}
