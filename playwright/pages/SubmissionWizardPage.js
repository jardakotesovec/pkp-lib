// @ts-check
const {expect} = require('@playwright/test');
const {BasePage} = require('./BasePage.js');
const {setTinyMceContent} = require('../support/tinymce.js');

/**
 * POM for the shared submission wizard. The wizard UI (start form + the
 * step-by-step wizard that follows) lives in lib/ui-library and is
 * identical in OJS/OMP/OPS — the sequence of steps ends in the same
 * Review step with the same submit confirmation dialog. Only the URL
 * prefix differs (contextPath).
 *
 * Built for row #10 (validation) and row #11 (copyright gate) of the
 * e2e-migration roadmap. Exposes the minimum surface those specs need:
 *
 *   - start()           Start form: pick locale, set title, accept any
 *                       configured checkbox/radio requirements, click
 *                       Begin Submission.
 *   - continueStep()    Click "Continue" on the current wizard step.
 *   - gotoStep()        Use the Steps nav to jump to any step by name.
 *   - setTitle()        Update the Details step's Title (multilingual).
 *   - clearTitle()      Same, cleared.
 *   - submit()          Click the primary Submit button + confirm the
 *                       modal. Returns once the "Submission complete"
 *                       page is visible.
 *
 * The assumption is that the spec knows when each helper is safe to
 * call — the POM doesn't try to hide the wizard's multi-step nature.
 */
