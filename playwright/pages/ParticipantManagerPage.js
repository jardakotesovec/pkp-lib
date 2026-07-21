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
 *  - More Actions → Notify opens the legacy `#notifyForm`
 *    (form/notify.tpl) inside a reka-ui dialog titled "Notify": a
 *    "Start Discussion" section, the same template select, a REQUIRED
 *    TinyMCE Message, and a single submit button labeled "Notify"
 *    (hideCancel=true).
 *  - More Actions → Remove / Login As open PkpDialog confirmations
 *    (`[data-cy="dialog"]`) handled in the Vue layer.
 *
 * DOM realities (live-probed 2026-07-21, stage-participants probes A–D):
 *  - The legacy form's cancel is an ANCHOR `a.cancelButton`, not a
 *    role=button; the reka-ui dialog close button and Escape are
 *    trapped while the legacy form is mounted — always leave via
 *    submit or cancelAssignmentForm().
 *  - The row menu trigger is `aria-label="<Full Name> More Actions"`
 *    (capital A). Escape does NOT close the open menu — toggle-click
 *    the trigger (closeMoreActions()).
 *  - Toasts render into `.app__notifications` and auto-expire after
 *    ~5 s — assert a toast IMMEDIATELY after the triggering action.
 *
 * Shared across OJS/OMP/OPS — the panel and the grid handler live in
 * pkp-lib and behave identically in all three apps.
 */
