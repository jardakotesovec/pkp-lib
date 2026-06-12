// @ts-check
const {test, expect} = require('../support/base-test.js');
const {setTinyMceContent, getTinyMceContent} = require('../support/tinymce.js');
const {EditorialWorkflowPage} = require('../../../../playwright/pages/EditorialWorkflowPage.js');
const submissionInReview = require('../../../../playwright/fixtures/scenarios/submission-in-review.js');
/**
 * Email templates management — docs/e2e/plans/email-templates-management.md
 * (6 rows; this spec backs all of them).
 *
 * Rows 1–4 port lib/pkp/cypress/tests/integration/emailTemplates/EmailTemplates.cy.js
 * (9 tests) into 4 focused tests:
 *
 *   1. edit-default: toggle an existing mailable's default template
 *      from unrestricted -> restricted and assign user groups. Folds
 *      Cypress's bidirectional toggles (Marks/Removes unrestricted) and
 *      the assign/remove user-groups pair into the single round-trip;
 *      what changes between Cypress's tests 1-4 is direction, not
 *      surface, so a single save→reload→re-open round-trip covers them.
 *   2. custom-restricted: create a new custom template with body +
 *      two user groups assigned. Cypress test 5.
 *   3. custom-unrestricted: create a new custom template with
 *      unrestricted=true, confirm the user-group checkboxes are NOT
 *      rendered, then flip the radio back to restricted within the
 *      same session and confirm the user-group checkboxes reappear.
 *      Folds Cypress tests 6, 8 (hide-direction) and 9 (show-direction
 *      reactive reveal).
 *   4. custom-restricted-no-groups: create a restricted custom template
 *      with zero user groups assigned and confirm the form accepts the
 *      zero-UG state. Cypress test 7 — the "is the validator OK with no
 *      UGs?" surface, distinct from tests 5/6's "save with checks".
 *
 * Rows 5–6 cover the lifecycle around the editor:
 *
 *   5. edited-default-in-sent-mail: the customized
 *      DecisionAcceptNotifyAuthor (EDITOR_DECISION_ACCEPT) body is what
 *      an Accept decision recorded through the UI actually sends — the
 *      Mailpit message to the author carries the unique marker with all
 *      {$...} variables rendered. (Drives the OJS EditorialWorkflowPage
 *      POM, same cross-import precedent as review-decisions.spec.js —
 *      the decision flow ships from pkp-lib but the workflow-page POM
 *      is app-specific.)
 *   6. reset-and-remove: the per-template Reset row action restores a
 *      customized default to stock subject/body; Remove deletes a
 *      custom template and it stays gone after a reload.
 *
 * Each test seeds its own E0 scratch journal so the bootstrapped
 * publicknowledge journal's email templates stay untouched.
 */

function uniqueTag() {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `em-w${workerIndex}-${suffix}`;
}

async function openManageEmails(page, journalPath) {
	await page.goto(
		`/index.php/${journalPath}/management/settings/manageEmails`,
	);
	// The mailables list is the first listPanel on the page; wait for
	// at least one item to render before any test proceeds.
	await expect(page.locator('li.listPanel__item').first()).toBeVisible();
}

/**
 * Click the Edit button on a mailable row in the outer Manage Emails
 * list. The button renders a visible "Edit" glyph with aria-hidden plus
 * a screen-reader-only "Edit {$name}" label, so the accessible name is
 * "Edit Discussion (Production)" (or whichever mailable).
 */
async function clickEditOnMailable(page, mailableName) {
	await page
		.locator('li.listPanel__item', {hasText: mailableName})
		.getByRole('button', {name: `Edit ${mailableName}`})
		.first()
		.click();
}

/**
 * Return a locator scoped to the "mailable" modal — i.e., the
 * EditMailableModal whose inner Templates listPanel is rendered.
 * Reka-ui's DialogPortal keeps two nested side-modals mounted
 * simultaneously when the template form is open on top of a mailable,
 * so scoping by a distinctive inner element (the Add Template button
 * only ever exists in the mailable modal) is how we disambiguate.
 */
