// @ts-check
const {expect} = require('@playwright/test');
const {BasePage} = require('./BasePage.js');

/**
 * POM for the Media tab — the Vue MediaFileManager
 * (lib/ui-library/src/managers/MediaFileManager/) rendered as a
 * Publication-section panel ("Media" side-nav entry) on the workflow
 * page, plus the side modals its actions open:
 *
 *  - "Add Media File" opens the Upload Media File side modal hosting
 *    FileMediaUploader: a dropzone-backed batch uploader where every
 *    file needs a genre (dependent genres only: Image / Multimedia /
 *    HTML Stylesheet) and — when the genre supports file variants
 *    (genres.supports_file_variants, IMAGE by default) — a variant
 *    type (Web resolution | High resolution). Submit posts the
 *    temporary-file ids to POST .../mediaFiles.
 *  - "Batch Link Media" opens a table of web-variant files with one
 *    InlineSelect of genre-matched high-res counterparts per row
 *    (+ "No high-resolution file"); Link Media posts to
 *    POST .../mediaFiles/link (MediaFilesController::linkMany).
 *  - Per-row More Actions (ellipsis menu, role=menuitem):
 *    "More Information" (legacy File Information Center),
 *    "Edit Metadata" (side modal, PkpForm → PUT .../mediaFiles/{id};
 *    common fields sync to variant-group siblings),
 *    "Manually Link Media" (variant-supporting genres only; PkpForm →
 *    PUT .../mediaFiles/{id}/link), and "Delete File" (PkpDialog
 *    "Delete media file?" → DELETE .../mediaFiles/{id}).
 *
 * The PkpTable takes its accessible name from the "Media Files" panel
 * title (same aria-labelledby wiring as FileStagePanel). Grouped pairs
 * render inside one <tbody> (TableBodyGroup) whose first row carries
 * the shared variant-group id cell (rowspan=2).
 *
 * Shared across OJS/OMP/OPS — the manager and controller live in
 * pkp-lib/ui-library. Owned by the media-files plan.
 */
