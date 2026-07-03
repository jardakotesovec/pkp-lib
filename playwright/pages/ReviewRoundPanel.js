// @ts-check
const {expect} = require('@playwright/test');
const {BasePage} = require('./BasePage.js');
const {FileStagePanel} = require('./FileStagePanel.js');

/**
 * POM for the review-round panel on the External Review stage — the
 * per-round surface owned by `review-rounds-and-revisions`. Wraps the
 * shared Vue managers (WorkflowSubmissionStatus, the WORKFLOW_REVIEW_REVISIONS
 * FileManager, AuthorResponseRequestManager / AuthorResponseManager) plus the
 * two legacy/compose flows those managers open:
 *
 *  - the author's **Upload revisions** action button
 *    (workflowConfigAuthorOJS getActionItems → FileUploadWizardHandler,
 *    modal title "Upload Review File") — reuses FileStagePanel#driveUploadWizard;
 *  - the editor's **Request Response** button (AuthorResponseRequestManager),
 *    which navigates to the standalone compose page
 *    (`reviewResponse/requestAuthorResponse` → RequestReviewRoundAuthorResponse.vue);
 *  - the author's **Submit Response** button (AuthorResponseManager), which
 *    opens the AuthorResponseFormModal (rich-text response + on-behalf-of authors).
 *
 * Shared across OJS/OMP/OPS — every referenced Vue component lives in
 * lib/ui-library. The editor/author dashboard URLs are parameterised by
 * `journalPath` (default `publicknowledge`).
 */