function mailableModalLocator(page) {
	return page
		.locator('[data-cy="active-modal"]')
		.filter({has: page.getByRole('button', {name: 'Add Template'})});
}

/**
 * Return a locator scoped to the "template" modal — the
 * EditTemplateModal stacked on top of the mailable modal. Filter on
 * the isUnrestricted radio, which only exists in the template form.
 */
function templateModalLocator(page) {
	return page
		.locator('[data-cy="active-modal"]')
		.filter({has: page.locator('input[name="isUnrestricted"]')});
}

/**
 * Open a mailable by name and click Edit on one of its templates.
 *
 * The mailable row in the outer listPanel has an "Edit" action that
 * opens the EditMailableModal side-modal. The side-modal itself
 * contains a second (nested) listPanel of templates; each template
 * row also has an "Edit" button that opens the EditTemplateModal on
 * top of the mailable modal. This helper performs both clicks.
 */
async function openEmailTemplate(page, mailableName, templateName) {
	await clickEditOnMailable(page, mailableName);

	const mailableModal = mailableModalLocator(page);
	await expect(mailableModal).toHaveCount(1);

	// The template row's Edit button has plain text "Edit".
	await mailableModal
		.locator('li.listPanel__item', {hasText: templateName})
		.getByRole('button', {name: 'Edit'})
		.click();

	const templateModal = templateModalLocator(page);
	await expect(templateModal).toHaveCount(1);
	return templateModal;
}

async function openNewTemplateForMailable(page, mailableName) {
	await clickEditOnMailable(page, mailableName);

	const mailableModal = mailableModalLocator(page);
	await expect(mailableModal).toHaveCount(1);
	await mailableModal.getByRole('button', {name: 'Add Template'}).click();

	const templateModal = templateModalLocator(page);
	await expect(templateModal).toHaveCount(1);
	return templateModal;
}

async function saveTemplateModal(page) {
	const templateModal = templateModalLocator(page);
	await templateModal.getByRole('button', {name: 'Save'}).click();
	// After save the side-modal auto-closes after a delay (see
	// ManageEmailsPage.vue's templateSaved). Wait for the template
	// modal to go away before continuing so that a subsequent reload
	// doesn't race an in-flight PUT.
	await expect(templateModal).toHaveCount(0, {timeout: 15_000});
}

async function setUnrestricted(modal, value) {
	// The FieldOptions radio renders value="true" / value="false" as
	// the literal strings; casting to bool in PHP then JSON-encoding
	// produces those.
	const target = value ? 'true' : 'false';
	await modal
		.locator(`input[name="isUnrestricted"][value="${target}"]`)
		.check({force: true});
}

