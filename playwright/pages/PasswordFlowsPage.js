// @ts-check
const {BasePage} = require('./BasePage.js');

/**
 * Shared POM for the LoginHandler password flows (lib/pkp):
 *   - the lost-password request form   (frontend/pages/userLostPassword.tpl)
 *   - the emailed reset-password form  (user/userPasswordReset.tpl)
 *   - the login change-password form   (user/loginChangePassword.tpl)
 *
 * All three are served by the shared `LoginHandler` + `ResetPasswordForm` +
 * `LoginChangePasswordForm` in lib/pkp, so this POM lives here and is reusable
 * by OMP/OPS.
 *
 * Locator note — the reset/change password inputs use `name=` selectors, NOT
 * `#id`. Those forms render their inputs through `fbvElement`, which
 * runtime-suffixes the id with `$FBV_uniqId` (e.g. `id="password-6a4a0be60c1db"`),
 * so `#password` never matches. The `name` attribute is stable (patterns.md
 * pitfall #8). The hidden `username`/`hash` fields keep their literal id, but
 * we scope everything through the form for safety.
 */
exports.PasswordFlowsPage = class PasswordFlowsPage extends BasePage {
	/** @param {import('@playwright/test').Page} page */
	constructor(page) {
		super(page);

		// ── Lost-password (forgot) form — a plain frontend POST form. ──
		this.lostPasswordForm = page.locator('form#lostPasswordForm');
		this.lostPasswordEmail = this.lostPasswordForm.locator('input#email');
		this.lostPasswordSubmit = this.lostPasswordForm.locator('button[type="submit"]');

		// ── Reset-password (new-password) form — reached via the email link. ──
		this.resetForm = page.locator('form#updateResetPassword');
		this.resetNewPassword = this.resetForm.locator('input[name="password"]');
		this.resetRepeatPassword = this.resetForm.locator('input[name="password2"]');
		this.resetSubmit = this.resetForm.locator('button[type="submit"]');

		// ── Change-password form — forced-change screen + standalone. ──
		this.changeForm = page.locator('form#loginChangePassword');
		this.changeUsername = this.changeForm.locator('input[name="username"]');
		this.changeOldPassword = this.changeForm.locator('input[name="oldPassword"]');
		this.changeNewPassword = this.changeForm.locator('input[name="password"]');
		this.changeRepeatPassword = this.changeForm.locator('input[name="password2"]');
		this.changeSubmit = this.changeForm.locator('button[type="submit"]');

		// ── Server-rendered validation errors (common/formErrors.tpl). ──
		this.formErrors = page.locator('#formErrors');
	}

	// ── Navigation ────────────────────────────────────────────────────────

	async gotoLostPassword(journal) {
		await this.page.goto(`/index.php/${journal}/login/lostPassword`);
	}

	/** GET the change-password screen; with `username` it pre-fills the field. */
	async gotoChangePassword(journal, username) {
		const suffix = username ? `/${encodeURIComponent(username)}` : '';
		await this.page.goto(`/index.php/${journal}/login/changePassword${suffix}`);
	}

	// ── Actions ───────────────────────────────────────────────────────────

	/** Open Reset Password, type an email, and submit the request. */
	async requestReset(journal, email) {
		await this.gotoLostPassword(journal);
		await this.lostPasswordEmail.fill(email);
		await this.lostPasswordSubmit.click();
	}

	/** Fill + submit the new-password (reset) form. */
	async submitNewPassword(password, repeat = password) {
		await this.resetNewPassword.fill(password);
		await this.resetRepeatPassword.fill(repeat);
		await this.resetSubmit.click();
	}

	/** Fill + submit the change-password form. `username` is optional (the
	 *  forced screen pre-fills it; the standalone form needs it typed). */
	async submitChange({username, oldPassword, newPassword, repeat}) {
		if (username !== undefined) {
			await this.changeUsername.fill(username);
		}
		await this.changeOldPassword.fill(oldPassword);
		await this.changeNewPassword.fill(newPassword);
		await this.changeRepeatPassword.fill(repeat ?? newPassword);
		await this.changeSubmit.click();
	}

	/**
	 * Pull the password-reset URL out of an email body (Text and/or HTML). The
	 * PASSWORD_RESET_CONFIRM template emits the link as a RAW string, not an
	 * `<a>` anchor, so `pkpMail.extractLink` does not apply. Returns the
	 * pathname + query only, so callers navigate it relative to their own
	 * worker's baseURL — the confirm HMAC is host-independent, so this
	 * sidesteps any base_url / per-worker-port skew.
	 *
	 * @param {string} bodyText
	 * @returns {string} pathname + search, e.g.
	 *   `/index.php/j/login/resetPassword/bob?confirm=<64hex>%3A<ts>`
	 */
	static extractResetPath(bodyText) {
		const decoded = String(bodyText).replace(/&amp;/g, '&');
		const match = decoded.match(
			/https?:\/\/[^\s"'<>]*\/login\/resetPassword\/[^\s"'<>]+/i,
		);
		if (!match) {
			throw new Error('No password-reset URL found in the email body');
		}
		const url = new URL(match[0]);
		return url.pathname + url.search;
	}
};
