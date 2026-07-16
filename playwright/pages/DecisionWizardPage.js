// @ts-check
const {expect} = require('@playwright/test');
const {BasePage} = require('./BasePage.js');

/**
 * POM for the full-page decision wizard (docs/product/specs/
 * editorial-decisions.md) — the surface behind every workflow action
 * button: `{journal}/decision/record/{submissionId}?decision={type}`,
 * rendered by lib/pkp/pages/decision/DecisionHandler.php +
 * templates/decision/record.tpl + DecisionPage.vue.
 *
 * Also wraps the two entry points that precede the wizard:
 *  - the decision buttons in the workflow panel's action rail
 *    (`[data-cy="workflow-action-items"]`), and
 *  - the "Require New Review Round" chooser the two revisions buttons
 *    open first (WorkflowSelectRevisionFormModal).
 *
 * Shared across OJS/OMP/OPS — the wizard engine, steps and chooser all
 * live in pkp-lib / lib/ui-library.
 *
 * DOM realities encoded here:
 * - The page h1 reads "{decision label}: {current step name}" on
 *   multi-step wizards, or just the label on one-step wizards.
 * - Email steps AJAX-load their template after mount
 *   (`.composer__loadingTemplateMask`); submitting while the mask is up
 *   posts empty subject/body and fails server-side validation.
 * - The completion dialog is a PkpDialog (`[data-cy="dialog"]`). Reached
 *   the normal way (from the workflow page, with a `ret` URL) it offers
 *   a single "View Submission Summary" link.
 */
