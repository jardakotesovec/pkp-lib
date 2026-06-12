// @ts-check
const {expect} = require('@playwright/test');
const {BasePage} = require('./BasePage.js');
const {waitForJQueryIdle} = require('../support/jquery.js');

/**
 * POM for the legacy installed-plugins grid (PluginGridHandler and its
 * two concrete handlers):
 *
 *   - Journal level: Settings → Website → Plugins → Installed Plugins
 *     (`grid.settings.plugins.SettingsPluginGridHandler`)
 *   - Site level: /admin/settings → Plugins → Installed Plugins
 *     (`grid.admin.plugins.AdminPluginGridHandler`)
 *
 * Both render into the same `#pluginGridContainer` via load_url_in_div,
 * as a CategoryGridHandler (one tbody per plugin category) with:
 *
 *   - one `tr.gridRow` per plugin, id ending `-row-<pluginName>` where
 *     <pluginName> is the LazyLoadPlugin name (lowercased class name,
 *     e.g. `webfeedplugin`);
 *   - an "Enabled" column rendered by selectStatusCell.tpl — the
 *     checkbox id starts with `select-cell-<pluginName>` and clicking
 *     it triggers the cell LinkAction (AjaxAction POST for enable; a
 *     RemoteActionConfirmationModal → Vue PkpDialog for disable, see
 *     PluginGridCellProvider::getCellActions);
 *   - per-row management actions (Settings / Delete / Upgrade) hidden
 *     in the sibling `tr.row_controls` until the row's `a.show_extras`
 *     glyph is clicked (patterns.md pitfall 9);
 *   - an always-visible filter form (`#pluginSearchForm`,
 *     pluginGridFilter.tpl) with a category select + plugin-name text
 *     input, submitted via ClientFormHandler back to fetch-grid.
 *
 * NOTE on toggling: the enable/disable round-trip ends with a
 * DataChanged event that re-renders the row, REPLACING the checkbox
 * element (new uniqid suffix). All locators here re-resolve from the
 * container so they survive that replacement.
 */
