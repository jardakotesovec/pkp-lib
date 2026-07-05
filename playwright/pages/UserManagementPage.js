// @ts-check
const {expect} = require('@playwright/test');
const {BasePage} = require('./BasePage.js');
const {waitForJQueryIdle} = require('../support/jquery.js');

/**
 * Users & Roles → Users tab (/{contextPath}/management/settings/access).
 *
 * Wraps the Vue `UserAccessManager` "Current Users" table
 * (lib/ui-library/src/managers/UserAccessManager/) plus the legacy
 * UserGridHandler side modals its row actions open (email / disable /
 * merge — see useUserAccessManagerActions.js).
 *
 * Surface facts this POM relies on (verified against the live sources):
 *  - The page hosts TWO PkpTables (Invitations + Current Users). The
 *    users table is scoped via its accessible name, which PkpTable
 *    wires from the label slot: "Current Users (N)".
 *  - The per-row More Actions trigger is a headlessui MenuButton whose
 *    aria-label is the `userAccess.management.options` key — which has
 *    NO en translation (renders `##…##`), so the trigger is anchored on
 *    `button[aria-haspopup="menu"]` instead (precedent:
 *    user-role-assignment.spec.js).
 *  - Menu items are `role="menuitem"`; only one menu is open at a time,
 *    so page-scoped menuitem lookups are safe.
 *  - Search (Search.vue) reacts to `keyup` only and debounces 250 ms —
 *    callers must use pressSequentially (never bare fill) and assert on
 *    the resulting list state. The clear button's accessible name is
 *    "Clear search phrase".
 *  - Pagination (Pagination.vue): "Next" carries no aria-label; the
 *    Previous and numbered buttons do ("Go to Previous", "Go to Page N").
 *    The summary line is TablePagination's "Showing X to Y of N".
 *  - Legacy side modals carry the `[data-cy="active-modal"]` hook.
 */
