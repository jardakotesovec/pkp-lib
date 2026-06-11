// @ts-check
const path = require('path');
const {test, expect} = require('../support/base-test.js');
const {SubmissionWizardPage} = require('../pages/SubmissionWizardPage.js');
const {setTinyMceContent} = require('../support/tinymce.js');

/**
 * Reviewer suggestions — docs/e2e/plans/reviewer-suggestions.md (4 rows).
 *
 * publicknowledge ships with reviewerSuggestionEnabled ON (bootstrap
 * enrichment), so the wizard renders the Reviewer Suggestions step by
 * default. Rows 1–2 drive that step end-to-end through the wizard UI;
 * rows 3–4 use the wave-1 `reviewerSuggestions[]` submission-scenario
 * seed (SubmissionBuilderProcessor::seedReviewerSuggestions) to start
 * from a submitted, in-review submission with suggestions attached and
 * exercise the editor-side approval flows.
 */

const ARTICLE_FIXTURE = path.resolve(
	__dirname,
	'..',
	'fixtures',
	'files',
	'default-article.pdf',
);

function uniqueTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

/** Alphanumeric-only variant of the tag, for usernames / name parts. */
function alnum(tag) {
	return tag.replace(/[^a-z0-9]/gi, '');
}

/**
 * Submitted submission in external review (round 1, no reviewers
 * assigned yet) with reviewer suggestions attached at submit parity.
 */
function inReviewWithSuggestionsSpec({tag, title, suggestions}) {
	return {
		tag,
		journal: 'publicknowledge',
		submitter: 'atester',
		section: 'ART',
		locale: 'en',
		participants: [{user: 'dbarnes', role: 'editor'}],
		decisions: [{type: 'sendExternalReview', by: 'dbarnes'}],
		reviewRounds: [{reviewers: []}],
		reviewerSuggestions: suggestions,
		publications: [{metadata: {title: {en: title}}}],
	};
}

/**
 * The legacy reviewer form pre-fills responseDueDate/reviewDueDate from
 * numWeeksPerResponse/numWeeksPerReview — both 4 on publicknowledge, so
 * the pair collides and the form's date validator blocks the submit.
 * Bump the review due date one day via the jQuery datepicker (the only
 * writer that keeps the alt-field, display input and validation hooks
 * in sync). Mirrors reviewer-assignment.spec.js.
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} form
 */
async function ensureDueDatesOrdered(page, form) {
	const responseDueHidden = form.locator('input[name="responseDueDate"]');
	const reviewDueHidden = form.locator('input[name="reviewDueDate"]');
	await expect(responseDueHidden).not.toHaveValue('');
	await expect(reviewDueHidden).not.toHaveValue('');
	const responseDueValue = await responseDueHidden.inputValue();
	const reviewDueValue = await reviewDueHidden.inputValue();
	if (responseDueValue === reviewDueValue) {
		const bumped = new Date(responseDueValue);
		bumped.setUTCDate(bumped.getUTCDate() + 1);
		const bumpedIso = bumped.toISOString().slice(0, 10);
		await page.evaluate((nextDate) => {
			const altField = document.querySelector('input[name="reviewDueDate"]');
			if (!altField) {
				throw new Error('reviewDueDate alt-field not found');
			}
			const visibleId = altField.id.replace(/-altField$/, '');
			const visible = document.getElementById(visibleId);
			if (!visible) {
				throw new Error(`reviewDueDate visible input ${visibleId} not found`);
			}
			const $ = window.jQuery || window.$;
			$(visible).datepicker('setDate', nextDate);
			$(visible).trigger('change');
			$(visible).datepicker('hide');
			visible.blur();
		}, bumpedIso);
		await expect(reviewDueHidden).toHaveValue(bumpedIso);
	}
}

/**
 * Fill and save the wizard's Add/Edit Reviewer Suggestion side-modal.
 * Field control ids follow the PkpForm convention
 * `{formId}-{field}-control[-{locale}]` with formId `reviewerSuggestions`.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{givenName?: string, familyName?: string, email?: string, affiliation?: string, reason?: string}} values
 */
