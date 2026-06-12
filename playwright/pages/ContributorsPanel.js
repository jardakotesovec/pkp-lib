// @ts-check
const {expect} = require('@playwright/test');
const {BasePage} = require('./BasePage.js');

/**
 * POM for the Contributors panel on the editorial workflow page
 * (ContributorManager → ContributorsListPanel in the ui-library).
 *
 * The panel lives under the workflow side-modal's "Contributors"
 * side-nav entry and carries `data-cy="contributor-manager"`. It is
 * shared across OJS/OMP/OPS (lib/ui-library managers/ContributorManager),
 * so the POM lives in lib/pkp.
 *
 * DOM realities baked in (see ContributorsListPanel.vue):
 *   - Rows are `li.listPanel__item` (role listitem); the title block
 *     holds `item.fullName` plus the contributor-role Badge.
 *   - The Order/Save Order toggle is ONE button whose label flips
 *     (common.order ↔ grid.action.saveOrdering) on `isOrdering`.
 *   - In ordering mode the row actions are replaced by Orderer up/down
 *     buttons whose accessible names interpolate the fullName:
 *     "Increase position of {fullName}" / "Decrease position of {fullName}".
 *   - Add/Edit open ContributorsEditModal — a stacked SideModal whose
 *     dialog accessible name is the form title ("Add Contributor" /
 *     "Edit"). Anchor readiness on the form's email input; the modal
 *     wrapper reports visibility:hidden during the open transition.
 *   - Delete opens a reka-ui confirmation dialog (`[data-cy="dialog"]`)
 *     titled "Delete Contributor" whose confirm button repeats the title.
 *   - saveOrder / setPrimaryContact / delete are legacy $.ajax POSTs with
 *     X-Http-Method-Override headers — match on URL, not HTTP verb.
 */