exports.PluginsGridPage = class PluginsGridPage extends BasePage {
	/** @param {import('@playwright/test').Page} page */
	constructor(page) {
		super(page);
		this.container = page.locator('#pluginGridContainer');
		this.filterForm = this.container.locator('form#pluginSearchForm');
	}

	/**
	 * Open the journal-level installed-plugins grid as a manager.
	 *
	 * @param {string} contextPath
	 */
	async gotoJournalGrid(contextPath) {
		await this.page.goto(
			`/index.php/${contextPath}/management/settings/website`,
		);
		await this.page.locator('#plugins-button').click();
		await this.awaitLoaded();
	}

	/**
	 * Open the site-level installed-plugins grid as the site admin.
	 */
	async gotoAdminGrid() {
		await this.page.goto('/index.php/index/admin/settings');
		await this.page.locator('#plugins-button').click();
		await this.awaitLoaded();
	}

	/**
	 * The grid is loaded async (load_url_in_div); wait for it before
	 * interacting. The filter form is rendered but HIDDEN at this point
	 * — GridHandler.js#initialize hides every `.pkp_form` inside the
	 * grid and wires the header's `.pkp_linkaction_search` glyph as its
	 * toggle — so visibility of the filter is NOT part of "loaded";
	 * `openFilter()` handles it.
	 */
	async awaitLoaded() {
		await expect(
			this.container.locator('.pkp_controllers_grid'),
		).toBeVisible({timeout: 20_000});
		await expect(this.filterForm).toBeAttached({timeout: 20_000});
	}

	/**
	 * Reveal the grid filter form when it's collapsed (the default).
	 * The search glyph toggles it (GridHandler.js:541-556); after a
	 * filtered re-fetch the grid restores the open state itself
	 * (replaceGridResponseHandler_), so only click when hidden.
	 */
	async openFilter() {
		if (!(await this.filterForm.isVisible())) {
			await this.container.locator('.pkp_linkaction_search').click();
		}
		await expect(this.filterForm).toBeVisible({timeout: 10_000});
	}

	/**
	 * The grid row for a plugin. `pluginName` is the LazyLoadPlugin
	 * name — the lowercased class name (`webfeedplugin`,
	 * `citationstylelanguageplugin`, `googlescholarplugin`, …).
	 *
	 * @param {string} pluginName
	 */
	row(pluginName) {
		return this.container
			.locator(`tr.gridRow[id$="-row-${pluginName}"]`)
			.first();
	}

	/**
	 * The "Enabled" column checkbox for a plugin row
	 * (selectStatusCell.tpl: `id="select-cell-<cellId>"` where the cell
	 * id starts with the plugin name).
	 *
	 * @param {string} pluginName
	 */
	enabledCheckbox(pluginName) {
		return this.container
			.locator(`input[id^="select-cell-${pluginName}"]`)
			.first();
	}

	/**
	 * Read the current enabled state off the grid checkbox.
	 *
	 * @param {string} pluginName
	 * @returns {Promise<boolean>}
	 */
	async isEnabled(pluginName) {
		const checkbox = this.enabledCheckbox(pluginName);
		await expect(checkbox).toBeVisible({timeout: 15_000});
		return checkbox.isChecked();
	}

	/**
	 * Enable a currently-disabled plugin via the grid checkbox. The
	 * checkbox click fires the `enable` AjaxAction (no confirmation);
	 * the grid then refreshes the row via the DataChanged event.
	 *
	 * @param {string} pluginName
	 */
	async enable(pluginName) {
		const checkbox = this.enabledCheckbox(pluginName);
		await expect(checkbox).toBeVisible({timeout: 15_000});
		await expect(checkbox).not.toBeChecked();
		await Promise.all([
			this.page.waitForResponse(
				(res) => /\/enable(\?|$)/.test(res.url()) && res.ok(),
				{timeout: 15_000},
			),
			checkbox.click(),
		]);
		// The DataChanged handler refetches the row; wait for the
		// refresh chain to settle and assert on the REPLACED checkbox.
		await waitForJQueryIdle(this.page);
		await expect(this.enabledCheckbox(pluginName)).toBeChecked({
			timeout: 15_000,
		});
	}

	/**
	 * Disable a currently-enabled plugin via the grid checkbox. The
	 * click opens the RemoteActionConfirmationModal — bridged to the
	 * Vue PkpDialog (`[data-cy="dialog"]`) with the grid.plugin.disable
	 * message and an OK/Cancel pair (ConfirmationModal PHP defaults) —
	 * and OK fires the `disable` POST.
	 *
	 * @param {string} pluginName
	 */
	async disable(pluginName) {
		const checkbox = this.enabledCheckbox(pluginName);
		await expect(checkbox).toBeVisible({timeout: 15_000});
		await expect(checkbox).toBeChecked();
		await checkbox.click();

		const dialog = this.page.locator('[data-cy="dialog"]').filter({
			hasText: 'Are you sure you want to disable this plugin?',
		});
		await expect(dialog).toBeVisible({timeout: 10_000});
		await Promise.all([
			this.page.waitForResponse(
				(res) => /\/disable(\?|$)/.test(res.url()) && res.ok(),
				{timeout: 15_000},
			),
			dialog.getByRole('button', {name: 'OK', exact: true}).click(),
		]);
		await waitForJQueryIdle(this.page);
		await expect(dialog).toBeHidden({timeout: 10_000});
		await expect(this.enabledCheckbox(pluginName)).not.toBeChecked({
			timeout: 15_000,
		});
	}

	/**
	 * Open a plugin's per-row Settings modal (the LinkAction added by
	 * GenericPlugin::getActions for enabled plugins, rendered in the
	 * hidden row_controls sibling) and wait for the plugin's own
	 * settings form (each plugin ships its own form id) to appear.
	 *
	 * Retry rationale: LinkActionHandler swallows clicks (noAction_
	 * binding) from activation until the action's finishCallback
	 * re-binds them, and with the Vue side-modal bridge that re-enable
	 * runs asynchronously AFTER the previous modal's form has already
	 * left the DOM (ModalRequest#finish → enableLink; the `disabled`
	 * attribute is cleared earlier by the pkpModalClose handler and is
	 * NOT a reliable signal — verified live). A reopen-click straight
	 * after a save can land in that window and be silently dropped, so
	 * we click-and-verify under expect().toPass().
	 *
	 * @param {string} pluginName
	 * @param {import('@playwright/test').Locator} settingsForm
	 *   locator for the plugin's settings form, e.g.
	 *   page.locator('form#citationStyleLanguageSettingsForm')
	 */
	async openSettingsModal(pluginName, settingsForm) {
		const row = this.row(pluginName);
		await expect(row).toBeVisible({timeout: 15_000});
		const rowId = await row.getAttribute('id');
		if (!rowId) {
			throw new Error(`Plugin row for "${pluginName}" has no id`);
		}
		// Expand THIS row's controls; the anchor's class flips to
		// hide_extras once expanded (pitfall 9), so only click when the
		// collapsed glyph is present.
		const expander = row.locator('a.show_extras');
		if (await expander.count()) {
			await expander.click();
		}
		const link = this.page
			.locator(`a[id^="${rowId}-settings-button-"]`)
			.first();
		await expect(link).toBeVisible({timeout: 10_000});
		await expect(async () => {
			await link.click();
			await expect(settingsForm.first()).toBeVisible({timeout: 2_000});
		}).toPass({timeout: 20_000});
	}

	/**
	 * Drive the grid filter (pluginGridFilter.tpl): set the category
	 * select and/or the plugin-name text input, then submit via the
	 * Search button. The ClientFormHandler re-fetches the grid, so we
	 * race the fetch-grid response and wait for jQuery to settle.
	 *
	 * @param {{name?: string, category?: string}} opts
	 *   `category` is the symbolic category name ('generic', 'themes',
	 *   …) or 'all' (PLUGIN_GALLERY_ALL_CATEGORY_SEARCH_VALUE).
	 */
	async filter({name, category} = {}) {
		await this.openFilter();
		// fbvElement ids are runtime-suffixed (pitfall 8); use name=.
		if (category !== undefined) {
			await this.filterForm
				.locator('select[name="category"]')
				.selectOption(category);
		}
		if (name !== undefined) {
			await this.filterForm.locator('input[name="pluginName"]').fill(name);
		}
		await Promise.all([
			this.page.waitForResponse(
				(res) => /fetch-grid/.test(res.url()) && res.ok(),
				{timeout: 15_000},
			),
			this.filterForm
				.getByRole('button', {name: 'Search', exact: true})
				.click(),
		]);
		await waitForJQueryIdle(this.page);
		await this.awaitLoaded();
	}
};