async function fillSuggestionModal(page, values) {
	const modal = page.locator('[data-cy="active-modal"]');
	// The side-modal wrapper reports `visibility: hidden` (its content
	// is re-shown via an inner element) — anchor readiness on a control
	// that every suggestion form renders instead of the wrapper.
	await expect(
		modal.locator('#reviewerSuggestions-email-control'),
	).toBeVisible({timeout: 10_000});
	if (values.givenName !== undefined) {
		await modal
			.locator('#reviewerSuggestions-givenName-control-en')
			.fill(values.givenName);
	}
	if (values.familyName !== undefined) {
		await modal
			.locator('#reviewerSuggestions-familyName-control-en')
			.fill(values.familyName);
	}
	if (values.email !== undefined) {
		await modal
			.locator('#reviewerSuggestions-email-control')
			.fill(values.email);
	}
	if (values.affiliation !== undefined) {
		await modal
			.locator('#reviewerSuggestions-affiliation-control-en')
			.fill(values.affiliation);
	}
	if (values.reason !== undefined) {
		await setTinyMceContent(
			page,
			'reviewerSuggestions-suggestionReason-control-en',
			values.reason,
		);
	}
	await Promise.all([
		page.waitForResponse(
			(res) =>
				/\/api\/v1\/submissions\/\d+\/reviewers\/suggestions/.test(res.url()) &&
				res.ok(),
			{timeout: 15_000},
		),
		modal.getByRole('button', {name: 'Save', exact: true}).click(),
	]);
	await expect(modal).toHaveCount(0, {timeout: 10_000});
}

