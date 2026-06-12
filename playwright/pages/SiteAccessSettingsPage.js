// @ts-check
const {BasePage} = require('./BasePage.js');

/**
 * POM for the Users & Roles → "Site Access Options" tab
 * (/index.php/<context>/management/settings/access), which hosts the
 * PKPUserAccessForm (FORM_USER_ACCESS = 'userAccess' — see
 * lib/pkp/classes/components/forms/context/PKPUserAccessForm.php):
 *
 *   - restrictSiteAccess    checkbox (lib/pkp)
 *   - disableUserReg        radio, enable(false)/disable(true) (lib/pkp)
 *   - restrictArticleAccess checkbox (OJS-only — appended by
 *     classes/components/forms/context/UserAccessForm.php; absent in
 *     OMP/OPS, so only OJS specs should touch it)
 *
 * The tab panel id is `access` (templates/management/access.tpl), so the
 * activating button is `#access-button` (Tabs.vue renders `{id}-button`)
 * and every field locator is scoped to the `#access` tabpanel.
 */
exports.SiteAccessSettingsPage = class SiteAccessSettingsPage extends BasePage {
	/**
	 * @param {import('@playwright/test').Page} page
	 * @param {string} contextPath journal/press/server URL path
	 */
	constructor(page, contextPath) {
		super(page);
		this.contextPath = contextPath;
		this.panel = page.locator('#access');
		this.saveButton = this.panel.getByRole('button', {
			name: 'Save',
			exact: true,
		});
	}

	/**
	 * Open Users & Roles and activate the Site Access Options tab. The
	 * tab button only exists after the Vue page mounts; Playwright
	 * auto-wait covers the gap.
	 */
	async goto() {
		await this.page.goto(
			`/index.php/${this.contextPath}/management/settings/access`,
		);
		await this.page.locator('#access-button').click();
	}

	/**
	 * Locator for a FieldOptions input by its name attribute.
	 *
	 * @param {string} name e.g. 'restrictSiteAccess'
	 */
	option(name) {
		return this.panel.locator(`input[name="${name}"]`);
	}

	/**
	 * Check/uncheck one of the form's FieldOptions checkboxes.
	 *
	 * @param {string} name input name attribute
	 * @param {boolean} on
	 */
	async setCheckbox(name, on) {
		const box = this.option(name);
		if (on) {
			await box.check();
		} else {
			await box.uncheck();
		}
	}

	/**
	 * Pick a FieldOptions radio by its visible option label (the label
	 * element wraps the input, so the accessible name is the label text).
	 *
	 * @param {RegExp|string} label
	 */
	async chooseRadio(label) {
		await this.panel.getByRole('radio', {name: label}).check();
	}

	/**
	 * Save the form and wait for the contexts API write to succeed.
	 * useFetch tunnels PUT via POST + X-Http-Method-Override
	 * (patterns.md wave-2 lesson), so accept both methods.
	 */
	async save() {
		const saved = this.page.waitForResponse(
			(res) =>
				/\/api\/v1\/contexts\/\d+/.test(res.url()) &&
				res.ok() &&
				['POST', 'PUT'].includes(res.request().method()),
			{timeout: 15_000},
		);
		await this.saveButton.click();
		await saved;
	}
};
