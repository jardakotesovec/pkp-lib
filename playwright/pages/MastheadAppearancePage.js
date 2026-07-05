// @ts-check
const {BasePage} = require('./BasePage.js');

/**
 * The Editorial Masthead appearance form — Settings → Website → Editorial
 * Masthead (`PKPAppearanceMastheadForm`, the `appearance-masthead` side-tab).
 *
 * SHARED (lib/pkp): the form lives in pkp-lib and renders identically in
 * OJS/OMP/OPS. It carries exactly two fields — the orderable
 * `mastheadUserGroupIds` list (drag-sortable list of masthead-eligible
 * non-reviewer groups) and a display-only reviewer note (`FieldHTML`). Saving
 * PUTs the journal context (`api/v1/contexts/{id}`, tunneled through POST +
 * `X-Http-Method-Override: PUT` by the Vue form).
 *
 * Reorder is driven through the `Orderer` up/down arrow buttons rather than
 * native HTML5 drag-and-drop, which is not reliably drivable in Playwright.
 */
exports.MastheadAppearancePage = class MastheadAppearancePage extends BasePage {
	/**
	 * @param {import('@playwright/test').Page} page
	 * @param {string} journalPath
	 */
	constructor(page, journalPath) {
		super(page);
		this.journalPath = journalPath;
		// The masthead field is a <fieldset> (role=group) named by its legend.
		// Anchoring on it scopes past the sibling appearance forms (theme,
		// setup, advanced) that also render on the Website settings page.
		this.mastheadField = page.getByRole('group', {name: 'Editorial Masthead'});
		this.form = page
			.locator('form.pkpForm')
			.filter({has: this.mastheadField});
		this.options = this.mastheadField.locator(
			'.pkpFormField--options__option',
		);
		this.saveButton = this.form.getByRole('button', {
			name: 'Save',
			exact: true,
		});
		// The display-only reviewer note (FieldHTML 'reviewer') — not a toggle.
		this.reviewerNote = this.form.getByText(
			/Reviewers will be displayed in a standardized format/i,
		);
	}

	/** Open Settings → Website and select the Editorial Masthead side-tab. */
	async goto() {
		await this.page.goto(
			`/index.php/${this.journalPath}/management/settings/website`,
		);
		await this.page.locator('#appearance-button').click();
		await this.page.locator('#appearance-masthead-button').click();
		await this.mastheadField.waitFor({state: 'visible', timeout: 15_000});
	}

	/** The current top→bottom order of the group option labels. */
	async optionOrder() {
		return this.options.evaluateAll((els) =>
			els.map((el) =>
				el
					.querySelector('.pkpFormField--options__optionLabel')
					?.textContent?.trim(),
			),
		);
	}

	/** The option row whose group name contains `name`. */
	optionFor(name) {
		return this.options.filter({hasText: name});
	}

	/** Move a group up one position via its Orderer up arrow. */
	async moveUp(name) {
		await this.optionFor(name).locator('button.orderer__up').click();
	}

	/**
	 * Click Save and await the context PUT (tunneled as POST + method-override)
	 * returning 200.
	 */
	async save() {
		const response = this.page.waitForResponse(
			(r) =>
				r.url().includes('/api/v1/contexts/') &&
				r.request().method() === 'POST' &&
				r.status() === 200,
		);
		await this.saveButton.click();
		await response;
	}
};
