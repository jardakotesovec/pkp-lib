// @ts-check
const {expect} = require('@playwright/test');
const {BasePage} = require('./BasePage.js');
const {setTinyMceContent} = require('../support/tinymce.js');

/**
 * POM for the Participants panel (`[data-cy="participant-manager"]`,
 * lib/ui-library/src/managers/ParticipantManager/) rendered on every
 * editorial workflow stage, plus the legacy PHP forms it opens:
 *
 *  - Assign → StageParticipantGridHandler::addParticipant renders the
 *    fbv `#addParticipantForm` inside a reka-ui dialog titled
 *    "Assign Participant" (editor.submission.addStageParticipant). The
 *    form carries the user-group filter + name-search user grid, the
 *    recommendOnly / canChangeMetadata checkboxes, and the notify
 *    section (template select + TinyMCE message).
 *  - More Actions → Edit reuses the same op with `assignmentId`; the
 *    dialog is titled "Edit Assignment"
 *    (editor.submission.editStageParticipant) and renders only the
 *    flag checkboxes (no user grid, no notify section).
 *  - More Actions → Remove / Login As open PkpDialog confirmations
 *    (`[data-cy="dialog"]`) handled in the Vue layer.
 *
 * Shared across OJS/OMP/OPS — the panel and the grid handler live in
 * pkp-lib and behave identically in all three apps.
 */