exports.ContributorsPanel = class ContributorsPanel extends BasePage {
	/** @param {import('@playwright/test').Page} page */
	constructor(page) {
		super(page);
		// The workflow page hosts itself in a side modal tagged
		// data-cy="active-modal"; when a stacked modal opens, the hook
		// migrates to it — so keep a .first() anchor for the side nav.
		this.workflowModal = page.locator('[data-cy="active-modal"]').first();
		this.manager = page.locator('[data-cy="contributor-manager"]');
	}

	/**
	 * Open the Contributors panel from the workflow page's side nav.
	 * Caller must already be on the workflow page (e.g. via
	 * EditorialWorkflowPage#goto). If the Publication group is collapsed
	 * (non-publication stage active), expand it first.
	 */
	async openPanel() {
		const sideNav = this.workflowModal.locator('nav');
		const entry = sideNav.getByText('Contributors', {exact: true}).first();
		// The Publication group's children are normally visible to editors
		// without expanding (wave-5 proof on the in-review workflow). Only
		// when the entry doesn't render on its own do we click the group
		// header — clicking it unconditionally would COLLAPSE an expanded
		// group.
		try {
			await entry.waitFor({state: 'visible', timeout: 5_000});
		} catch {
			await sideNav.getByText('Publication', {exact: true}).first().click();
			await entry.waitFor({state: 'visible', timeout: 10_000});
		}
		await entry.click();
		await expect(this.manager).toBeVisible({timeout: 10_000});
	}

	/**
	 * The list row for a contributor, matched on the displayed full name.
	 *
	 * @param {string} fullName e.g. 'Ramiro Vaca'
	 */
	row(fullName) {
		return this.manager.getByRole('listitem').filter({hasText: fullName});
	}

	/** Ordered collection of row title blocks (one per contributor). */
	rowTitles() {
		return this.manager.locator('.listPanel__itemTitle');
	}

	/**
	 * Open the Add Contributor modal and wait for the form to mount.
	 *
	 * @returns {Promise<import('@playwright/test').Locator>} the stacked dialog
	 */
	async openAddModal() {
		await this.manager
			.getByRole('button', {name: 'Add Contributor', exact: true})
			.click();
		const modal = this.page.getByRole('dialog', {name: 'Add Contributor'});
		await expect(modal.locator('input[name="email"]')).toBeVisible({
			timeout: 15_000,
		});
		return modal;
	}

	/**
	 * Open the Edit modal for a contributor row and wait for the
	 * prefilled form to mount. The dialog's accessible name is the bare
	 * form title "Edit" (grid.action.edit) — exact-match to avoid the
	 * substring trap on such a common word.
	 *
	 * @param {string} fullName
	 * @returns {Promise<import('@playwright/test').Locator>} the stacked dialog
	 */
	async openEditModal(fullName) {
		await this.row(fullName)
			.getByRole('button', {name: 'Edit', exact: true})
			.click();
		const modal = this.page.getByRole('dialog', {name: 'Edit', exact: true});
		await expect(modal.locator('input[name="email"]')).toBeVisible({
			timeout: 15_000,
		});
		return modal;
	}

	/**
	 * Fill the minimum required fields for a person contributor on the
	 * Add/Edit form: en-locale name, email, country, plus the required
	 * contributorRoles "Author" checkbox.
	 *
	 * @param {import('@playwright/test').Locator} modal
	 * @param {{givenName: string, familyName: string, email: string, country?: string}} fields
	 */
	async fillPersonFields(modal, {givenName, familyName, email, country = 'CA'}) {
		await modal.locator('input[name="givenName-en"]').fill(givenName);
		await modal.locator('input[name="familyName-en"]').fill(familyName);
		await modal.locator('input[name="email"]').fill(email);
		await modal.locator('select[name="country"]').selectOption(country);
		await modal
			.locator('label', {hasText: 'Author'})
			.locator('input[type="checkbox"]')
			.first()
			.check({force: true});
	}

	/**
	 * Every successful contributor mutation kicks off a deterministic
	 * refresh chain: the panel's success handler emits
	 * `updated:publication`, whose store handler calls triggerDataChange()
	 * — which makes the workflow store refetch `GET /submissions/{id}` (+
	 * publication). That refetch re-renders the whole panel a beat AFTER
	 * the mutation response, and a click landing inside that re-render is
	 * silently swallowed (this exact race ate the Save Order click — the
	 * refetch landed between mousedown and the Vue handler, reverting the
	 * optimistic reorder too). Register this BEFORE the triggering click
	 * and await it after, so the panel is quiescent when the caller moves
	 * on.
	 *
	 * @returns {Promise<unknown>}
	 */
	workflowRefetchAfterMutation() {
		// The refetch is a PAIR of GETs fired together: the bare submission
		// and the bare publication (both without query strings — the
		// panel's own jQuery refresh GET carries a `?_=` cache-buster and
		// must NOT satisfy this wait, since it *precedes* the refetch).
		// Absorb both: a leftover in-flight publication GET reverts any
		// optimistic state the next interaction depends on (this exact
		// remainder flipped a saved reorder back to server order).
		const submissionRefetch = this.page.waitForResponse(
			(res) =>
				/\/api\/v1\/submissions\/\d+$/.test(res.url()) &&
				res.request().method() === 'GET' &&
				res.ok(),
			{timeout: 20_000},
		);
		const publicationRefetch = this.page.waitForResponse(
			(res) =>
				/\/api\/v1\/submissions\/\d+\/publications\/\d+$/.test(res.url()) &&
				res.request().method() === 'GET' &&
				res.ok(),
			{timeout: 20_000},
		);
		return Promise.all([submissionRefetch, publicationRefetch]);
	}

	/**
	 * Submit the contributor form and wait for the API write to land.
	 * Works for both POST (add) and PUT-via-override (edit) — matched on
	 * the contributors URL only. Also absorbs the post-save workflow
	 * refetch (see workflowRefetchAfterMutation).
	 *
	 * @param {import('@playwright/test').Locator} modal
	 */
	async saveForm(modal) {
		const refetch = this.workflowRefetchAfterMutation();
		await Promise.all([
			this.page.waitForResponse(
				(res) =>
					/\/api\/v1\/submissions\/\d+\/publications\/\d+\/contributors/.test(
						res.url(),
					) && res.ok(),
				{timeout: 20_000},
			),
			modal.getByRole('button', {name: 'Save', exact: true}).click(),
		]);
		await refetch;
	}

	/**
	 * Composite: add a contributor through the UI and wait for their row
	 * to appear in the list.
	 *
	 * @param {{givenName: string, familyName: string, email: string, country?: string}} fields
	 */
	async addContributor(fields) {
		const modal = await this.openAddModal();
		await this.fillPersonFields(modal, fields);
		await this.saveForm(modal);
		await expect(
			this.manager.getByText(`${fields.givenName} ${fields.familyName}`),
		).toBeVisible({timeout: 15_000});
	}

	/**
	 * Delete a contributor: row Delete button → "Delete Contributor"
	 * confirmation dialog → confirm; waits for the DELETE-override POST.
	 *
	 * @param {string} fullName
	 */
	async deleteContributor(fullName) {
		await this.row(fullName)
			.getByRole('button', {name: 'Delete', exact: true})
			.click();
		const dialog = this.page
			.locator('[data-cy="dialog"]')
			.filter({hasText: 'Delete Contributor'});
		await expect(dialog).toBeVisible({timeout: 10_000});
		await expect(dialog).toContainText(fullName);
		const refetch = this.workflowRefetchAfterMutation();
		await Promise.all([
			this.page.waitForResponse(
				(res) =>
					/\/api\/v1\/submissions\/\d+\/publications\/\d+\/contributors\/\d+/.test(
						res.url(),
					) && res.ok(),
				{timeout: 20_000},
			),
			dialog
				.getByRole('button', {name: 'Delete Contributor', exact: true})
				.click(),
		]);
		await refetch;
	}

	/** Enter ordering mode (the "Order" toggle). */
	async startOrdering() {
		await this.manager
			.getByRole('button', {name: 'Order', exact: true})
			.click();
		// Ordering mode swaps row actions for Orderer up/down controls —
		// the "Save Order" label on the toggle is the arrival signal.
		await expect(
			this.manager.getByRole('button', {name: 'Save Order', exact: true}),
		).toBeVisible({timeout: 10_000});
	}

	/**
	 * Move a contributor one position up while in ordering mode.
	 *
	 * @param {string} fullName
	 */
	async moveUp(fullName) {
		await this.manager
			.getByRole('button', {
				name: `Increase position of ${fullName}`,
				exact: true,
			})
			.click();
	}

	/**
	 * Move a contributor one position down while in ordering mode.
	 *
	 * @param {string} fullName
	 */
	async moveDown(fullName) {
		await this.manager
			.getByRole('button', {
				name: `Decrease position of ${fullName}`,
				exact: true,
			})
			.click();
	}

	/** Persist the new order (the "Save Order" toggle) and wait for the write. */
	async saveOrder() {
		const refetch = this.workflowRefetchAfterMutation();
		await Promise.all([
			this.page.waitForResponse(
				(res) => res.url().includes('/contributors/saveOrder') && res.ok(),
				{timeout: 20_000},
			),
			this.manager
				.getByRole('button', {name: 'Save Order', exact: true})
				.click(),
		]);
		await refetch;
		// Back out of ordering mode — the toggle reads "Order" again.
		await expect(
			this.manager.getByRole('button', {name: 'Order', exact: true}),
		).toBeVisible({timeout: 10_000});
	}

	/**
	 * Open the byline Preview modal ("List of Contributors" — it shows the
	 * abbreviated / publication-lists / full author strings).
	 *
	 * @returns {Promise<import('@playwright/test').Locator>} the stacked dialog
	 */
	async openPreview() {
		await this.manager
			.getByRole('button', {name: 'Preview', exact: true})
			.click();
		const modal = this.page.getByRole('dialog', {name: 'List of Contributors'});
		// Anchor on inner content: the side-modal wrapper reports
		// visibility:hidden during the open transition.
		await expect(
			modal.getByRole('cell', {name: 'Full', exact: true}),
		).toBeVisible({timeout: 15_000});
		return modal;
	}

	/**
	 * Close a stacked side modal via its back/close button ("Close" is
	 * the sr-only label on the DialogClose button).
	 *
	 * @param {import('@playwright/test').Locator} modal
	 */
	async closeStackedModal(modal) {
		await modal.getByRole('button', {name: 'Close', exact: true}).first().click();
		await expect(modal).toBeHidden({timeout: 10_000});
	}

	/**
	 * The "Primary Contact" badge on a contributor's row (present only on
	 * the current primary contact).
	 *
	 * @param {string} fullName
	 */
	primaryContactBadge(fullName) {
		return this.row(fullName).getByText('Primary Contact', {exact: true});
	}

	/**
	 * The "Set Primary Contact" button on a contributor's row (present on
	 * every row except the current primary contact's).
	 *
	 * @param {string} fullName
	 */
	setPrimaryContactButton(fullName) {
		return this.row(fullName).getByRole('button', {
			name: 'Set Primary Contact',
			exact: true,
		});
	}

	/**
	 * Reassign the primary contact to the named contributor and wait for
	 * the publication PUT (a $.ajax POST with method override against the
	 * publication endpoint) to land.
	 *
	 * @param {string} fullName
	 */
	async setPrimaryContact(fullName) {
		const refetch = this.workflowRefetchAfterMutation();
		await Promise.all([
			// The write is a $.ajax POST (+ PUT override) on the publication
			// endpoint — exclude GETs so a trailing refetch of the same URL
			// can't satisfy the wait.
			this.page.waitForResponse(
				(res) =>
					/\/api\/v1\/submissions\/\d+\/publications\/\d+(\?.*)?$/.test(
						res.url(),
					) &&
					res.request().method() !== 'GET' &&
					res.ok(),
				{timeout: 20_000},
			),
			this.setPrimaryContactButton(fullName).click(),
		]);
		await refetch;
	}
};