exports.DecisionWizardPage = class DecisionWizardPage extends BasePage {
	/**
	 * @param {import('@playwright/test').Page} page
	 * @param {{journalPath?: string}} [opts]
	 */
	constructor(page, {journalPath = 'publicknowledge'} = {}) {
		super(page);
		this.journalPath = journalPath;
	}

	/** The workflow panel's decision action rail (scoping root). */
	actionItems() {
		return this.page.locator('[data-cy="workflow-action-items"]').first();
	}

	/**
	 * A decision button in the action rail.
	 *
	 * @param {string} label e.g. 'Send for Review'
	 */
	decisionButton(label) {
		return this.actionItems().getByRole('button', {name: label, exact: true});
	}

	/**
	 * Press a decision button and wait for the wizard page.
	 *
	 * @param {string} label
	 */
	async clickDecision(label) {
		await this.decisionButton(label).click();
		await this.page.waitForURL(/\/decision\/record\//, {timeout: 20_000});
	}

	/**
	 * Drive a revisions chooser ("Require New Review Round" dialog): the
	 * Request Revisions / Recommend Revisions buttons open it before any
	 * navigation. Picks the radio and presses Next, landing on the
	 * matching wizard.
	 *
	 * @param {object} [opts]
	 * @param {string} [opts.buttonLabel='Request Revisions'] entry button
	 *   (and dialog title): 'Request Revisions' or 'Recommend Revisions'
	 * @param {boolean} [opts.newRound=false] pick the second option
	 *   (revisions subject to a new review round)
	 */
	async clickRevisionsChooser({
		buttonLabel = 'Request Revisions',
		newRound = false,
	} = {}) {
		await this.decisionButton(buttonLabel).click();
		const modal = this.revisionsChooser(buttonLabel);
		await expect(modal).toBeVisible({timeout: 15_000});
		if (newRound) {
			await modal
				.getByLabel(
					'Revisions will be subject to a new round of peer reviews.',
				)
				.check();
		}
		await Promise.all([
			this.page.waitForURL(/\/decision\/record\//, {timeout: 20_000}),
			modal.getByRole('button', {name: 'Next', exact: true}).click(),
		]);
	}

	/**
	 * The revisions chooser dialog (titled after its entry button).
	 *
	 * @param {string} [title='Request Revisions']
	 */
	revisionsChooser(title = 'Request Revisions') {
		return this.page.getByRole('dialog', {name: title});
	}

	/**
	 * The wizard's h1: "{label}: {step name}" on multi-step wizards.
	 *
	 * @param {string|RegExp} text
	 */
	pageHeading(text) {
		return this.page.getByRole('heading', {level: 1, name: text});
	}

	/** The steps rail (one button per step, labelled with the step name). */
	stepsRail() {
		return this.page.locator('.pkpSteps__buttonWrapper').first();
	}

	/** The current step's panel (heading + fields). */
	stepPanel() {
		return this.page.locator('.decision__stepPanel').first();
	}

	/**
	 * Wait for the Composer email step to finish auto-loading its
	 * template — required before Continue / Record Decision / edits.
	 */
	async awaitEmailTemplateLoaded() {
		const mask = this.page.locator('.composer__loadingTemplateMask');
		await expect(mask).toHaveCount(0, {timeout: 20_000});
	}

	/**
	 * Advance past the current step ("Continue"; the last step swaps it
	 * for Record Decision). Settles any pending email-template load
	 * first.
	 */
	async clickContinue() {
		await this.awaitEmailTemplateLoaded();
		await this.page
			.getByRole('button', {name: 'Continue', exact: true})
			.click();
	}

	/**
	 * Click "Skip this email" on a skippable email step. The footer link
	 * disappears once the step is marked skipped (the wizard advances or
	 * shows the skipped notice).
	 */
	async skipEmail() {
		await this.awaitEmailTemplateLoaded();
		const skip = this.page.getByRole('button', {
			name: 'Skip this email',
			exact: true,
		});
		await skip.click();
		await expect(skip).toHaveCount(0, {timeout: 10_000});
	}

	/**
	 * The current email step's recipients control ("To" chips with the
	 * recipient full names).
	 */
	recipients() {
		return this.page.locator('.composer__recipients').first();
	}

	/**
	 * The current email step's subject input (`{stepId}-subject`).
	 *
	 * @param {string} stepId e.g. 'notifyAuthors'
	 */
	subjectInput(stepId) {
		return this.page.locator(`#${stepId}-subject`);
	}

	/**
	 * Overwrite the email subject AFTER the template load has populated
	 * it (editing earlier is clobbered when the template arrives; the
	 * non-empty poll also proves the prefill happened). Used to weave
	 * the test tag into delivered mail for scoped Mailpit lookups.
	 *
	 * @param {string} stepId
	 * @param {string} subject
	 */
	async setEmailSubject(stepId, subject) {
		await this.awaitEmailTemplateLoaded();
		const input = this.subjectInput(stepId);
		await expect(input).toBeVisible({timeout: 15_000});
		await expect
			.poll(async () => (await input.inputValue()).length, {timeout: 15_000})
			.toBeGreaterThan(0);
		await input.fill(subject);
	}

	/**
	 * Attach round review files (a reviewer's uploaded files) to the
	 * current email step: Attach Files → the "Review Files" attacher
	 * ("Attach Review Files" button in the attacher list) → tick the
	 * named files → "Attach Selected".
	 *
	 * @param {string[]} fileNames
	 */
	async attachReviewFiles(fileNames) {
		await this.awaitEmailTemplateLoaded();
		await this.page
			.getByRole('button', {name: 'Attach Files', exact: true})
			.click();
		const attacherList = this.page.getByRole('dialog', {
			name: 'Attach Files',
		});
		await expect(attacherList).toBeVisible({timeout: 10_000});
		await attacherList
			.getByRole('button', {name: 'Attach Review Files', exact: true})
			.click();
		// The stacked AttacherModal takes the attacher's label as title.
		const picker = this.page.getByRole('dialog', {name: 'Review Files'});
		await expect(picker).toBeVisible({timeout: 10_000});
		for (const name of fileNames) {
			await picker
				.locator('.selectSubmissionFileListItem')
				.filter({hasText: name})
				.locator('input[type="checkbox"]')
				.check();
		}
		await picker
			.getByRole('button', {name: 'Attach Selected', exact: true})
			.click();
		await expect(picker).toBeHidden({timeout: 10_000});
		for (const name of fileNames) {
			await expect(
				this.page.locator('.composer__attachments'),
			).toContainText(name, {timeout: 10_000});
		}
	}

	/**
	 * A file's checkbox on a Select Files (PromoteFiles) step, matched
	 * by the file name rendered next to it.
	 *
	 * @param {string} fileName
	 */
	promoteFileCheckbox(fileName) {
		// The promote-files step is the only one that renders
		// SelectSubmissionFileListItem rows, so match page-wide (scoping to
		// the first step panel would grab the email step instead).
		return this.page
			.locator('.selectSubmissionFileListItem')
			.filter({hasText: fileName})
			.locator('input[type="checkbox"]');
	}

	/**
	 * Submit the decision (final step) and wait for the completion
	 * dialog.
	 *
	 * @param {string|RegExp} [expectedMessage] substring of the
	 *   completion text (DecisionType::getCompletedMessage)
	 * @returns {Promise<import('@playwright/test').Locator>} the dialog
	 */
	async recordDecision(expectedMessage) {
		await this.awaitEmailTemplateLoaded();
		await this.page
			.getByRole('button', {name: 'Record Decision', exact: true})
			.click();
		const dialog = this.page.locator('[data-cy="dialog"]');
		await expect(dialog).toBeVisible({timeout: 20_000});
		if (expectedMessage) {
			await expect(dialog).toContainText(expectedMessage);
		}
		return dialog;
	}

	/**
	 * From the completion dialog (workflow-page entry): "View Submission
	 * Summary" back to the open workflow panel.
	 */
	async viewSummaryFromCompletion() {
		await Promise.all([
			this.page.waitForURL(/workflowSubmissionId=/, {
				timeout: 20_000,
				waitUntil: 'commit',
			}),
			this.page
				.locator('[data-cy="dialog"]')
				.getByRole('link', {name: /^View Submission( Summary)?$/})
				.click(),
		]);
	}

	/**
	 * Press a decision button, drive an all-default wizard (settle every
	 * email template, Continue through each step) and record. Only for
	 * flows whose steps need no per-test input.
	 *
	 * @param {string} label decision button
	 * @param {object} [opts]
	 * @param {number} [opts.steps=1] number of wizard steps
	 * @param {string|RegExp} [opts.expectedMessage]
	 */
	async recordDefaultDecision(label, {steps = 1, expectedMessage} = {}) {
		await this.clickDecision(label);
		for (let i = 1; i < steps; i++) {
			await this.clickContinue();
		}
		await this.recordDecision(expectedMessage);
		await this.viewSummaryFromCompletion();
	}
};
