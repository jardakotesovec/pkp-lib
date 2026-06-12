// @ts-check
const {expect} = require('@playwright/test');
const {BasePage} = require('./BasePage.js');
const {waitForJQueryIdle} = require('../support/jquery.js');

/**
 * POM for the Roles tab on Users & Roles (Settings > Users & Roles >
 * Roles) — the legacy Smarty/jQuery user-group grid
 * (`grid.settings.roles.UserGroupGridHandler`), loaded via
 * load_url_in_div into `#roleGridContainer`.
 *
 * Legacy-grid realities encoded here (same family as
 * ReviewFormSettingsPage):
 *  - Grid/link-action DOM ids derive from the component path:
 *    `component-grid-settings-roles-usergroupgrid-...`.
 *  - Columns are fixed: Role Name | Permission level | one column per
 *    workflow stage (OJS: Submission=1, Review=3, Copyediting=4,
 *    Production=5), each stage cell a selectStatusCell checkbox wired
 *    to an immediate AjaxAction (assignStage/unassignStage — no
 *    confirmation modal). The displayed state is authoritative only
 *    after the DataChangedEvent row refresh; assert persistence after
 *    a reload, not after the optimistic native toggle.
 *  - Stage checkboxes are rendered `disabled` for stages the row's
 *    permission level forbids (RoleDAO::getForbiddenStages) — manager
 *    rows are fully locked, reviewer rows only allow Review.
 *  - Per-row actions (editUserGroup / removeUserGroup) hide inside the
 *    sibling `tr.row_controls` until `a.show_extras` is clicked
 *    (patterns.md pitfall 9).
 *  - The add/edit form is `form#userGroupForm` in an AjaxModal; its
 *    fbvFormButtons submit is the default "OK" label. Stacked modal
 *    copies accumulate — bind to `.last()`.
 *  - Default-role names repeat in the Permission level column (the
 *    "Translator" row carries level "Author"), so name-anchored row
 *    lookups scope to the first cell (`rowByName`), not the row text.
 *
 * Shared across OJS/OMP/OPS — the grid ships from pkp-lib (stage
 * columns differ per app; the STAGE_COLUMNS map below is the OJS set,
 * which OMP would extend with internal review).
 */

const GRID_ID = 'component-grid-settings-roles-usergroupgrid';

