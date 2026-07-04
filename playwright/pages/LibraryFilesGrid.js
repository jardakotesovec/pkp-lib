// @ts-check
const {expect} = require('@playwright/test');
const {BasePage} = require('./BasePage.js');
const {waitForJQueryIdle} = require('../support/jquery.js');

/**
 * POM for a Document-Library category grid — the shared legacy
 * `LibraryFileGridHandler` family (pkp-lib), used at two levels:
 *
 *  - the CONTEXT (journal) library grid `LibraryFileAdminGridHandler`,
 *    loaded via load_url_in_div into `#libraryGridDiv` on Settings →
 *    Workflow → Library (grid id
 *    `component-grid-settings-library-libraryfileadmingrid`); and
 *  - the SUBMISSION library grid `SubmissionDocumentsFilesGridHandler`,
 *    loaded into `#submissionLibraryGridContainer` inside the "Submission
 *    Library" workflow modal (grid id
 *    `component-grid-files-submissiondocuments-submissiondocumentsfilesgrid`).
 *
 * Both render a category grid (one collapsible category per document type:
 * Marketing / Permissions / Reports / Other) with an "Add a file"
 * grid-level action; each document is a data row whose file name is a
 * download link action (DownloadLibraryFileLinkAction). The Add/Edit form
 * is the same `#uploadForm` fbv AjaxModal with an fbv plupload widget —
 * driven exactly like the sibling upload flows (setInputFiles on the
 * opacity-0 input, wait for the temporaryFileId hidden field to populate,
 * then submit the default "OK" button).
 *
 * Legacy-grid realities encoded here (mirrors ReviewFormSettingsPage):
 *  - Per-row Edit/Delete actions hide inside `tr.row_controls` until the
 *    row's `a.show_extras` glyph is clicked (patterns.md pitfall 9).
 *  - Delete is a RemoteActionConfirmationModal → OK confirm; the row
 *    leaves only after the DataChangedEvent grid refresh.
 *  - Modal stacking accumulates DOM copies of `#uploadForm`; every form
 *    lookup binds to `.last()`.
 *  - All mutations ride jQuery AJAX; `waitForJQueryIdle` after each
 *    save/confirm keeps follow-up assertions deterministic.
 *
 * Shared across OJS/OMP/OPS — the library grids ship from pkp-lib.
 */
