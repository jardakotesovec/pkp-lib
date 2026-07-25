// @ts-check
const {expect} = require('@playwright/test');
const {BasePage} = require('./BasePage.js');
const {setTinyMceContent} = require('../support/tinymce.js');
const {waitForJQueryIdle} = require('../support/jquery.js');

/**
 * POM for the reviewer's submission wizard at
 * /{journal}/{locale}/reviewer/submission/{submissionId}.
 *
 * The page is a server-rendered legacy surface inside the Vue backend
 * shell: a jQueryUI tab strip (#reviewTabs, "1. Request" → "4.
 * Completion") whose panels load the fbv step forms via AJAX
 * (PKPReviewerHandler::step). There are no data-cy hooks — selectors key
 * off the stable form ids (#reviewStep1Form…#reviewStep3Form) and
 * visible button labels. fbvElement ids carry a runtime $FBV_uniqId
 * suffix, so field lookups use `id^=` prefixes (same constraint the
 * Cypress suite had — see lib/pkp/cypress/support/commands.js#625).
 *
 * Shared across OJS/OMP/OPS: the templates live in
 * lib/pkp/templates/reviewer/review/.
 */
exports.ReviewerSubmissionPage = class ReviewerSubmissionPage extends BasePage {
	/** @param {import('@playwright/test').Page} page */
	constructor(page) {
		super(page);
		this.step1Form = page.locator('form#reviewStep1Form');
		this.step2Form = page.locator('form#reviewStep2Form');
		this.step3Form = page.locator('form#reviewStep3Form');
		/** h2 on reviewCompleted.tpl — the canonical completion signal. */
		this.completedHeading = page.getByRole('heading', {
			name: /Review Submitted/i,
		});
		/** jQueryUI tab strip built by reviewStepHeader.tpl. */
		this.tabStrip = page.locator('#reviewTabs');
		/** Files the editor sent for review — tab 1 and again tab 3. */
		this.reviewFilesStep1 = page.locator('#reviewFilesStep1');
		this.reviewFilesStep3 = page.locator('#reviewFilesStep3');
		/** The reviewer's own attachments grid on tab 3. */
		this.attachmentsGrid = page.locator('#reviewAttachmentsGridContainer');
		/** Foot-of-form required-fields box; display:none until a blocked submit. */
		this.messageBox = page.locator('#reviewStep3MessageBox');
		this.recommendationSelect = page.locator('select#reviewerRecommendationId');
		this.submitReviewButton = this.step3Form.getByRole('button', {
			name: /^Submit Review$/i,
		});
		this.saveForLaterButton = this.step3Form.getByRole('button', {
			name: 'Save for Later',
			exact: true,
		});
		/** Tab 1's primary button once the invitation has been accepted. */
		this.saveAndContinueButton = this.step1Form.getByRole('button', {
			name: 'Save and continue',
			exact: true,
		});
		this.continueToStep3Button = this.step2Form.getByRole('button', {
			name: /Continue to Step #3/i,
		});
		/** ReviewerSubmissionPage.vue — rendered only for earlier rounds. */
		this.previousReviewsPanel = page
			.locator('div')
			.filter({has: page.getByRole('heading', {name: 'Previous Reviews'})})
			.last();
	}

	// ---------------------------------------------------------------- tabs

	/**
	 * A tab in the strip, by its visible label ("1. Request",
	 * "2. Guidelines", "3. Download & Review", "4. Completion"). A locked
	 * tab carries `aria-disabled="true"` + `ui-state-disabled` — there is
	 * no `disabled` attribute, so `toBeDisabled()` never fires here.
	 *
	 * @param {string} label
	 */
	tab(label) {
		return this.tabStrip.locator('li.ui-tabs-tab').filter({hasText: label});
	}

	/** @param {string} label */
	async expectTabLocked(label) {
		await expect(this.tab(label)).toHaveAttribute('aria-disabled', 'true', {
			timeout: 15_000,
		});
	}

	/** @param {string} label */
	async expectTabUnlocked(label) {
		await expect(this.tab(label)).not.toHaveAttribute('aria-disabled', 'true', {
			timeout: 15_000,
		});
	}

	/** @param {string} label */
	async expectTabActive(label) {
		await expect(this.tab(label)).toHaveClass(/ui-tabs-active/, {
			timeout: 15_000,
		});
	}

	/**
	 * Click a tab and wait for its panel. Panels are AJAX-loaded by
	 * ReviewerTabHandler, so readiness is the step form (or, for tab 4,
	 * the completion heading).
	 *
	 * @param {1|2|3|4} step
	 */
	async openTab(step) {
		const labels = {
			1: '1. Request',
			2: '2. Guidelines',
			3: '3. Download & Review',
			4: '4. Completion',
		};
		await this.tab(labels[step]).locator('a').click();
		const arrived = {
			1: this.step1Form,
			2: this.step2Form,
			3: this.step3Form,
			4: this.completedHeading,
		}[step];
		await expect(arrived).toBeVisible({timeout: 20_000});
	}

	/**
	 * Force-click a locked tab (jQueryUI marks it `tabindex="-1"` +
	 * `aria-disabled`, so an ordinary click is refused by Playwright's
	 * actionability checks). Used to prove the lock is real: nothing
	 * about the URL or the visible panel may change.
	 *
	 * @param {string} label
	 */
	async forceClickTab(label) {
		await this.tab(label).locator('a').click({force: true});
	}

	// -------------------------------------------------------------- step 1

	/**
	 * A read-only Review Schedule field on tab 1. fbv suffixes the
	 * element id at runtime, so match on the id prefix.
	 *
	 * @param {'dateNotified'|'responseDue'|'dateDue'} field
	 */
	scheduleField(field) {
		return this.step1Form.locator(`input[id^="${field}"]`).first();
	}

	/**
	 * The competing-interests radios (rendered only when the journal has
	 * a competing-interests policy).
	 *
	 * @param {'no'|'has'} which
	 */
	competingInterestsRadio(which) {
		return this.step1Form.locator(
			which === 'no' ? '#noCompetingInterests' : '#hasCompetingInterests',
		);
	}

	/** The container the "I may have…" radio reveals. */
	competingInterestsBox() {
		return this.step1Form.locator('#reviewerCompetingInterestsContainer');
	}

	/**
	 * Type into the competing-interests rich-text box (it is a TinyMCE
	 * editor over a runtime-suffixed textarea).
	 *
	 * @param {string} html
	 */
	async fillCompetingInterests(html) {
		const id = await this.step1Form
			.locator('textarea[id^="reviewerCompetingInterests"]')
			.first()
			.getAttribute('id');
		if (!id) throw new Error('reviewerCompetingInterests textarea not found');
		await setTinyMceContent(this.page, id, html);
	}

	// ------------------------------------------------- the decline modal

	/**
	 * Open the decline modal (tab 1's fbv cancel slot — a plain
	 * `<a class="cancelButton">` wired to a ButtonGenericLinkAction) and
	 * resolve its form plus the live id of its rich-text field.
	 *
	 * @returns {Promise<{form: import('@playwright/test').Locator, textareaId: string}>}
	 */
	async openDeclineForm() {
		await expect(this.step1Form).toBeVisible({timeout: 15_000});
		await this.page
			.getByRole('link', {name: 'Decline Review Request', exact: true})
			.first()
			.click();

		const form = this.page.locator('form#declineReviewForm');
		await expect(form).toBeVisible({timeout: 15_000});
		const textareaId = await form
			.locator('textarea[id^="declineReviewMessage"]')
			.first()
			.getAttribute('id');
		if (!textareaId) {
			throw new Error('declineReviewMessage textarea not found');
		}
		return {form, textareaId};
	}

	/**
	 * Submit an open decline form. saveDeclineReview answers with a JSON
	 * redirect to the journal's reader-facing home page, so the wait is
	 * for the browser to leave /reviewer/submission/.
	 *
	 * @param {import('@playwright/test').Locator} form
	 */
	async submitDeclineForm(form) {
		await Promise.all([
			this.page.waitForURL(
				(url) => !url.pathname.includes('/reviewer/submission'),
				{timeout: 20_000, waitUntil: 'commit'},
			),
			form
				.getByRole('button', {name: 'Decline Review Request', exact: true})
				.click(),
		]);
	}

	// ------------------------------------------------------ step 3 grids

	/**
	 * A legacy-grid row inside one of the two file grids, matched by file
	 * name.
	 *
	 * @param {import('@playwright/test').Locator} grid
	 * @param {string} fileName
	 */
	gridRow(grid, fileName) {
		return grid.locator('tr.gridRow').filter({hasText: fileName}).first();
	}

	/**
	 * Expand a grid row's `a.show_extras` twisty so its Edit / Delete
	 * link actions become visible (they are in the DOM either way).
	 *
	 * @param {string} fileName
	 */
	async expandAttachmentRow(fileName) {
		const row = this.gridRow(this.attachmentsGrid, fileName);
		await expect(row).toBeVisible({timeout: 15_000});
		// Row actions do NOT live inside the row: the grid renders them in
		// a sibling `tr.row_controls` with id `{rowId}-control-row`, hidden
		// until the twisty is clicked. The row keeps its `has_extras`
		// class throughout, so the control row's visibility is the signal.
		const rowId = await row.getAttribute('id');
		const controls = this.page.locator(`#${rowId}-control-row`);
		await row.locator('a.show_extras').click();
		await expect(controls).toBeVisible({timeout: 10_000});
		return {row, controls};
	}

	/**
	 * Rename an attachment through the row's Edit action (the "Edit a
	 * file" AjaxModal hosting the Vue FileMetadataForm).
	 *
	 * @param {string} fileName  current name (row lookup)
	 * @param {string} newName   name to save
	 */
	async renameAttachment(fileName, newName) {
		const {controls} = await this.expandAttachmentRow(fileName);
		await controls.getByRole('link', {name: 'Edit', exact: true}).click();
		const modal = this.page.getByRole('dialog', {name: 'Edit a file'}).first();
		await expect(modal).toBeVisible({timeout: 15_000});
		const nameInput = modal.locator('input[id$="-name-control-en"]').first();
		await expect(nameInput).toBeEnabled({timeout: 15_000});
		await nameInput.fill(newName);
		await modal.getByRole('button', {name: 'Save', exact: true}).click();
		await expect(modal).toBeHidden({timeout: 20_000});
		await expect(this.attachmentsGrid).toContainText(newName, {
			timeout: 20_000,
		});
	}

	// ---------------------------------------------- previous-round panel

	/**
	 * A "Previous Reviews" line for one earlier round. Every line uses
	 * the single "Round {n} Review Submitted on {date}" wording,
	 * whatever actually happened in that round (ledger row A).
	 *
	 * @param {number} round
	 */
	previousReviewLine(round) {
		return this.previousReviewsPanel.getByText(
			new RegExp(`Round ${round} Review Submitted on`),
		);
	}

	/**
	 * Press "Read Round {n} Review" and wait for the round-history side
	 * panel. The side-modal wrapper reports `visibility: hidden` during
	 * the open transition, so readiness anchors on the panel's own
	 * heading.
	 *
	 * @param {number} round
	 * @returns {Promise<import('@playwright/test').Locator>} the side modal
	 */
	async openRoundHistory(round) {
		await this.page
			.getByRole('button', {name: `Read Round ${round} Review`, exact: true})
			.click();
		const modal = this.page.locator('[data-cy="active-modal"]').last();
		// The heading is rendered twice (the side-modal chrome's title and
		// the panel's own h1) — either proves arrival.
		await expect(
			modal
				.getByRole('heading', {
					name: `Round ${round} Review submitted by you for`,
				})
				.first(),
		).toBeVisible({timeout: 20_000});
		return modal;
	}

	/**
	 * @param {number} submissionId
	 * @param {{journalPath?: string, locale?: string}} [opts]
	 */
	async goto(submissionId, {journalPath = 'publicknowledge', locale = 'en'} = {}) {
		await this.page.goto(
			`/index.php/${journalPath}/${locale}/reviewer/submission/${submissionId}`,
		);
	}

	/**
	 * Step 1 → Step 2: tick the privacy consent (rendered only when the
	 * journal has a privacy statement AND the assignment isn't confirmed
	 * yet) and click "Accept Review, Continue to Step #2".
	 */
	async acceptInvitation() {
		await expect(this.step1Form).toBeVisible({timeout: 15_000});
		const consent = this.step1Form.locator('input[name="privacyConsent"]');
		if (await consent.count()) {
			await consent.check();
		}
		// The step forms are AjaxFormHandler-driven: the arrival signal is
		// the next step's form, not a URL change (a one-click entry lands
		// on the query-string form of the workspace URL and never leaves
		// it).
		await this.page
			.getByRole('button', {name: /Accept Review, Continue to Step #2/i})
			.click();
		await expect(this.step2Form).toBeVisible({timeout: 20_000});
	}

	/**
	 * Step 2 → Step 3: acknowledge the guidelines.
	 */
	async continueToStep3() {
		await expect(this.step2Form).toBeVisible({timeout: 15_000});
		await this.page.getByRole('button', {name: /Continue to Step #3/i}).click();
		await expect(this.step3Form).toBeVisible({timeout: 20_000});
	}

	/**
	 * Step 1: open the decline modal ("Decline Review Request" cancel
	 * link action), replace the prefilled regrets email with `messageHtml`
	 * and submit. PKPReviewerHandler::saveDeclineReview then redirects the
	 * browser to the journal index — wait for that navigation.
	 *
	 * @param {string} messageHtml  body of the comment-to-editor email
	 */
	async declineInvitation(messageHtml) {
		const {form, textareaId} = await this.openDeclineForm();
		// The regrets textarea is a rich fbvElement — raw template id
		// `declineReviewMessage` plus the runtime uniqId suffix.
		await setTinyMceContent(this.page, textareaId, messageHtml);
		await this.submitDeclineForm(form);
	}

	/**
	 * Step 3: fill the default review-form comment editors.
	 * Pass only the streams the test needs.
	 *
	 * @param {{toAuthor?: string, toEditor?: string}} comments
	 */
	async fillStep3Comments({toAuthor, toEditor} = {}) {
		await expect(this.step3Form).toBeVisible({timeout: 15_000});
		if (toAuthor !== undefined) {
			const id = await this.step3Form
				.locator('textarea[id^="comments-"]')
				.first()
				.getAttribute('id');
			if (!id) throw new Error('Step 3: comments textarea not found');
			await setTinyMceContent(this.page, id, toAuthor);
		}
		if (toEditor !== undefined) {
			const id = await this.step3Form
				.locator('textarea[id^="commentsPrivate-"]')
				.first()
				.getAttribute('id');
			if (!id) throw new Error('Step 3: commentsPrivate textarea not found');
			await setTinyMceContent(this.page, id, toEditor);
		}
	}

	/**
	 * Step 3: pick a recommendation by its visible label (e.g. "Accept
	 * Submission", "Revisions Required"). The select keeps the stable id
	 * `reviewerRecommendationId`; option labels come from the journal's
	 * seeded ReviewerRecommendation rows.
	 *
	 * @param {string} label
	 */
	async selectRecommendation(label) {
		await this.step3Form
			.locator('select#reviewerRecommendationId')
			.selectOption({label});
	}

	/**
	 * Step 3 with a review form attached (reviewFormResponse.tpl
	 * replaces the free-text comment editors): the response control for
	 * a free-text element. Small text / text field render an input,
	 * textarea elements a plain (non-TinyMCE) textarea — all share the
	 * stable `name="reviewFormResponses[{elementId}]"`.
	 *
	 * @param {number} elementId review_form_elements id (from the
	 *   context scenario's reviewForms[].elementIds)
	 */
	reviewFormTextResponse(elementId) {
		return this.step3Form
			.locator(
				`textarea[name="reviewFormResponses[${elementId}]"], ` +
					`input[name="reviewFormResponses[${elementId}]"]`,
			)
			.first();
	}

	/**
	 * Step 3: pick a multiple-response option (radio buttons /
	 * checkboxes). Option inputs keep the unsuffixed template id
	 * `reviewFormResponses-{elementId}-{optionIndex}` with the option's
	 * 0-based, spec-order index as both id segment and value.
	 *
	 * @param {number} elementId
	 * @param {number} optionIndex
	 */
	async checkReviewFormOption(elementId, optionIndex) {
		await this.step3Form
			.locator(`input#reviewFormResponses-${elementId}-${optionIndex}`)
			.check();
	}

	/**
	 * Step 3: upload a review attachment through the legacy
	 * FileUploadWizardHandler ("Upload File" link action on the
	 * ReviewerReviewAttachmentsGridHandler grid). Review attachments
	 * carry no genre select (SubmissionFilesUploadForm disables it for
	 * SUBMISSION_FILE_REVIEW_ATTACHMENT), so the wizard is: file →
	 * metadata → finish, all behind the same `#continueButton`.
	 *
	 * @param {string} filePath  absolute path of the file to upload
	 * @param {string} fileName  basename, asserted in the grid after upload
	 */
	async uploadAttachment(filePath, fileName) {
		const grid = this.page.locator('#reviewAttachmentsGridContainer');
		await expect(grid).toBeVisible({timeout: 15_000});
		await grid.getByText('Upload File', {exact: true}).first().click();

		// The legacy AjaxModal bridges into the Vue side-modal stack with
		// the link action's title ("Upload File") as the accessible name.
		const wizard = this.page
			.getByRole('dialog', {name: 'Upload File'})
			.first();
		await expect(wizard).toBeVisible({timeout: 15_000});

		// Step 1 — drive the opacity-0 plupload input directly. "Change
		// File" appears once the async upload settles; clicking Continue
		// earlier posts an empty form.
		await wizard.locator('input[type=file]').setInputFiles(filePath);
		await expect(wizard.getByText('Change File')).toBeVisible({
			timeout: 15_000,
		});
		await wizard.locator('button#continueButton').click();

		// Step 2 — metadata (name prefilled from the file name).
		await expect(
			wizard.locator('label[for$="-name-control-en"]'),
		).toBeVisible({timeout: 10_000});
		await wizard.locator('button#continueButton').click();

		// Step 3 — confirmation; same button id, label "Complete".
		await expect(wizard.getByText(/File Added/i)).toBeVisible({
			timeout: 10_000,
		});
		await wizard.locator('button#continueButton').click();
		await expect(wizard).toBeHidden({timeout: 15_000});

		// Grid refreshes with the new row.
		await expect(grid).toContainText(fileName, {timeout: 15_000});
	}

	/**
	 * Step 3: click "Submit Review" and OK the PkpDialog confirm — but
	 * make no assumption about the outcome. Validation-gating tests use
	 * this directly (the wizard stays on step 3 when a required review
	 * form element is empty); `submitReview` layers the happy-path
	 * completion assertion on top.
	 */
	async attemptSubmitReview() {
		const confirmDialog = this.page.locator('[data-cy="dialog"]');
		// A press can be swallowed: LinkActionHandler disables the button
		// for the duration of a confirmation cycle and re-binds on finish,
		// so a press landing in that window registers nothing. Re-click
		// only while no dialog has opened.
		for (let i = 0; i < 3; i++) {
			await this.submitReviewButton.click();
			const appeared = await confirmDialog
				.waitFor({state: 'visible', timeout: 5_000})
				.then(() => true)
				.catch(() => false);
			if (appeared) break;
		}
		await expect(confirmDialog).toBeVisible({timeout: 10_000});
		await expect(confirmDialog).toContainText(
			'Are you sure you want to submit this review?',
		);
		await confirmDialog.getByRole('button', {name: 'OK', exact: true}).click();
		await expect(confirmDialog).toBeHidden({timeout: 10_000});
	}

	/**
	 * Press "Submit Review" and assert the confirmation NEVER opens and
	 * no step save is posted — the shape of the ledger-16 dead button
	 * (two confirmed-then-rejected cycles leave the click handlers
	 * duplicated and the third press inert). The button still looks
	 * usable, so the only observable signals are the absent dialog and
	 * the absent request.
	 *
	 */
	async submitExpectingNoResponse() {
		// Settle first so the assertion cannot be measuring the transient
		// dead window right after a confirmation cycle.
		await waitForJQueryIdle(this.page);
		await expect(this.submitReviewButton).toBeEnabled();
		await this.submitReviewButton.click();
		// Bounded event wait rather than a sleep: the assertion is that
		// neither the confirmation nor a step save ever materialises.
		const sawSave = await this.page
			.waitForRequest((r) => r.url().includes('/reviewer/saveStep/'), {
				timeout: 4_000,
			})
			.then(() => true)
			.catch(() => false);
		expect(sawSave, 'no step save may be posted').toBe(false);
		await expect(this.page.locator('[data-cy="dialog"]')).toHaveCount(0);
		await expect(this.step3Form).toBeVisible();
	}

	/**
	 * Step 3: "Submit Review" → PkpDialog confirm ("Are you sure…") → OK
	 * → "Review Submitted" completion view.
	 */
	async submitReview() {
		await this.attemptSubmitReview();
		await expect(this.completedHeading).toBeVisible({timeout: 15_000});
	}

	/**
	 * Step 3: click "Submit Review" expecting the review to be REFUSED
	 * (a required field is empty — the OJS recommendation, or a required
	 * review-form element). The submit is gated either client-side (the
	 * reviewStep3Required.js / fbv required validator blocks before any
	 * navigation) or server-side (saveStep re-renders step 3 with the
	 * error) — so the confirm dialog is optional. Either way the wizard
	 * must stay on step 3 and never reach the completion view. Asserts
	 * exactly that.
	 */
	async submitAndExpectBlocked() {
		await this.step3Form
			.getByRole('button', {name: /^Submit Review$/i})
			.click();
		const confirmDialog = this.page.locator('[data-cy="dialog"]');
		if (await confirmDialog.isVisible().catch(() => false)) {
			await confirmDialog
				.getByRole('button', {name: 'OK', exact: true})
				.click();
			await expect(confirmDialog).toBeHidden({timeout: 10_000});
		}
		// The review must NOT have completed: still on step 3, no
		// completion view. Give the (possible) server round-trip a beat.
		await expect(this.completedHeading).toBeHidden({timeout: 10_000});
		await expect(this.step3Form).toBeVisible({timeout: 10_000});
	}

	/**
	 * Step 3: "Save for Later". Saves comments/recommendation without
	 * validation and stays on Step 3 (the server answers a
	 * DataChangedEvent, no navigation). Waits on the saveStep response —
	 * toast assertions race under parallel workers.
	 */
	async saveForLater() {
		const saved = this.page.waitForResponse(
			(r) => r.url().includes('/reviewer/saveStep/') && r.status() === 200,
			{timeout: 15_000},
		);
		await this.step3Form
			.getByRole('button', {name: 'Save for Later', exact: true})
			.click();
		await saved;
	}
};
