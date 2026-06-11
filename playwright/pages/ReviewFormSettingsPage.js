// @ts-check
const {expect} = require('@playwright/test');
const {BasePage} = require('./BasePage.js');
const {setTinyMceContent} = require('../support/tinymce.js');
const {waitForJQueryIdle} = require('../support/jquery.js');

/**
 * POM for the Review Forms manager grid at Settings > Workflow >
 * Review > Review Forms — a legacy Smarty/jQuery component grid
 * (`grid.settings.reviewForms.ReviewFormGridHandler`), loaded via
 * load_url_in_div into `#reviewFormGridContainer`.
 *
 * Legacy-grid realities encoded here:
 *  - Grid/link-action DOM ids derive from the component path with the
 *    `Handler` suffix dropped and dots lowercased/dashed
 *    (PKPHandler::setupBackendPage):
 *    `component-grid-settings-reviewforms-reviewformgrid-...`.
 *  - Per-row actions (Edit / Copy / Preview / Delete) hide inside the
 *    sibling `tr.row_controls` until the row's `a.show_extras` glyph is
 *    clicked (patterns.md pitfall 9).
 *  - The Active column is a checkbox (selectStatusCell.tpl) wired to a
 *    RemoteActionConfirmationModal — clicking opens an OK/Cancel
 *    confirm, and the actual state flips only after the grid row
 *    refreshes from the server.
 *  - Modal stacking accumulates DOM copies of legacy form ids — every
 *    form lookup binds to `.last()` (ReviewerManagerPage convention).
 *  - All mutations ride jQuery AJAX; `waitForJQueryIdle` after every
 *    save/confirm is what makes follow-up assertions deterministic.
 *
 * Shared across OJS/OMP/OPS — review forms ship from pkp-lib.
 */

const GRID_ID = 'component-grid-settings-reviewforms-reviewformgrid';
const ELEMENTS_GRID_ID =
	'component-grid-settings-reviewforms-reviewformelementsgrid';
const LISTBUILDER_ID =
	'component-listbuilder-settings-reviewforms-reviewformelementresponseitemlistbuilder';