exports.LibraryFilesGrid = class LibraryFilesGrid extends BasePage {
	/**
	 * @param {import('@playwright/test').Page} page
	 * @param {{containerSelector: string, gridId: string}} opts
	 *   containerSelector — the load_url_in_div wrapper, e.g. '#libraryGridDiv'
	 *   gridId — the component grid DOM id (no leading '#')
	 */
	constructor(page, {containerSelector, gridId}) {
		super(page);
		this.containerSelector = containerSelector;
		this.gridId = gridId;
	}

	/** The load_url_in_div container (last, to survive modal stacking). */
	container() {
		return this.page.locator(this.containerSelector).last();
	}

	/** The "Add a file" grid-level action link. */
	addFileButton() {
		return this.container().locator(
			`a[id^="${this.gridId}-addFile-button-"]`,
		);
	}

	/** The "View Document Library" grid-level action link (submission grid). */
	viewLibraryButton() {
		return this.container().locator(
			`a[id^="${this.gridId}-viewLibrary-button-"]`,
		);
	}

	/** Wait for the grid (its Add-a-file action) to have landed. */
	async expectReady() {
		await expect(this.addFileButton().first()).toBeVisible({timeout: 20_000});
		await waitForJQueryIdle(this.page);
	}

	/** A data row matched by the document's (link) name. */
	rowFor(name) {
		return this.container().locator('tr.gridRow', {hasText: name});
	}

	/** The download link action anchor for a document (its file name). */
	fileLink(name) {
		return this.container().getByRole('link', {name, exact: true});
	}

	/**
	 * Open the "Add a file" modal and return its `#uploadForm` legacy form.
	 *
	 * @returns {Promise<import('@playwright/test').Locator>}
	 */
	async openAddFileForm() {
		await this.addFileButton().first().click();
		const form = this.page.locator('form#uploadForm').last();
		await expect(form).toBeVisible({timeout: 15_000});
		await waitForJQueryIdle(this.page);
		return form;
	}

	/**
	 * Fill the library-file form (`#uploadForm`) and submit it. Drives the
	 * fbv plupload widget: waits for the uploader to finish initializing
	 * (loses its `loading` class), sets the file on the opacity-0 input,
	 * then waits for the FileUploadFormHandler to stage the temporary file
	 * (the hidden `temporaryFileId` field populates) before submitting —
	 * submitting earlier posts with no file and the form re-validates open.
	 *
	 * Description is intentionally optional: the template asterisks it but
	 * no server validator enforces it (spec Known deviation), so a caller
	 * may omit it and the document still saves.
	 *
	 * @param {import('@playwright/test').Locator} form  #uploadForm
	 * @param {object} data
	 * @param {string} data.name          document display name (primary locale)
	 * @param {string} data.type          Type option label (Marketing/…/Other)
	 * @param {string} data.filePath      absolute path to upload
	 * @param {string} [data.description] optional description text
	 * @param {boolean} [data.publicAccess] tick Public Access (context grid only)
	 * @param {string} [data.locale='en']
	 */
	async fillAndSubmit(form, {name, type, filePath, description, publicAccess = false, locale = 'en'}) {
		await form.locator(`input[name="libraryFileName[${locale}]"]`).fill(name);
		await form.locator('select[name="fileType"]').selectOption({label: type});
		if (description !== undefined) {
			await form
				.locator(`textarea[name="description[${locale}]"]`)
				.fill(description);
		}

		// Plupload: wait for init (the widget drops its `loading` class once
		// the runtime is ready), then feed the hidden input and wait for the
		// staged temporaryFileId before submitting.
		await expect(form.locator('#plupload')).not.toHaveClass(/loading/, {
			timeout: 15_000,
		});
		await form.locator('input[type="file"]').setInputFiles(filePath);
		await expect(form.locator('input[name="temporaryFileId"]')).not.toHaveValue(
			'',
			{timeout: 20_000},
		);

		if (publicAccess) {
			await form.locator('input[name="publicAccess"]').check();
		}

		await form.getByRole('button', {name: 'OK', exact: true}).click();
		await expect(form).toBeHidden({timeout: 20_000});
		await waitForJQueryIdle(this.page);
	}

	/**
	 * One-call add: open the Add-file modal, fill, submit, and wait for the
	 * new document's download link to appear in the grid.
	 *
	 * @param {object} data  see fillAndSubmit
	 */
	async addFile(data) {
		const form = await this.openAddFileForm();
		await this.fillAndSubmit(form, data);
		await expect(this.fileLink(data.name)).toBeVisible({timeout: 20_000});
	}

	/**
	 * Expand a document row's hidden controls and click one of its actions.
	 *
	 * @param {string} name       document name identifying the row
	 * @param {'editFile'|'deleteFile'} actionId
	 */
	async clickRowAction(name, actionId) {
		const row = this.rowFor(name).first();
		const rowId = await row.getAttribute('id');
		if (!rowId) {
			throw new Error(`library file row for '${name}' has no id`);
		}
		const showExtras = row.locator('a.show_extras');
		if ((await showExtras.count()) > 0) {
			await showExtras.first().click();
		}
		await this.container()
			.locator(`a[id^="${rowId}-${actionId}-button-"]`)
			.first()
			.click();
	}

	/**
	 * Open a document's Edit modal (`#uploadForm` prefilled) and return it.
	 *
	 * @param {string} name
	 * @returns {Promise<import('@playwright/test').Locator>}
	 */
	async openEditForm(name) {
		await this.clickRowAction(name, 'editFile');
		const form = this.page.locator('form#uploadForm').last();
		await expect(form).toBeVisible({timeout: 15_000});
		await waitForJQueryIdle(this.page);
		return form;
	}

	/**
	 * Rename a document through its Edit form (metadata-only; no file
	 * replacement). Submits and waits for the new name to list.
	 *
	 * @param {string} oldName
	 * @param {string} newName
	 * @param {string} [locale='en']
	 */
	async renameFile(oldName, newName, locale = 'en') {
		const form = await this.openEditForm(oldName);
		const nameInput = form.locator(`input[name="libraryFileName[${locale}]"]`);
		await nameInput.fill(newName);
		await form.getByRole('button', {name: 'OK', exact: true}).click();
		await expect(form).toBeHidden({timeout: 20_000});
		await waitForJQueryIdle(this.page);
		await expect(this.fileLink(newName)).toBeVisible({timeout: 20_000});
	}

	/**
	 * Delete a document via its row action + the RemoteActionConfirmation
	 * OK, waiting for the row to leave the grid.
	 *
	 * @param {string} name
	 */
	async deleteFile(name) {
		await this.clickRowAction(name, 'deleteFile');
		const okButton = this.page
			.getByRole('button', {name: 'OK', exact: true})
			.last();
		await expect(okButton).toBeVisible({timeout: 10_000});
		await okButton.click();
		await waitForJQueryIdle(this.page);
		await expect(this.fileLink(name)).toHaveCount(0, {timeout: 20_000});
	}
};

// Grid DOM ids (component string, dots→dashes, lowercased, `Handler`
// suffix dropped — PKPHandler::setupBackendPage).
exports.LibraryFilesGrid.CONTEXT_GRID_ID =
	'component-grid-settings-library-libraryfileadmingrid';
exports.LibraryFilesGrid.SUBMISSION_GRID_ID =
	'component-grid-files-submissiondocuments-submissiondocumentsfilesgrid';