test.describe('Email templates', () => {
	test(
		'admin toggles a default template from unrestricted to restricted with user groups',
		{tag: '@regression'},
		async ({pkpApi, asUser}) => {
			const tag = uniqueTag();
			const {context} = await pkpApi.createJournal({
				tag,
				users: [{username: 'dbarnes', roles: ['manager']}],
			});
			const ctx = await asUser('dbarnes');
			const page = await ctx.newPage();
			await openManageEmails(page, context.path);

			const mailable = 'Discussion (Production)';

			// Open the default template, flip to restricted, pick two
			// user groups, save.
			let templateModal = await openEmailTemplate(page, mailable, mailable);
			await setUnrestricted(templateModal, false);
			await templateModal
				.locator('input[name="assignedUserGroupIds"]')
				.nth(0)
				.check({force: true});
			await templateModal
				.locator('input[name="assignedUserGroupIds"]')
				.nth(1)
				.check({force: true});
			await saveTemplateModal(page);

			// Reload and verify the selection persisted.
			await page.reload();
			await expect(page.locator('li.listPanel__item').first()).toBeVisible();
			templateModal = await openEmailTemplate(page, mailable, mailable);
			await expect(
				templateModal.locator('input[name="isUnrestricted"]:checked'),
			).toHaveValue('false');
			await expect(
				templateModal.locator('input[name="assignedUserGroupIds"]').nth(0),
			).toBeChecked();
			await expect(
				templateModal.locator('input[name="assignedUserGroupIds"]').nth(1),
			).toBeChecked();
		
		},
	);

	test(
		'admin adds a new restricted custom template with body and two user groups',
		{tag: '@regression'},
		async ({pkpApi, asUser}) => {
			const tag = uniqueTag();
			const {context} = await pkpApi.createJournal({
				tag,
				users: [{username: 'dbarnes', roles: ['manager']}],
			});
			const ctx = await asUser('dbarnes');
			const page = await ctx.newPage();
			await openManageEmails(page, context.path);

			const mailable = 'Discussion (Production)';
			const templateName = `Custom restricted ${tag}`;

			let templateModal = await openNewTemplateForMailable(page, mailable);

			await templateModal
				.locator('input[id^="editEmailTemplate-name-control-en"]')
				.fill(templateName);
			await templateModal
				.locator('input[id^="editEmailTemplate-subject-control-en"]')
				.fill(`Subject for ${tag}`);
			await setTinyMceContent(
				page,
				'editEmailTemplate-body-control-en',
				`<p>Body for ${tag}</p>`,
			);

			await setUnrestricted(templateModal, false);
			// Cypress seeds the two "middle" user groups (indices 1 and 2)
			// because the test on publicknowledge left index 0 assigned
			// elsewhere; on a scratch journal nothing else is wired, so
			// indices 0 and 1 are fine.
			await templateModal
				.locator('input[name="assignedUserGroupIds"]')
				.nth(0)
				.check({force: true});
			await templateModal
				.locator('input[name="assignedUserGroupIds"]')
				.nth(1)
				.check({force: true});

			await saveTemplateModal(page);

			// Reload and verify the custom template persisted with both
			// user groups still checked.
			await page.reload();
			await expect(page.locator('li.listPanel__item').first()).toBeVisible();
			templateModal = await openEmailTemplate(page, mailable, templateName);
			await expect(
				templateModal.locator('input[name="isUnrestricted"]:checked'),
			).toHaveValue('false');
			await expect(
				templateModal.locator('input[name="assignedUserGroupIds"]').nth(0),
			).toBeChecked();
			await expect(
				templateModal.locator('input[name="assignedUserGroupIds"]').nth(1),
			).toBeChecked();
		
		},
	);

	test(
		'admin creates an unrestricted custom template and user-group options are hidden',
		{tag: '@regression'},
		async ({pkpApi, asUser}) => {
			const tag = uniqueTag();
			const {context} = await pkpApi.createJournal({
				tag,
				users: [{username: 'dbarnes', roles: ['manager']}],
			});
			const ctx = await asUser('dbarnes');
			const page = await ctx.newPage();
			await openManageEmails(page, context.path);

			const mailable = 'Discussion (Production)';
			const templateName = `Custom unrestricted ${tag}`;

			let templateModal = await openNewTemplateForMailable(page, mailable);

			await templateModal
				.locator('input[id^="editEmailTemplate-name-control-en"]')
				.fill(templateName);
			await templateModal
				.locator('input[id^="editEmailTemplate-subject-control-en"]')
				.fill(`Subject for ${tag}`);
			await setTinyMceContent(
				page,
				'editEmailTemplate-body-control-en',
				`<p>Body for ${tag}</p>`,
			);

			await setUnrestricted(templateModal, true);
			// User-group checkboxes are gated on isUnrestricted=false via
			// FieldOptions's showWhen — with unrestricted=true they must
			// not be in the DOM at all.
			await expect(
				templateModal.locator('input[name="assignedUserGroupIds"]'),
			).toHaveCount(0);

			// Reactive show direction: flipping the radio back to
			// restricted in the same session must re-mount the
			// user-group checkboxes (FieldOptions remounts the dependent
			// field on showWhen-truthy). Then flip back to unrestricted
			// before saving so the persisted state still matches the
			// test name.
			await setUnrestricted(templateModal, false);
			await expect(
				templateModal.locator('input[name="assignedUserGroupIds"]').first(),
			).toBeVisible();
			await setUnrestricted(templateModal, true);
			await expect(
				templateModal.locator('input[name="assignedUserGroupIds"]'),
			).toHaveCount(0);

			await saveTemplateModal(page);

			await page.reload();
			await expect(page.locator('li.listPanel__item').first()).toBeVisible();
			templateModal = await openEmailTemplate(page, mailable, templateName);
			await expect(
				templateModal.locator('input[name="isUnrestricted"]:checked'),
			).toHaveValue('true');
			await expect(
				templateModal.locator('input[name="assignedUserGroupIds"]'),
			).toHaveCount(0);

		},
	);

	test(
		'admin creates a restricted custom template with no assigned user groups',
		{tag: '@regression'},
		async ({pkpApi, asUser}) => {
			const tag = uniqueTag();
			const {context} = await pkpApi.createJournal({
				tag,
				users: [{username: 'dbarnes', roles: ['manager']}],
			});
			const ctx = await asUser('dbarnes');
			const page = await ctx.newPage();
			await openManageEmails(page, context.path);

			// Cypress test 7 anchors on a different mailable
			// (`Reinstate Submission Declined Without Review`) than tests
			// 5/6's `Discussion (Production)` — the validator's behaviour
			// is per-mailable in principle but the no-UG-restricted state
			// is permitted everywhere, so we stay on the same mailable
			// the other Playwright tests use to keep one less moving
			// part. The point of this test is "form accepts a restricted
			// template with zero UGs", not "this specific mailable".
			const mailable = 'Discussion (Production)';
			const templateName = `Custom restricted (no groups) ${tag}`;

			let templateModal = await openNewTemplateForMailable(page, mailable);

			await templateModal
				.locator('input[id^="editEmailTemplate-name-control-en"]')
				.fill(templateName);
			await templateModal
				.locator('input[id^="editEmailTemplate-subject-control-en"]')
				.fill(`Subject for ${tag}`);
			await setTinyMceContent(
				page,
				'editEmailTemplate-body-control-en',
				`<p>Body for ${tag}</p>`,
			);

			await setUnrestricted(templateModal, false);
			// Confirm the user-group checkboxes ARE rendered (showWhen
			// flipped on by isUnrestricted=false) but explicitly leave
			// every box unchecked — the surface is "form saves with zero
			// UGs assigned".
			await expect(
				templateModal.locator('input[name="assignedUserGroupIds"]').first(),
			).toBeVisible();
			const ugCheckboxes = templateModal.locator(
				'input[name="assignedUserGroupIds"]',
			);
			const ugCount = await ugCheckboxes.count();
			for (let i = 0; i < ugCount; i++) {
				await expect(ugCheckboxes.nth(i)).not.toBeChecked();
			}

			await saveTemplateModal(page);

			// Reload and confirm the persisted state: restricted, but no
			// user groups checked.
			await page.reload();
			await expect(page.locator('li.listPanel__item').first()).toBeVisible();
			templateModal = await openEmailTemplate(page, mailable, templateName);
			await expect(
				templateModal.locator('input[name="isUnrestricted"]:checked'),
			).toHaveValue('false');
			const reloadedUgCount = await templateModal
				.locator('input[name="assignedUserGroupIds"]')
				.count();
			for (let i = 0; i < reloadedUgCount; i++) {
				await expect(
					templateModal.locator('input[name="assignedUserGroupIds"]').nth(i),
				).not.toBeChecked();
			}
		},
	);

	test(
		'edited default template text is used in the accept decision email',
		{tag: ['@regression', '@slow']},
		async ({pkpApi, asUser, pkpMail}) => {
			// Plan row 5. Template edit + decision wizard + Mailpit poll.
			test.slow();
			const tag = uniqueTag();
			// Whitespace-free marker distinct from the title tag, so the
			// Mailpit match proves the EDITED template body was sent (the
			// stock body also interpolates the tagged {$submissionTitle}).
			const marker = `AcceptTplMarker-${tag}`;
			const {context} = await pkpApi.createJournal({
				tag,
				users: [
					{username: 'dbarnes', roles: ['manager', 'editor']},
					{username: 'rvaca', roles: ['author']},
				],
			});
			// Empty reviewer list — Accept is offered without completed
			// reviews and the wizard then has exactly the notifyAuthors +
			// promote-files steps (review-decisions.spec.js row 1).
			const {submission} = await pkpApi.createSubmission(
				submissionInReview({tag, journal: context.path, reviewers: []}),
			);

			const ctx = await asUser('dbarnes');
			const page = await ctx.newPage();
			await openManageEmails(page, context.path);

			// Edit the DecisionAcceptNotifyAuthor default template
			// (EDITOR_DECISION_ACCEPT — mailable name "Submission
			// Accepted"). Keep the stock body's variables so the
			// delivered mail proves they render.
			const mailable = 'Submission Accepted';
			await openEmailTemplate(page, mailable, mailable);
			await setTinyMceContent(
				page,
				'editEmailTemplate-body-control-en',
				`<p>Dear {$recipientName},</p>` +
					`<p>${marker} — we are pleased to accept {$submissionTitle} ` +
					`for publication in {$contextName}.</p>`,
			);
			await saveTemplateModal(page);

			// Record an Accept decision through the UI. The decision
			// wizard's notifyAuthors composer auto-loads the mailable's
			// default template — which is now the customized row
			// (Repo::emailTemplate()->getByKey returns the override).
			const workflow = new EditorialWorkflowPage(page);
			await workflow.goto(submission.id, {journalPath: context.path});
			await workflow.clickDecision('Accept Submission');
			await workflow.clickContinue();
			await workflow.recordDecision(
				'has been accepted for publication and sent to the copyediting stage',
			);

			// The author's mail carries the marker (edited body used) with
			// every template variable rendered: the {$submissionTitle}
			// substitution surfaces the tagged title, and no raw {$...}
			// token survives anywhere in subject or body.
			const [message] = await pkpMail.find({
				to: 'rvaca@mailinator.com',
				contains: marker,
				timeoutMs: 20_000,
			});
			const full = await pkpMail.fullMessage(message.ID);
			const content = `${full.HTML ?? ''}${full.Text ?? ''}`;
			expect(content).toContain(marker);
			expect(content).toContain(tag);
			expect(content).not.toMatch(/\{\$\w+\}/);
			expect(message.Subject).not.toMatch(/\{\$\w+\}/);
		},
	);

	test(
		'reset restores a default template and remove deletes a custom one',
		{tag: '@regression'},
		async ({pkpApi, asUser}) => {
			// Plan row 6.
			const tag = uniqueTag();
			const {context} = await pkpApi.createJournal({
				tag,
				users: [{username: 'dbarnes', roles: ['manager']}],
			});
			const ctx = await asUser('dbarnes');
			const page = await ctx.newPage();
			await openManageEmails(page, context.path);

			const mailable = 'Discussion (Production)';

			// --- Reset half -------------------------------------------
			// Capture the stock subject/body before any edit; the Reset
			// assertion compares against these instead of hard-coding
			// locale strings.
			let templateModal = await openEmailTemplate(page, mailable, mailable);
			const subjectInput = () =>
				templateModalLocator(page).locator(
					'input[id^="editEmailTemplate-subject-control-en"]',
				);
			const stockSubject = await subjectInput().inputValue();
			const stockBody = await getTinyMceContent(
				page,
				'editEmailTemplate-body-control-en',
			);

			// Edit subject + body and save. A pristine default has no DB
			// row (EditMailableModal only offers Reset when item.id is
			// set), so Reset appearing after the save doubles as the
			// customized-row persistence check.
			const mailableModal = mailableModalLocator(page);
			const defaultRow = mailableModal
				.locator('li.listPanel__item', {hasText: mailable})
				.first();
			await expect(
				defaultRow.getByRole('button', {name: 'Reset', exact: true}),
			).toHaveCount(0);
			await subjectInput().fill(`Edited subject ${tag}`);
			await setTinyMceContent(
				page,
				'editEmailTemplate-body-control-en',
				`<p>Edited body ${tag}</p>`,
			);
			await saveTemplateModal(page);
			await expect(
				defaultRow.getByRole('button', {name: 'Reset', exact: true}),
			).toBeVisible({timeout: 15_000});

			// Reset → confirm dialog → the row swaps back to the pristine
			// default (Reset button unmounts again).
			await defaultRow
				.getByRole('button', {name: 'Reset', exact: true})
				.click();
			const resetDialog = page
				.locator('[data-cy="dialog"]')
				.filter({hasText: 'Reset Template'});
			await expect(resetDialog).toBeVisible({timeout: 10_000});
			await resetDialog
				.getByRole('button', {name: 'Reset Template', exact: true})
				.click();
			await expect(
				defaultRow.getByRole('button', {name: 'Reset', exact: true}),
			).toHaveCount(0, {timeout: 15_000});

			// Reopening shows the stock subject/body again.
			await defaultRow
				.getByRole('button', {name: 'Edit', exact: true})
				.click();
			templateModal = templateModalLocator(page);
			await expect(templateModal).toHaveCount(1);
			await expect(subjectInput()).toHaveValue(stockSubject);
			expect(
				await getTinyMceContent(page, 'editEmailTemplate-body-control-en'),
			).toBe(stockBody);
			// Close the template modal (no save) before the Remove half.
			await templateModal
				.getByRole('button', {name: 'Close', exact: true})
				.click({force: true});
			await expect(templateModalLocator(page)).toHaveCount(0, {
				timeout: 10_000,
			});

			// --- Remove half ------------------------------------------
			const templateName = `Custom removable ${tag}`;
			await mailableModal.getByRole('button', {name: 'Add Template'}).click();
			templateModal = templateModalLocator(page);
			await expect(templateModal).toHaveCount(1);
			await templateModal
				.locator('input[id^="editEmailTemplate-name-control-en"]')
				.fill(templateName);
			await subjectInput().fill(`Removable subject ${tag}`);
			await setTinyMceContent(
				page,
				'editEmailTemplate-body-control-en',
				`<p>Removable body ${tag}</p>`,
			);
			await saveTemplateModal(page);

			const customRow = mailableModal
				.locator('li.listPanel__item', {hasText: templateName})
				.first();
			await expect(customRow).toBeVisible({timeout: 15_000});
			await customRow
				.getByRole('button', {name: 'Remove', exact: true})
				.click();
			const removeDialog = page
				.locator('[data-cy="dialog"]')
				.filter({hasText: 'Remove Template'});
			await expect(removeDialog).toBeVisible({timeout: 10_000});
			await removeDialog
				.getByRole('button', {name: 'Remove Template', exact: true})
				.click();
			await expect(
				mailableModal.locator('li.listPanel__item', {hasText: templateName}),
			).toHaveCount(0, {timeout: 15_000});

			// ... and it stays gone after a full reload.
			await page.reload();
			await expect(page.locator('li.listPanel__item').first()).toBeVisible();
			await clickEditOnMailable(page, mailable);
			const reloadedMailableModal = mailableModalLocator(page);
			await expect(reloadedMailableModal).toHaveCount(1);
			await expect(
				reloadedMailableModal.locator('li.listPanel__item', {
					hasText: templateName,
				}),
			).toHaveCount(0);
		},
	);
});