exports.ReviewRoundPanel = class ReviewRoundPanel extends BasePage {
	/**
	 * @param {import('@playwright/test').Page} page
	 * @param {{journalPath?: string}} [opts]
	 */
	constructor(page, {journalPath = 'publicknowledge'} = {}) {
		super(page);
		this.journalPath = journalPath;
	}

	/**
	 * Open the editor's workflow view for a submission (dashboard/editorial).
	 *
	 * @param {number} submissionId
	 */
	async gotoEditor(submissionId) {
		await this.page.goto(
			`/index.php/${this.journalPath}/en/dashboard/editorial?workflowSubmissionId=${submissionId}`,
			{waitUntil: 'commit'},
		);
	}

	/**
	 * Open the author's read-mostly tracking view for their own submission
	 * (dashboard/mySubmissions). The panel opens on the current round.
	 *
	 * @param {number} submissionId
	 */
	async gotoAuthor(submissionId) {
		await this.page.goto(
			`/index.php/${this.journalPath}/en/dashboard/mySubmissions?workflowSubmissionId=${submissionId}`,
			{waitUntil: 'commit'},
		);
	}

	/** The workflow dialog the round panel renders inside. */
	modal() {
		return this.page.locator('[data-cy="active-modal"]').first();
	}

	/**
	 * The round Status card heading ("Round N Status", from
	 * notification.type.roundStatusTitle). Scoped to the workflow modal.
	 *
	 * @param {number} [round=1]
	 */
	statusHeading(round = 1) {
		return this.modal().getByRole('heading', {name: `Round ${round} Status`});
	}

	/**
	 * Wait for the round Status card, then assert its body contains the
	 * given label (the localized ReviewRound::getStatusKey string).
	 *
	 * @param {number} round
	 * @param {string|RegExp} label
	 */
	async expectRoundStatus(round, label) {
		await expect(this.statusHeading(round)).toBeVisible({timeout: 20_000});
		await expect(this.modal().getByText(label)).toBeVisible({timeout: 20_000});
	}

	/**
	 * Select a review round from the left workflow menu. The item is
	 * labelled "Review Round {n}"; when another stage is active the Review
	 * parent may be collapsed, so expand it first.
	 *
	 * @param {number} round
	 */
	async openRound(round) {
		const nav = this.modal().locator('nav').first();
		const item = nav.getByText(`Review Round ${round}`, {exact: true});
		if (!(await item.isVisible().catch(() => false))) {
			await nav.getByText('Review', {exact: true}).first().click();
		}
		await expect(item).toBeVisible({timeout: 15_000});
		await item.click();
	}

	/**
	 * Drive the author's "Upload revisions" flow end-to-end: click the
	 * action button, then run the 3-step FileUploadWizardHandler (genre +
	 * file → metadata → confirm). The revision lands in the round as a
	 * SUBMISSION_FILE_REVIEW_REVISION file and the round status recomputes.
	 *
	 * @param {object} opts
	 * @param {string} opts.filePath      absolute path to upload
	 * @param {string} opts.displayName   unique per-test file name
	 * @param {string} [opts.genreLabel='Article Text']
	 */
	async uploadRevision({filePath, displayName, genreLabel = 'Article Text'}) {
		await this.modal()
			.getByRole('button', {name: 'Upload revisions', exact: true})
			.click();
		const wizard = this.page
			.getByRole('dialog', {name: 'Upload Review File'})
			.first();
		await expect(wizard).toBeVisible({timeout: 15_000});
		// FileStagePanel#driveUploadWizard only needs the page; the title
		// is irrelevant to the wizard drive.
		const fsp = new FileStagePanel(this.page, 'Revisions Uploaded');
		await fsp.driveUploadWizard(wizard, {filePath, genreLabel, displayName});
	}

	/**
	 * Drive the editor's "Request Response" compose flow. Clicks the
	 * enabled Request Response button (AuthorResponseRequestManager),
	 * waits for the standalone compose page, overwrites the (template-
	 * loaded) subject with a tagged marker so the delivered email is
	 * Mailpit-scopable, and submits. Resolves once the "Request for review
	 * response sent" success dialog shows.
	 *
	 * @param {string} tag  unique marker woven into the email subject
	 */
	async requestAuthorResponse(tag) {
		await this.modal()
			.getByRole('button', {name: 'Request Response', exact: true})
			.click();
		await this.page.waitForURL(/reviewResponse\/requestAuthorResponse/, {
			timeout: 20_000,
			waitUntil: 'commit',
		});

		// The Composer auto-loads the RequestReviewRoundAuthorResponse
		// template; editing before it settles would be overwritten.
		await expect(
			this.page.locator('.composer__loadingTemplateMask'),
		).toHaveCount(0, {timeout: 20_000});
		const subject = this.page.locator('#composer-subject');
		await expect(subject).toBeVisible({timeout: 15_000});
		// The template populates a non-empty subject; wait for it before
		// overwriting (a race would clobber our marker back to blank).
		await expect
			.poll(async () => (await subject.inputValue()).length, {timeout: 15_000})
			.toBeGreaterThan(0);
		await subject.fill(`Author response request ${tag}`);

		await this.page
			.getByRole('button', {name: 'Submit Request', exact: true})
			.click();
		const dialog = this.page
			.locator('[data-cy="dialog"]')
			.filter({hasText: 'Request for review response sent'});
		await expect(dialog).toBeVisible({timeout: 20_000});
	}

	/**
	 * Drive the author's Submit-Response form end-to-end. Opens the
	 * AuthorResponseFormModal via the `reviewResponseAction=respond`
	 * deep-link (the same auto-open path the request email uses — the
	 * panel's Submit-Response button relies on it too), fills the
	 * multilingual rich-text response, ticks the on-behalf-of author, and
	 * submits. Resolves once the form closes.
	 *
	 * @param {object} opts
	 * @param {number} opts.submissionId
	 * @param {string} opts.responseHtml  the rich-text response body
	 * @param {string} opts.authorName    on-behalf-of author's full name (checkbox label)
	 */
	async submitAuthorResponse({submissionId, responseHtml, authorName}) {
		await this.page.goto(
			`/index.php/${this.journalPath}/en/dashboard/mySubmissions?workflowSubmissionId=${submissionId}&reviewResponseAction=respond`,
			{waitUntil: 'commit'},
		);
		// The form auto-opens; anchor on the on-behalf-of field description.
		const onBehalf = this.page.getByText(
			'Author contributors who this response is being submitted on behalf of.',
		);
		await expect(onBehalf).toBeVisible({timeout: 20_000});

		// The response field is a multilingual FieldRichTextArea
		// (`ReviewRoundAuthorResponse-authorResponse-control-{locale}`);
		// resolve the mounted primary-locale editor id dynamically.
		const editorId = await this.resolveResponseEditorId();
		await this.page.waitForFunction(
			(id) => Boolean(window.tinymce?.get(id)?.initialized),
			editorId,
			{timeout: 15_000},
		);
		await this.page.evaluate(
			({id, html}) => {
				const editor = window.tinymce.get(id);
				editor.setContent(html);
				editor.save();
				const dispatch = editor.dispatch ?? editor.fire;
				dispatch.call(editor, 'Change');
				dispatch.call(editor, 'Input');
			},
			{id: editorId, html: responseHtml},
		);

		// On-behalf-of author checkbox (associatedAuthorIds option).
		await this.page.getByLabel(authorName, {exact: true}).check();

		await this.page
			.getByRole('button', {name: 'Submit Response', exact: true})
			.click();
		// The form's @success closes the modal — wait for the on-behalf-of
		// description to leave the DOM.
		await expect(onBehalf).toBeHidden({timeout: 20_000});
	}

	/**
	 * Find the mounted TinyMCE editor id backing the author-response field.
	 * Prefers the primary-locale (`-en`) control; falls back to any
	 * `authorResponse` editor. Polls until the editor mounts.
	 *
	 * @returns {Promise<string>}
	 */
	async resolveResponseEditorId() {
		const handle = await this.page.waitForFunction(
			() => {
				const tiny = window.tinymce;
				const list =
					(typeof tiny?.get === 'function' ? tiny.get() : null) ?? [];
				const ids = list.map((e) => e.id);
				return (
					ids.find(
						(id) => id.includes('authorResponse') && id.endsWith('-en'),
					) ||
					ids.find((id) => id.includes('authorResponse')) ||
					null
				);
			},
			undefined,
			{timeout: 15_000},
		);
		return /** @type {string} */ (await handle.jsonValue());
	}
};
