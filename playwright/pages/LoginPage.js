// @ts-check
const {BasePage} = require('./BasePage.js');

/**
 * POM for /login. Shared — every app has the same login form.
 * Used by:
 *   - bootstrap's "saves auth storage states" step (see support/auth.js)
 *   - any ad-hoc login spec (rarely; most specs use storageState instead)
 */
exports.LoginPage = class LoginPage extends BasePage {
	constructor(page) {
		super(page);
		// Match the selectors the Cypress suite has used for years
		// (lib/pkp/cypress/support/commands.js:login). Labels vary by
		// locale; the input/form ids are stable.
		this.username = page.locator('input#username');
		this.password = page.locator('input#password');
		this.signIn = page.locator('form#login button');
		// "Keep me logged in" — issues the Laravel `remember_web_*` cookie
		// when submitted ticked. NB the template renders it with a stray
		// `checked="$remember"` attribute (never interpolated), so the box
		// is *checked by default* in the browser (see registration-login
		// spec's remember-me test).
		this.remember = page.locator('input#remember');
		// Server-rendered failure message (LoginHandler::signIn re-renders
		// frontend/pages/userLogin.tpl with `error` set; en string:
		// "Invalid username/email or password. Please try again.").
		this.error = page.locator('form#login .pkp_form_error');
		// Hidden round-trip field. Validation::redirectLogin() appends the
		// originally-requested REQUEST_URI as ?source=...; the login form
		// carries it through the POST so LoginHandler::signIn can
		// redirectUrl() back to the protected page after authentication.
		this.sourceField = page.locator('form#login input[name="source"]');
	}

	/**
	 * OJS maintains per-context sessions; baseline users with journal-scoped
	 * roles (editor, reviewer, copyeditor, …) must sign in inside that
	 * journal's login to receive a session that works for its workflow
	 * pages. 'index' is the site-level login — correct for admin and for
	 * users doing cross-context work.
	 *
	 * @param {string} [contextPath='index']
	 */
	async goto(contextPath = 'index') {
		await this.page.goto(`/index.php/${contextPath}/en/login`);
	}

	/**
	 * @param {string} username
	 * @param {string} password
	 * @param {string} [contextPath='index']
	 */
	async login(username, password, contextPath = 'index') {
		await this.goto(contextPath);
		await this.username.fill(username);
		await this.password.fill(password);
		await this.signIn.click();
	}

	/**
	 * Fill and submit credentials on an ALREADY-RENDERED login form,
	 * without navigating first. Use when the test arrived at /login via
	 * an app redirect (e.g. an anonymous hit on a protected URL that
	 * appended ?source=...) and the form's hidden state — most notably
	 * the `source` round-trip field — must be preserved. `login()` would
	 * re-goto() the bare login URL and drop it.
	 *
	 * @param {string} username
	 * @param {string} password
	 */
	async submitCredentials(username, password) {
		await this.username.fill(username);
		await this.password.fill(password);
		await this.signIn.click();
	}
};
