// @ts-check
const {expect} = require('@playwright/test');
const {BasePage} = require('./BasePage.js');

/**
 * POM for the full-page decision wizard — the decision/record/{id} page
 * (lib/pkp/pages/decision/DecisionHandler.php → lib/ui-library
 * DecisionPage.vue, template lib/pkp/templates/decision/record.tpl).
 * Covers the steps rail, the Composer email steps, the promote-files
 * step, the footer (Skip this email / Cancel / Continue / Record
 * Decision) and the completion dialog.
 *
 * Shared across OJS/OMP/OPS — every surface it touches ships from
 * pkp-lib / lib/ui-library.
 *
 * DOM realities encoded here:
 * - The page heading is `h1.app__pageHeading` — "{Decision label}:
 *   {current step name}" for multi-step wizards, the bare label for
 *   single-step ones.
 * - Step pills render inside `.pkpSteps__buttonWrapper`; each carries
 *   its step name (2–3 steps never overflow into the collapsed form).
 * - Email steps auto-load their template via AJAX; the Composer shows
 *   `.composer__loadingTemplateMask` while loading and editing before
 *   it settles is overwritten (patterns.md pitfall 11). Every subject
 *   edit waits for the mask AND for the template's non-empty subject.
 * - The Composer subject input id is `{stepId}-subject`; the "To"
 *   chips render inside `.composer__recipients`.
 * - Promote-file rows are `.selectSubmissionFileListItem` with a
 *   checkbox named `promoteFile{fileId}` — scoped to the step panel
 *   (`.decision__stepPanel`) so the attach-files picker's identical
 *   rows can never match.
 * - The completion dialog is a PkpDialog (`[data-cy="dialog"]`); its
 *   dashboard-entry variant carries a single "View Submission Summary"
 *   link (DecisionPage.vue openCompletedDialog, ret-param branch).
 */
