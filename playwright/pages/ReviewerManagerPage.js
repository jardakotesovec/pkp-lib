// @ts-check
const {expect} = require('@playwright/test');
const {BasePage} = require('./BasePage.js');

/**
 * POM for the Reviewer Manager panel on the per-submission editorial
 * workflow page (`[data-cy="reviewer-manager"]`, Review stage) and the
 * legacy reviewer-grid side-modals its actions open:
 *
 *   - Add Reviewer (advancedSearchReviewerForm + SelectReviewerListPanel)
 *   - Create New Reviewer (createReviewerForm, reached from Add Reviewer)
 *   - Edit Review (editReviewForm)
 *   - Unassign / Cancel Reviewer (unassignReviewerForm — same op, the
 *     submit label flips on dateConfirmed)
 *   - Reinstate Reviewer (reinstateReviewerForm — offered only for
 *     cancelled assignments)
 *   - Resend Review Request (resendRequestReviewerForm — offered only
 *     for declined assignments)
 *   - Review Reminder (sendReminderForm — primary row action when the
 *     response/review is overdue)
 *
 * The Vue side lives at lib/ui-library/src/managers/ReviewerManager/*;
 * every action proxies into the legacy
 * grid.users.reviewer.ReviewerGridHandler via openLegacyModal, so the
 * modals are server-rendered fbv forms (runtime-suffixed ids, jQuery
 * datepickers, TinyMCE personal-message bodies).
 *
 * Shared across OJS/OMP/OPS — the reviewer manager ships from pkp-lib.
 */
