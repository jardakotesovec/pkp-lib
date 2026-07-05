// @ts-check
const {expect} = require('@playwright/test');
const {BasePage} = require('./BasePage.js');
const {waitForJQueryIdle} = require('../support/jquery.js');
const {setTinyMceContent, getTinyMceContent} = require('../support/tinymce.js');

/**
 * Tab registry for /user/profile (lib/pkp/templates/user/profile.tpl).
 *
 * Keys are the `<li><a name="...">` anchors the legacy
 * `$.pkp.controllers.TabHandler` matches against `location.hash`
 * (lib/pkp/js/controllers/TabHandler.js:47-61 reads the page anchor at
 * init; 75-89 re-selects on hashchange). Values carry:
 *   - form:   the stable `id` of the form each tab AJAX-loads
 *   - saveOp: the ProfileTabHandler save op, in the uncamelized form
 *             the component router puts in the URL
 *             (PKPString::uncamelize — note `saveAPIProfile` becomes
 *             `save-a-p-i-profile`, each capital its own word).
 */
const TABS = {
	identity: {form: '#identityForm', saveOp: 'save-identity'},
	contact: {form: '#contactForm', saveOp: 'save-contact'},
	roles: {form: '#rolesForm', saveOp: 'save-roles'},
	publicProfile: {form: '#publicProfileForm', saveOp: 'save-public-profile'},
	changePassword: {form: '#changePasswordForm', saveOp: 'save-password'},
	notificationSettings: {
		form: '#notificationSettingsForm',
		saveOp: 'save-notification-settings',
	},
	apiSettings: {form: '#apiProfileForm', saveOp: 'save-a-p-i-profile'},
};

/**
 * POM for the user profile tabset at /index.php/<context>/user/profile.
 *
 * The page is legacy-stack: a Smarty-rendered jQuery-UI tabset
 * (`#profileTabs`) whose panels AJAX-load FBV forms driven by
 * `AjaxFormHandler`. Saves POST to component-router URLs
 * (`$$$call$$$/tab/user/profile-tab/<save-op>`) and re-render the form
 * in place, so persistence must always be re-asserted after a reload.
 */