exports.SubmissionWizardPage = class SubmissionWizardPage extends BasePage {
	/**
	 * @param {import('@playwright/test').Page} page
	 * @param {string} [contextPath='publicknowledge']
	 */
	constructor(page, contextPath = 'publicknowledge') {
		super(page);
		this.contextPath = contextPath;
		this.submitButton = page.getByRole('button', {
			name: /^Submit$/,
		});
	}

	/**
	 * Navigate to the Start Submission page. Every user with submit
	 * permissions on the journal lands here from the "New Submission"
	 * button in the dashboard; we skip the dashboard and go direct.
	 */
	async goto() {
		await this.page.goto(`/index.php/${this.contextPath}/submission`);
	}

	/**
	 * Fill the Start form and click Begin Submission. After this returns
	 * the wizard is mounted on step 1 (Upload Files).
	 *
	 * @param {Object} opts
	 * @param {string} opts.title             Title for the StartSubmission rich-text field.
	 * @param {string} [opts.locale='English']  Label of the submission locale radio.
	 *                                         Only matters if the journal supports 2+ locales.
	 * @param {string} [opts.section]         Label of the section radio to click (e.g. 'Articles').
	 *                                         Only matters if the journal has 2+ submittable sections.
	 */
	async start({title, locale = 'English', section}) {
		// Locale radio — only rendered when supportedSubmissionLocales >= 2.
		const localeLabel = this.page.locator('label', {hasText: locale});
		if (await localeLabel.first().isVisible().catch(() => false)) {
			await localeLabel.first().click();
		}

		// StartSubmission.title is a FieldRichText with id
		// 'startSubmission-title-control'. It's a oneline rich text —
		// TinyMCE is still in play, so route through the shared helper.
		await setTinyMceContent(
			this.page,
			'startSubmission-title-control',
			title,
		);

		// Section radio — only present when 2+ submittable sections exist.
		if (section) {
			const sectionLabel = this.page.locator('label', {hasText: section});
			if (await sectionLabel.first().isVisible().catch(() => false)) {
				await sectionLabel.first().click();
			}
		}

		// Submission checklist confirm — only rendered when the journal
		// has a submissionChecklist configured. Click whatever confirm
		// label is present; swallow if absent.
		const checklist = this.page.locator('label', {
			hasText: 'Yes, my submission meets all of these requirements.',
		});
		if (await checklist.first().isVisible().catch(() => false)) {
			await checklist.first().click();
		}

		// Privacy consent — only rendered when privacyStatement is set.
		const privacy = this.page.locator('label', {
			hasText: 'Yes, I agree to have my data collected',
		});
		if (await privacy.first().isVisible().catch(() => false)) {
			await privacy.first().click();
		}

		await this.page
			.getByRole('button', {name: 'Begin Submission'})
			.click();

		// Wait until we've left the start page and the wizard mounts.
		// The submission handler redirects to /submission?id=<id> with a
		// fragment for the current step, e.g. '#files'. Detecting the
		// '?id=' query tells us we're past the Start form; the wizard
		// itself takes a moment to Vue-hydrate.
		await this.page.waitForURL(/\/submission\?id=\d+/i, {
			timeout: 20_000,
		});
		await expect(
			this.page.locator('.submissionWizard'),
		).toBeVisible();
	}

	/**
	 * Click the wizard footer's primary Continue button. Scoped to the
	 * submission wizard footer so the (unrelated) "continue" strings
	 * anywhere else on the page can't match.
	 */
	async continueStep() {
		await this.page
			.locator('.submissionWizard__footer')
			.getByRole('button', {name: 'Continue'})
			.click();
	}

	/**
	 * Click the wizard footer's Back button (absent on the first step).
	 */
	async back() {
		await this.page
			.locator('.submissionWizard__footer')
			.getByRole('button', {name: 'Back'})
			.click();
	}

	/**
	 * Jump to a wizard step via the Steps nav (the horizontal rail of
	 * step pills at the top of the wizard). Use this to re-open an
	 * earlier step after errors were surfaced at Review.
	 *
	 * When the rail doesn't fit the viewport width, Steps.vue collapses
	 * it: every non-current pill gets the `-screenReader` class
	 * (visually clipped to 1px) and a chevron toggle is added. A
	 * `force: true` click on a clipped pill dispatches its events at
	 * coordinates that belong to whichever element is rendered there —
	 * a silent no-op. Expand the rail first when the target pill is
	 * clipped, then click normally so Playwright's actionability
	 * checks hold. (Only started steps render as <button>; clicking an
	 * unstarted step is a caller error and fails on the locator.)
	 *
	 * Two further hardenings, both observed against the live wizard:
	 *   - The pill's accessible name is "{n} {label}", so a plain
	 *     substring match resolves gotoStep('Review') to the
	 *     "Reviewer Suggestions" pill (it precedes "Review" in the
	 *     rail). The name match is end-anchored instead.
	 *   - The rail re-renders whenever startedSteps changes (the step
	 *     number swaps for a check icon); a click dispatched into that
	 *     re-render is swallowed. Verify the step actually opened and
	 *     retry the click a couple of times before failing.
	 *
	 * @param {string} stepName  e.g. 'Details', 'Review', 'Upload Files'
	 */
	async gotoStep(stepName) {
		const rail = this.page.locator('.pkpSteps');
		const namePattern = new RegExp(
			stepName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$',
		);
		const pill = rail.getByRole('button', {name: namePattern}).first();
		for (let attempt = 0; ; attempt++) {
			const clipped = rail.locator('li.-screenReader').filter({
				has: this.page.getByRole('button', {name: namePattern}),
			});
			if (await clipped.count()) {
				// The expand toggle lives in .pkpSteps__controls, which is
				// aria-hidden — locate by CSS, not role.
				await rail.locator('.pkpSteps__controls button').click();
			}
			// Hit-test-free click. Even when expanded, the dropdown's
			// pills can sit underneath the sticky app header / side nav
			// at default viewport sizes, so a coordinate-based click gets
			// intercepted ("<nav id=app-nav> intercepts pointer events").
			// dispatchEvent fires the Vue @click handler on the pill
			// element itself regardless of geometry.
			await pill.dispatchEvent('click');
			try {
				await this.expectStep(stepName, {timeout: 3_000});
				return;
			} catch (err) {
				if (attempt >= 2) {
					throw err;
				}
			}
		}
	}

	/**
	 * Assert which wizard step is active, via the Steps rail's current
	 * pill. Call before step-specific assertions so a mis-advanced
	 * wizard (e.g. a Continue click swallowed during a slow autosave
	 * under parallel load) fails with a clear step-name mismatch
	 * instead of an opaque locator timeout.
	 *
	 * The match is end-anchored ("{n} {label}" is the pill text) so
	 * that expectStep('Review') can't be satisfied by the
	 * "Reviewer Suggestions" pill.
	 *
	 * @param {string} stepName  e.g. 'For the Editors', 'Review'
	 * @param {{timeout?: number}} [opts]
	 */
	async expectStep(stepName, {timeout} = {}) {
		await expect(
			this.page.locator('.pkpSteps__step__label--current'),
		).toHaveText(
			new RegExp(
				stepName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$',
			),
			timeout ? {timeout} : undefined,
		);
	}

	/**
	 * Set the Details step's Title field for a specific locale.
	 *
	 * @param {string} title
	 * @param {string} [locale='en']
	 */
	async setTitle(title, locale = 'en') {
		await this.setDetailsField('title', title, locale);
	}

	/**
	 * Set any rich-text field of the Details step (the `titleAbstract`
	 * form) for a specific locale — e.g. 'title' or 'abstract'. The
	 * wizard's Details form removes `prefix` and `subtitle`, so those
	 * two never resolve here.
	 *
	 * @param {string} field   field name, e.g. 'abstract'
	 * @param {string} html    HTML (plain text is fine; TinyMCE wraps it)
	 * @param {string} [locale='en']
	 */
	async setDetailsField(field, html, locale = 'en') {
		await setTinyMceContent(
			this.page,
			`titleAbstract-${field}-control-${locale}`,
			html,
		);
	}

	/**
	 * Clear the Details step's Title field for a specific locale. Useful
	 * for the validation spec, which needs to trigger a required-field
	 * error after the autosave has seeded the title from the Start form.
	 *
	 * @param {string} [locale='en']
	 */
	async clearTitle(locale = 'en') {
		await this.setTitle('', locale);
	}

	/**
	 * Check the confirmSubmission copyright checkbox. Only valid on
	 * the Review step after the journal has a copyrightNotice
	 * configured. FieldOptions doesn't attach a stable id to each
	 * option input, so scope by `name`.
	 */
	async acceptCopyright() {
		await this.page
			.locator('input[name="confirmCopyright"][type="checkbox"]')
			.first()
			.check();
	}

	/**
	 * Set the "Comments for the Editor" TinyMCE rich-text field on the
	 * "For the Editors" step. The underlying control id is
	 * `commentsForTheEditors-commentsForTheEditors-control` (form id +
	 * field id). Caller is responsible for being on the correct step.
	 *
	 * @param {string} html  HTML (plain text is fine; TinyMCE wraps it).
	 */
	async setCommentsForEditors(html) {
		await setTinyMceContent(
			this.page,
			'commentsForTheEditors-commentsForTheEditors-control',
			html,
		);
	}

	/**
	 * Open the "Change Submission Settings" modal by clicking the
	 * `-linkButton` next to the "Submitting to the ... section in ..."
	 * caption. Only rendered when the journal has 2+ supported submission
	 * locales OR 2+ submittable sections (i.e., whenever there's
	 * something to reconfigure post-start).
	 */
	async openReconfigureModal() {
		await this.page
			.locator('#submission-configuration button', {hasText: 'Change'})
			.click();
		// The modal title is "Change Submission Settings". Wait for the
		// side-modal body to render — ModalManager tags the active one
		// with [data-cy="active-modal"] like the Discussion Manager
		// flows rely on.
		await expect(
			this.page
				.locator('[data-cy="active-modal"]')
				.getByRole('heading', {name: 'Change Submission Settings'}),
		).toBeVisible();
	}

	/**
	 * Inside the open reconfigure modal, pick the locale radio whose
	 * label matches `localeLabel` (e.g. "French (Canada)"), optionally
	 * switch the section radio, then click Save. Waits for the modal to
	 * close before returning.
	 *
	 * The reconfigure form is the backend's `ReconfigureSubmission` —
	 * it renders a `FieldOptions` (radio) named `locale` and, when the
	 * journal has 2+ sections, another named `sectionId`. Labels come
	 * from the localized locale name / section title.
	 *
	 * @param {Object} opts
	 * @param {string} [opts.localeLabel]   visible radio label, e.g. 'French (Canada)'
	 * @param {string} [opts.sectionLabel]  visible radio label, e.g. 'Reviews'
	 */
	async changeReconfigureSettings({localeLabel, sectionLabel} = {}) {
		const modal = this.page.locator('[data-cy="active-modal"]');
		if (localeLabel) {
			await modal
				.locator('label', {hasText: localeLabel})
				.first()
				.click();
		}
		if (sectionLabel) {
			await modal
				.locator('label', {hasText: sectionLabel})
				.first()
				.click();
		}
		await modal.getByRole('button', {name: 'Save', exact: true}).click();
		// The modal detaches on save; the form title heading
		// disappears with it. Wait on that rather than the zero-size
		// wrapper.
		await expect(
			this.page
				.locator('[data-cy="active-modal"]')
				.getByRole('heading', {name: 'Change Submission Settings'}),
		).toHaveCount(0, {timeout: 10_000});
	}

	/**
	 * Extract the submission id from the wizard's URL. The wizard
	 * mounts at `/submission?id=<id>#<step>`; this parses the `id`
	 * query param. Returns null if we're not on a wizard URL.
	 *
	 * @returns {number|null}
	 */
	currentSubmissionId() {
		const match = this.page.url().match(/[?&]id=(\d+)/);
		return match ? Number(match[1]) : null;
	}

	/**
	 * Click the primary Submit button and confirm the modal. Returns
	 * once the "Submission complete" page is visible — the caller can
	 * then assert on it.
	 */
	async submit() {
		await this.submitButton.click();
		const dialog = this.page.getByRole('dialog');
		await expect(dialog).toBeVisible();
		await dialog.getByRole('button', {name: 'Submit'}).click();
		await expect(
			this.page.getByRole('heading', {name: 'Submission complete'}),
		).toBeVisible({timeout: 20_000});
	}

	/**
	 * Click the footer's Submit button and wait for the confirmation
	 * dialog to open. Returns the dialog locator so the caller can
	 * assert on its copy and choose Cancel or Submit itself (the
	 * `submit()` helper above wraps the always-confirm path).
	 *
	 * Scrolls the button into view first — the Review panels above it
	 * shift layout while validation settles, which otherwise races
	 * Playwright's stability check.
	 *
	 * @returns {Promise<import('@playwright/test').Locator>}
	 */
	async openSubmitDialog() {
		const submitBtn = this.page
			.locator('.submissionWizard__footer')
			.getByRole('button', {name: /^Submit$/});
		await submitBtn.scrollIntoViewIfNeeded();
		await expect(submitBtn).toBeEnabled({timeout: 15_000});
		await submitBtn.click();
		const dialog = this.page.getByRole('dialog');
		await expect(dialog).toBeVisible({timeout: 10_000});
		return dialog;
	}

	/**
	 * Upload a file on the Upload Files step via the dropzone's hidden
	 * `<input type="file">` (clicking the visible button would open a
	 * real OS dialog — see patterns.md). Races the upload POST so the
	 * returned list item is already saved server-side.
	 *
	 * @param {string} filePath  absolute path of the fixture to upload
	 * @returns {Promise<import('@playwright/test').Locator>} the new file's list item
	 */
	async uploadFile(filePath) {
		const fileInput = this.page.locator('input[type="file"]').first();
		await expect(fileInput).toBeAttached({timeout: 15_000});
		await Promise.all([
			this.page.waitForResponse(
				(res) =>
					res.request().method() === 'POST' &&
					/\/api\/v1\/submissions\/\d+\/files$/.test(res.url()) &&
					res.ok(),
				{timeout: 30_000},
			),
			fileInput.setInputFiles(filePath),
		]);
		const baseName = filePath.split(/[\\/]/).pop() ?? filePath;
		const item = this.fileItem(baseName);
		await expect(item).toBeVisible({timeout: 15_000});
		return item;
	}

	/**
	 * Locator for an uploaded file's list item, scoped by file name.
	 *
	 * @param {string} name  file name as shown in the list (e.g. 'dummy.pdf')
	 */
	fileItem(name) {
		return this.page
			.locator('.listPanel__item--submissionFile')
			.filter({hasText: name})
			.first();
	}

	/**
	 * Answer the "What kind of file is this?" prompt on a just-uploaded
	 * file by clicking one of the primary-genre link buttons (e.g.
	 * 'Article Text'). Waits for the genre PUT to land so the badge is
	 * rendered before returning.
	 *
	 * @param {import('@playwright/test').Locator} item  file list item (from uploadFile)
	 * @param {string} genreName  visible label of a primary genre
	 */
	async assignPrimaryGenre(item, genreName) {
		const btn = item
			.locator('.listPanel--submissionFiles__setGenreButton')
			.filter({hasText: genreName})
			.first();
		await Promise.all([
			this.page.waitForResponse(
				(res) =>
					res.request().method() === 'POST' &&
					/\/api\/v1\/submissions\/\d+\/files\/\d+/.test(res.url()) &&
					res.ok(),
				{timeout: 15_000},
			),
			btn.click(),
		]);
		await expect(
			item.locator('.listPanel--submissionFiles__itemGenre'),
		).toContainText(genreName, {timeout: 10_000});
	}

	/**
	 * Open the file's genre form via the genre prompt's "Other" link
	 * button (non-primary genres aren't offered as one-click buttons).
	 * The same side modal opens from the item's "Edit" button for files
	 * that already have a genre. Returns the modal's form locator so the
	 * caller can assert on the genre options before saving.
	 *
	 * @param {import('@playwright/test').Locator} item  file list item
	 * @returns {Promise<import('@playwright/test').Locator>} the genre form inside the modal
	 */
	async openFileGenreForm(item) {
		// Both a genre named "Other" and the prompt's edit shortcut are
		// labelled "Other", but only the supplementary genres render in
		// the modal — the prompt row only offers primary genres plus
		// this one "Other" button (SubmissionFilesListItem.vue).
		await item
			.locator('.listPanel--submissionFiles__setGenreButton', {
				hasText: 'Other',
			})
			.first()
			.click();
		// The form root carries no stable id; anchor on the genreId radio
		// group the PKPSubmissionFileForm always renders.
		const form = this.page
			.locator('[data-cy="active-modal"] form')
			.filter({has: this.page.locator('input[name="genreId"]')})
			.first();
		await expect(
			form.locator('input[name="genreId"]').first(),
		).toBeVisible({timeout: 15_000});
		return form;
	}

	/**
	 * Pick a genre radio in the open genre form and Save. Waits for the
	 * file PUT and for the badge to reflect the new genre.
	 *
	 * @param {import('@playwright/test').Locator} form  from openFileGenreForm
	 * @param {import('@playwright/test').Locator} item  the owning file list item
	 * @param {string} genreName  visible radio label (e.g. 'Data Set')
	 */
	async saveFileGenre(form, item, genreName) {
		await form.locator('label', {hasText: genreName}).first().click();
		await Promise.all([
			this.page.waitForResponse(
				(res) =>
					res.request().method() === 'POST' &&
					/\/api\/v1\/submissions\/\d+\/files\/\d+/.test(res.url()) &&
					res.ok(),
				{timeout: 15_000},
			),
			form.getByRole('button', {name: 'Save', exact: true}).click(),
		]);
		await expect(form).toHaveCount(0, {timeout: 10_000});
		await expect(
			item.locator('.listPanel--submissionFiles__itemGenre'),
		).toContainText(genreName, {timeout: 10_000});
	}

	/**
	 * Remove an uploaded file via its "Remove" button + the confirm
	 * dialog. Waits for the DELETE and for the item to leave the list.
	 *
	 * @param {import('@playwright/test').Locator} item  file list item
	 */
	async removeFile(item) {
		await item.getByRole('button', {name: 'Remove'}).click();
		const dialog = this.page.getByRole('dialog');
		await expect(dialog).toContainText(
			'Are you sure you want to remove this file?',
		);
		await Promise.all([
			this.page.waitForResponse(
				(res) =>
					res.request().method() === 'POST' &&
					/\/api\/v1\/submissions\/\d+\/files\/\d+/.test(res.url()) &&
					res.ok(),
				{timeout: 15_000},
			),
			dialog.getByRole('button', {name: 'Yes', exact: true}).click(),
		]);
		await expect(item).toHaveCount(0, {timeout: 10_000});
	}

	/**
	 * Add a contributor on the Contributors step. Opens the "Add
	 * Contributor" side modal, fills the person fields, ticks the
	 * required Author contributor-role checkbox, Saves, and waits for
	 * the POST + the new name to appear in the list panel.
	 *
	 * @param {Object} opts
	 * @param {string} opts.givenName
	 * @param {string} opts.familyName
	 * @param {string} opts.email
	 * @param {string} [opts.country='CA']  country option value
	 * @param {string} [opts.locale='en']   locale suffix of the name inputs
	 */
	async addContributor({givenName, familyName, email, country = 'CA', locale = 'en'}) {
		await this.page
			.getByRole('button', {name: 'Add Contributor', exact: true})
			.click();

		// The modal wrapper reports visibility:hidden during its open
		// transition (patterns.md) — anchor on the email input instead.
		const emailInput = this.page.locator('input[name="email"]').last();
		await expect(emailInput).toBeVisible({timeout: 15_000});

		await this.page
			.locator(`input[name="givenName-${locale}"]`)
			.last()
			.fill(givenName);
		await this.page
			.locator(`input[name="familyName-${locale}"]`)
			.last()
			.fill(familyName);
		await emailInput.fill(email);
		await this.page
			.locator('select[name="country"]')
			.last()
			.selectOption(country);

		// contributorRoles is a required FieldOptions checkbox group when
		// the journal ships more than one contributor role (publicknowledge
		// does: Author + Translator).
		const roleCheckbox = this.page
			.locator('label', {hasText: 'Author'})
			.locator('input[type="checkbox"]')
			.first();
		if (await roleCheckbox.isVisible().catch(() => false)) {
			await roleCheckbox.check({force: true});
		}

		await Promise.all([
			this.page.waitForResponse(
				(res) =>
					/\/api\/v1\/submissions\/\d+\/publications\/\d+\/contributors/.test(
						res.url(),
					) && res.ok(),
				{timeout: 20_000},
			),
			this.page
				.getByRole('button', {name: 'Save', exact: true})
				.last()
				.click(),
		]);
		await expect(
			this.contributorItem(`${givenName} ${familyName}`),
		).toBeVisible({timeout: 15_000});
	}

	/**
	 * Locator for a contributor's list-panel row, scoped by full name.
	 *
	 * @param {string} fullName  e.g. 'Author Tester'
	 */
	contributorItem(fullName) {
		return this.page
			.locator('.listPanel--contributor .listPanel__item')
			.filter({hasText: fullName})
			.first();
	}

	/**
	 * Locator for one of the Review step's per-section panels, filtered
	 * by its heading. Multilingual journals render Details / For the
	 * Editors once per metadata locale — pass e.g. /^Details \(English\)/
	 * to disambiguate.
	 *
	 * @param {string|RegExp} heading
	 */
	reviewPanel(heading) {
		return this.page
			.locator('.submissionWizard__reviewPanel')
			.filter({
				has: this.page.getByRole('heading', {name: heading}),
			})
			.first();
	}
};
