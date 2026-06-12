// @ts-check
const {test, expect} = require('../../support/base-test.js');
const {PluginsGridPage} = require('../../pages/PluginsGridPage.js');

/**
 * Site-level plugin toggle — docs/e2e/plans/plugin-management.md row 3.
 * THE FIRST SPEC IN THE DEDICATED SERIAL PROJECT.
 *
 * WHY SERIAL (charter principle 9, docs/e2e/PRINCIPLES.md): the
 * /admin/settings → Plugins grid (AdminPluginGridHandler) mutates the
 * SITE-scoped `plugin_settings` row (context_id NULL) — a singleton
 * shared by every journal and every parallel worker's PHP server. A
 * parallel neighbor reading site-plugin state mid-toggle would observe
 * a half-flipped installation, and two site-toggle tests racing each
 * other would corrupt the restore. The serial project (config-factory
 * .js `serial`: workers=1, fullyParallel=false, depends on [setup,
 * <app>]) guarantees this test runs ALONE, AFTER the parallel suite.
 * The test still restores the original state in `finally` so even
 * back-to-back serial specs and warm re-runs see a clean baseline.
 *
 * Plugin choice: googleScholar was verified as the safe candidate —
 * display-only (citation_* meta tags on article pages), and no other
 * plan row depends on its state (citationStyleLanguage and webFeed are
 * NOT safe; plugin-management rows 1/2/4 and sitemap-feeds depend on
 * them).
 *
 * Effect-surface note (investigated, deliberately NOT asserted): for a
 * context-level generic plugin the site toggle has NO observable
 * front-end effect on journal pages. LazyLoadPlugin::setEnabled /
 * getEnabled resolve to the SITE context id only when the request has
 * no journal context (lib/pkp/classes/plugins/LazyLoadPlugin.php:73-96),
 * while GoogleScholarPlugin::register reads the JOURNAL's own
 * `enabled` row on article-page requests
 * (plugins/generic/googleScholar/GoogleScholarPlugin.php:38-40) — and
 * every journal got `enabled=true` installed from settings.xml at
 * context-creation time. So the citation meta tags on an article page
 * are governed by the journal row, not the site row, and asserting
 * them here would test journal-level state (already covered by the
 * parallel plugin-management spec), not this toggle. The toggle
 * round-trip + persistence + restore is the behavior under test.
 */

test.use({user: 'admin'});

test.describe('Site-level plugin management (serial)', () => {
	test(
		'admin toggles the googleScholar site-level enable checkbox; the state persists across reload and is restored',
		{tag: '@regression'},
		async ({page}) => {
			const plugin = 'googlescholarplugin';
			const grid = new PluginsGridPage(page);
			await grid.gotoAdminGrid();

			// The site grid renders grouped by category (CategoryGridHandler
			// — one labelled category row per plugin category). Match the
			// rows, not bare text: the collapsed filter form holds hidden
			// <option> elements with the same labels.
			await expect(
				grid.container.getByRole('row', {name: 'Generic Plugins'}),
			).toBeVisible();
			await expect(
				grid.container.getByRole('row', {name: 'Theme Plugins'}),
			).toBeVisible();

			// Capture the original state — a warm DB may have either value
			// (the site row starts absent → unchecked on a cold bootstrap).
			const original = await grid.isEnabled(plugin);

			try {
				// Flip the toggle (disable path confirms the PkpDialog the
				// RemoteActionConfirmationModal bridges to).
				if (original) {
					await grid.disable(plugin);
				} else {
					await grid.enable(plugin);
				}

				// Persistence: a full page reload re-renders the grid from
				// plugin_settings; the flipped state must survive.
				await grid.gotoAdminGrid();
				expect(await grid.isEnabled(plugin)).toBe(!original);
			} finally {
				// RESTORE the original site-level state no matter what the
				// assertions above did — this row is the only writer of the
				// site-scoped googleScholar setting, but later serial specs
				// and warm re-runs must inherit a clean baseline.
				await grid.gotoAdminGrid();
				const current = await grid.isEnabled(plugin);
				if (current !== original) {
					if (original) {
						await grid.enable(plugin);
					} else {
						await grid.disable(plugin);
					}
				}
				await grid.gotoAdminGrid();
				expect(await grid.isEnabled(plugin)).toBe(original);
			}
		},
	);
});