exports.DecisionWizardPage = class DecisionWizardPage extends BasePage {
	/** @param {import('@playwright/test').Page} page */
	constructor(page) {
		super(page);
		this.recordButton = page.getByRole('button', {
			name: 'Record Decision',
			exact: true,
		});
		this.continueButton = page.getByRole('button', {
			name: 'Continue',
			exact: true,
		});
		this.skipLink = page.getByRole('button', {
			name: 'Skip this email',
			exact: true,
		});
	}

	/** The wizard page heading ("{Decision}: {step}" or the bare label). */
	heading() {
		return this.page.locator('h1.app__pageHeading');
	}

	/**
	 * The steps rail — an <ol> whose accessible name is the wizard's
	 * completeSteps label. Non-current steps render as plain list items
	 * (no button role), so entries are matched at the listitem level.
	 */
	stepsList() {
		return this.page.getByRole('list', {
			name: 'Complete the following steps to take this decision',
		});
	}

	/**
	 * A steps-rail entry by its step name ("Notify Authors",
	 * "Notify Reviewers", "Select Files", "Request Payment", ...).
	 *
	 * @param {string} label
	 */
	stepItem(label) {
		return this.stepsList().getByRole('listitem').filter({hasText: label});
	}

	/**
	 * Wait for any pending Composer template load to settle. Editing or
	 * advancing earlier posts empty subject/body and fails server-side
	 * validation. The loading mask can flicker (a count-0 check passes
	 * BEFORE the load even starts), so on email steps the real signal is
	 * the template's non-empty subject — every decision email template
	 * prefills one. A no-op on non-email steps (no visible subject).
	 */
	async awaitTemplateLoaded() {
		const subject = this.page.locator('input[id$="-subject"]:visible');
		if ((await subject.count()) > 0) {
			await expect
				.poll(async () => (await subject.first().inputValue()).length, {
					timeout: 20_000,
				})
				.toBeGreaterThan(0);
		}
		await expect(
			this.page.locator('.composer__loadingTemplateMask'),
		).toHaveCount(0, {timeout: 20_000});
	}

	/**
	 * Overwrite the current email step's subject once the template has
	 * prefilled it (overwriting earlier would be clobbered when the
	 * template arrives). Weave the test's unique tag in for Mailpit
	 * scoping.
	 *
	 * @param {string} stepId  e.g. 'notifyAuthors', 'notifyReviewers', 'discussion'
	 * @param {string} subject
	 */
	async setEmailSubject(stepId, subject) {
		await this.awaitTemplateLoaded();
		const input = this.page.locator(`#${stepId}-subject`);
		await expect(input).toBeVisible({timeout: 15_000});
		await expect
			.poll(async () => (await input.inputValue()).length, {timeout: 15_000})
			.toBeGreaterThan(0);
		await input.fill(subject);
	}

	/**
	 * The current email step's "To:" recipients region (chips / names).
	 * Every step panel stays in the DOM (hidden when not current), so
	 * the region is filtered to the visible one.
	 */
	recipients() {
		return this.page.locator('.composer__recipients:visible');
	}

	/**
	 * Advance one step (waits out any template load first). The page
	 * heading carries the current step's name, and the footer re-renders
	 * as composer state settles — a Continue click can be swallowed by a
	 * re-mount, so the advance is verified against the heading and the
	 * click retried.
	 */
	async continueStep() {
		await this.awaitTemplateLoaded();
		const before = ((await this.heading().textContent()) ?? '').trim();
		for (let i = 0; i < 3; i++) {
			await this.continueButton.click();
			try {
				await expect
					.poll(
						async () => ((await this.heading().textContent()) ?? '').trim(),
						{timeout: 5_000},
					)
					.not.toBe(before);
				return;
			} catch {
				// Swallowed click — retry.
			}
		}
		throw new Error(
			`Decision wizard did not advance past step "${before}" after 3 Continue clicks`,
		);
	}

	/**
	 * Record the decision from the last step and wait for the completion
	 * dialog (a persistent PkpDialog — never a transient toast). File
	 * promotion requests run client-side BEFORE the dialog opens, so its
	 * appearance also proves the promote copies completed.
	 *
	 * @param {string} [expectedLabel]  the DecisionType::getCompletedLabel()
	 *   heading, e.g. 'Sent for Review'
	 * @returns {Promise<import('@playwright/test').Locator>} the dialog
	 */
	async record(expectedLabel) {
		await this.awaitTemplateLoaded();
		const dialog = this.page.locator('[data-cy="dialog"]');
		// A click can be swallowed by a footer re-mount. Re-click ONLY
		// when nothing registered (no dialog AND the button is still
		// enabled) — while the decision POST is in flight the button is
		// disabled, and re-clicking after completion could double-submit.
		for (let i = 0; i < 3; i++) {
			await this.recordButton.click();
			const appeared = await dialog
				.waitFor({state: 'visible', timeout: 10_000})
				.then(() => true)
				.catch(() => false);
			if (appeared) {
				break;
			}
			if (await this.recordButton.isDisabled().catch(() => false)) {
				// Submission in flight — give the POST + file copies time.
				break;
			}
		}
		await expect(dialog).toBeVisible({timeout: 30_000});
		if (expectedLabel) {
			await expect(dialog).toContainText(expectedLabel);
		}
		return dialog;
	}

	/**
	 * Drive a wizard whose per-step content is not under test: keep the
	 * template-loaded defaults, Continue through every step, Record on
	 * the last, and assert the completion label.
	 *
	 * @param {string} [expectedLabel]
	 * @returns {Promise<import('@playwright/test').Locator>} the dialog
	 */
	async recordThrough(expectedLabel) {
		for (let i = 0; i < 5; i++) {
			await this.awaitTemplateLoaded();
			await this.recordButton
				.or(this.continueButton)
				.first()
				.waitFor({state: 'visible', timeout: 15_000});
			if (await this.recordButton.isVisible().catch(() => false)) {
				break;
			}
			await this.continueStep();
		}
		return this.record(expectedLabel);
	}

	/**
	 * Follow the completion dialog's single "View Submission Summary"
	 * link (dashboard entry, DecisionPage returnUrlToSubmissionSummary
	 * branch) back to the workflow panel.
	 *
	 * @param {number|string} submissionId
	 */
	async viewSummary(submissionId) {
		await Promise.all([
			this.page.waitForURL(
				new RegExp(`workflowSubmissionId=${submissionId}(&|$)`),
				{timeout: 20_000, waitUntil: 'commit'},
			),
			this.page
				.locator('[data-cy="dialog"]')
				.getByRole('link', {name: 'View Submission Summary', exact: true})
				.click(),
		]);
	}

	/**
	 * Skip the current email step and wait for the skip to register —
	 * either the panel flips to the skipped notice (last step) or the
	 * wizard advances to the next step.
	 */
	async skipCurrentEmail() {
		await this.awaitTemplateLoaded();
		await this.skipLink.click();
		await expect(
			this.page
				.getByText('This step has been skipped and no email will be sent.')
				.or(this.recordButton)
				.first(),
		).toBeVisible({timeout: 15_000});
	}

	/**
	 * A promote-step file row, matched by file name, scoped to the step
	 * panel (the attach-files picker renders the same row class inside
	 * its own dialog).
	 *
	 * @param {string} fileName
	 */
	promoteFileRow(fileName) {
		return this.page
			.locator('.decision__stepPanel .selectSubmissionFileListItem')
			.filter({hasText: fileName});
	}

	/**
	 * The checkbox of a promote-step file row.
	 *
	 * @param {string} fileName
	 */
	promoteFileCheckbox(fileName) {
		return this.promoteFileRow(fileName).locator('input[type="checkbox"]');
	}

	/**
	 * Attach a reviewer-uploaded file to the current email step via the
	 * "Attach Review Files" attacher: TinyMCE toolbar "Attach Files" →
	 * attacher list → review-files picker (rows read "{Reviewer name} —
	 * {file name}") → "Attach Selected". Both side modals close and the
	 * file lands in the Composer's attachments strip.
	 *
	 * @param {string} fileText  text identifying the picker row (file name)
	 */
	async attachReviewFile(fileText) {
		await this.awaitTemplateLoaded();
		await this.page
			.getByRole('button', {name: 'Attach Files', exact: true})
			.click();
		const attacherList = this.page.getByRole('dialog', {name: 'Attach Files'});
		await expect(attacherList).toBeVisible({timeout: 15_000});
		await attacherList
			.getByRole('button', {name: 'Attach Review Files', exact: true})
			.click();

		const picker = this.page.getByRole('dialog', {name: 'Review Files'});
		await expect(picker).toBeVisible({timeout: 15_000});
		await picker
			.locator('.selectSubmissionFileListItem')
			.filter({hasText: fileText})
			.locator('input[type="checkbox"]')
			.check();
		await picker
			.getByRole('button', {name: 'Attach Selected', exact: true})
			.click();

		await expect(picker).toBeHidden({timeout: 15_000});
		await expect(this.attachments()).toContainText(fileText, {
			timeout: 15_000,
		});
	}

	/** The Composer's attached-files strip on the current email step. */
	attachments() {
		return this.page.locator('.composer__attachments');
	}
};