exports.RolesSettingsPage = class RolesSettingsPage extends BasePage {
	/**
	 * Workflow-stage ids in grid column order (OJS). Column index in the
	 * row = 2 (name + permission level) + indexOf(stageId).
	 */
	static STAGE_COLUMNS = [1, 3, 4, 5];

	/** @param {import('@playwright/test').Page} page */
	constructor(page) {
		super(page);
		this.grid = page.locator('#roleGridContainer');
		this.createButton = page.locator(
			`a[id^="${GRID_ID}-addUserGroup-button-"]`,
		);
		/** Set by goto(); enables reload-based workarounds. */
		this.journalPath = null;
	}

	/**
	 * Open Users & Roles, activate the Roles tab and wait for the legacy
	 * grid to land.
	 *
	 * @param {string} journalPath
	 */
	async goto(journalPath) {
		this.journalPath = journalPath;
		await this.page.goto(
			`/index.php/${journalPath}/management/settings/access`,
		);
		// PkpTabs renders each trigger as `#{tabId}-button`; clicking is
		// deterministic regardless of which tab the page restored.
		await this.page.locator('#roles-button').click();
		await expect(this.createButton).toBeVisible({timeout: 20_000});
		await waitForJQueryIdle(this.page);
	}

	/**
	 * Data rows whose ROW TEXT contains `text`. Safe for tag-unique
	 * custom role names; for default-role names use `rowByName` (the
	 * permission-level column repeats role-name words).
	 *
	 * @param {string} text
	 */
	rows(text) {
		return this.grid.locator(`tr.gridRow[id^="${GRID_ID}-row-"]`, {
			hasText: text,
		});
	}

	/**
	 * The single data row whose NAME CELL (first column) holds exactly
	 * `name`. Exact matching matters twice over: the level column
	 * repeats role words ("Translator" carries level "Author") and the
	 * default names nest ("Reader" is a substring of "Proofreader").
	 *
	 * @param {string} name
	 */
	rowByName(name) {
		return this.grid
			.locator(`tr.gridRow[id^="${GRID_ID}-row-"]`)
			.filter({
				has: this.page
					.locator('td:first-child')
					.getByText(name, {exact: true}),
			});
	}

	/** The Permission level cell (second column) of a row. */
	levelCell(row) {
		return row.locator('td').nth(1);
	}

	/**
	 * The stage-assignment checkbox of a row for a workflow stage id.
	 * selectStatusCell checkboxes carry no name/value attributes — the
	 * column position is the only stable address.
	 *
	 * @param {import('@playwright/test').Locator} row
	 * @param {number} stageId 1 | 3 | 4 | 5
	 */
	stageCheckbox(row, stageId) {
		const idx = RolesSettingsPage.STAGE_COLUMNS.indexOf(stageId);
		if (idx === -1) {
			throw new Error(`Unknown OJS stage id ${stageId}`);
		}
		return row
			.locator('td')
			.nth(2 + idx)
			.locator('input[type="checkbox"]');
	}

	/**
	 * Click a stage checkbox (fires the assign/unassignStage AjaxAction)
	 * and wait for the row refresh to settle. Callers assert the new
	 * state on a fresh `stageCheckbox` lookup (the row DOM is replaced).
	 *
	 * @param {import('@playwright/test').Locator} row
	 * @param {number} stageId
	 */
	async toggleStage(row, stageId) {
		await this.stageCheckbox(row, stageId).click();
		await waitForJQueryIdle(this.page);
	}

	/**
	 * Resolve the DOM ids of all grid rows matching `text` (row-text
	 * match), in display order.
	 *
	 * @param {string} text
	 * @returns {Promise<string[]>}
	 */
	async rowIds(text) {
		const rows = this.rows(text);
		const count = await rows.count();
		const ids = [];
		for (let i = 0; i < count; i++) {
			const id = await rows.nth(i).getAttribute('id');
			if (id) ids.push(id);
		}
		return ids;
	}

	/** The `tr.gridRow` for a previously resolved row id. */
	rowById(rowId) {
		return this.page.locator(`tr#${rowId}`);
	}

	/**
	 * Resolve the DOM row id of the role named `name`, guaranteeing the
	 * row actually carries its edit/remove actions.
	 *
	 * Works around an app bug: UserGroupGridHandler::loadData returns
	 * rows keyed by POSITION (Eloquent ->all()), and the query has no
	 * ORDER BY, so the row at positional index 0 is non-deterministic —
	 * and UserGroupGridRow::initialize gates its actions on
	 * `!empty($rowId) && is_numeric($rowId)`, where `empty('0')` is
	 * true. The first row in the (unordered) result therefore renders
	 * with NO `a.show_extras` and NO edit/remove links. Reloading
	 * re-runs the unordered query and usually reshuffles which role
	 * lands at index 0, so a bounded reload-retry lands the target role
	 * on a non-zero index where its actions exist.
	 *
	 * @param {string} name role name (row-text unique, e.g. a tagged
	 *   custom role)
	 * @param {{tries?: number}} [opts]
	 * @returns {Promise<string>} a row id whose row has actions
	 */
	async resolveActionableRowId(name, {tries = 6} = {}) {
		for (let attempt = 0; attempt < tries; attempt++) {
			const row = this.rows(name).first();
			await expect(row).toHaveCount(1, {timeout: 15_000});
			const id = await row.getAttribute('id');
			const hasExtras =
				(await row.locator('a.show_extras').count()) > 0;
			if (id && hasExtras) {
				return id;
			}
			// Index-0 bug bit this role this load — reshuffle by reload.
			if (!this.journalPath) {
				throw new Error(
					'resolveActionableRowId needs a prior goto() to reload',
				);
			}
			await this.goto(this.journalPath);
		}
		throw new Error(
			`Role "${name}" kept landing on grid index 0 (no row actions) across ${tries} reloads — UserGroupGridRow empty('0') bug`,
		);
	}

	/**
	 * Expand a row's hidden controls (`a.show_extras` → sibling
	 * `tr.row_controls`). No-op when already expanded.
	 *
	 * @param {string} rowId
	 */
	async expandRowExtras(rowId) {
		const showExtras = this.rowById(rowId).locator('a.show_extras');
		if ((await showExtras.count()) > 0) {
			await showExtras.click();
		}
	}

	/**
	 * Link-action anchor for a row action: 'editUserGroup' |
	 * 'removeUserGroup' (UserGroupGridRow LinkAction ids).
	 *
	 * @param {string} rowId
	 * @param {string} actionId
	 */
	rowActionLink(rowId, actionId) {
		return this.page.locator(`a[id^="${rowId}-${actionId}-button-"]`);
	}

	/**
	 * Expand the row's controls and click one of its actions.
	 *
	 * @param {string} rowId
	 * @param {string} actionId
	 */
	async clickRowAction(rowId, actionId) {
		await this.expandRowExtras(rowId);
		await this.rowActionLink(rowId, actionId).first().click();
	}

	/**
	 * Confirm a RemoteActionConfirmationModal (role delete) and wait for
	 * the grid refresh to settle.
	 */
	async confirmOk() {
		const okButton = this.page
			.getByRole('button', {name: 'OK', exact: true})
			.last();
		await expect(okButton).toBeVisible({timeout: 10_000});
		await okButton.click();
		await waitForJQueryIdle(this.page);
	}

	/**
	 * Open the Create New Role modal and return the legacy form.
	 *
	 * @returns {Promise<import('@playwright/test').Locator>}
	 */
	async openCreateForm() {
		await this.createButton.click();
		const form = this.page.locator('form#userGroupForm').last();
		await expect(form).toBeVisible({timeout: 15_000});
		return form;
	}

	/**
	 * Open the row's Edit modal (same #userGroupForm; the permission
	 * level select renders disabled on edit).
	 *
	 * @param {string} rowId
	 * @returns {Promise<import('@playwright/test').Locator>}
	 */
	async openEditForm(rowId) {
		await this.clickRowAction(rowId, 'editUserGroup');
		const form = this.page.locator('form#userGroupForm').last();
		await expect(form).toBeVisible({timeout: 15_000});
		return form;
	}

	/**
	 * Fill the user-group form. All keys optional; on edit the
	 * permission level is locked server-side so omit it there.
	 *
	 * `options` toggles the role-option checkboxes by input name
	 * (permitSelfRegistration / recommendOnly / permitMetadataEdit /
	 * masthead / permitSettings). UserGroupFormHandler hides options
	 * irrelevant to the selected level, so setting a hidden option
	 * fails loudly — which is the desired behavior.
	 *
	 * @param {import('@playwright/test').Locator} form #userGroupForm
	 * @param {{permissionLevel?: string, name?: string, abbrev?: string,
	 *   stages?: number[], options?: Object<string, boolean>,
	 *   locale?: string}} data
	 */
	async fillRoleForm(
		form,
		{permissionLevel, name, abbrev, stages, options, locale = 'en'},
	) {
		if (permissionLevel !== undefined) {
			await form
				.locator('select[name="roleId"]')
				.selectOption({label: permissionLevel});
		}
		if (name !== undefined) {
			await form.locator(`input[name="name[${locale}]"]`).fill(name);
		}
		if (abbrev !== undefined) {
			await form.locator(`input[name="abbrev[${locale}]"]`).fill(abbrev);
		}
		if (stages !== undefined) {
			for (const stageId of RolesSettingsPage.STAGE_COLUMNS) {
				const checkbox = form.locator(
					`input[name="assignedStages[]"][value="${stageId}"]`,
				);
				const wanted = stages.includes(stageId);
				// Only drive enabled checkboxes — forbidden stages render
				// disabled and must keep their server-determined state.
				if (await checkbox.isEnabled()) {
					await checkbox.setChecked(wanted);
				} else if (wanted) {
					throw new Error(
						`Stage ${stageId} is forbidden for this permission level`,
					);
				}
			}
		}
		for (const [optionName, value] of Object.entries(options ?? {})) {
			await form
				.locator(`input[name="${optionName}"]`)
				.setChecked(value);
		}
	}

	/**
	 * Submit the user-group form via its "OK" fbv submit and wait for
	 * the AjaxFormHandler to close the modal (a still-open form means
	 * server-side validation failed) and the grid refresh to settle.
	 *
	 * @param {import('@playwright/test').Locator} form
	 */
	async saveForm(form) {
		await form.getByRole('button', {name: 'OK', exact: true}).click();
		await expect(form).toBeHidden({timeout: 15_000});
		await waitForJQueryIdle(this.page);
	}

	/**
	 * Delete a role via its row action + confirmation.
	 *
	 * NOTE the grid does NOT drop the row client-side: this grid's
	 * loadData returns a VirtualArrayIterator over a positional array
	 * (UserGroupGridHandler::loadData), so DOM row ids are positional
	 * indices while removeUserGroup's DataChangedEvent carries the real
	 * userGroupId — the follow-up fetchRow answers elementNotFound for
	 * an id no row carries and the stale row lingers until a reload.
	 * Callers must re-`goto()` before asserting the row is gone.
	 *
	 * @param {string} rowId
	 */
	async deleteRole(rowId) {
		await this.clickRowAction(rowId, 'removeUserGroup');
		await this.confirmOk();
	}
};