exports.ReviewerManagerPage = class ReviewerManagerPage extends BasePage {
	/** @param {import('@playwright/test').Page} page */
	constructor(page) {
		super(page);
		this.manager = page.locator('[data-cy="reviewer-manager"]');
	}

	/**
	 * Open the editorial workflow page for a submission and wait for the
	 * reviewer manager to mount (the submission must be in a review
	 * stage, otherwise the panel never renders).
	 *
	 * @param {number} submissionId
	 * @param {{journalPath?: string, locale?: string}} [opts]
	 */
	async gotoWorkflow(submissionId, {journalPath = 'publicknowledge', locale = 'en'} = {}) {
		await this.page.goto(
			`/index.php/${journalPath}/${locale}/dashboard/editorial?workflowSubmissionId=${submissionId}`,
		);
		await expect(this.manager).toBeVisible({timeout: 20_000});
	}

	/**
	 * Open the AUTHOR's read-mostly review-stage view for their own
	 * submission (dashboard/mySubmissions) and wait for the redacted
	 * reviewer manager to mount. The panel only renders when the round
	 * carries at least one open + completed review (rule 5 of
	 * review-anonymity); callers that expect it absent should assert on
	 * the modal instead.
	 *
	 * @param {number} submissionId
	 * @param {{journalPath?: string, locale?: string}} [opts]
	 */
	async gotoAuthorWorkflow(submissionId, {journalPath = 'publicknowledge', locale = 'en'} = {}) {
		await this.page.goto(
			`/index.php/${journalPath}/${locale}/dashboard/mySubmissions?workflowSubmissionId=${submissionId}`,
			{waitUntil: 'commit'},
		);
		await expect(this.manager).toBeVisible({timeout: 20_000});
	}

	/**
	 * The reviewer manager table row for a reviewer, matched by the
	 * reviewer's full name.
	 *
	 * @param {string} reviewerFullName
	 */
	row(reviewerFullName) {
		return this.manager.locator('tr').filter({hasText: reviewerFullName}).first();
	}

	/**
	 * Click "Add Reviewer" on the panel and wait for the side-modal.
	 * The whole workflow page is itself a reka-ui dialog, so scope by
	 * the unique accessible name.
	 *
	 * @returns {Promise<import('@playwright/test').Locator>} the modal
	 */
	async openAddReviewerModal() {
		await this.manager
			.getByRole('button', {name: 'Add Reviewer', exact: true})
			.click();
		const modal = this.page.getByRole('dialog', {
			name: 'Add Reviewer',
			exact: true,
		});
		await expect(modal).toBeVisible({timeout: 15_000});
		return modal;
	}

	/**
	 * The SelectReviewerListPanel inside the Add Reviewer modal. The
	 * suggestions panel (when present) reuses the same class, so bind to
	 * the last instance — the candidate list always renders below it.
	 *
	 * @param {import('@playwright/test').Locator} modal
	 */
	selectPanel(modal) {
		return modal.locator('.listPanel--selectReviewer').last();
	}

	/**
	 * Type a phrase into the select-reviewer panel's search. The Search
	 * component reacts to (debounced) keyup only — fill() never fires
	 * the filter — so clear via fill('') and commit via typing.
	 *
	 * @param {import('@playwright/test').Locator} modal
	 * @param {string} phrase  single whitespace-free token (searchPhrase OR-joins on spaces)
	 */
	async searchSelectPanel(modal, phrase) {
		const search = this.selectPanel(modal).locator('.pkpSearch__input');
		await expect(search).toBeVisible({timeout: 15_000});
		await search.fill('');
		await search.pressSequentially(phrase);
	}

	/**
	 * Pick a candidate via the per-item "Select {name}" button
	 * (screen-reader name from common.selectWithName) and wait for the
	 * assignment form to morph in. Stacked modal opens accumulate DOM
	 * copies of the legacy ids — bind to the last instance.
	 *
	 * @param {import('@playwright/test').Locator} modal
	 * @param {string} fullName e.g. 'Paul Hudson'
	 * @returns {Promise<import('@playwright/test').Locator>} the
	 *   #advancedSearchReviewerForm assignment form
	 */
	async selectReviewer(modal, fullName) {
		await modal
			.getByRole('button', {name: `Select ${fullName}`, exact: true})
			.first()
			.click();
		const regularForm = modal.locator('#regularReviewerForm').last();
		await expect(regularForm).toBeVisible({timeout: 15_000});
		await expect(regularForm.locator('#selectedReviewerName')).toContainText(
			fullName,
		);
		return regularForm.locator('#advancedSearchReviewerForm');
	}

	/**
	 * Pick a last-round reviewer via the per-item "Reassign {name}"
	 * button (sr name from reviewer.list.reassign.withName; pinned on
	 * round ≥ 2 for reviewers who completed a review in the previous
	 * round) and wait for the assignment form. The
	 * AdvancedReviewerSearchHandler swaps the personal message to the
	 * REVIEW_REQUEST_SUBSEQUENT body for these reviewers.
	 *
	 * @param {import('@playwright/test').Locator} modal
	 * @param {string} fullName e.g. 'Paul Hudson'
	 * @returns {Promise<import('@playwright/test').Locator>} the
	 *   #advancedSearchReviewerForm assignment form
	 */
	async reassignReviewer(modal, fullName) {
		await modal
			.getByRole('button', {name: `Reassign ${fullName}`, exact: true})
			.first()
			.click();
		const regularForm = modal.locator('#regularReviewerForm').last();
		await expect(regularForm).toBeVisible({timeout: 15_000});
		await expect(regularForm.locator('#selectedReviewerName')).toContainText(
			fullName,
		);
		return regularForm.locator('#advancedSearchReviewerForm');
	}

	/**
	 * Open the Read Review modal from a row's primary "Read Review"
	 * action (offered on submitted/viewed rows in the editorial view and
	 * on completed open reviews in the author-redacted view). The
	 * legacy readReview modal's accessible name is "Review: {submission
	 * title}", so the dialog lookup anchors on the prefix. Resolves the
	 * #readReviewForm (editor variant; the author variant has no form —
	 * pass {expectForm: false}).
	 *
	 * @param {string} reviewerFullName
	 * @param {{expectForm?: boolean}} [opts]
	 * @returns {Promise<{modal: import('@playwright/test').Locator, form: import('@playwright/test').Locator|null}>}
	 */
	async openReadReview(reviewerFullName, {expectForm = true} = {}) {
		await this.row(reviewerFullName)
			.getByRole('button', {name: 'Read Review', exact: true})
			.click();
		const modal = this.page.getByRole('dialog', {name: /^Review:/});
		await expect(modal).toBeVisible({timeout: 15_000});
		if (!expectForm) {
			return {modal, form: null};
		}
		const form = await this.legacyForm(modal, 'readReviewForm');
		return {modal, form};
	}

	/**
	 * From the Add Reviewer modal, switch to the Create New Reviewer
	 * form (link action rendered in the search panel's button row).
	 *
	 * @param {import('@playwright/test').Locator} modal
	 * @returns {Promise<import('@playwright/test').Locator>} the
	 *   #createReviewerForm
	 */
	async openCreateReviewerForm(modal) {
		await modal
			.getByRole('link', {name: 'Create New Reviewer', exact: true})
			.last()
			.click();
		const createForm = modal.locator('#createReviewerForm').last();
		await expect(createForm).toBeVisible({timeout: 20_000});
		return createForm;
	}

	/**
	 * Drive a legacy jQuery-UI datepicker pair to a target date. The fbv
	 * datepicker wraps each date in two inputs: a visible display input
	 * and a hidden `name="..."` alt-field carrying the canonical
	 * yyyy-mm-dd value the form posts. fill() on the visible input never
	 * propagates to the alt-field, so drive `$.datepicker('setDate')` —
	 * the only writer that keeps the alt-field, the display input and
	 * the form's validation hooks in sync. Hide the picker afterwards:
	 * the legacy form binds focus → show, and the open dropdown blocks
	 * the submit button.
	 *
	 * @param {import('@playwright/test').Locator} form  scope holding the field
	 * @param {string} fieldName  'responseDueDate' | 'reviewDueDate'
	 * @param {string} isoDate    target date as yyyy-mm-dd
	 */
	async setDatepickerDate(form, fieldName, isoDate) {
		const altField = form.locator(`input[name="${fieldName}"]`).last();
		await altField.evaluate((el, nextDate) => {
			const visibleId = el.id.replace(/-altField$/, '');
			const visible = document.getElementById(visibleId);
			if (!visible) {
				throw new Error(`datepicker visible input ${visibleId} not found`);
			}
			// @ts-ignore - jQuery is a page global on legacy forms
			const $ = window.jQuery || window.$;
			$(visible).datepicker('setDate', nextDate);
			$(visible).trigger('change');
			$(visible).datepicker('hide');
			visible.blur();
		}, isoDate);
		await expect(altField).toHaveValue(isoDate);
	}

	/**
	 * The legacy reviewer forms pre-fill responseDueDate/reviewDueDate
	 * from numWeeksPerResponse/numWeeksPerReview — both 4 on the
	 * bootstrap journal, so the pair collides and the form's
	 * GREATER_OR_EQUAL date validator can flip the submit off mid-edit.
	 * Push the review due date one day past the response due date when
	 * they collide, mirroring what an editor does in the UI.
	 *
	 * @param {import('@playwright/test').Locator} form
	 */
	async ensureDueDatesOrdered(form) {
		const responseDueHidden = form.locator('input[name="responseDueDate"]').last();
		const reviewDueHidden = form.locator('input[name="reviewDueDate"]').last();
		await expect(responseDueHidden).not.toHaveValue('');
		await expect(reviewDueHidden).not.toHaveValue('');
		const responseDueValue = await responseDueHidden.inputValue();
		const reviewDueValue = await reviewDueHidden.inputValue();
		if (reviewDueValue <= responseDueValue) {
			const bumped = new Date(responseDueValue);
			bumped.setUTCDate(bumped.getUTCDate() + 1);
			await this.setDatepickerDate(
				form,
				'reviewDueDate',
				bumped.toISOString().slice(0, 10),
			);
		}
	}

	/**
	 * Open a More-Actions menu entry on a reviewer's row and wait for
	 * the resulting legacy side-modal. Menu items are headlessui
	 * role=menuitem entries portaled outside the row — scope the item
	 * lookup to the page.
	 *
	 * @param {string} reviewerFullName
	 * @param {string} menuItemName  e.g. 'Unassign Reviewer'
	 * @param {string} modalTitle    accessible dialog name, e.g. 'Unassign Reviewer'
	 * @returns {Promise<import('@playwright/test').Locator>} the modal
	 */
	async openRowAction(reviewerFullName, menuItemName, modalTitle) {
		await this.row(reviewerFullName)
			.getByRole('button', {name: 'More Actions'})
			.click();
		await this.page
			.getByRole('menuitem', {name: menuItemName, exact: true})
			.click();
		return this.actionModal(modalTitle);
	}

	/**
	 * Click a primary (inline) row action — e.g. "Send Reminder" on an
	 * overdue assignment — and wait for the resulting modal.
	 *
	 * @param {string} reviewerFullName
	 * @param {string} actionLabel  e.g. 'Send Reminder'
	 * @param {string} modalTitle   accessible dialog name, e.g. 'Review Reminder'
	 * @returns {Promise<import('@playwright/test').Locator>} the modal
	 */
	async clickRowPrimaryAction(reviewerFullName, actionLabel, modalTitle) {
		await this.row(reviewerFullName)
			.getByRole('button', {name: actionLabel, exact: true})
			.click();
		return this.actionModal(modalTitle);
	}

	/**
	 * The ReviewMethodIcons label inside a reviewer's row. The icons are
	 * aria-hidden SVGs; the human-readable method name renders as an
	 * sr-only span ("Open" / "Anonymous Reviewer/Disclosed Author" /
	 * "Anonymous Reviewer/Anonymous Author" — see
	 * ReviewMethodIcons.vue + editor.submissionReview.* locale keys), so
	 * an exact text lookup scoped to the row is the stable hook.
	 *
	 * Works on both the editor view and the author-redacted view — the
	 * Type column renders in both (useReviewerManagerConfig#getColumns).
	 *
	 * @param {string} reviewerFullName
	 * @param {string} label  exact method label
	 */
	reviewTypeLabel(reviewerFullName, label) {
		return this.row(reviewerFullName).getByText(label, {exact: true});
	}

	/**
	 * Open the Edit Review modal for a reviewer's row (More Actions →
	 * Edit) and resolve its legacy #editReviewForm. The form carries the
	 * due-date datepicker pair (visible input + hidden Y-m-d altField,
	 * BOTH named responseDueDate/reviewDueDate — use .last() for the
	 * canonical altField), the reviewMethod radio trio (values 1
	 * anonymous / 2 double-anonymous / 3 open) and the review-files
	 * grid. Submit label is the fbvFormButtons default "OK".
	 *
	 * @param {string} reviewerFullName
	 * @returns {Promise<{modal: import('@playwright/test').Locator, form: import('@playwright/test').Locator}>}
	 */
	async openEditReviewModal(reviewerFullName) {
		const modal = await this.openRowAction(
			reviewerFullName,
			'Edit',
			'Edit Review',
		);
		const form = await this.legacyForm(modal, 'editReviewForm');
		return {modal, form};
	}

	/**
	 * The reviewMethod radio inside the Edit Review form. fbv suffixes
	 * element ids at runtime, so address the input by name + value.
	 *
	 * @param {import('@playwright/test').Locator} form  the #editReviewForm
	 * @param {number} methodId  ReviewAssignment::SUBMISSION_REVIEW_METHOD_* (1|2|3)
	 */
	reviewMethodRadio(form, methodId) {
		return form.locator(`input[name="reviewMethod"][value="${methodId}"]`);
	}

	/**
	 * Open the Review Details modal for a reviewer's row (More Actions →
	 * Review Details). Unlike openRowAction, the resulting legacy
	 * readReview modal's accessible name embeds the submission title
	 * ("Review Details: {title}"), so the dialog lookup is anchored on
	 * the prefix instead of an exact match.
	 *
	 * @param {string} reviewerFullName
	 * @returns {Promise<import('@playwright/test').Locator>} the modal
	 */
	async openReviewDetails(reviewerFullName) {
		await this.row(reviewerFullName)
			.getByRole('button', {name: 'More Actions'})
			.click();
		await this.page
			.getByRole('menuitem', {name: 'Review Details', exact: true})
			.click();
		const modal = this.page.getByRole('dialog', {name: /^Review Details/});
		await expect(modal).toBeVisible({timeout: 15_000});
		return modal;
	}

	/**
	 * Resolve a reviewer-action side-modal by its accessible name. The
	 * side-modal wrapper can report `visibility: hidden` during the
	 * open transition, so callers should anchor readiness on an inner
	 * form (see `legacyForm`).
	 *
	 * @param {string} title
	 */
	async actionModal(title) {
		const modal = this.page.getByRole('dialog', {name: title, exact: true});
		await expect(modal).toBeVisible({timeout: 15_000});
		return modal;
	}

	/**
	 * Locate a legacy fbv form inside an action modal and wait for it.
	 *
	 * @param {import('@playwright/test').Locator} modal
	 * @param {string} formId  e.g. 'unassignReviewerForm'
	 */
	async legacyForm(modal, formId) {
		const form = modal.locator(`#${formId}`).last();
		await expect(form).toBeVisible({timeout: 15_000});
		return form;
	}

	/**
	 * Wait for a legacy rich-text (TinyMCE) field inside a form to be
	 * initialized AND carry a marker string (the test's unique tag,
	 * substituted into the precompiled email body via
	 * {$submissionTitle}). Submitting before TinyMCE settles can post an
	 * empty body. fbv suffixes the textarea id at runtime, so look the
	 * live id up by prefix.
	 *
	 * @param {import('@playwright/test').Locator} form
	 * @param {string} idPrefix  e.g. 'personalMessage' or 'message'
	 * @param {string} marker    substring the editor content must contain
	 * @param {{timeout?: number}} [opts]
	 */
	async awaitRichTextContains(form, idPrefix, marker, {timeout = 20_000} = {}) {
		const textareaId = await form
			.locator(`textarea[id^="${idPrefix}"]`)
			.first()
			.getAttribute('id');
		if (!textareaId) {
			throw new Error(`No textarea with id prefix '${idPrefix}' found`);
		}
		await this.page.waitForFunction(
			({id, text}) => {
				// @ts-ignore - tinymce is a page global on legacy forms
				const editor = window.tinymce?.get(id);
				return Boolean(editor?.initialized) && editor.getContent().includes(text);
			},
			{id: textareaId, text: marker},
			{timeout},
		);
	}

	/**
	 * Submit a legacy form via its named submit button and wait for the
	 * hosting modal to close (AjaxFormHandler closes it on success — a
	 * still-open modal means server-side validation failed).
	 *
	 * @param {import('@playwright/test').Locator} form
	 * @param {string} buttonName  e.g. 'Unassign Reviewer'
	 * @param {import('@playwright/test').Locator} modal
	 */
	async submitLegacyForm(form, buttonName, modal) {
		const submitButton = form.getByRole('button', {
			name: buttonName,
			exact: true,
		});
		await expect(submitButton).toBeEnabled({timeout: 10_000});
		await submitButton.click();
		await expect(modal).toBeHidden({timeout: 20_000});
	}

	/**
	 * Fetch the submission's reviewAssignments via the REST API using
	 * the page's session cookies — the DB-side round-trip closing the
	 * loop on what the panel shows.
	 *
	 * @param {number} submissionId
	 * @param {string} [journalPath='publicknowledge']
	 * @returns {Promise<object[]>}
	 */
	async fetchReviewAssignments(submissionId, journalPath = 'publicknowledge') {
		const res = await this.page.request.get(
			`/index.php/${journalPath}/api/v1/submissions/${submissionId}`,
		);
		if (!res.ok()) {
			throw new Error(
				`GET submission ${submissionId} failed: ${res.status()} ${await res.text()}`,
			);
		}
		const submission = await res.json();
		return submission.reviewAssignments || [];
	}
};