test.describe('Reviewer suggestions', () => {
	test.use({user: 'atester'});

	test('author manages suggestions in the wizard: step position, add, edit, delete, review panel', {tag: '@regression'}, async ({page}) => {
		const tag = uniqueTag('rsw');
		const familyA = `Keeplesse${alnum(tag)}`;
		const familyB = `Stayworth${alnum(tag)}`;

		const wizard = new SubmissionWizardPage(page);
		await wizard.goto();
		await wizard.start({title: `Sugmanage-${tag}`, section: 'Articles'});

		// The step rail renders the Reviewer Suggestions step at its
		// expected position: files → details → contributors → for the
		// editors → reviewer suggestions → review.
		await expect(page.locator('.pkpSteps__step__label')).toHaveText([
			/Upload Files/,
			/Details/,
			/Contributors/,
			/For the Editors/,
			/Reviewer Suggestions/,
			/^\d+ Review$/,
		]);

		// Walk forward to the Reviewer Suggestions step — unstarted steps
		// don't render as clickable rail pills, so the rail can't jump
		// ahead.
		await wizard.expectStep('Upload Files');
		await wizard.continueStep();
		await wizard.expectStep('Details');
		await wizard.continueStep();
		await wizard.expectStep('Contributors');
		await wizard.continueStep();
		await wizard.expectStep('For the Editors');
		await wizard.continueStep();
		await wizard.expectStep('Reviewer Suggestions');
		const panel = page.locator('.reviewerSuggestionsListPanel');
		await expect(panel).toBeVisible({timeout: 10_000});

		// Add the first suggestion with the full field set.
		await panel.getByRole('button', {name: 'Add Reviewer Suggestion'}).click();
		await fillSuggestionModal(page, {
			givenName: 'Alice',
			familyName: familyA,
			email: `alice.${alnum(tag)}@mailinator.com`,
			affiliation: `AffOne-${tag}`,
			reason: `Reason-${tag} subject-matter expert`,
		});
		const itemA = panel.locator('.listPanel__item').filter({hasText: familyA});
		await expect(itemA).toBeVisible({timeout: 10_000});
		await expect(itemA).toContainText(`AffOne-${tag}`);
		await expect(itemA).toContainText(`alice.${alnum(tag)}@mailinator.com`);

		// Edit it (change the affiliation) and verify the list updates.
		await itemA.getByRole('button', {name: 'Edit'}).click();
		await fillSuggestionModal(page, {affiliation: `AffTwo-${tag}`});
		await expect(itemA).toContainText(`AffTwo-${tag}`, {timeout: 10_000});

		// Add a second suggestion, then delete the first.
		await panel.getByRole('button', {name: 'Add Reviewer Suggestion'}).click();
		await fillSuggestionModal(page, {
			givenName: 'Bob',
			familyName: familyB,
			email: `bob.${alnum(tag)}@mailinator.com`,
			affiliation: `AffThree-${tag}`,
			reason: `Reason-${tag} methods expert`,
		});
		await expect(
			panel.locator('.listPanel__item').filter({hasText: familyB}),
		).toBeVisible({timeout: 10_000});

		await itemA.getByRole('button', {name: 'Delete'}).click();
		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible({timeout: 10_000});
		await expect(dialog).toContainText('Delete Reviewer Suggestion');
		await dialog
			.getByRole('button', {name: 'Delete Reviewer Suggestion'})
			.click();
		await expect(itemA).toHaveCount(0, {timeout: 10_000});

		// The remaining suggestion appears on the Review step's panel.
		await wizard.continueStep();
		await wizard.expectStep('Review');
		const reviewPanel = page
			.locator('.submissionWizard__reviewPanel')
			.filter({
				has: page.getByRole('heading', {name: 'Reviewer Suggestions'}),
			});
		await expect(reviewPanel).toBeVisible({timeout: 15_000});
		await expect(reviewPanel).toContainText(`Bob ${familyB}`);
		await expect(reviewPanel).toContainText(`bob.${alnum(tag)}@mailinator.com`);
		await expect(reviewPanel).not.toContainText(familyA);
	});

	test('suggestions survive submit and reach the editor workflow', {tag: '@regression'}, async ({page, asUser}) => {
		const tag = uniqueTag('rss');
		const family = `Throughton${alnum(tag)}`;
		const title = `Sugsubmit-${tag}`;

		const wizard = new SubmissionWizardPage(page);
		await wizard.goto();
		// Reviews section: abstracts not required on the bootstrap
		// journal, so the submit gate only needs title + file.
		await wizard.start({title, section: 'Reviews'});
		const submissionId = wizard.currentSubmissionId();
		expect(submissionId).toBeTruthy();

		// Step 1 — upload the article file via the wizard's plupload UI.
		const fileInput = page.locator('input[type="file"]').first();
		await expect(fileInput).toBeAttached({timeout: 15_000});
		const [uploadResp] = await Promise.all([
			page.waitForResponse(
				(res) =>
					res.request().method() === 'POST' &&
					/\/api\/v1\/submissions\/\d+\/files$/.test(res.url()) &&
					res.ok(),
				{timeout: 30_000},
			),
			fileInput.setInputFiles(ARTICLE_FIXTURE),
		]);
		expect(uploadResp.ok()).toBeTruthy();
		const listItem = page.locator('.listPanel__item--submissionFile').first();
		await expect(listItem).toBeVisible({timeout: 15_000});
		const articleTextBtn = listItem
			.locator('.listPanel--submissionFiles__setGenreButton')
			.filter({hasText: 'Article Text'})
			.first();
		await Promise.all([
			page.waitForResponse(
				(res) =>
					res.request().method() === 'POST' &&
					/\/api\/v1\/submissions\/\d+\/files\/\d+/.test(res.url()) &&
					res.ok(),
				{timeout: 15_000},
			),
			articleTextBtn.click(),
		]);

		// Step 2 — Details: the publication title gate.
		await wizard.continueStep();
		await wizard.expectStep('Details');
		await wizard.setTitle(title, 'en');
		// Step 3 — Contributors (atester auto-seeded).
		await wizard.continueStep();
		await wizard.expectStep('Contributors');
		// Step 4 — For the Editors (nothing required).
		await wizard.continueStep();
		await wizard.expectStep('For the Editors');
		// Step 5 — Reviewer Suggestions: add one suggestion.
		await wizard.continueStep();
		await wizard.expectStep('Reviewer Suggestions');
		await page
			.locator('.reviewerSuggestionsListPanel')
			.getByRole('button', {name: 'Add Reviewer Suggestion'})
			.click();
		await fillSuggestionModal(page, {
			givenName: 'Carla',
			familyName: family,
			email: `carla.${alnum(tag)}@mailinator.com`,
			affiliation: `Affsubmit-${tag}`,
			reason: `Reason-${tag} survives submit`,
		});
		await expect(
			page.locator('.listPanel__item').filter({hasText: family}),
		).toBeVisible({timeout: 10_000});

		// Step 6 — Review: the suggestion shows in the review panel and
		// Submit completes.
		await wizard.continueStep();
		await wizard.expectStep('Review');
		const reviewPanel = page
			.locator('.submissionWizard__reviewPanel')
			.filter({
				has: page.getByRole('heading', {name: 'Reviewer Suggestions'}),
			});
		await expect(reviewPanel).toContainText(`Carla ${family}`, {timeout: 15_000});

		// Copyright gate only renders when the journal configures a
		// copyrightNotice — accept it when present.
		const copyright = page.locator(
			'input[name="confirmCopyright"][type="checkbox"]',
		);
		if (await copyright.first().isVisible().catch(() => false)) {
			await copyright.first().check();
		}

		const submitBtn = page.getByRole('button', {name: /^Submit$/});
		await expect(submitBtn).toBeVisible({timeout: 15_000});
		await submitBtn.scrollIntoViewIfNeeded();
		await expect(submitBtn).toBeEnabled({timeout: 10_000});
		await submitBtn.click();
		const confirmDialog = page.getByRole('dialog');
		await expect(confirmDialog).toBeVisible({timeout: 10_000});
		await confirmDialog.getByRole('button', {name: 'Submit', exact: true}).click();
		await expect(
			page.getByRole('heading', {name: 'Submission complete'}),
		).toBeVisible({timeout: 30_000});

		// Editor side: dbarnes opens the workflow and sees the
		// suggestion with name + affiliation under "Reviewers Suggested
		// by Author".
		const editorCtx = await asUser('dbarnes');
		const editorPage = await editorCtx.newPage();
		await editorPage.goto(
			`/index.php/publicknowledge/en/dashboard/editorial?workflowSubmissionId=${submissionId}`,
		);
		const suggestionManager = editorPage.locator(
			'[data-cy="reviewer-suggestion-manager"]',
		);
		await expect(suggestionManager).toBeVisible({timeout: 20_000});
		await expect(suggestionManager).toContainText('Reviewers Suggested by Author');
		await expect(suggestionManager).toContainText(`Carla ${family}`);
		await expect(suggestionManager).toContainText(`Affsubmit-${tag}`);
	});

	test('editor approves a suggestion into Add Reviewer (create-new mode, prefilled)', {tag: '@regression'}, async ({pkpApi, asUser}) => {
		const tag = uniqueTag('rsc');
		const family = `Newbright${alnum(tag)}`;
		const email = `nova.${alnum(tag)}@mailinator.com`;
		const {submission} = await pkpApi.createSubmission(
			inReviewWithSuggestionsSpec({
				tag,
				title: `Sugcreate-${tag}`,
				suggestions: [
					{
						givenName: 'Nova',
						familyName: family,
						email,
						affiliation: `Affcreate-${tag}`,
						suggestionReason: `Reason-${tag} new to the journal`,
					},
				],
			}),
		);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		await page.goto(
			`/index.php/publicknowledge/en/dashboard/editorial?workflowSubmissionId=${submission.id}`,
		);

		const suggestionManager = page.locator(
			'[data-cy="reviewer-suggestion-manager"]',
		);
		await expect(suggestionManager).toBeVisible({timeout: 20_000});
		await expect(suggestionManager).toContainText(`Nova ${family}`);

		// Per-suggestion actions menu (headlessui — portal to the page).
		await suggestionManager
			.getByRole('button', {name: `Nova ${family} More Actions`})
			.click();
		await page.getByRole('menuitem', {name: 'Add Reviewer'}).click();

		// The suggestion's email matches no existing user, so the form
		// opens in create-new mode, prefilled from the suggestion.
		const modal = page.getByRole('dialog', {name: 'Add Reviewer', exact: true});
		await expect(modal).toBeVisible({timeout: 15_000});
		const createForm = modal.locator('#createReviewerForm').last();
		await expect(createForm).toBeVisible({timeout: 20_000});
		await expect(createForm.locator('input[name="givenName[en]"]')).toHaveValue('Nova');
		await expect(createForm.locator('input[name="familyName[en]"]')).toHaveValue(family);
		await expect(createForm.locator('input[name="email"]')).toHaveValue(email);

		// Complete the create-new required fields the suggestion can't
		// provide: username (+ skip the welcome email).
		await createForm
			.locator('input[name="username"]')
			.fill(`rev${alnum(tag)}`);
		const skipEmail = createForm.locator('input[name="skipEmail"]');
		if (await skipEmail.isVisible().catch(() => false)) {
			await skipEmail.check();
		}
		const userGroupSelect = createForm.locator('select[name="userGroupId"]');
		if (await userGroupSelect.isVisible().catch(() => false)) {
			await userGroupSelect.selectOption({label: 'Reviewer'});
		}
		await ensureDueDatesOrdered(page, createForm);

		const submitButton = createForm.getByRole('button', {
			name: 'Add Reviewer',
			exact: true,
		});
		await expect(submitButton).toBeEnabled({timeout: 5_000});
		await submitButton.click();
		await expect(modal).toBeHidden({timeout: 20_000});

		// The new reviewer is assigned to the round…
		const reviewerManager = page.locator('[data-cy="reviewer-manager"]');
		await expect(reviewerManager).toContainText(`Nova ${family}`, {timeout: 20_000});
		// …and the suggestion left the unapproved list (it was the only
		// one, so the whole panel disappears).
		await expect(suggestionManager).toHaveCount(0, {timeout: 20_000});

		// DB round-trip: the suggestion row is approved and linked to
		// the created reviewer account.
		const res = await page.request.get(
			`/index.php/publicknowledge/api/v1/submissions/${submission.id}/reviewers/suggestions`,
		);
		expect(res.ok()).toBeTruthy();
		const body = await res.json();
		const suggestion = body.items.find((item) => item.email === email);
		expect(suggestion.approvedAt).toBeTruthy();
		expect(suggestion.reviewerId).toBeTruthy();
	});

	test('editor approves a suggestion matching an existing user via advanced search', {tag: '@regression'}, async ({pkpApi, asUser}) => {
		const tag = uniqueTag('rse');
		const {submission} = await pkpApi.createSubmission(
			inReviewWithSuggestionsSpec({
				tag,
				title: `Sugexisting-${tag}`,
				suggestions: [
					{
						// jjanssen — an existing publicknowledge reviewer.
						givenName: 'Julie',
						familyName: 'Janssen',
						email: 'jjanssen@mailinator.com',
						affiliation: 'Utrecht University',
						suggestionReason: `Reason-${tag} has reviewed before`,
					},
				],
			}),
		);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		await page.goto(
			`/index.php/publicknowledge/en/dashboard/editorial?workflowSubmissionId=${submission.id}`,
		);

		const suggestionManager = page.locator(
			'[data-cy="reviewer-suggestion-manager"]',
		);
		await expect(suggestionManager).toBeVisible({timeout: 20_000});
		await suggestionManager
			.getByRole('button', {name: 'Julie Janssen More Actions'})
			.click();
		await page.getByRole('menuitem', {name: 'Add Reviewer'}).click();

		// Email matches an enrolled reviewer → routes to the advanced
		// search/selection flow, not the create-new form: the assignment
		// form opens with the matching account already selected.
		const modal = page.getByRole('dialog', {name: 'Add Reviewer', exact: true});
		await expect(modal).toBeVisible({timeout: 15_000});
		const regularForm = modal.locator('#regularReviewerForm').last();
		await expect(regularForm).toBeVisible({timeout: 20_000});
		await expect(regularForm.locator('#selectedReviewerName')).toContainText(
			'Julie Janssen',
		);
		await expect(modal.locator('#createReviewerForm')).toHaveCount(0);

		const reviewerForm = regularForm.locator('#advancedSearchReviewerForm');
		await ensureDueDatesOrdered(page, reviewerForm);
		const submitButton = reviewerForm.getByRole('button', {
			name: 'Add Reviewer',
			exact: true,
		});
		await expect(submitButton).toBeEnabled({timeout: 5_000});
		await submitButton.click();
		await expect(modal).toBeHidden({timeout: 20_000});

		// Assignment exists and the suggestion is linked to jjanssen's
		// existing account.
		const reviewerManager = page.locator('[data-cy="reviewer-manager"]');
		await expect(reviewerManager).toContainText('Julie Janssen', {timeout: 20_000});
		await expect(suggestionManager).toHaveCount(0, {timeout: 20_000});

		const res = await page.request.get(
			`/index.php/publicknowledge/api/v1/submissions/${submission.id}/reviewers/suggestions`,
		);
		expect(res.ok()).toBeTruthy();
		const body = await res.json();
		const suggestion = body.items.find(
			(item) => item.email === 'jjanssen@mailinator.com',
		);
		expect(suggestion.approvedAt).toBeTruthy();
		expect(suggestion.reviewerId).toBe(suggestion.existingUserId);
	});
});
