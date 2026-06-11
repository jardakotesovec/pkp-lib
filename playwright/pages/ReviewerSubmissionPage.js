// @ts-check
const {expect} = require('@playwright/test');
const {BasePage} = require('./BasePage.js');
const {setTinyMceContent} = require('../support/tinymce.js');

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
		await Promise.all([
			this.page.waitForURL(/\/reviewer\/submission\//, {timeout: 15_000}),
			this.page
				.getByRole('button', {name: /Accept Review, Continue to Step #2/i})
				.click(),
		]);
		await expect(this.step2Form).toBeVisible({timeout: 15_000});
	}

	/**
	 * Step 2 → Step 3: acknowledge the guidelines.
	 */
	async continueToStep3() {
		await expect(this.step2Form).toBeVisible({timeout: 15_000});
		await Promise.all([
			this.page.waitForURL(/\/reviewer\/submission\//, {timeout: 15_000}),
			this.page.getByRole('button', {name: /Continue to Step #3/i}).click(),
		]);
		await expect(this.step3Form).toBeVisible({timeout: 15_000});
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
		await expect(this.step1Form).toBeVisible({timeout: 15_000});
		// The decline control is the fbv cancel slot: a plain
		// `<a href="#" class="cancelButton">Decline Review Request</a>`
		// wired to a ButtonGenericLinkAction that opens the regrets modal.
		await this.page
			.getByRole('link', {name: 'Decline Review Request', exact: true})
			.first()
			.click();

		const declineForm = this.page.locator('form#declineReviewForm');
		await expect(declineForm).toBeVisible({timeout: 15_000});

		// The regrets textarea is a rich fbvElement — raw template id
		// `declineReviewMessage` plus the runtime uniqId suffix.
		const textareaId = await declineForm
			.locator('textarea[id^="declineReviewMessage"]')
			.first()
			.getAttribute('id');
		if (!textareaId) {
			throw new Error('declineReviewMessage textarea not found');
		}
		await setTinyMceContent(this.page, textareaId, messageHtml);

		await Promise.all([
			// saveDeclineReview answers with a JSON redirect to the
			// journal index — i.e. away from /reviewer/submission/.
			this.page.waitForURL((url) => !url.pathname.includes('/reviewer/submission'), {
				timeout: 20_000,
				waitUntil: 'commit',
			}),
			declineForm
				.getByRole('button', {name: 'Decline Review Request', exact: true})
				.click(),
		]);
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
	 * Step 3: "Submit Review" → PkpDialog confirm ("Are you sure…") → OK
	 * → "Review Submitted" completion view.
	 */
	async submitReview() {
		await this.step3Form
			.getByRole('button', {name: /^Submit Review$/i})
			.click();
		const confirmDialog = this.page.locator('[data-cy="dialog"]');
		await expect(confirmDialog).toBeVisible({timeout: 10_000});
		await confirmDialog.getByRole('button', {name: 'OK', exact: true}).click();
		await expect(this.completedHeading).toBeVisible({timeout: 15_000});
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
