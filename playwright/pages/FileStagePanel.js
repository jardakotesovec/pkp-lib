// @ts-check
const path = require('path');
const {expect} = require('@playwright/test');
const {BasePage} = require('./BasePage.js');
const {waitForJQueryIdle} = require('../support/jquery.js');

/**
 * POM for a workflow file-stage panel — the Vue FileManager
 * (lib/ui-library/src/managers/FileManager/FileManager.vue) rendered on
 * the editorial workflow page for each file stage, plus the two legacy
 * flows its buttons open:
 *
 *  - "Upload" (Actions.FILE_UPLOAD, e.g. Production Ready Files) opens
 *    the legacy FileUploadWizardHandler directly: a 3-step fbv wizard
 *    (genre + plupload file → metadata → confirm) whose advance button
 *    reuses `id=continueButton` on every step.
 *  - "Upload/Select Files" (Actions.FILE_SELECT_UPLOAD, e.g. Draft
 *    Files / Copyedited Files) opens the stage's Manage*FilesGridHandler
 *    `selectFiles` modal: a selectable category grid of the submission's
 *    files (checkboxes named `selectedFiles[]`) with an "Upload File"
 *    grid action that stacks the same 3-step wizard on top. Saving the
 *    form (fbv "OK") imports checked files into the panel's file stage
 *    and syncs the `viewable` flag.
 *
 * The FileManager has no data-cy hook; the PkpTable inside it takes its
 * accessible name from the panel title (aria-labelledby), so the panel
 * is located by `getByRole('table', {name: title})` and scoped to the
 * PkpTable root (the table's parent div, which also contains the
 * header bar with the action buttons and the bottom controls).
 *
 * Shared across OJS/OMP/OPS — FileManager and the legacy grid handlers
 * live in pkp-lib. Owned by the copyediting/production-stage specs.
 */