exports.ReviewFormSettingsPage = class ReviewFormSettingsPage extends BasePage {
	/** @param {import('@playwright/test').Page} page */
	constructor(page) {
		super(page);
		this.grid = page.locator('#reviewFormGridContainer');
		this.createFormButton = page.locator(
			`a[id^="${GRID_ID}-createReviewForm-button-"]`,
		);
	}

	/**
	 * Open Settings > Workflow, activate the Review top tab and the
	 * Review Forms side tab, and wait for the legacy grid to land.
	 *
	 * @param {string} journalPath
	 */
	async goto(journalPath) {
		await this.page.goto(
			`/index.php/${journalPath}/management/settings/workflow`,
		);
		// PkpTabs renders each trigger as `#{tabId}-button`; the Review
		// Forms side tab only exists inside the activated Review panel.
		await this.page.locator('#review-button').click();
		await this.page.locator('#reviewForms-button').click();
		await expect(this.createFormButton).toBeVisible({timeout: 20_000});
		await waitForJQueryIdle(this.page);
	}

	/**
	 * The data rows (`tr.gridRow`) whose text contains `title`. Returns
	 * the locator unresolved so callers can assert counts (duplicate
	 * titles after Copy) as well as single rows.
	 *
	 * @param {string} title
	 */
	rows(title) {
		return this.grid.locator(`tr.gridRow[id^="${GRID_ID}-row-"]`, {
			hasText: title,
		});
	}

	/**
	 * Resolve the DOM ids of all grid rows matching `title`, in display
	 * order. Used to tell an original apart from its Copy (same title;
	 * the copy gets a new, higher review_form_id baked into the row id).
	 *
	 * @param {string} title
	 * @returns {Promise<string[]>}
	 */
	async rowIds(title) {
		const rows = this.rows(title);
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
	 * Expand a row's hidden controls (`a.show_extras` → sibling
	 * `tr.row_controls`). No-op when already expanded (the glyph class
	 * flips to `hide_extras`).
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
	 * Link-action anchor for a row action. Action ids match the
	 * LinkAction ids in ReviewFormGridRow: 'edit' | 'copy' | 'preview'
	 * | 'delete'.
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
	 * @param {string} actionId 'edit' | 'copy' | 'preview' | 'delete'
	 */
	async clickRowAction(rowId, actionId) {
		await this.expandRowExtras(rowId);
		await this.rowActionLink(rowId, actionId).first().click();
	}

	/**
	 * Confirm a RemoteActionConfirmationModal (Copy / Delete /
	 * Activate / Deactivate) and wait for the grid refresh to settle.
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
	 * The Active-column checkbox of a row (selectStatusCell.tpl). The
	 * checkbox id is cell-unique-suffixed, so locate by type within the
	 * row — it is the row's only checkbox.
	 *
	 * @param {string} rowId
	 */
	activeCheckbox(rowId) {
		return this.rowById(rowId).locator('input[type="checkbox"]');
	}

	/**
	 * Click the Active checkbox and confirm. The click itself only
	 * opens the confirmation modal; the displayed state flips when the
	 * grid row refreshes (DataChangedEvent → fetchRow), so callers
	 * should follow up with an expect on `activeCheckbox(rowId)`.
	 *
	 * @param {string} rowId
	 */
	async toggleActive(rowId) {
		await this.activeCheckbox(rowId).click();
		await this.confirmOk();
	}

	/**
	 * Open the Create Review Form modal and return the legacy form.
	 *
	 * @returns {Promise<import('@playwright/test').Locator>}
	 */
	async openCreateForm() {
		await this.createFormButton.click();
		const form = this.page.locator('form#reviewFormForm').last();
		await expect(form).toBeVisible({timeout: 15_000});
		return form;
	}

	/**
	 * Fill the review-form basics form (title required; description is
	 * a rich multilingual textarea). On a single-locale journal the fbv
	 * field names collapse to `title[en]` / `description[en]` with no
	 * locale segment in the runtime-suffixed ids — anchor on names.
	 *
	 * @param {import('@playwright/test').Locator} form #reviewFormForm
	 * @param {{title: string, description?: string, locale?: string}} data
	 */
	async fillFormBasics(form, {title, description, locale = 'en'}) {
		await form.locator(`input[name="title[${locale}]"]`).fill(title);
		if (description !== undefined) {
			const textareaId = await form
				.locator(`textarea[name="description[${locale}]"]`)
				.getAttribute('id');
			if (!textareaId) {
				throw new Error('review form description textarea not found');
			}
			await setTinyMceContent(this.page, textareaId, description);
		}
	}

	/**
	 * Submit a legacy AjaxFormHandler form via its Save button and wait
	 * for the hosting modal to close (a still-open form means
	 * server-side validation failed) and the grid refresh to settle.
	 *
	 * @param {import('@playwright/test').Locator} form
	 */
	async saveAjaxForm(form) {
		await form.getByRole('button', {name: 'Save', exact: true}).click();
		await expect(form).toBeHidden({timeout: 15_000});
		await waitForJQueryIdle(this.page);
	}

	/**
	 * Open the row's Edit modal — the #editReviewFormTabs jQueryUI
	 * tabset (Review Form / Form Items / Preview Form).
	 *
	 * @param {string} rowId
	 * @returns {Promise<import('@playwright/test').Locator>} the tabset
	 */
	async openEditModal(rowId) {
		await this.clickRowAction(rowId, 'edit');
		const tabs = this.page.locator('#editReviewFormTabs').last();
		await expect(tabs).toBeVisible({timeout: 15_000});
		await waitForJQueryIdle(this.page);
		return tabs;
	}

	/**
	 * Activate the "Form Items" tab inside the Edit modal and wait for
	 * the elements grid (ReviewFormElementsGridHandler) to load.
	 *
	 * @param {import('@playwright/test').Locator} tabs #editReviewFormTabs
	 * @returns {Promise<import('@playwright/test').Locator>} the
	 *   elements-grid container
	 */
	async openFormItemsTab(tabs) {
		await tabs.getByRole('tab', {name: 'Form Items'}).click();
		const createElementButton = this.page.locator(
			`a[id^="${ELEMENTS_GRID_ID}-createReviewFormElement-button-"]`,
		);
		await expect(createElementButton.last()).toBeVisible({timeout: 15_000});
		await waitForJQueryIdle(this.page);
		return this.page.locator('#reviewFormElementsGridContainer').last();
	}

	/**
	 * Activate the "Preview Form" tab and wait for the assembled
	 * preview (#previewReviewForm — reviewFormResponse.tpl rendered
	 * with the saved elements).
	 *
	 * @param {import('@playwright/test').Locator} tabs #editReviewFormTabs
	 * @returns {Promise<import('@playwright/test').Locator>} the preview form
	 */
	async openPreviewTab(tabs) {
		await tabs.getByRole('tab', {name: 'Preview Form'}).click();
		const preview = this.page.locator('form#previewReviewForm').last();
		await expect(preview).toBeVisible({timeout: 15_000});
		await waitForJQueryIdle(this.page);
		return preview;
	}

	/**
	 * From the Form Items tab, open the Create New Item modal.
	 *
	 * After a previous element save, the DataChangedEvent refresh
	 * re-renders the elements grid around its header link action; a
	 * click landing in that window is swallowed without opening the
	 * AjaxModal (observed ~1 in 3 runs on the SECOND element of a
	 * test). Bounded retry, mirroring SubmissionWizardPage.gotoStep's
	 * treatment of re-render-swallowed clicks.
	 *
	 * @returns {Promise<import('@playwright/test').Locator>} the
	 *   #reviewFormElementForm legacy form
	 */
	async openCreateElementForm() {
		const link = this.page
			.locator(`a[id^="${ELEMENTS_GRID_ID}-createReviewFormElement-button-"]`)
			.last();
		const form = this.page.locator('form#reviewFormElementForm').last();
		for (let attempt = 0; ; attempt++) {
			try {
				await link.click({timeout: 5_000});
				await expect(form).toBeVisible({timeout: 5_000});
				break;
			} catch (err) {
				// The click may also have opened the modal late — accept it.
				if (await form.isVisible().catch(() => false)) {
					break;
				}
				if (attempt >= 2) {
					throw err;
				}
				await waitForJQueryIdle(this.page);
			}
		}
		// The possible-responses listbuilder loads async (load_url_in_div)
		// below the fold of the form; wait for its Add Item action so
		// option-entry (when needed) doesn't race the fetch.
		await expect(
			form.locator(`a[id^="${LISTBUILDER_ID}-addItem-button-"]`).last(),
		).toBeAttached({timeout: 15_000});
		await waitForJQueryIdle(this.page);
		return form;
	}

	/**
	 * Add one possible-response option through the legacy listbuilder:
	 * Add Item appends an editable row whose (multilingual, primary
	 * locale) text input is `newRowId[possibleResponse][en]`; pressing
	 * Enter triggers the row save (sync AJAX bounce off fetchRow) and
	 * re-renders the row read-only.
	 *
	 * @param {import('@playwright/test').Locator} form #reviewFormElementForm
	 * @param {string} text
	 * @param {string} [locale='en']
	 */
	async addElementOption(form, text, locale = 'en') {
		await form
			.locator(`a[id^="${LISTBUILDER_ID}-addItem-button-"]`)
			.last()
			.click();
		await waitForJQueryIdle(this.page);
		const input = form
			.locator(`.gridRowEdit input[name="newRowId[possibleResponse][${locale}]"]`)
			.last();
		await expect(input).toBeVisible({timeout: 10_000});
		await input.fill(text);
		await input.press('Enter');
		await waitForJQueryIdle(this.page);
		// The saved row renders the option read-only in its display cell.
		await expect(
			form.locator('.gridCellDisplay', {hasText: text}).last(),
		).toBeVisible({timeout: 10_000});
	}

	/**
	 * Create one review-form element end-to-end: question (rich,
	 * primary locale), required flag, item type by visible label
	 * (e.g. 'Extended text box', 'Radio buttons (you can only choose
	 * one)'), and possible-response options for the multiple-response
	 * types. Saves and waits for the elements grid to list the new
	 * question.
	 *
	 * @param {{question: string, typeLabel: string, required?: boolean, options?: string[], locale?: string}} spec
	 */
	async addElement({question, typeLabel, required = false, options = [], locale = 'en'}) {
		const form = await this.openCreateElementForm();

		const questionId = await form
			.locator(`textarea[name="question[${locale}]"]`)
			.getAttribute('id');
		if (!questionId) {
			throw new Error('review form element question textarea not found');
		}
		await setTinyMceContent(this.page, questionId, question);

		if (required) {
			// fbv checkboxes keep their template ids unsuffixed.
			await form.locator('input#required').check();
		}

		await form
			.locator('select[name="elementType"]')
			.selectOption({label: typeLabel});

		for (const option of options) {
			await this.addElementOption(form, option, locale);
		}

		await this.saveAjaxForm(form);
		await expect(
			this.page
				.locator('#reviewFormElementsGridContainer')
				.last()
				.getByText(question),
		).toBeVisible({timeout: 15_000});
	}
};