exports.ParticipantManagerPage = class ParticipantManagerPage extends BasePage {
	/** Removal-confirm warning body (editor.submission.removeStageParticipant.description). */
	static get REMOVE_WARNING() {
		return 'You are about to remove this participant from all stages.';
	}

	/** Edit form's nothing-changeable text (stageParticipants.noOptionsToHandle). */
	static get NO_CHANGES_MESSAGE() {
		return 'No changes can be made to this participant';
	}

	/** Row note for a recommend-only assignment (participantManager.onlyAllowedToRecommend). */
	static get RECOMMEND_ONLY_NOTE() {
		return 'Only allowed to recommend an editorial decision';
	}

	/** Toast after a new assignment (notification.addedStageParticipant). */
	static get ADDED_TOAST() {
		return 'User added as a stage participant.';
	}

	/** Toast after a privilege edit (notification.editStageParticipant). */
	static get EDITED_TOAST() {
		return 'The stage assignment has been changed.';
	}

	/** Toast after Notify / assign-with-message (notification.sentNotification). */
	static get NOTIFY_TOAST() {
		return 'Notification sent to users.';
	}

	/**
	 * Copyediting stage-status texts (per-assigned-editor notice rows,
	 * ledger 9: keyed on a stage DISCUSSION existing, not assignments).
	 * Rendered in the workflow shell's primary column, visible only to
	 * editors assigned on the stage.
	 */
	static get ASSIGN_COPYEDITOR_PROMPT() {
		return 'Assign a copyeditor using the Assign link in the Participants list.';
	}

	static get AWAITING_COPYEDITS() {
		return 'Awaiting copyedits.';
	}

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
			ParticipantManagerPage.RECOMMEND_ONLY_NOTE,
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
	 * Close an OPEN more-actions menu by toggle-clicking its trigger.
	 * (Escape does not close this Headless-UI menu — probe A.)
	 *
	 * @param {string} fullName
	 */
	async closeMoreActions(fullName) {
		await this.panel
			.getByRole('button', {name: `${fullName} More Actions`, exact: true})
			.click();
		await expect(this.page.getByRole('menuitem')).toHaveCount(0);
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
	 * Assert the EXACT ordered action set of a participant's menu, then
	 * close it again. The affordance matrix (probe A item 3) is the
	 * core of scenarios s4/s5/s8 — e.g. an Assistant sees ['Notify'],
	 * a recommend-only SE sees ['Notify', 'Remove'] on other SE rows.
	 *
	 * @param {string} fullName
	 * @param {string[]} labels expected menuitem labels, in DOM order
	 */
	async expectMenuActions(fullName, labels) {
		await this.openMoreActions(fullName);
		await expect(this.page.getByRole('menuitem')).toHaveText(labels);
		await this.closeMoreActions(fullName);
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
	 * In the (open) assign form: pick a role in the picker's user-group
	 * filter dropdown. Only roles whose groups work the current stage
	 * are offered (reviewer roles never are).
	 *
	 * @param {import('@playwright/test').Locator} form
	 * @param {string} userGroup visible group label, e.g. 'Copyeditor'
	 */
	async filterPickerByGroup(form, userGroup) {
		await form
			.locator('select[name="filterUserGroupId"]')
			.selectOption({label: userGroup});
	}

	/**
	 * In the (open) assign form: run a name search in the user picker.
	 *
	 * @param {import('@playwright/test').Locator} form
	 * @param {string} nameSearch
	 */
	async searchPicker(form, nameSearch) {
		await form.locator('input[name="name"]').fill(nameSearch);
		await form.getByRole('button', {name: 'Search', exact: true}).click();
	}

	/**
	 * A user row in the picker grid (the legacy UserSelectGridHandler
	 * table embedded in the assign form).
	 *
	 * @param {import('@playwright/test').Locator} modal
	 * @param {string} fullName
	 */
	pickerRow(modal, fullName) {
		return modal.locator('tr', {hasText: fullName}).first();
	}

	/**
	 * The picker grid's empty placeholder ("No Items", grid.noItems) —
	 * what an excluded (already-assigned) person's name search yields
	 * on EVERY stage panel (probe C item 6, scenario s6).
	 *
	 * @param {import('@playwright/test').Locator} modal
	 */
	pickerNoItems(modal) {
		return modal
			.locator('#userSelectGridContainer')
			.getByText('No Items', {exact: true});
	}

	/**
	 * In the (open) assign form: filter by user group, search by name,
	 * and check the radio of the matching user row.
	 *
	 * @param {{modal: import('@playwright/test').Locator, form: import('@playwright/test').Locator}} ctx
	 * @param {{userGroup: string, nameSearch: string, fullName: string}} opts
	 */
	async selectUser({modal, form}, {userGroup, nameSearch, fullName}) {
		await this.filterPickerByGroup(form, userGroup);
		await this.searchPicker(form, nameSearch);
		const row = this.pickerRow(modal, fullName);
		await expect(row).toBeVisible({timeout: 15_000});
		await row.locator('input[name="userId"]').check();
	}

	/**
	 * The "Assignment privileges" recommend-only checkbox
	 * (name=recommendOnly). In add mode it renders whenever the chosen
	 * role is an editor role — for ANY administering user, including a
	 * recommend-only SE (ledger 75); in edit mode only when the acting
	 * user may change it (isChangeRecommendOnlyAllowed).
	 *
	 * @param {import('@playwright/test').Locator} form
	 */
	recommendOnlyCheckbox(form) {
		return form.locator('input[name="recommendOnly"]');
	}

	/**
	 * The "Permissions" metadata-edit checkbox (name=canChangeMetadata).
	 *
	 * @param {import('@playwright/test').Locator} form
	 */
	metadataCheckbox(form) {
		return form.locator('input[name="canChangeMetadata"]');
	}

	/**
	 * Set the recommend-only privilege box in the (open) assign/edit form.
	 *
	 * @param {import('@playwright/test').Locator} form
	 * @param {boolean} [on]
	 */
	async setRecommendOnly(form, on = true) {
		await this.recommendOnlyCheckbox(form).setChecked(on);
	}

	/**
	 * The edit form's nothing-changeable text ("No changes can be made
	 * to this participant") — shown e.g. on one's own Section-Editor
	 * row, where Edit is still offered (probe B item 13, scenario s5).
	 *
	 * @param {import('@playwright/test').Locator} form
	 */
	noChangesMessage(form) {
		return form.getByText(ParticipantManagerPage.NO_CHANGES_MESSAGE);
	}

	/**
	 * Dismiss the assign/edit form WITHOUT saving. The legacy form's
	 * cancel is an anchor `a.cancelButton` (NOT role=button), and the
	 * reka-ui dialog's own close button and Escape are trapped while
	 * the legacy form is mounted — this is the only clean exit besides
	 * submitting.
	 *
	 * @param {{modal: import('@playwright/test').Locator, form: import('@playwright/test').Locator}} ctx
	 */
	async cancelAssignmentForm({modal, form}) {
		await form.locator('a.cancelButton').click();
		await expect(modal).toBeHidden({timeout: 15_000});
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
		// Sync the editor into its textarea NOW: the legacy submit's own
		// triggerSave can race the just-applied template body, posting an
		// empty message (fatal where Message is required — notify form).
		await this.page.evaluate((id) => window.tinymce.get(id).save(), textareaId);
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
	 * Blank the assign form's notify message (TinyMCE) so the save
	 * assigns SILENTLY — no discussion, no email, and the stage-status
	 * prompt does not flip (ledger 9, scenario s2).
	 *
	 * @param {import('@playwright/test').Locator} form
	 */
	async clearNotifyMessage(form) {
		await this.setNotifyMessage(form, '');
	}

	/**
	 * Submit the assign/edit form (fbvFormButtons default "OK") and wait
	 * for the dialog to close. Pass `toast` (ADDED_TOAST / EDITED_TOAST)
	 * to assert the confirmation from click-time: toasts auto-expire
	 * after ~5 s and can stack duplicates, so waiting for the modal to
	 * hide first is a race — observe the toast concurrently instead.
	 *
	 * @param {import('@playwright/test').Locator} modal
	 * @param {{toast?: string}} [opts]
	 */
	async submitAssignmentForm(modal, {toast} = {}) {
		await modal.getByRole('button', {name: 'OK', exact: true}).click();
		if (toast) {
			await expect(this.toast(toast).first()).toBeVisible({timeout: 20_000});
		}
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
	 * Open the Notify dialog for a participant (more-actions → Notify).
	 * Dialog titled "Notify", legacy `#notifyForm` inside: the "Start
	 * Discussion" section ("Begin a discussion between yourself and …"),
	 * the template select, a REQUIRED Message, submit button "Notify"
	 * (no cancel — hideCancel=true).
	 *
	 * @param {string} fullName
	 * @returns {Promise<{modal: import('@playwright/test').Locator, form: import('@playwright/test').Locator}>}
	 */
	async openNotifyForm(fullName) {
		await this.clickMenuItem(fullName, 'Notify');
		const modal = this.page.getByRole('dialog', {name: 'Notify', exact: true});
		await expect(modal).toBeVisible({timeout: 15_000});
		const form = modal.locator('#notifyForm').last();
		await expect(form).toBeVisible({timeout: 15_000});
		return {modal, form};
	}

	/**
	 * Submit the (open) Notify dialog via its "Notify" button and wait
	 * for it to close. Pass `toast: NOTIFY_TOAST` to assert the
	 * "Notification sent to users." confirmation from click-time (same
	 * expiry/duplicate race as submitAssignmentForm).
	 *
	 * @param {import('@playwright/test').Locator} modal
	 * @param {{toast?: string}} [opts]
	 */
	async submitNotifyForm(modal, {toast} = {}) {
		await modal.getByRole('button', {name: 'Notify', exact: true}).click();
		if (toast) {
			await expect(this.toast(toast).first()).toBeVisible({timeout: 20_000});
		}
		await expect(modal).toBeHidden({timeout: 20_000});
	}

	/**
	 * Full Notify flow: open the dialog, optionally pick a predefined
	 * template (the same select#template + fetchTemplateBody flow as
	 * the assign form), optionally replace the message, send.
	 *
	 * @param {string} fullName
	 * @param {{template?: string, message?: string, toast?: string}} [opts]
	 */
	async notifyParticipant(fullName, {template, message, toast} = {}) {
		const {modal, form} = await this.openNotifyForm(fullName);
		if (template) {
			await this.selectNotifyTemplate(form, template);
		}
		if (message) {
			await this.setNotifyMessage(form, message);
		}
		await this.submitNotifyForm(modal, {toast});
	}

	/**
	 * Open the Remove confirmation (more-actions → Remove) and return
	 * the dialog WITHOUT confirming — for asserting the exact warning
	 * ("Remove Participant" + REMOVE_WARNING, scenario s7) before OK,
	 * or cancelling.
	 *
	 * @param {string} fullName
	 * @returns {Promise<import('@playwright/test').Locator>}
	 */
	async openRemoveDialog(fullName) {
		await this.clickMenuItem(fullName, 'Remove');
		const confirm = this.page.locator('[data-cy="dialog"]').filter({
			hasText: 'Remove Participant',
		});
		await expect(confirm).toBeVisible({timeout: 10_000});
		return confirm;
	}

	/**
	 * Remove a participant via more-actions → Remove → confirm. Waits
	 * for the row to leave the list.
	 *
	 * @param {string} fullName
	 */
	async removeParticipant(fullName) {
		const confirm = await this.openRemoveDialog(fullName);
		await confirm.getByRole('button', {name: /^OK$/i}).click();
		await expect(this.participantRow(fullName)).toHaveCount(0, {
			timeout: 15_000,
		});
	}

	/**
	 * A toast in the global notification stack (`.app__notifications`).
	 * Toasts auto-expire after ~5 s — await this IMMEDIATELY after the
	 * triggering action (use the ADDED_TOAST / EDITED_TOAST /
	 * NOTIFY_TOAST statics for the exact texts).
	 *
	 * @param {string} text
	 */
	toast(text) {
		return this.page.locator('.app__notifications').getByText(text);
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
