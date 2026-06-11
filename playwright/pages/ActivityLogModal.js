// @ts-check
const {expect} = require('@playwright/test');
const {BasePage} = require('./BasePage.js');
const {waitForJQueryIdle} = require('../support/jquery.js');

/**
 * POM for the Activity Log — the legacy info-center side modal opened
 * from the workflow page's "Activity Log" header action
 * (`editor.activityLog` → useWorkflowActions#workflowViewActivityLog →
 * SubmissionInformationCenterHandler::viewInformationCenter).
 *
 * The modal hosts a jQuery-UI TabHandler with up to two tabs:
 *   - History (`viewHistory`) — only for assigned managers/sub-editors
 *     (`removeHistoryTab`); loads the SubmissionEventLogGridHandler grid
 *     into `#submissionHistoryGridContainer`.
 *   - Notes (`viewNotes`) — `#informationCenterNotes` with the
 *     `#newNoteForm` AjaxFormHandler form.
 *
 * Default-selected tab index is 0 (InformationCenterHandler::
 * setupTemplate), i.e. History whenever it renders.
 *
 * All content is legacy jQuery-driven — interactions are followed by
 * `waitForJQueryIdle` per the patterns.md AjaxModal guidance.
 */
exports.ActivityLogModal = class ActivityLogModal extends BasePage {
	/** @param {import('@playwright/test').Page} page */
	constructor(page) {
		super(page);
		/**
		 * The workflow header action button. Rendered only when
		 * `canAccessEditorialHistory` (manager/sub-editor/site-admin role
		 * on the active stage).
		 */
		this.openButton = page
			.getByRole('button', {name: 'Activity Log', exact: true})
			.first();
		/** Side modal titled with submission.list.infoCenter. */
		this.dialog = page.getByRole('dialog', {name: 'Activity Log & Notes'});
		this.historyTab = this.dialog.getByRole('tab', {name: 'History'});
		this.notesTab = this.dialog.getByRole('tab', {name: 'Notes'});
		this.historyGrid = this.dialog.locator('#submissionHistoryGridContainer');
		this.notesPanel = this.dialog.locator('#informationCenterNotes');
		this.newNoteForm = this.dialog.locator('form#newNoteForm');
	}

	/**
	 * Click the workflow page's Activity Log button and wait for the
	 * modal's tab strip to mount. Anchors on the Notes tab (present for
	 * every role that can open the modal at all) — the side-modal
	 * wrapper itself reports visibility:hidden during transitions.
	 */
	async openFromWorkflow() {
		await this.openButton.click();
		await expect(this.notesTab).toBeVisible({timeout: 20_000});
		await waitForJQueryIdle(this.page);
	}

	/**
	 * A row of the History event-log grid containing the given text.
	 * Rows merge event-log + email-log entries, most recent first; the
	 * three columns are date / user / event message.
	 *
	 * @param {string|RegExp} text
	 */
	historyRow(text) {
		return this.historyGrid.locator('tr').filter({hasText: text});
	}

	/** Switch to the History tab and wait for the grid to load. */
	async openHistoryTab() {
		await this.historyTab.click();
		await expect(this.historyGrid).toBeVisible({timeout: 20_000});
		await waitForJQueryIdle(this.page);
	}

	/** Switch to the Notes tab and wait for the note form to load. */
	async openNotesTab() {
		await this.notesTab.click();
		await expect(this.newNoteForm).toBeVisible({timeout: 20_000});
		await waitForJQueryIdle(this.page);
	}

	/**
	 * A note entry (`.note`) in the Notes tab containing the given text.
	 * Each entry carries the author full name + posted date in its
	 * `.details` header.
	 *
	 * @param {string|RegExp} text
	 */
	note(text) {
		return this.notesPanel.locator('.note').filter({hasText: text});
	}

	/**
	 * Post a note through the Notes tab form (`saveNote`) and wait for
	 * the refreshed list to render it. The textarea is a plain (non-rich)
	 * fbvElement whose id carries the runtime $FBV_uniqId suffix.
	 *
	 * @param {string} text
	 */
	async addNote(text) {
		await this.newNoteForm.locator('textarea[id^="newNote"]').fill(text);
		await this.newNoteForm
			.getByRole('button', {name: 'Add Note', exact: true})
			.click();
		await waitForJQueryIdle(this.page);
		await expect(this.note(text)).toBeVisible({timeout: 20_000});
	}

	/**
	 * Close the modal via the side-modal close control so the workflow
	 * page's own header actions are clickable again.
	 */
	async close() {
		await this.dialog
			.getByRole('button', {name: 'Close', exact: true})
			.first()
			.click({force: true});
		await expect(this.dialog).toBeHidden({timeout: 15_000});
	}
};