exports.MediaFileManagerPage = class MediaFileManagerPage extends BasePage {
	/** @param {import('@playwright/test').Page} page */
	constructor(page) {
		super(page);
		this.table = page.getByRole('table', {name: 'Media Files', exact: true});
	}

	/** The workflow page's hosting side-modal. */
	workflowModal() {
		return this.page.locator('[data-cy="active-modal"]').first();
	}

	/**
	 * The PkpTable root — innermost div containing the named table;
	 * includes the header bar with the "Batch Link Media" / "Add Media
	 * File" action buttons (siblings of the <table> element).
	 */
	root() {
		return this.page.locator('div').filter({has: this.table}).last();
	}

	/**
	 * Open the Media panel from the workflow side nav. The publication
	 * version group auto-expands for the latest publication
	 * (useWorkflowMenu's submission watcher), so the "Media" entry is
	 * clickable directly.
	 */
	async open() {
		const item = this.workflowModal()
			.locator('nav')
			.getByText('Media', {exact: true});
		await expect(item).toBeVisible({timeout: 20_000});
		await item.click();
		await this.expectVisible();
	}

	async expectVisible() {
		await expect(this.table).toBeVisible({timeout: 20_000});
	}

	/** Top action buttons (header bar). */
	addButton() {
		return this.root().getByRole('button', {name: 'Add Media File', exact: true});
	}

	batchLinkButton() {
		return this.root().getByRole('button', {name: 'Batch Link Media', exact: true});
	}

	/**
	 * A media-file row, matched by visible text (file name). In a
	 * grouped pair each file still has its own <tr>.
	 *
	 * @param {string} text
	 */
	row(text) {
		return this.table.getByRole('row').filter({hasText: text});
	}

	/**
	 * The <tbody> that holds BOTH named files — only exists when the two
	 * files render as one variant group (TableBodyGroup).
	 *
	 * @param {string} nameA
	 * @param {string} nameB
	 */
	groupBody(nameA, nameB) {
		return this.table
			.locator('tbody')
			.filter({hasText: nameA})
			.filter({hasText: nameB});
	}

	/**
	 * Open a row's More Actions ellipsis menu (headlessui portals the
	 * items to the document root — item lookups are page-scoped).
	 *
	 * @param {string} rowText
	 */
	async openRowMenu(rowText) {
		await this.row(rowText)
			.getByRole('button', {name: /More Actions/i})
			.click();
	}

	/**
	 * Pick an action from a row's More Actions menu. Labels come from
	 * useMediaFileManagerConfig#getItemActions: "More Information",
	 * "Edit Metadata", "Manually Link Media", "Delete File".
	 *
	 * @param {string} rowText
	 * @param {string} itemLabel
	 */
	async clickRowAction(rowText, itemLabel) {
		await this.openRowMenu(rowText);
		await this.page
			.getByRole('menuitem', {name: itemLabel, exact: true})
			.click();
	}

	/**
	 * Open the "Add Media File" upload modal and wait for the dropzone
	 * to be interactive. Returns the modal locator.
	 */
	async openAddModal() {
		await this.addButton().click();
		const modal = this.page
			.locator('[data-cy="active-modal"]')
			.filter({hasText: 'Upload Media File'})
			.first();
		await expect(modal.getByText('Drag and drop files here.')).toBeVisible({
			timeout: 15_000,
		});
		return modal;
	}

	/**
	 * Feed one file into the upload modal's hidden dropzone input and
	 * wait for its temporaryFiles upload to settle (the per-file genre
	 * select only renders once the upload succeeded). Dropzone replaces
	 * its hidden input after every selection, so the input is located
	 * fresh on each call.
	 *
	 * @param {import('@playwright/test').Locator} modal
	 * @param {string|{name: string, mimeType: string, buffer: Buffer}} file
	 *   absolute path of the file to add, or an in-memory descriptor
	 *   (Playwright setInputFiles payload) — the latter lets a caller feed
	 *   the SAME fixture under distinct names so the resulting rows are
	 *   individually targetable.
	 * @param {number} expectedCount   how many uploaded cards should
	 *   exist after this upload settles
	 */
	async addFileToUploader(modal, file, expectedCount) {
		await modal
			.locator('#mediaFileAddUploader input[type="file"]')
			.first()
			.setInputFiles(file);
		await expect(this.uploaderGenreSelects(modal)).toHaveCount(expectedCount, {
			timeout: 20_000,
		});
	}

	/**
	 * The per-file genre selects ("What kind of media is this?"), in
	 * file-add order. Ids are `mediaFileAddUploader-genreId-{uuid}` with
	 * a runtime uuid — match on the stable prefix.
	 *
	 * @param {import('@playwright/test').Locator} modal
	 */
	uploaderGenreSelects(modal) {
		return modal.locator('select[id^="mediaFileAddUploader-genreId-"]');
	}

	/**
	 * The per-file variant-type selects ("File resolution type"), same
	 * ordering as the genre selects.
	 *
	 * @param {import('@playwright/test').Locator} modal
	 */
	uploaderVariantSelects(modal) {
		return modal.locator('select[id^="mediaFileAddUploader-variantType-"]');
	}

	/**
	 * The modal's submit button ("Upload Files") — disabled until every
	 * file has an uploaded temporary file + a genre (+ implicit variant
	 * type, which defaults to web).
	 *
	 * @param {import('@playwright/test').Locator} modal
	 */
	uploadFilesButton(modal) {
		return modal.getByRole('button', {name: 'Upload Files', exact: true});
	}

	/**
	 * Open the "Batch Link Media" modal and wait for its table to load
	 * (the modal refetches the media list before rendering rows).
	 *
	 * @returns {Promise<import('@playwright/test').Locator>}
	 */
	async openBatchLinkModal() {
		await this.batchLinkButton().click();
		const modal = this.page
			.locator('[data-cy="active-modal"]')
			.filter({hasText: 'Link web version media files'})
			.first();
		await expect(
			modal.getByRole('columnheader', {name: 'Selected Web Version'}),
		).toBeVisible({timeout: 15_000});
		return modal;
	}

	/**
	 * The high-res InlineSelect for a web file's row in the batch-link
	 * modal (native <select> with a per-row aria-label).
	 *
	 * @param {import('@playwright/test').Locator} modal
	 * @param {string} webFileName  localized name of the web file
	 */
	batchLinkSelectFor(modal, webFileName) {
		return modal.getByRole('combobox', {
			name: `Select high-resolution version for ${webFileName}`,
		});
	}

	/**
	 * Delete a media file via More Actions → Delete File and confirm
	 * the PkpDialog ("Delete media file?" naming the file). Waits for
	 * the row to leave the table (the delete's finishedCallback
	 * refetches the list).
	 *
	 * @param {string} fileName
	 */
	async deleteFile(fileName) {
		await this.clickRowAction(fileName, 'Delete File');
		const dialog = this.page
			.locator('[data-cy="dialog"]')
			.filter({hasText: 'Delete media file?'});
		await expect(dialog).toBeVisible({timeout: 10_000});
		await expect(dialog).toContainText(fileName);
		await dialog.getByRole('button', {name: 'OK', exact: true}).click();
		await expect(this.row(fileName)).toHaveCount(0, {timeout: 20_000});
	}

	/**
	 * GET the publication's media files via the REST API with the
	 * page's session cookies. Returns the summarized items
	 * (variantGroupId / variantType / caption / description / name…).
	 *
	 * @param {number} submissionId
	 * @param {number} publicationId
	 * @param {string} [journalPath='publicknowledge']
	 * @returns {Promise<object[]>}
	 */
	async fetchMediaFiles(submissionId, publicationId, journalPath = 'publicknowledge') {
		const res = await this.page.request.get(
			`/index.php/${journalPath}/api/v1/submissions/${submissionId}/publications/${publicationId}/mediaFiles`,
		);
		if (!res.ok()) {
			throw new Error(
				`GET mediaFiles for ${submissionId}/${publicationId} failed: ${res.status()} ${await res.text()}`,
			);
		}
		const body = await res.json();
		return body.items || body;
	}
};