exports.UserManagementPage = class UserManagementPage extends BasePage {
	/**
	 * @param {import('@playwright/test').Page} page
	 * @param {string} contextPath  journal urlPath (e.g. a scratch journal's path)
	 */
	constructor(page, contextPath) {
		super(page);
		this.contextPath = contextPath;
		this.heading = page.getByRole('heading', {name: 'Users & Roles'});
		this.usersTable = page.getByRole('table', {name: /Current Users/});
		this.searchInput = page.getByPlaceholder(/Enter a user's name/);
		this.activeModal = page.locator('[data-cy="active-modal"]');
	}

	async goto() {
		await this.page.goto(
			`/index.php/${this.contextPath}/management/settings/access`,
		);
		await expect(this.heading).toBeVisible({timeout: 15_000});
		await expect(this.usersTable).toBeVisible({timeout: 15_000});
	}

	/**
	 * The "Current Users (N)" h3 — doubles as the list's total-count
	 * assertion (the count is itemCount from the paginated fetch).
	 *
	 * @param {number} count
	 */
	usersHeading(count) {
		return this.page.getByRole('heading', {
			name: new RegExp(`^Current Users \\(${count}\\)$`),
		});
	}

	/**
	 * A data row in the users table, located by visible text (full name
	 * or email — both are rendered as plain cell text).
	 *
	 * @param {string} text
	 */
	rowFor(text) {
		return this.usersTable.locator('tbody tr', {hasText: text});
	}

	/**
	 * Open a row's More Actions menu and wait for it to render.
	 *
	 * @param {import('@playwright/test').Locator} row
	 */
	async openRowMenu(row) {
		await row.locator('button[aria-haspopup="menu"]').click();
		await expect(this.page.getByRole('menu')).toBeVisible();
	}

	/**
	 * Open a row's menu and return its action labels (trimmed, in render
	 * order). Caller closes the menu via closeRowMenu().
	 *
	 * @param {import('@playwright/test').Locator} row
	 * @returns {Promise<string[]>}
	 */
	async rowActionLabels(row) {
		await this.openRowMenu(row);
		const labels = await this.page.getByRole('menuitem').allTextContents();
		return labels.map((label) => label.trim());
	}

	async closeRowMenu() {
		await this.page.keyboard.press('Escape');
		await expect(this.page.getByRole('menu')).toBeHidden();
	}

	/**
	 * Open a row's menu and click one of its actions by exact accessible
	 * name ('Edit', 'Email', 'Login As', 'Remove User', 'Disable User',
	 * 'Enable User', 'Merge user').
	 *
	 * @param {import('@playwright/test').Locator} row
	 * @param {string} name
	 */
	async clickRowAction(row, name) {
		await this.openRowMenu(row);
		await this.page.getByRole('menuitem', {name, exact: true}).click();
	}

	/**
	 * Type a search phrase (replacing any existing one). keyup-driven +
	 * 250 ms debounce — assert on the resulting list/heading state.
	 *
	 * @param {string} phrase  single whitespace-free token (searchPhrase
	 *   OR-joins on whitespace — patterns.md)
	 */
	async search(phrase) {
		await this.searchInput.click();
		await this.searchInput.fill('');
		await this.searchInput.pressSequentially(phrase);
	}

	async clearSearch() {
		await this.page
			.getByRole('button', {name: 'Clear search phrase'})
			.click();
	}

	/**
	 * TablePagination's summary line, e.g. "Showing 1 to 25 of 27".
	 *
	 * @param {number} start
	 * @param {number} finish
	 * @param {number} total
	 */
	showingText(start, finish, total) {
		return this.page.getByText(`Showing ${start} to ${finish} of ${total}`);
	}

	get nextPageButton() {
		return this.page.getByRole('button', {name: 'Next', exact: true});
	}

	get previousPageButton() {
		return this.page.getByRole('button', {name: 'Go to Previous'});
	}

	/** @param {number} n */
	pageButton(n) {
		return this.page.getByRole('button', {name: `Go to Page ${n}`});
	}

	/**
	 * Is the Notify tab present? It renders only when the journal has
	 * `enableBulkEmails` on (off by default → hidden). A `role="tab"`
	 * whose accessible name is "Notify".
	 */
	get notifyTab() {
		return this.page.getByRole('tab', {name: 'Notify'});
	}

	/**
	 * Disable a user via the grid row action. Opens the legacy
	 * `#userDisableForm` AjaxModal (a Vue side modal wrapping the jQuery
	 * form), fills the free-text reason (a plain textarea — NOT rich) and
	 * submits it via the default fbv "OK" button, then waits for the
	 * AjaxFormHandler to close the modal + refresh the grid.
	 *
	 * @param {import('@playwright/test').Locator} row
	 * @param {string} reason
	 */
	async disableUser(row, reason) {
		await this.clickRowAction(row, 'Disable User');
		await this.submitDisableForm(reason);
	}

	/**
	 * Re-enable a previously-disabled user via the grid row action (the
	 * menu item reads "Enable User" once disabled). Same legacy form; the
	 * reason field is optional here.
	 *
	 * @param {import('@playwright/test').Locator} row
	 * @param {string} [reason]
	 */
	async enableUser(row, reason = '') {
		await this.clickRowAction(row, 'Enable User');
		await this.submitDisableForm(reason);
	}

	/**
	 * Fill + submit the shared enable/disable legacy form.
	 *
	 * @param {string} reason
	 */
	async submitDisableForm(reason) {
		const form = this.page.locator('form#userDisableForm');
		await expect(form).toBeVisible({timeout: 15_000});
		if (reason) {
			// fbvElement ids are runtime-suffixed ($FBV_uniqId); the `name`
			// is stable (patterns.md pitfall 8).
			await form.locator('textarea[name="disableReason"]').fill(reason);
		}
		await form.getByRole('button', {name: 'OK', exact: true}).click();
		await waitForJQueryIdle(this.page);
		await expect(form).toBeHidden({timeout: 15_000});
	}

	/**
	 * Remove a user from the journal (ends ALL their active roles here)
	 * via the grid Remove action. Opens the reka-ui confirm dialog and
	 * confirms it, waiting on the resulting `remove-user` POST rather than
	 * a toast (parallel-safe).
	 *
	 * @param {import('@playwright/test').Locator} row
	 */
	async removeUserFromJournal(row) {
		await this.clickRowAction(row, 'Remove User');
		const ok = this.page.getByRole('button', {name: 'OK', exact: true});
		await expect(ok).toBeVisible({timeout: 10_000});
		const removed = this.page.waitForResponse(
			(r) =>
				r.url().includes('/user-grid/remove-user') &&
				r.request().method() === 'POST',
		);
		await ok.click();
		await removed;
		await waitForJQueryIdle(this.page);
	}
};