exports.UserProfilePage = class UserProfilePage extends BasePage {
	/**
	 * @param {import('@playwright/test').Page} page
	 * @param {string} contextPath journal urlPath the profile is opened in
	 */
	constructor(page, contextPath) {
		super(page);
		this.contextPath = contextPath;
		this.heading = page.getByRole('heading', {name: 'Profile', exact: true});
	}

	/**
	 * Full-load navigation to the profile page. With a tab anchor the
	 * TabHandler pre-selects that tab at init, so the right form loads
	 * without an extra click. Waits for the tab's form to be visible.
	 *
	 * @param {keyof typeof TABS} [tab='identity']
	 */
	async goto(tab = 'identity') {
		await this.page.goto(
			`/index.php/${this.contextPath}/user/profile#${tab}`,
		);
		await expect(this.heading).toBeVisible({timeout: 15_000});
		await expect(this.form(tab)).toBeVisible({timeout: 15_000});
	}

	/**
	 * Reload the current profile URL (hash included) and wait for the
	 * anchored tab's form to re-render — the canonical
	 * "survives reload" step.
	 *
	 * @param {keyof typeof TABS} tab the tab the current URL is anchored on
	 */
	async reload(tab) {
		await this.page.reload();
		await expect(this.heading).toBeVisible({timeout: 15_000});
		await expect(this.form(tab)).toBeVisible({timeout: 15_000});
	}

	/**
	 * The tab's form locator (`#identityForm`, `#contactForm`, ...).
	 *
	 * @param {keyof typeof TABS} tab
	 */
	form(tab) {
		return this.page.locator(TABS[tab].form);
	}

	/**
	 * Click the form's Save button (fbvFormButtons renders it as
	 * `button.submitFormButton`) and wait until BOTH the save POST has
	 * returned OK and jQuery's AJAX counter has drained — the
	 * AjaxFormHandler chains a form re-render plus a notification fetch
	 * after the POST, and asserting before they settle races the
	 * replaceWith (see patterns.md "Wait on jQuery to settle").
	 *
	 * @param {keyof typeof TABS} tab
	 */
	async save(tab) {
		const responsePromise = this.page.waitForResponse(
			(r) =>
				r.url().includes(`/profile-tab/${TABS[tab].saveOp}`) &&
				r.request().method() === 'POST',
			{timeout: 20_000},
		);
		await this.form(tab)
			.locator('button.submitFormButton')
			.click();
		const response = await responsePromise;
		expect(
			response.ok(),
			`save ${tab}: POST ${TABS[tab].saveOp} returned ${response.status()}`,
		).toBeTruthy();
		await waitForJQueryIdle(this.page);
	}

	/**
	 * Set the content of a rich (TinyMCE) FBV textarea, addressed by its
	 * stable `name` attribute. FBV textarea ids are uniqid-suffixed at
	 * render time (templates/form/textarea.tpl line 82), so the editor
	 * id must be read from the live DOM before calling the tinymce
	 * helper.
	 *
	 * @param {keyof typeof TABS} tab
	 * @param {string} name e.g. 'signature[en]' or 'mailingAddress'
	 * @param {string} html
	 */
	async setRichField(tab, name, html) {
		const textarea = this.form(tab).locator(`textarea[name="${name}"]`);
		await expect(textarea).toBeAttached({timeout: 15_000});
		const id = await textarea.getAttribute('id');
		if (!id) {
			throw new Error(`setRichField: textarea[name="${name}"] has no id`);
		}
		await setTinyMceContent(this.page, id, html);
	}

	/**
	 * Read back a rich (TinyMCE) FBV textarea's content by `name` —
	 * mirror of setRichField for post-reload persistence assertions.
	 * Server-rendered values live in the editor, not the textarea value
	 * (patterns.md wave-2 lesson), hence getTinyMceContent.
	 *
	 * @param {keyof typeof TABS} tab
	 * @param {string} name
	 * @returns {Promise<string>} editor HTML
	 */
	async getRichField(tab, name) {
		const textarea = this.form(tab).locator(`textarea[name="${name}"]`);
		await expect(textarea).toBeAttached({timeout: 15_000});
		const id = await textarea.getAttribute('id');
		if (!id) {
			throw new Error(`getRichField: textarea[name="${name}"] has no id`);
		}
		return getTinyMceContent(this.page, id);
	}

	/**
	 * A form field addressed by its `name` attribute, scoped to the tab's
	 * form. Multilingual fbv text fields render as `name="affiliation[en]"`
	 * (see templates/form/textInput.tpl), single-valued ones as plain
	 * `name="phone"`; both are stable (unlike the uniqid-suffixed ids).
	 *
	 * @param {keyof typeof TABS} tab
	 * @param {string} name e.g. 'preferredPublicName[en]', 'phone', 'country'
	 */
	field(tab, name) {
		return this.form(tab).locator(`[name="${name}"]`);
	}

	/** Fill a plain text / tel / email / textarea field by `name`. */
	async fillField(tab, name, value) {
		await this.field(tab, name).fill(value);
	}

	/** Select an `<option>` by value in a `<select>` field by `name`. */
	async selectField(tab, name, value) {
		await this.field(tab, name).selectOption(value);
	}

	/** The tab's Save button (fbvFormButtons → `button.submitFormButton`). */
	saveButton(tab) {
		return this.form(tab).locator('button.submitFormButton');
	}

	/**
	 * Click Save WITHOUT awaiting the save POST. Use when client-side
	 * validation is expected to BLOCK submission (e.g. an invalid Homepage
	 * URL — the FBV url validator fails in the browser and no POST fires, so
	 * `save()`'s `waitForResponse` would hang). The caller then asserts the
	 * inline `label.error`.
	 *
	 * @param {keyof typeof TABS} tab
	 */
	async clickSaveExpectingClientError(tab) {
		await this.saveButton(tab).click();
	}

	// ── Roles tab ───────────────────────────────────────────────────────

	/**
	 * The CURRENT-context self-registration checkbox for a role group.
	 * `assignRoleContent` renders the request context's reader/author/
	 * reviewer groups FIRST (userGroups.tpl), ahead of the collapsed
	 * "other contexts" extras, so `.first()` is the in-context box.
	 *
	 * @param {'reader'|'author'|'reviewer'} role
	 */
	roleCheckbox(role) {
		return this.form('roles').locator(`input[name^="${role}Group["]`).first();
	}

	/**
	 * Add a reviewing-interest tag via the tag-it widget and commit it with
	 * Enter (the tagit "new" input carries no `name` until committed;
	 * interestsInput.tpl posts the committed tags as `interests[]`).
	 *
	 * @param {string} text
	 */
	async addInterest(text) {
		const input = this.page.locator('#interests .tagit-new input');
		await input.click();
		await input.fill(text);
		await input.press('Enter');
	}

	/** The reviewing-interests widget (committed tags carry `.tagit-choice`). */
	interestsWidget() {
		return this.page.locator('#interests');
	}

	// ── Public profile tab ──────────────────────────────────────────────

	/**
	 * Upload a profile image through the plupload file input and wait for
	 * the dedicated upload op (uncamelized `upload-profile-image`) to
	 * return. The FileUploadFormHandler then re-renders the form in place
	 * with the stored image + a Delete button — note this re-render CLEARS
	 * any unsaved text fields (biography / URL), so upload separately from
	 * text saves.
	 *
	 * @param {string} filePath absolute path to a ≤150×150 image
	 */
	async uploadProfileImage(filePath) {
		const responsePromise = this.page.waitForResponse(
			(r) => r.url().includes('/profile-tab/upload-profile-image'),
			{timeout: 20_000},
		);
		await this.form('publicProfile')
			.locator('input[type="file"]')
			.setInputFiles(filePath);
		const response = await responsePromise;
		expect(
			response.ok(),
			`profile image upload returned ${response.status()}`,
		).toBeTruthy();
		await waitForJQueryIdle(this.page);
	}

	/** The rendered profile-image `<img>` (present once an image is stored). */
	profileImage() {
		return this.form('publicProfile').locator('img');
	}

	/**
	 * The readonly API-key display input on the API Key tab. fbvElement
	 * derives `name` from `id` ("apiKey") and names are NOT uniqid
	 * suffixed, so the name selector is stable.
	 */
	apiKeyField() {
		return this.form('apiSettings').locator('input[name="apiKey"]');
	}

	/**
	 * Click the API Key tab's single action button ("Create API Key" or
	 * "Delete" depending on state — APIProfileForm::fetch swaps label
	 * and action) and wait for the save round-trip + form re-render.
	 *
	 * The Delete flavour guards itself with a NATIVE `confirm()` dialog
	 * (templates/user/apiProfileForm.tpl onClick) — callers exercising
	 * Delete must register a page 'dialog' handler BEFORE calling this.
	 *
	 * @param {string|RegExp} label
	 */
	async submitApiKeyAction(label) {
		const responsePromise = this.page.waitForResponse(
			(r) =>
				r.url().includes('/profile-tab/save-a-p-i-profile') &&
				r.request().method() === 'POST',
			{timeout: 20_000},
		);
		await this.form('apiSettings')
			.getByRole('button', {name: label, exact: true})
			.click();
		const response = await responsePromise;
		expect(
			response.ok(),
			`API key action "${label}" returned ${response.status()}`,
		).toBeTruthy();
		await waitForJQueryIdle(this.page);
	}
};