exports.ParticipantManagerPage = class ParticipantManagerPage extends BasePage {
	/** @param {import('@playwright/test').Page} page */
	constructor(page) {
		super(page);

		this.panel = page.locator('[data-cy="participant-manager"]');
		this.assignButton = this.panel.getByRole('button', {
			name: 'Assign',
			exact: true,
		});
		// Rendered inside the panel only while the current session is an
		// impersonated one (participantManagerStore.isUserLoggedInAs);
		// label is user.logOutAs = "Logout as {fullName-of-current-user}".
		this.logoutAsButton = this.panel.getByRole('button', {
			name: /^Logout as /,
		});
	}

	/**
	 * Navigate to the workflow view of a submission. The Participants
	 * panel renders inside the workflow side-modal for the submission's
	 * current stage.
	 *
	 * @param {number} submissionId
	 * @param {{journalPath?: string, locale?: string, dashboardPage?: 'editorial'|'mySubmissions'}} [opts]
	 */
	async gotoWorkflow(
		submissionId,
		{journalPath = 'publicknowledge', locale = 'en', dashboardPage = 'editorial'} = {},
	) {
		await this.page.goto(
			`/index.php/${journalPath}/${locale}/dashboard/${dashboardPage}?workflowSubmissionId=${submissionId}`,
		);
	}

	async expectVisible() {
		await expect(this.panel).toBeVisible({timeout: 15_000});
	}

	/**
	 * The list row (li) for a participant, matched by display name.
	 *
	 * @param {string} fullName e.g. 'Maria Fritz'
	 */
	participantRow(fullName) {
		return this.panel.locator('li').filter({hasText: fullName});
	}

	/**
	 * The role label element inside a participant's row
	 * (ParticipantManagerItemInfoRole renders the user-group name).
	 *
	 * @param {string} fullName
	 * @param {string} roleName e.g. 'Copyeditor', 'Author'
	 */
	roleLabel(fullName, roleName) {
		return this.participantRow(fullName).getByText(roleName, {exact: true});
	}

	/**
	 * The recommend-only indicator inside a participant's row
	 * (ParticipantManagerItemInfoRecommendOnly →
	 * participantManager.onlyAllowedToRecommend: "Only allowed to
	 * recommend an editorial decision").
	 *
	 * @param {string} fullName
	 */
	recommendOnlyIndicator(fullName) {
		return this.participantRow(fullName).getByText(
			'Only allowed to recommend an editorial decision',
		);
	}

	/**
	 * Open the per-participant DropdownActions menu. The trigger's
	 * accessible name is "<fullName> More Actions" (ParticipantManager.vue
	 * :label prop); items portal to the document root as role=menuitem.
	 *
	 * @param {string} fullName
	 */
	async openMoreActions(fullName) {
		await this.panel
			.getByRole('button', {name: `${fullName} More Actions`, exact: true})
			.click();
	}

	/**
	 * A menu item in the (already open) more-actions dropdown. Scoped to
	 * page because the menu portals outside the panel subtree.
	 *
	 * @param {string} label e.g. 'Edit', 'Remove', 'Login As', 'Notify'
	 */
	menuItem(label) {
		return this.page.getByRole('menuitem', {name: label, exact: true});
	}

	/**
	 * Open the menu for a participant and click one of its items.
	 *
	 * @param {string} fullName
	 * @param {string} label
	 */
	async clickMenuItem(fullName, label) {
		await this.openMoreActions(fullName);
		await this.menuItem(label).click();
	}

	/**
	 * Click Assign and wait for the legacy add-participant form. Returns
	 * the dialog + form locators for follow-up steps.
	 *
	 * @returns {Promise<{modal: import('@playwright/test').Locator, form: import('@playwright/test').Locator}>}
	 */
	async openAssignForm() {
		await this.expectVisible();
		await this.assignButton.click();
		const modal = this.page.getByRole('dialog', {
			name: 'Assign Participant',
			exact: true,
		});
		await expect(modal).toBeVisible({timeout: 15_000});
		const form = modal.locator('#addParticipantForm').last();
		await expect(form).toBeVisible({timeout: 15_000});
		return {modal, form};
	}

	/**
	 * Open the Edit Assignment form for an existing participant via the
	 * more-actions menu. Same `#addParticipantForm`, edit shape (current
	 * user + flag checkboxes only).
	 *
	 * @param {string} fullName
	 * @returns {Promise<{modal: import('@playwright/test').Locator, form: import('@playwright/test').Locator}>}
	 */
	async openEditAssignmentForm(fullName) {
		await this.clickMenuItem(fullName, 'Edit');
		const modal = this.page.getByRole('dialog', {
			name: 'Edit Assignment',
			exact: true,
		});
		await expect(modal).toBeVisible({timeout: 15_000});
		const form = modal.locator('#addParticipantForm').last();
		await expect(form).toBeVisible({timeout: 15_000});
		return {modal, form};
	}

	/**
	 * In the (open) assign form: filter by user group, search by name,
	 * and check the radio of the matching user row.
	 *
	 * @param {{modal: import('@playwright/test').Locator, form: import('@playwright/test').Locator}} ctx
	 * @param {{userGroup: string, nameSearch: string, fullName: string}} opts
	 */
	async selectUser({modal, form}, {userGroup, nameSearch, fullName}) {
		await form
			.locator('select[name="filterUserGroupId"]')
			.selectOption({label: userGroup});
		await form.locator('input[name="name"]').fill(nameSearch);
		await form.getByRole('button', {name: 'Search', exact: true}).click();
		const row = modal.locator('tr', {hasText: fullName}).first();
		await expect(row).toBeVisible({timeout: 15_000});
		await row.locator('input[name="userId"]').check();
	}

	/**
	 * In the (open) assign form: pick an email template in the notify
	 * section. The select's change handler POSTs fetchTemplateBody and
	 * replaces the TinyMCE message with the template body — wait for
	 * both so a follow-up setNotifyMessage isn't overwritten by the
	 * late-arriving template content.
	 *
	 * @param {import('@playwright/test').Locator} form
	 * @param {string} templateLabel e.g. 'Request Copyedit'
	 */
	async selectNotifyTemplate(form, templateLabel) {
		const templateLoaded = this.page.waitForResponse(
			(r) => r.url().includes('fetch-template-body') && r.ok(),
			{timeout: 15_000},
		);
		await form.locator('select#template').selectOption({label: templateLabel});
		await templateLoaded;
		// The response callback applies the body asynchronously — observe
		// the editor content actually arriving before touching it.
		const textareaId = await form
			.locator('textarea[name="message"]')
			.getAttribute('id');
		await this.page.waitForFunction(
			(id) => {
				const editor = window.tinymce?.get(id);
				return Boolean(editor?.initialized) && editor.getContent().trim().length > 0;
			},
			textareaId,
			{timeout: 15_000},
		);
	}

	/**
	 * Replace the notify message body (TinyMCE). The fbv textarea id is
	 * runtime-suffixed, so resolve it from the stable name attribute.
	 *
	 * @param {import('@playwright/test').Locator} form
	 * @param {string} html
	 */
	async setNotifyMessage(form, html) {
		const textareaId = await form
			.locator('textarea[name="message"]')
			.getAttribute('id');
		if (!textareaId) {
			throw new Error('notify message textarea has no id');
		}
		await setTinyMceContent(this.page, textareaId, html);
	}

	/**
	 * Submit the assign/edit form (fbvFormButtons default "OK") and wait
	 * for the dialog to close.
	 *
	 * @param {import('@playwright/test').Locator} modal
	 */
	async submitAssignmentForm(modal) {
		await modal.getByRole('button', {name: 'OK', exact: true}).click();
		await expect(modal).toBeHidden({timeout: 20_000});
	}

	/**
	 * Full add-participant flow: Assign → filter + search + pick user
	 * (→ optional notify template/message) → OK → row appears.
	 *
	 * @param {object} opts
	 * @param {string} opts.userGroup   visible group label, e.g. 'Copyeditor'
	 * @param {string} opts.nameSearch  name fragment, e.g. 'Vogt'
	 * @param {string} opts.fullName    expected display name, e.g. 'Sarah Vogt'
	 * @param {{template?: string, message?: string}} [opts.notify]
	 *        notify section inputs; omit to assign silently
	 */
	async assignParticipant({userGroup, nameSearch, fullName, notify}) {
		const {modal, form} = await this.openAssignForm();
		await this.selectUser({modal, form}, {userGroup, nameSearch, fullName});
		if (notify?.template) {
			await this.selectNotifyTemplate(form, notify.template);
		}
		if (notify?.message) {
			await this.setNotifyMessage(form, notify.message);
		}
		await this.submitAssignmentForm(modal);
		await expect(this.participantRow(fullName)).toBeVisible({timeout: 15_000});
	}

	/**
	 * Remove a participant via more-actions → Remove → confirm. Waits
	 * for the row to leave the list.
	 *
	 * @param {string} fullName
	 */
	async removeParticipant(fullName) {
		await this.clickMenuItem(fullName, 'Remove');
		const confirm = this.page.locator('[data-cy="dialog"]').filter({
			hasText: 'Remove Participant',
		});
		await expect(confirm).toBeVisible({timeout: 10_000});
		await confirm.getByRole('button', {name: /^OK$/i}).click();
		await expect(this.participantRow(fullName)).toHaveCount(0, {
			timeout: 15_000,
		});
	}

	/**
	 * Impersonate a participant via more-actions → Login As → confirm.
	 * The OK action redirects through login/signInAsUser to the workflow
	 * dashboard URL appropriate for the participant's role; wait for the
	 * new document to report the impersonated session.
	 *
	 * @param {string} fullName
	 */
	async loginAsParticipant(fullName) {
		await this.clickMenuItem(fullName, 'Login As');
		const confirm = this.page.locator('[data-cy="dialog"]').filter({
			hasText: 'Log in as this user?',
		});
		await expect(confirm).toBeVisible({timeout: 10_000});
		await confirm.getByRole('button', {name: /^OK$/i}).click();
		await this.waitForImpersonation(true);
	}

	/**
	 * End impersonation via the panel's "Logout as …" button and wait
	 * for the restored (non-impersonated) session document.
	 */
	async logoutAsParticipant() {
		await this.logoutAsButton.click();
		await this.waitForImpersonation(false);
	}

	/**
	 * Wait until the page (surviving the redirect navigations of
	 * signInAsUser/signOutAsUser) reports the given impersonation state
	 * via the server-injected pkp.currentUser.
	 *
	 * @param {boolean} expected
	 */
	async waitForImpersonation(expected) {
		await this.page.waitForFunction(
			(flag) =>
				Boolean(window.pkp?.currentUser) &&
				Boolean(window.pkp.currentUser.isUserLoggedInAs) === flag,
			expected,
			{timeout: 20_000},
		);
	}

	/**
	 * The server-injected identity snapshot for the current document
	 * (username, fullName, isUserLoggedInAs, loggedInAsUser, …).
	 *
	 * @returns {Promise<object|null>}
	 */
	async currentUser() {
		return this.page.evaluate(() => window.pkp?.currentUser ?? null);
	}
};
