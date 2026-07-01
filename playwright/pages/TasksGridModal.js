// @ts-check
const {expect} = require('@playwright/test');
const {BasePage} = require('./BasePage.js');
const {waitForJQueryIdle} = require('../support/jquery.js');

/**
 * POM for the user's Tasks inbox — the legacy task-notifications grid
 * (lib/pkp/controllers/grid/notifications/TaskNotificationsGridHandler.php)
 * that opens in a side modal from the top-nav bell
 * (lib/ui-library TopNavActions.vue#openTasks → useLegacyGridUrl →
 * grid/notifications/task-notifications-grid/fetch-grid).
 *
 * DOM facts the locators rely on:
 *  - The bell is a top-nav <button> whose accessible name starts with the
 *    sr-only "Tasks" label; when unread tasks exist the count badge text
 *    is appended to the name, so the name is matched by a ^Tasks regex,
 *    never exactly (and never asserted on — bell badge counts are
 *    explicitly out of scope for parallel tests).
 *  - Each notification renders via
 *    lib/pkp/templates/controllers/grid/tasks/task.tpl: a `div.task`
 *    (+ class `unread` while dateRead is NULL) inside the row's
 *    LinkAction anchor; `.details .submission` carries the submission
 *    title for query-backed notifications
 *    (NotificationsGridCellProvider::_getTitle).
 *  - SelectableItemsFeature puts an
 *    `input[type=checkbox][name="selectedNotifications[]"]` (the grid's
 *    getSelectName plus the [] suffix gridRowSelectInput.tpl appends)
 *    with the notification id as value in every row
 *    (templates/controllers/grid/gridRowSelectInput.tpl:10).
 *  - Mark New / Mark Read / Delete are BELOW-grid LinkActions; the JS
 *    handler (lib/pkp/js/controllers/grid/notifications/
 *    NotificationsGridHandler.js) $.post()s the checked ids to the
 *    kebab-cased component-router ops (mark-new, mark-read,
 *    delete-notifications — patterns.md rule 11) and refreshes the grid
 *    on the DataChangedEvent. Selection does NOT survive that refresh
 *    (responseHandler_ bounces jsonData.content — empty for these ops —
 *    into selectedNotificationIds), so callers re-select before every
 *    action; selectTask() is check()-idempotent for exactly that.
 *  - Clicking the task cell itself fires the row's `details` LinkAction:
 *    markRead?redirect=1 → redirectUrlJson → the legacy SiteHandler
 *    (still bound on <body> by layouts/backend.tpl:33) navigates to
 *    QueryNotificationManager::getNotificationUrl — the submission's
 *    workflow page for the notified user.
 */
exports.TasksGridModal = class TasksGridModal extends BasePage {
	/** @param {import('@playwright/test').Page} page */
	constructor(page) {
		super(page);
		this.bellButton = page.getByRole('button', {name: /^Tasks/});
		// ModalManager tags the top-most open side-modal.
		this.modal = page.locator('[data-cy="active-modal"]');
		this.grid = this.modal.locator('.pkp_controllers_grid');
	}

	/** Open the inbox via the top-nav bell and wait for the grid load. */
	async open() {
		await this.bellButton.click();
		await expect(
			this.modal.getByRole('heading', {name: 'Tasks', level: 1}),
		).toBeVisible({timeout: 15_000});
		await expect(this.grid).toBeVisible({timeout: 15_000});
	}

	/**
	 * The task.tpl cell whose message carries the marker (tests ride
	 * their unique tag in the discussion title, which the NEW_QUERY
	 * message interpolates — submission.query.new).
	 * @param {string} marker
	 */
	task(marker) {
		return this.modal.locator('div.task').filter({hasText: marker});
	}

	/**
	 * The grid row containing the marked notification (checkbox cell +
	 * task cell).
	 * @param {string} marker
	 */
	row(marker) {
		return this.modal.locator('tr.gridRow').filter({hasText: marker});
	}

	/** @param {string} marker */
	async expectUnread(marker) {
		await expect(this.task(marker)).toHaveClass(/\bunread\b/);
	}

	/** @param {string} marker */
	async expectRead(marker) {
		await expect(this.task(marker)).toBeVisible();
		await expect(this.task(marker)).not.toHaveClass(/\bunread\b/);
	}

	/**
	 * Tick the row's selection checkbox. Idempotent (check, not click)
	 * because the grid refresh after every action clears selections.
	 * @param {string} marker
	 */
	async selectTask(marker) {
		await this.row(marker)
			.locator('input[name="selectedNotifications[]"]')
			.check();
	}

	/**
	 * Click a below-grid action and wait for its POST + the grid
	 * refresh it triggers to settle.
	 * @param {'Mark Read'|'Mark New'|'Delete'} label
	 * @param {'mark-read'|'mark-new'|'delete-notifications'} op
	 */
	async clickAction(label, op) {
		const responsePromise = this.page.waitForResponse(
			(r) =>
				r.url().includes(`/task-notifications-grid/${op}`) &&
				r.request().method() === 'POST' &&
				r.status() === 200,
			{timeout: 20_000},
		);
		await this.modal.getByRole('link', {name: label, exact: true}).click();
		await responsePromise;
		await waitForJQueryIdle(this.page);
	}

	async markRead() {
		await this.clickAction('Mark Read', 'mark-read');
	}

	async markNew() {
		await this.clickAction('Mark New', 'mark-new');
	}

	async deleteSelected() {
		await this.clickAction('Delete', 'delete-notifications');
	}

	/**
	 * Click the notification itself (the details LinkAction). The
	 * handler marks it read and redirects to the submission workflow —
	 * callers wait for that navigation.
	 * @param {string} marker
	 */
	async openTask(marker) {
		await this.task(marker).click();
	}
};
