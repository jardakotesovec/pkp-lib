// @ts-check
const {expect} = require('@playwright/test');
const {BasePage} = require('./BasePage.js');

/**
 * Website settings — Settings > Website (templates/management/website.tpl).
 *
 * Wraps the two-level tab navigation (outer tabs: Appearance / Setup /
 * Plugins / Content; side tabs inside each) plus the Vue PkpForm save
 * dance (Save click → contexts API PUT → "Saved" status badge) and the
 * FieldUploadImage dropzone upload that three prior waves hand-rolled.
 *
 * Tab-id cheat sheet (button id = `${tabId}-button`, panel id = tabId):
 *   Appearance → theme | appearance-setup | appearance-masthead | advanced
 *   Setup      → information | languages | navigationMenus | announcements
 *                | highlights | lists | privacy | dateTime
 *
 * NESTED-TAB TRAP (patterns.md pitfall 2): the OUTER "Setup" tab is
 * `#setup` while Appearance's inner "Setup" side tab is
 * `#appearance-setup` — two different tabs. This POM's methods take the
 * side-tab id, so callers never touch the ambiguous `#setup-button`
 * directly for the inner tab.
 */
exports.WebsiteSettingsPage = class WebsiteSettingsPage extends BasePage {
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
			`/index.php/${this.contextPath}/management/settings/website`,
		);
		await expect(this.page.locator('#appearance-button')).toBeVisible({
			timeout: 15_000,
		});
	}

	/**
	 * Open a side tab under the outer Appearance tab and return its panel
	 * locator. `theme` is the default-active side tab but clicking its
	 * button is idempotent, so callers don't need to special-case it.
	 *
	 * @param {'theme'|'appearance-setup'|'appearance-masthead'|'advanced'} sideTabId
	 * @returns {Promise<import('@playwright/test').Locator>} the tab panel
	 */
	async openAppearanceTab(sideTabId) {
		await this.page.locator('#appearance-button').click();
		await this.page.locator(`#${sideTabId}-button`).click();
		const panel = this.page.locator(`#${sideTabId}`);
		await expect(panel.locator('form').first()).toBeVisible({
			timeout: 15_000,
		});
		return panel;
	}

	/**
	 * Open a side tab under the outer Setup tab and return its panel
	 * locator. Form-hosting tabs only — the grid-hosting tabs (languages,
	 * navigationMenus) load jQuery grids instead of a Vue form, so this
	 * helper's form-visible wait doesn't apply to them.
	 *
	 * @param {'information'|'announcements'|'lists'|'privacy'|'dateTime'} sideTabId
	 * @returns {Promise<import('@playwright/test').Locator>} the tab panel
	 */
	async openSetupTab(sideTabId) {
		await this.page.locator('#setup-button').click();
		await this.page.locator(`#${sideTabId}-button`).click();
		const panel = this.page.locator(`#${sideTabId}`);
		await expect(panel.locator('form').first()).toBeVisible({
			timeout: 15_000,
		});
		return panel;
	}

	/**
	 * Save the (first) form inside a tab panel and wait for both the
	 * backend write and the user-visible confirmation:
	 *   1. the API response (default: any contexts API write — the theme
	 *      form posts to /contexts/{id}/theme which the default also
	 *      matches; pass `endpoint` to narrow),
	 *   2. the `[role="status"] Saved` badge (patterns.md pitfall 13).
	 *
	 * NOTE: useFetch tunnels PUT via POST + X-Http-Method-Override, so
	 * the method predicate accepts both.
	 *
	 * @param {import('@playwright/test').Locator} panel a tab panel from openAppearanceTab/openSetupTab
	 * @param {{endpoint?: RegExp}} [opts]
	 * @returns {Promise<import('@playwright/test').Response>}
	 */
	async saveForm(panel, {endpoint = /\/api\/v1\/contexts\/\d+/} = {}) {
		const [response] = await Promise.all([
			this.page.waitForResponse(
				(res) =>
					endpoint.test(res.url()) &&
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

	/**
	 * Upload an image into a FieldUploadImage (dropzone.js) field and
	 * return the alt-text input that appears once the temporary-file
	 * upload succeeds.
	 *
	 * Dropzone's hidden `<input type=file>` gets its deterministic id
	 * (`${formId}-${fieldName}-hiddenFileId-${locale}`) assigned in a
	 * post-mount setTimeout (FieldUpload.vue mounted hook), hence the
	 * attached-state wait before setInputFiles. Clicking the visible
	 * "Upload file" button would open a real OS dialog — same trap as
	 * the legacy plupload widgets (patterns.md pitfall 12).
	 *
	 * @param {string} formId e.g. 'appearanceSetup'
	 * @param {string} fieldName e.g. 'pageHeaderLogoImage'
	 * @param {string} filePath absolute path of the image fixture
	 * @param {{locale?: string}} [opts]
	 * @returns {Promise<import('@playwright/test').Locator>} the alt-text input
	 */
	async uploadImage(formId, fieldName, filePath, {locale = 'en'} = {}) {
		const hiddenInput = this.page.locator(
			`#${formId}-${fieldName}-hiddenFileId-${locale}`,
		);
		await hiddenInput.waitFor({state: 'attached', timeout: 15_000});
		const uploaded = this.page.waitForResponse(
			(res) =>
				/\/api\/v1\/temporaryFiles/.test(res.url()) &&
				res.ok() &&
				res.request().method() === 'POST',
			{timeout: 20_000},
		);
		await hiddenInput.setInputFiles(filePath);
		await uploaded;
		const altText = this.page.locator(
			`#${formId}-${fieldName}-altText-${locale}`,
		);
		await expect(altText).toBeVisible({timeout: 15_000});
		return altText;
	}
};
