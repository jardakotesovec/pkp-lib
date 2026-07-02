// @ts-check
const {expect} = require('@playwright/test');
const {BasePage} = require('./BasePage.js');

/**
 * Workflow settings — Settings > Workflow
 * (templates/management/workflow.tpl).
 *
 * Built for the submission-wizard-metadata specs: wraps the outer
 * Submission tab's Metadata side tab (the PKPMetadataSettingsForm
 * panel) and its FieldMetadataSetting fieldsets — the "Enable …
 * metadata" checkbox that reveals the three do-not-request / ask /
 * require radios.
 *
 * Tab-id cheat sheet (button id = `${tabId}-button`, panel id = tabId):
 *   Submission → disableSubmissions | instructions | metadata
 *                | components | contributorRoles
 *   Review     → reviewSetup | reviewerGuidance | reviewForms
 *                [| reviewerRecommendations]
 *
 * Save dance mirrors WebsiteSettingsPage.saveForm: Save click →
 * contexts API PUT (tunnelled via POST + X-Http-Method-Override) →
 * `[role="status"] Saved` badge (patterns.md pitfall 13).
 */
exports.WorkflowSettingsPage = class WorkflowSettingsPage extends BasePage {
	/**
	 * @param {import('@playwright/test').Page} page
	 * @param {string} contextPath the journal/press/server urlPath
	 */
	constructor(page, contextPath) {
		super(page);
		this.contextPath = contextPath;
	}

	async goto() {
		await this.page.goto(
			`/index.php/${this.contextPath}/management/settings/workflow`,
		);
		await expect(this.page.locator('#submission-button')).toBeVisible({
			timeout: 15_000,
		});
	}

	/**
	 * Open the Metadata side tab under the (default-active) outer
	 * Submission tab and return its panel locator.
	 *
	 * @returns {Promise<import('@playwright/test').Locator>} the tab panel
	 */
	async openMetadataTab() {
		await this.page.locator('#submission-button').click();
		await this.page.locator('#metadata-button').click();
		const panel = this.page.locator('#metadata');
		await expect(panel.locator('form').first()).toBeVisible({
			timeout: 15_000,
		});
		return panel;
	}

	/**
	 * Open the Setup side tab under the outer Review tab and return its
	 * panel locator (the PKPReviewSetupForm — review mode, deadlines,
	 * reviewer-suggestion toggle …). Only rendered on apps with a review
	 * stage. Save via `saveForm(panel)` — the panel holds one form.
	 *
	 * @returns {Promise<import('@playwright/test').Locator>} the tab panel
	 */
	async openReviewSetupTab() {
		await this.page.locator('#review-button').click();
		await this.page.locator('#reviewSetup-button').click();
		const panel = this.page.locator('#reviewSetup');
		await expect(panel.locator('form').first()).toBeVisible({
			timeout: 15_000,
		});
		return panel;
	}

	/**
	 * One FieldMetadataSetting fieldset, scoped by its unique
	 * "Enable … metadata" checkbox label (e.g. 'Enable subject
	 * metadata'). The legend labels ('Subjects', 'Type', …) repeat as
	 * substrings elsewhere; the enable-label is unique per field.
	 *
	 * @param {import('@playwright/test').Locator} panel from openMetadataTab
	 * @param {string} enableLabel e.g. 'Enable subject metadata'
	 */
	metadataFieldset(panel, enableLabel) {
		return panel
			.locator('fieldset.pkpFormField--metadata')
			.filter({hasText: enableLabel})
			.first();
	}

	/**
	 * The "Enable … metadata" checkbox of a metadata fieldset (each
	 * fieldset renders exactly one checkbox).
	 *
	 * @param {import('@playwright/test').Locator} fieldset from metadataFieldset
	 */
	enableCheckbox(fieldset) {
		return fieldset.locator('input[type="checkbox"]');
	}

	/**
	 * One of the three submission-mode radios of a metadata fieldset,
	 * scoped by its visible label (e.g. 'Ask the author to provide
	 * subjects during submission.').
	 *
	 * @param {import('@playwright/test').Locator} fieldset from metadataFieldset
	 * @param {string} radioLabel
	 */
	modeRadio(fieldset, radioLabel) {
		return fieldset
			.locator('label', {hasText: radioLabel})
			.locator('input[type="radio"]');
	}

	/**
	 * Save the (first) form inside the tab panel and wait for the
	 * contexts API write plus the "Saved" status badge. The response
	 * await is the real anchor — the badge can linger from an earlier
	 * save in multi-phase tests.
	 *
	 * @param {import('@playwright/test').Locator} panel from openMetadataTab
	 * @returns {Promise<import('@playwright/test').Response>}
	 */
	async saveForm(panel) {
		const [response] = await Promise.all([
			this.page.waitForResponse(
				(res) =>
					/\/api\/v1\/contexts\/\d+/.test(res.url()) &&
					res.ok() &&
					['POST', 'PUT'].includes(res.request().method()),
				{timeout: 15_000},
			),
			panel
				.locator('form')
				.first()
				.getByRole('button', {name: 'Save', exact: true})
				.click(),
		]);
		await expect(
			panel.locator('[role="status"]', {hasText: 'Saved'}),
		).toBeVisible({timeout: 15_000});
		return response;
	}
};
