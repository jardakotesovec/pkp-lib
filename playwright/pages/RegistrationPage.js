// @ts-check
const {BasePage} = require('./BasePage.js');

/**
 * POM for the public self-registration form at `{context}/user/register`
 * (RegistrationHandler::register → frontend/pages/userRegister.tpl +
 * components/registrationForm.tpl). Shared — the registration handler,
 * form and templates all live in lib/pkp, so every app renders the same
 * form. App-specific bits (which journal, which reviewer user-group id)
 * are passed in by the caller.
 *
 * Field ids are stable (`#givenName`, `#affiliation`, `#email`, …). The
 * privacy-consent + reviewer-optin controls render conditionally:
 *   - `privacyConsent` only when the in-context journal has a privacy
 *     statement configured (publicknowledge does).
 *   - `reviewerGroup[<id>]` one per reviewer user-group that permits
 *     self-registration (publicknowledge ships `reviewerGroup[16]`).
 *
 * Validation errors surface in the top-of-form `#formErrors` summary
 * (common/formErrors.tpl) — not inline per field — so assert there.
 */
exports.RegistrationPage = class RegistrationPage extends BasePage {
	constructor(page) {
		super(page);
		this.form = page.locator('form#register');
		this.givenName = page.locator('#givenName');
		this.familyName = page.locator('#familyName');
		this.affiliation = page.locator('#affiliation');
		this.country = page.locator('#country');
		this.email = page.locator('#email');
		this.username = page.locator('#username');
		this.password = page.locator('#password');
		this.password2 = page.locator('#password2');
		this.interests = page.locator('#interests');
		this.privacyConsent = page.locator('input[name="privacyConsent"]');
		this.emailConsent = page.locator('input[name="emailConsent"]');
		this.submit = page.locator('form#register button[type="submit"]');
		// Top-of-form validation summary (common/formErrors.tpl).
		this.errorSummary = page.locator('#formErrors');
		this.csrfInput = page.locator('form#register input[name="csrfToken"]');
	}

	/** @param {string} contextPath e.g. 'publicknowledge' */
	async goto(contextPath) {
		await this.page.goto(`/index.php/${contextPath}/user/register`);
	}

	/** The reviewer opt-in checkbox for a given reviewer user-group id. */
	reviewerOptin(groupId) {
		return this.page.locator(`input[name="reviewerGroup[${groupId}]"]`);
	}

	/**
	 * Fill the identity + credential fields. Only fills what is provided,
	 * so callers can omit e.g. affiliation to exercise the off-UI path.
	 *
	 * @param {object} data
	 * @param {string} [data.givenName]
	 * @param {string} [data.familyName]
	 * @param {string} [data.affiliation]
	 * @param {string} [data.country]   ISO alpha-2 (dropdown value)
	 * @param {string} [data.email]
	 * @param {string} [data.username]
	 * @param {string} [data.password]
	 */
	async fill(data) {
		if (data.givenName !== undefined) await this.givenName.fill(data.givenName);
		if (data.familyName !== undefined) await this.familyName.fill(data.familyName);
		if (data.affiliation !== undefined) await this.affiliation.fill(data.affiliation);
		if (data.country !== undefined) await this.country.selectOption(data.country);
		if (data.email !== undefined) await this.email.fill(data.email);
		if (data.username !== undefined) await this.username.fill(data.username);
		if (data.password !== undefined) {
			await this.password.fill(data.password);
			await this.password2.fill(data.password);
		}
	}

	async acceptConsent() {
		await this.privacyConsent.check();
	}

	async submitForm() {
		await this.submit.click();
	}

	/** Read the CSRF token from the rendered form (for off-UI POSTs). */
	async csrfToken() {
		return this.csrfInput.inputValue();
	}
};