exports.FileStagePanel = class FileStagePanel extends BasePage {
	/**
	 * @param {import('@playwright/test').Page} page
	 * @param {string} title  panel title, e.g. 'Draft Files',
	 *   'Copyedited Files', 'Production Ready Files'
	 */
	constructor(page, title) {
		super(page);
		this.title = title;
		this.table = page.getByRole('table', {name: title, exact: true});
	}

	/**
	 * The PkpTable root — the innermost div containing the named table.
	 * Includes the header bar (title + top action buttons) and the
	 * bottom controls (Download All Files), which are siblings of the
	 * <table> element itself.
	 */
	root() {
		return this.page.locator('div').filter({has: this.table}).last();
	}

	async expectVisible() {
		await expect(this.table).toBeVisible({timeout: 20_000});
	}

	/**
	 * A file row in the panel, matched by visible text (file name).
	 *
	 * @param {string} text
	 */
	row(text) {
		return this.table.getByRole('row').filter({hasText: text});
	}

	/**
	 * The file-name download link inside a row (FileManagerCellFileName
	 * renders an <a href=file.url> when the API exposes a url).
	 *
	 * @param {string} name
	 */
	fileLink(name) {
		return this.row(name).getByRole('link', {name});
	}

	/**
	 * Open the legacy "Upload/Select Files" modal (FILE_SELECT_UPLOAD).
	 * The button label is always "Upload/Select Files"; the resulting
	 * dialog's title varies by stage (`uploadSelectTitleKey`):
	 * Draft Files → "Upload/Select Files", Copyedited Files →
	 * "Upload Review File".
	 *
	 * @param {string} modalTitle
	 * @returns {Promise<import('@playwright/test').Locator>} the dialog
	 */
	async openUploadSelect(modalTitle) {
		await this.root()
			.getByRole('button', {name: 'Upload/Select Files', exact: true})
			.click();
		// Substring name match — the proven pattern for legacy modal
		// dialogs (see decision-request-revisions.spec.js); their
		// accessible name comes from the modal title bar.
		const modal = this.page.getByRole('dialog', {name: modalTitle}).first();
		await expect(modal).toBeVisible({timeout: 15_000});
		// The selectable grid loads via load_url_in_div — wait for the
		// fetch to settle so rows/actions are interactable.
		await waitForJQueryIdle(this.page);
		return modal;
	}

	/**
	 * In the (open) Upload/Select modal: reveal files from other
	 * workflow stages. The selectable category grid defaults to the
	 * panel's own stage only; the "Show files from all accessible
	 * workflow stages." filter checkbox (ToggleFormHandler — submits on
	 * change) refetches the grid with every stage's categories. Needed
	 * before importing e.g. a submission-stage file into Draft Files.
	 *
	 * @param {import('@playwright/test').Locator} modal
	 */
	async showAllStages(modal) {
		await modal
			.getByLabel('Show files from all accessible workflow stages.')
			.check();
		await waitForJQueryIdle(this.page);
	}

	/**
	 * In the (open) Upload/Select modal: tick the checkbox of the row
	 * matching `fileName`. Used both to import a file from another stage
	 * and to keep a freshly-uploaded file selected (the manage form
	 * syncs `viewable` to the checkbox state on save).
	 *
	 * @param {import('@playwright/test').Locator} modal
	 * @param {string} fileName
	 */
	async ensureFileSelected(modal, fileName) {
		const row = modal.locator('tr', {hasText: fileName}).first();
		await expect(row).toBeVisible({timeout: 15_000});
		await row.locator('input[name="selectedFiles[]"]').setChecked(true);
	}

	/**
	 * Submit the Upload/Select form (fbvFormButtons default "OK"). The
	 * AjaxFormHandler closes the modal on success and the legacy-modal
	 * finished callback refreshes the Vue panel.
	 *
	 * @param {import('@playwright/test').Locator} modal
	 */
	async saveUploadSelect(modal) {
		await modal.getByRole('button', {name: 'OK', exact: true}).click();
		await waitForJQueryIdle(this.page);
		await expect(modal).toBeHidden({timeout: 20_000});
	}

	/**
	 * From inside the Upload/Select modal, open the stacked "Upload
	 * File" wizard (AddFileLinkAction on the selectable grid).
	 *
	 * @param {import('@playwright/test').Locator} modal
	 * @param {string} wizardTitle stage-dependent (AddFileLinkAction::_getTextLabels),
	 *   e.g. 'Upload Copyedited File'
	 * @returns {Promise<import('@playwright/test').Locator>} the wizard dialog
	 */
	async openNestedUploadWizard(modal, wizardTitle) {
		await modal.locator('a:has-text("Upload File")').first().click();
		const wizard = this.page.getByRole('dialog', {name: wizardTitle}).first();
		await expect(wizard).toBeVisible({timeout: 15_000});
		return wizard;
	}

	/**
	 * Open the direct upload wizard from the panel's "Upload" button
	 * (FILE_UPLOAD — Production Ready Files).
	 *
	 * @param {string} wizardTitle e.g. 'Upload a Production Ready File'
	 * @returns {Promise<import('@playwright/test').Locator>} the wizard dialog
	 */
	async openDirectUploadWizard(wizardTitle) {
		await this.root()
			.getByRole('button', {name: 'Upload', exact: true})
			.click();
		const wizard = this.page.getByRole('dialog', {name: wizardTitle}).first();
		await expect(wizard).toBeVisible({timeout: 15_000});
		return wizard;
	}

	/**
	 * Drive the 3-step legacy upload wizard end-to-end. Mirrors the
	 * pattern proven in decision-request-revisions.spec.js / the
	 * EditorialWorkflowPage#addGalley helper:
	 *   1. pick genre + setInputFiles on the opacity-0 plupload input;
	 *      wait for "Change File" (upload settled) before Continue —
	 *      otherwise the form posts with no file.
	 *   2. metadata: name prefilled from the filename; optionally
	 *      override the primary-locale name (input id ends with
	 *      `-name-control-en`; fbv ids are runtime-suffixed).
	 *   3. confirm ("File Added") → Complete (same `#continueButton`).
	 *
	 * @param {import('@playwright/test').Locator} wizard
	 * @param {object} opts
	 * @param {string} opts.filePath              absolute path to upload
	 * @param {string} [opts.genreLabel='Article Text']
	 * @param {string} [opts.displayName]         unique per-test file name
	 */
	async driveUploadWizard(wizard, {filePath, genreLabel = 'Article Text', displayName}) {
		// The step-1 form loads via AJAX inside the dialog — wait for the
		// genre select to render before touching anything. Skipping this
		// races the load: setInputFiles would feed a file to an uploader
		// whose genre is unset, and plupload never starts the upload
		// (Continue stays disabled forever).
		const genreSelect = wizard.locator('select[name=genreId]');
		await expect(genreSelect).toBeVisible({timeout: 15_000});
		await genreSelect.selectOption({label: genreLabel});
		await wizard.locator('input[type=file]').setInputFiles(filePath);
		await expect(wizard.getByText('Change File')).toBeVisible({
			timeout: 15_000,
		});
		await wizard.locator('button#continueButton').click();

		// Step 2 — metadata. Anchor arrival on the en name control (one
		// label per form locale; bare text match is not strict-mode-safe).
		const nameInput = wizard.locator('input[id$="-name-control-en"]');
		await expect(nameInput).toBeVisible({timeout: 15_000});
		if (displayName) {
			await nameInput.fill(displayName);
		}
		await wizard.locator('button#continueButton').click();

		// Step 3 — confirm; the button is now labeled "Complete" but
		// keeps id=continueButton.
		await expect(wizard.getByText('File Added')).toBeVisible({
			timeout: 15_000,
		});
		await wizard.locator('button#continueButton').click();
		await expect(wizard).toBeHidden({timeout: 15_000});
		await waitForJQueryIdle(this.page);
	}

	/**
	 * Full FILE_SELECT_UPLOAD upload flow: open the Upload/Select modal,
	 * stack the upload wizard, upload the file, keep it checked in the
	 * selectable grid (viewable=true), and save. The new row appears in
	 * the panel afterwards.
	 *
	 * @param {object} opts
	 * @param {string} opts.selectTitle  Upload/Select dialog title
	 * @param {string} opts.wizardTitle  stacked wizard dialog title
	 * @param {string} opts.filePath
	 * @param {string} opts.displayName
	 * @param {string} [opts.genreLabel='Article Text']
	 */
	async uploadViaUploadSelect({selectTitle, wizardTitle, filePath, displayName, genreLabel = 'Article Text'}) {
		const modal = await this.openUploadSelect(selectTitle);
		const wizard = await this.openNestedUploadWizard(modal, wizardTitle);
		await this.driveUploadWizard(wizard, {filePath, genreLabel, displayName});
		await this.ensureFileSelected(modal, displayName);
		await this.saveUploadSelect(modal);
		await expect(this.row(displayName)).toBeVisible({timeout: 20_000});
	}

	/**
	 * Click "Download All Files" (bottom controls; rendered only once
	 * the panel has at least one file) and capture the resulting
	 * archive download.
	 *
	 * @returns {Promise<import('@playwright/test').Download>}
	 */
	async downloadAll() {
		const button = this.root().getByRole('button', {
			name: 'Download All Files',
		});
		await expect(button).toBeVisible({timeout: 15_000});
		const [download] = await Promise.all([
			this.page.waitForEvent('download'),
			button.click(),
		]);
		return download;
	}
};

/**
 * Resolve a bundled fixture file (lib/pkp/playwright/fixtures/files/).
 *
 * @param {string} [name='default-article.pdf']
 */
exports.fixtureFilePath = function fixtureFilePath(name = 'default-article.pdf') {
	return path.resolve(__dirname, '..', 'fixtures', 'files', name);
};
