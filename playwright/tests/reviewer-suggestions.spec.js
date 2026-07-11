// @ts-check
const {test, expect} = require('../support/base-test.js');
const {ReviewerManagerPage} = require('../pages/ReviewerManagerPage.js');
const {SubmissionWizardPage} = require('../pages/SubmissionWizardPage.js');
const {WorkflowSettingsPage} = require('../pages/WorkflowSettingsPage.js');

/**
 * Reviewer suggestions — one test per canonical scenario of
 * docs/product/specs/reviewer-suggestions.md (7 scenarios → 7 tests).
 * The feature is shared pkp-lib (wizard step ReviewerSuggestionsListPanel,
 * workflow-side ReviewerSuggestionManager, Add Reviewer picker block), so
 * the spec lives here — mirroring assign-and-manage-reviewers.spec.js;
 * the scenario payloads necessarily use OJS vocabulary (publicknowledge /
 * ART / sendExternalReview), matching the bootstrap context the suite
 * runs against.
 *
 * Coverage per scenario:
 *   s1  wizard step: rail order, required-field validation (Family Name
 *       exempt), two suggestions added (one with an existing account's
 *       email), Review-step recap (name/email/affiliation, no reason)
 *   s2  wizard housekeeping: edit prefill+update, duplicate-email guard,
 *       delete dialog, empty list → recap warning + Submit still works
 *   s3  post-submit: author tracking view has no panel; manager sees the
 *       read-only "Reviewers Suggested by Author" panel below
 *       Participants; write API refused (the freeze); empty → no panel
 *   s4  review stage: suggestion row's "…" → Add Reviewer opens the
 *       assignment form with the existing reviewer preselected (no
 *       search grid); completing removes it live from the review panel
 *       and picker block while the submission-stage panel keeps it
 *   s5  unknown email: picker block above "Locate a Reviewer" →
 *       Select → prefilled Create New Reviewer → account created,
 *       assigned, suggestion consumed
 *   s6  ordinary-search assignment of a suggested email consumes the
 *       suggestion anyway (match is by email, not by entry point)
 *   s7  the journal dial: untick via Settings → Workflow → Review hides
 *       the wizard step, panels and block (data kept); re-enable brings
 *       everything back — plus the RS-A Assistant A/B (see below)
 *
 * As-built deviations the spec verifies (do NOT "fix" these to intent —
 * see the spec's Known deviations):
 *  - RS-A: on a suggestions-enabled journal an assigned Assistant gets a
 *    blocking error dialog on workflow load and loses the Add Reviewer
 *    button entirely; dial off restores it (A/B asserted inside s7).
 *  - RS-C: the duplicate-email refusal is raw framework wording
 *    "The email has already been taken." (s2).
 *  - RS-F: used and open suggestions are indistinguishable on the
 *    submission-stage panel (s4).
 *  - Ledger row 52 (assign-and-manage-reviewers): the picker-block
 *    Select buttons carry "Select undefined" accessible names — the
 *    POM's selectSuggestion clicks by position, not name.
 *
 * Parallel-safety: every submission (and the s7 scratch journal) is
 * per-test; tags are single hyphenless alphanumeric tokens riding in the
 * submission title; publicknowledge is used read-only + additively (its
 * reviewerSuggestionEnabled bootstrap default is ON and is never
 * touched — the dial test runs on the scratch journal); no seeded user
 * gains a role anywhere (throwaway users carry the s7 roles); no Mailpit
 * reads (suggestions are deliberately mail-silent; the assignment mails
 * are owned by assign-and-manage-reviewers).
 */

test.use({user: 'author.alex'}); // the default actor: a pure-author account

const JOURNAL = 'publicknowledge';

/** A unique, hyphenless, alphanumeric tag (parallel isolation). */
function uniqueTag(prefix = 'rs') {
	const workerLetter = String.fromCharCode(
		97 + (test.info().parallelIndex % 26),
	);
	let suffix = '';
	while (suffix.length < 6) {
		suffix += Math.random().toString(36).replace(/[^a-z0-9]/g, '');
	}
	return `${prefix}${workerLetter}${suffix.slice(0, 6)}`;
}

/** The wizard address for a given submission. */
function wizardUrl(submissionId, journalPath = JOURNAL) {
	return `/index.php/${journalPath}/submission?id=${submissionId}`;
}

/** The editorial workflow address for a given submission. */
function workflowUrl(submissionId, journalPath = JOURNAL) {
	return `/index.php/${journalPath}/en/dashboard/editorial?workflowSubmissionId=${submissionId}`;
}

/** Read the logged-in page's CSRF token (exposed on any backend page). */
async function readCsrf(page) {
	await page.waitForFunction(() => !!window.pkp?.currentUser?.csrfToken, null, {
		timeout: 15_000,
	});
	return page.evaluate(() => window.pkp.currentUser.csrfToken);
}

/**
 * Walk the wizard forward with Continue until `stepName` is the current
 * step. Step counts differ per journal (Reviewer Suggestions is
 * conditional), so walk by name, not by count.
 */
async function walkTo(wizard, stepName, max = 7) {
	const current = wizard.page.locator('.pkpSteps__step__label--current');
	const done = new RegExp(
		stepName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$',
	);
	for (let i = 0; i < max; i++) {
		const label = ((await current.textContent()) ?? '').trim();
		if (done.test(label)) {
			return;
		}
		await wizard.continueStep();
	}
	await wizard.expectStep(stepName);
}

/**
 * Wait out the Review step's transient "Checking your submission"
 * state (the entry validation call).
 */
async function awaitReviewCheck(page) {
	await expect(page.getByText('Checking your submission')).toBeHidden({
		timeout: 30_000,
	});
}

/** Scenario spec for a resumable wizard draft (submitted: false). */
function draftSpec({
	tag,
	title,
	journal = JOURNAL,
	submitter = 'author.alex',
	abstract,
	reviewerSuggestions,
}) {
	return {
		tag,
		journal,
		submitter,
		section: 'ART',
		locale: 'en',
		submitted: false,
		...(reviewerSuggestions ? {reviewerSuggestions} : {}),
		publications: [
			{
				metadata: {
					title: {en: title},
					...(abstract ? {abstract: {en: abstract}} : {}),
				},
			},
		],
	};
}

/**
 * Scenario spec for a submission sitting in external review round 1
 * with reviewer suggestions recorded before submit.
 */
function inReviewSpec({
	tag,
	reviewerSuggestions,
	journal = JOURNAL,
	submitter = 'author.alex',
	participants = [{user: 'editor.diana', role: 'editor'}],
	decisions = [{type: 'sendExternalReview', by: 'editor.diana'}],
}) {
	return {
		tag,
		journal,
		submitter,
		section: 'ART',
		locale: 'en',
		participants,
		decisions,
		reviewRounds: [{reviewers: []}],
		reviewerSuggestions,
		publications: [
			{
				versionStage: 'AO',
				metadata: {
					title: {en: `Reviewer suggestions ${tag}`},
					abstract: {en: `<p>Reviewer-suggestions fixture ${tag}.</p>`},
				},
				published: false,
			},
		],
	};
}

/** Confirm any "discard changes?" dialog raised by a form's warnOnClose guard. */
async function dismissDiscardDialog(page) {
	const dialog = page.locator('[data-cy="dialog"]');
	if (await dialog.isVisible().catch(() => false)) {
		const ok = dialog.getByRole('button', {name: /^(OK|Yes|Discard)$/}).first();
		if (await ok.isVisible().catch(() => false)) {
			await ok.click();
		}
	}
}

/** Click a stage entry in the workflow page's side navigation. */
async function openWorkflowStage(page, label) {
	await page
		.locator('[data-cy="active-modal"]')
		.first()
		.locator('nav')
		.getByText(label, {exact: true})
		.first()
		.click();
}

test.describe('Reviewer suggestions', () => {
	test('s1: the author suggests two reviewers in the wizard, with required-field validation and the Review recap', async ({
		page,
		pkpApi,
	}) => {
		test.slow(); // full wizard walk with two modal round-trips
		const tag = uniqueTag('rsa');
		const {submission} = await pkpApi.createSubmission(
			draftSpec({tag, title: `Wizard suggestions ${tag}`}),
		);

		const wizard = new SubmissionWizardPage(page);
		await page.goto(wizardUrl(submission.id));
		await expect(page.locator('.submissionWizard')).toBeVisible({
			timeout: 20_000,
		});

		// The step sits between For the Editors and Review (rule 1).
		await expect(page.locator('.pkpSteps__step__label')).toHaveText([
			/Upload Files\s*$/,
			/Details\s*$/,
			/Contributors\s*$/,
			/For the Editors\s*$/,
			/Reviewer Suggestions\s*$/,
			/Review\s*$/,
		]);

		await walkTo(wizard, 'Reviewer Suggestions');
		await expect(
			page.getByRole('heading', {
				name: 'Make a Submission: Reviewer Suggestions',
			}),
		).toBeVisible();

		// Empty list state + the add button.
		const panel = wizard.reviewerSuggestionsPanel();
		await expect(panel).toContainText('Reviewer Suggestions');
		await expect(panel).toContainText('No items found.');

		// Saving the form empty flags the four required fields; Family
		// Name is the one name field with no requirement (Fields table).
		let modal = await wizard.openAddSuggestionModal();
		await modal.getByRole('button', {name: 'Save', exact: true}).click();
		await expect(wizard.suggestionFieldError('givenName')).toBeVisible();
		await expect(wizard.suggestionFieldError('email', null)).toBeVisible();
		await expect(wizard.suggestionFieldError('affiliation')).toBeVisible();
		await expect(wizard.suggestionFieldError('suggestionReason')).toBeVisible();
		await expect(wizard.suggestionFieldError('familyName')).toHaveCount(0);

		// First suggestion: an email that matches no account.
		const gretaEmail = `greta${tag}@mailinator.com`;
		await wizard.fillSuggestionForm({
			givenName: 'Greta',
			familyName: 'Probe',
			email: gretaEmail,
			affiliation: 'Probe University',
			reason: `<p>Methods expert ${tag}</p>`,
		});
		await wizard.saveSuggestionForm(modal);
		const greta = wizard.suggestionItem('Greta Probe');
		await expect(greta).toBeVisible();
		await expect(greta).toContainText('Probe University'); // affiliation badge
		await expect(greta).toContainText(gretaEmail); // email subtitle

		// Second suggestion: a colleague whose email already has an
		// account at this journal — accepted and listed the same way.
		modal = await wizard.openAddSuggestionModal();
		await wizard.fillSuggestionForm({
			givenName: 'Julia',
			familyName: 'Colleague',
			email: 'reviewer.julia@mailinator.com',
			affiliation: 'Colleague College',
			reason: `<p>Knows the field ${tag}</p>`,
		});
		await wizard.saveSuggestionForm(modal);
		await expect(wizard.suggestionItem('Julia Colleague')).toBeVisible();

		// The Review recap lists name, email and affiliation — not the
		// reason (rule 2).
		await walkTo(wizard, 'Review');
		await awaitReviewCheck(page);
		const recap = wizard.reviewPanel('Reviewer Suggestions');
		await expect(recap).toContainText('Greta Probe');
		await expect(recap).toContainText(gretaEmail);
		await expect(recap).toContainText('Probe University');
		await expect(recap).toContainText('Julia Colleague');
		await expect(recap).toContainText('reviewer.julia@mailinator.com');
		await expect(recap).not.toContainText('Methods expert');
		await expect(
			recap.getByText('No reviewers have been suggested'),
		).toHaveCount(0);
	});

	test('s2: edit, the duplicate-email guard, the delete dialog, and an emptied list still submits', async ({
		page,
		pkpApi,
	}) => {
		test.slow(); // wizard walk + three modal round-trips + submit
		const tag = uniqueTag('rsb');
		const ritaEmail = `rita${tag}@mailinator.com`;
		const {submission} = await pkpApi.createSubmission(
			draftSpec({
				tag,
				title: `Housekeeping ${tag}`,
				abstract: `<p>Abstract for ${tag}.</p>`,
				reviewerSuggestions: [
					{
						givenName: 'Rita',
						familyName: 'One',
						email: ritaEmail,
						affiliation: 'Alpha University',
						suggestionReason: `<p>First pick ${tag}</p>`,
					},
					{
						givenName: 'Sami',
						familyName: 'Two',
						email: `sami${tag}@mailinator.com`,
						affiliation: 'Beta College',
						suggestionReason: `<p>Second pick ${tag}</p>`,
					},
				],
			}),
		);

		const wizard = new SubmissionWizardPage(page);
		await page.goto(wizardUrl(submission.id));
		await expect(page.locator('.submissionWizard')).toBeVisible({
			timeout: 20_000,
		});
		await walkTo(wizard, 'Reviewer Suggestions');
		await expect(wizard.suggestionItem('Rita One')).toBeVisible();
		await expect(wizard.suggestionItem('Sami Two')).toBeVisible();

		// Edit reopens the side panel prefilled; the changed affiliation
		// shows in the list after saving.
		let modal = await wizard.openEditSuggestionModal('Rita One');
		await expect(wizard.suggestionFieldControl('givenName')).toHaveValue(
			'Rita',
		);
		await expect(wizard.suggestionFieldControl('email', null)).toHaveValue(
			ritaEmail,
		);
		await wizard.fillSuggestionForm({affiliation: 'Beta Institute'});
		await wizard.saveSuggestionForm(modal);
		await expect(wizard.suggestionItem('Rita One')).toContainText(
			'Beta Institute',
		);

		// A third suggestion reusing the first one's email is refused on
		// the Email field.
		// ⚠ As-built: the refusal is raw framework wording — "The email
		// has already been taken." (spec Known deviations, RS-C).
		modal = await wizard.openAddSuggestionModal();
		await wizard.fillSuggestionForm({
			givenName: 'Tres',
			familyName: 'Third',
			email: ritaEmail,
			affiliation: 'Gamma Institute',
			reason: `<p>Duplicate try ${tag}</p>`,
		});
		await modal.getByRole('button', {name: 'Save', exact: true}).click();
		// The message renders twice — the field error span AND the error
		// summary's "Go to Email: …" jump link; anchor the exact-text span.
		await expect(
			modal.getByText('The email has already been taken.', {exact: true}),
		).toBeVisible();
		await modal
			.getByRole('button', {name: 'Close', exact: true})
			.first()
			.click();
		await dismissDiscardDialog(page);
		await expect(
			modal.locator('#reviewerSuggestions-email-control'),
		).toBeHidden({timeout: 15_000});

		// Deleting runs through the confirmation dialog (rule 1's verbatim
		// title/message/buttons live in the POM helper's locators).
		await wizard.deleteSuggestion('Sami Two');

		// Emptying the whole list is allowed…
		await wizard.deleteSuggestion('Rita One');
		await expect(wizard.reviewerSuggestionsPanel()).toContainText(
			'No items found.',
		);

		// …the Review step warns, and Submit still completes (rule 2).
		await walkTo(wizard, 'Review');
		await awaitReviewCheck(page);
		await expect(
			wizard
				.reviewPanel('Reviewer Suggestions')
				.getByText('No reviewers have been suggested for this submission.'),
		).toBeVisible();
		await expect(wizard.reviewErrorsBanner).toBeHidden();
		const dialog = await wizard.openSubmitDialog();
		await dialog.getByRole('button', {name: 'Submit'}).click();
		await expect(
			page.getByRole('heading', {name: 'Submission complete'}),
		).toBeVisible({timeout: 20_000});
	});

	test('s3: after submit the author loses the list, the manager sees a read-only panel below Participants, and writes are frozen', async ({
		page,
		asUser,
		pkpApi,
	}) => {
		const tag = uniqueTag('rsc');
		const title = `Frozen ${tag}`;
		// A: submitted at the submission stage, with two suggestions.
		const {submission: subA} = await pkpApi.createSubmission({
			...draftSpec({
				tag,
				title,
				reviewerSuggestions: [
					{
						givenName: 'Freda',
						familyName: 'Frost',
						email: `freda${tag}@mailinator.com`,
						affiliation: 'Frost University',
						suggestionReason: `<p>Cold-methods expert ${tag}</p>`,
					},
					{
						givenName: 'Frank',
						familyName: 'Field',
						email: `frank${tag}@mailinator.com`,
						affiliation: 'Field Institute',
						suggestionReason: `<p>Field-work veteran ${tag}</p>`,
					},
				],
			}),
			submitted: true,
		});
		// B: submitted with no suggestions at all.
		const {submission: subB} = await pkpApi.createSubmission({
			...draftSpec({tag: `${tag}b`, title: `Empty ${tag}`}),
			submitted: true,
		});

		// The author's own tracking view has no reviewer suggestions area
		// (Actors table: the author never sees the list again).
		await page.goto(
			`/index.php/${JOURNAL}/en/dashboard/mySubmissions?workflowSubmissionId=${subA.id}`,
			{waitUntil: 'commit'},
		);
		await expect(
			page.locator('[data-cy="active-modal"]').first(),
		).toContainText(title, {timeout: 20_000});
		await expect(
			page.locator('[data-cy="reviewer-suggestion-manager"]'),
		).toHaveCount(0);

		// The manager's workflow page: the panel sits directly below
		// Participants, read-only, showing name + affiliation + reason.
		const mgrCtx = await asUser('manager.maya');
		const mgrPage = await mgrCtx.newPage();
		const rm = new ReviewerManagerPage(mgrPage);
		await mgrPage.goto(workflowUrl(subA.id), {waitUntil: 'commit'});
		await expect(
			mgrPage.locator('[data-cy="participant-manager"]'),
		).toBeVisible({timeout: 20_000});
		await expect(rm.suggestionManager).toBeVisible();
		await expect(rm.suggestionManager).toContainText(
			'Reviewers Suggested by Author',
		);
		await expect(rm.suggestionRow('Freda Frost')).toContainText(
			'Frost University',
		);
		await expect(rm.suggestionRow('Freda Frost')).toContainText(
			`Cold-methods expert ${tag}`,
		);
		await expect(rm.suggestionRow('Frank Field')).toBeVisible();
		// No edit, delete or add controls anywhere (submission stage is
		// read-only — rule 6).
		await expect(rm.suggestionManager.getByRole('button')).toHaveCount(0);
		// Placement: the panel follows the Participants panel in the side
		// column.
		expect(
			await mgrPage.evaluate(() => {
				const participants = document.querySelector(
					'[data-cy="participant-manager"]',
				);
				const suggestions = document.querySelector(
					'[data-cy="reviewer-suggestion-manager"]',
				);
				return Boolean(
					participants &&
						suggestions &&
						participants.compareDocumentPosition(suggestions) &
							Node.DOCUMENT_POSITION_FOLLOWING,
				);
			}),
		).toBe(true);

		// The freeze: the server refuses writes for every role, managers
		// included (rule 3).
		const csrf = await readCsrf(mgrPage);
		const res = await mgrPage.request.post(
			`/index.php/${JOURNAL}/api/v1/submissions/${subA.id}/reviewers/suggestions`,
			{
				headers: {'X-Csrf-Token': csrf},
				data: {
					givenName: {en: 'Late'},
					familyName: {en: 'Arrival'},
					email: `late${tag}@mailinator.com`,
					affiliation: {en: 'Late University'},
					suggestionReason: {en: '<p>Too late</p>'},
				},
			},
		);
		expect(res.status()).toBe(401);
		const body = await res.json();
		expect(body.errorMessage).toBe(
			'Add, update or delete of reviewer suggestion for completed submission is restricted.',
		);

		// A submission whose author suggested no one shows no panel at all.
		await mgrPage.goto(workflowUrl(subB.id), {waitUntil: 'commit'});
		await expect(
			mgrPage.locator('[data-cy="participant-manager"]'),
		).toBeVisible({timeout: 20_000});
		await expect(rm.suggestionManager).toHaveCount(0);
	});

	test('s4: assigning from a suggestion preselects the existing reviewer, consumes it live, and the submission-stage panel keeps it', async ({
		asUser,
		pkpApi,
	}) => {
		test.slow(); // legacy assignment form + three panel surfaces
		const tag = uniqueTag('rsd');
		const {submission} = await pkpApi.createSubmission(
			inReviewSpec({
				tag,
				participants: [
					{user: 'editor.diana', role: 'editor'},
					{user: 'sectioneditor.ana', role: 'sectionEditor'},
				],
				reviewerSuggestions: [
					{
						givenName: 'Jules',
						familyName: 'Colleague',
						email: 'reviewer.julia@mailinator.com', // an enrolled reviewer
						affiliation: 'Colleague College',
						suggestionReason: `<p>Round-one pick ${tag}</p>`,
					},
					{
						givenName: 'Open',
						familyName: 'Other',
						email: `other${tag}@mailinator.com`,
						affiliation: 'Other University',
						suggestionReason: `<p>Backup pick ${tag}</p>`,
					},
				],
			}),
		);

		const edCtx = await asUser('sectioneditor.ana');
		const edPage = await edCtx.newPage();
		const rm = new ReviewerManagerPage(edPage);
		await rm.gotoWorkflow(submission.id);

		// The review-stage panel lists the open suggestions, each with a
		// "…" menu whose single action is Add Reviewer (rule 6).
		await expect(rm.suggestionRow('Jules Colleague')).toBeVisible();
		await expect(rm.suggestionRow('Open Other')).toBeVisible();

		// The suggested email belongs to an existing reviewer → the normal
		// assignment form opens preselected, with no search list (rule 8).
		const modal = await rm.openSuggestionAddReviewer('Jules Colleague');
		await expect(modal.locator('#searchGridAndButton')).toHaveCount(0);
		await expect(modal.locator('#selectedReviewerName')).toContainText(
			'Julia Reviewer',
		);
		const form = modal.locator('#advancedSearchReviewerForm');
		await rm.ensureDueDatesOrdered(form);
		await rm.awaitRichTextContains(form, 'personalMessage', tag);
		await rm.submitLegacyForm(form, 'Add Reviewer', modal);

		// Without a reload: gone from the review-stage panel (rule 9) …
		await expect(rm.suggestionRow('Jules Colleague')).toBeHidden({
			timeout: 20_000,
		});
		await expect(rm.suggestionRow('Open Other')).toBeVisible();
		await expect(rm.row('Julia Reviewer')).toContainText('Request Sent');

		// … and from the picker block inside Add Reviewer.
		const picker = await rm.openAddReviewerModal();
		await expect(rm.suggestionsBlock(picker)).toBeVisible();
		await expect(rm.suggestionBlockItem(picker, 'Open Other')).toBeVisible();
		await expect(
			rm.suggestionBlockItem(picker, 'Jules Colleague'),
		).toBeHidden();
		await rm.closeModal(picker);

		// The submission-stage panel still lists the used suggestion,
		// read-only.
		// ⚠ As-built: nothing distinguishes the used suggestion from the
		// still-open one there (spec Known deviations, RS-F).
		await openWorkflowStage(edPage, 'Submission');
		await expect(rm.suggestionRow('Jules Colleague')).toBeVisible({
			timeout: 20_000,
		});
		await expect(rm.suggestionRow('Open Other')).toBeVisible();
		await expect(
			rm.suggestionManager.getByRole('button', {name: /More Actions/}),
		).toHaveCount(0);
	});

	test('s5: a suggestion with an unknown email prefills Create New Reviewer from the picker block', async ({
		asUser,
		pkpApi,
	}) => {
		test.slow(); // account creation through the legacy form
		const tag = uniqueTag('rse');
		const novaEmail = `nova${tag}@mailinator.com`;
		const {submission} = await pkpApi.createSubmission(
			inReviewSpec({
				tag,
				reviewerSuggestions: [
					{
						givenName: 'Nova',
						familyName: 'Prospect',
						email: novaEmail, // matches no account
						affiliation: 'Prospect Institute',
						suggestionReason: `<p>New blood ${tag}</p>`,
					},
					{
						givenName: 'Keep',
						familyName: 'Open',
						email: `keep${tag}@mailinator.com`,
						affiliation: 'Open University',
						suggestionReason: `<p>Still open ${tag}</p>`,
					},
				],
			}),
		);

		const edCtx = await asUser('editor.diana');
		const edPage = await edCtx.newPage();
		const rm = new ReviewerManagerPage(edPage);
		await rm.gotoWorkflow(submission.id);

		// The block sits above the "Locate a Reviewer" search and shows
		// name, affiliation and reason (rule 7).
		const picker = await rm.openAddReviewerModal();
		await expect(
			picker.locator('.listPanel--selectReviewer').first(),
		).toContainText('Select a Reviewer from Reviewer Suggestions');
		await expect(rm.selectPanel(picker)).toContainText('Locate a Reviewer');
		const novaItem = rm.suggestionBlockItem(picker, 'Nova Prospect');
		await expect(novaItem).toContainText('Prospect Institute');
		await expect(novaItem).toContainText(`New blood ${tag}`);

		// Select → the Create New Reviewer form, prefilled with the
		// suggestion's identity (rule 8; ⚠ the click helper works around
		// the "Select undefined" accessible name — ledger row 52).
		await rm.selectSuggestion(picker, 'Nova Prospect');
		const createForm = edPage.locator('#createReviewerForm').last();
		await expect(createForm).toBeVisible({timeout: 20_000});
		await expect(
			createForm.locator('input[name="givenName[en]"]').last(),
		).toHaveValue('Nova');
		await expect(
			createForm.locator('input[name="familyName[en]"]').last(),
		).toHaveValue('Prospect');
		await expect(createForm.locator('input[name="email"]').last()).toHaveValue(
			novaEmail,
		);
		await expect(
			createForm.locator('input[name="affiliation[en]"]').last(),
		).toHaveValue('Prospect Institute');

		// The editor adds the username and completes the assignment.
		await createForm.locator('input[name="username"]').last().fill(`rev${tag}`);
		await rm.ensureDueDatesOrdered(createForm);
		await rm.awaitRichTextContains(createForm, 'personalMessage', tag);
		await createForm
			.getByRole('button', {name: 'Add Reviewer', exact: true})
			.click();
		await expect(createForm).toBeHidden({timeout: 20_000});
		// Ledger row 52: the picker block does not live-refresh after an
		// assignment completed from inside it — close it and verify the
		// consumed state on fresh mounts instead.
		if (await picker.isVisible().catch(() => false)) {
			await rm.closeModal(picker);
		}

		await rm.gotoWorkflow(submission.id);
		await expect(rm.row('Nova Prospect')).toContainText('Request Sent');
		await expect(rm.suggestionRow('Nova Prospect')).toBeHidden();
		await expect(rm.suggestionRow('Keep Open')).toBeVisible();
		const reopened = await rm.openAddReviewerModal();
		await expect(rm.suggestionBlockItem(reopened, 'Keep Open')).toBeVisible();
		await expect(
			rm.suggestionBlockItem(reopened, 'Nova Prospect'),
		).toBeHidden();
	});

	test('s6: an ordinary-search assignment of a suggested email consumes the suggestion anyway', async ({
		asUser,
		pkpApi,
	}) => {
		const tag = uniqueTag('rsf');
		const {submission} = await pkpApi.createSubmission(
			inReviewSpec({
				tag,
				reviewerSuggestions: [
					{
						// Deliberately NOT the account's display name — the
						// used-marking matches by email, not name (rule 10).
						givenName: 'Paula',
						familyName: 'Suggested',
						email: 'reviewer.paul@mailinator.com',
						affiliation: 'Suggested University',
						suggestionReason: `<p>Independent pick ${tag}</p>`,
					},
					{
						givenName: 'Still',
						familyName: 'Open',
						email: `still${tag}@mailinator.com`,
						affiliation: 'Open Institute',
						suggestionReason: `<p>Untouched ${tag}</p>`,
					},
				],
			}),
		);

		const edCtx = await asUser('editor.diana');
		const edPage = await edCtx.newPage();
		const rm = new ReviewerManagerPage(edPage);
		await rm.gotoWorkflow(submission.id);
		await expect(rm.suggestionRow('Paula Suggested')).toBeVisible();

		// The editor ignores the suggestions and assigns Paul through the
		// ordinary picker search.
		const modal = await rm.openAddReviewerModal();
		await expect(
			rm.suggestionBlockItem(modal, 'Paula Suggested'),
		).toBeVisible();
		await rm.searchSelectPanel(modal, 'Paul');
		const form = await rm.selectReviewer(modal, 'Paul Reviewer');
		await rm.ensureDueDatesOrdered(form);
		await rm.awaitRichTextContains(form, 'personalMessage', tag);
		await rm.submitLegacyForm(form, 'Add Reviewer', modal);

		await expect(rm.row('Paul Reviewer')).toContainText('Request Sent');
		// The matching suggestion nonetheless disappears from the
		// review-stage panel and the picker block; the unrelated one stays.
		await expect(rm.suggestionRow('Paula Suggested')).toBeHidden({
			timeout: 20_000,
		});
		await expect(rm.suggestionRow('Still Open')).toBeVisible();
		const reopened = await rm.openAddReviewerModal();
		await expect(rm.suggestionBlockItem(reopened, 'Still Open')).toBeVisible();
		await expect(
			rm.suggestionBlockItem(reopened, 'Paula Suggested'),
		).toBeHidden();
	});

	test('s7: the journal dial hides the step, panels and block without deleting anything — and gates the Assistant lockout', async ({
		asUser,
		pkpApi,
	}) => {
		test.slow(); // scratch journal, four actors, two settings flips
		const tag = uniqueTag('rsg');
		const ed = `ed${tag}`;
		const ast = `ast${tag}`;
		const au = `au${tag}`;

		// A scratch journal with the dial ON and throwaway users: an
		// editor-group manager, a Funding-coordinator assistant (the one
		// default assistant group whose stages include external review)
		// and a plain author (publicknowledge's dial is bootstrap state
		// and must never be flipped — charter principle 1).
		const {context} = await pkpApi.createJournal({
			tag,
			reviewerSuggestionEnabled: true,
			users: [
				{
					username: ed,
					password: ed + ed,
					email: `${ed}@mailinator.com`,
					givenName: 'Edda',
					familyName: 'Editor',
					roles: ['editor'],
				},
				{
					username: ast,
					password: ast + ast,
					email: `${ast}@mailinator.com`,
					givenName: 'Asta',
					familyName: 'Helper',
					roles: ['funding'],
				},
				{
					username: au,
					password: au + au,
					email: `${au}@mailinator.com`,
					givenName: 'Alma',
					familyName: 'Author',
					roles: ['author'],
				},
			],
		});
		const journalPath = context.path;

		const {submission} = await pkpApi.createSubmission(
			inReviewSpec({
				tag,
				journal: journalPath,
				submitter: au,
				participants: [
					{user: ed, role: 'editor'},
					{user: ast, role: 'funding'},
				],
				decisions: [{type: 'sendExternalReview', by: ed}],
				reviewerSuggestions: [
					{
						givenName: 'Sonia',
						familyName: 'Suggested',
						email: `sonia${tag}@mailinator.com`,
						affiliation: 'Dial University',
						suggestionReason: `<p>Dial reason ${tag}</p>`,
					},
				],
			}),
		);

		// --- Dial ON: the editor sees the actionable review-stage panel.
		const edCtx = await asUser(ed);
		const edPage = await edCtx.newPage();
		const rmEd = new ReviewerManagerPage(edPage);
		await rmEd.gotoWorkflow(submission.id, {journalPath});
		await expect(rmEd.suggestionRow('Sonia Suggested')).toBeVisible();
		await expect(
			rmEd
				.suggestionRow('Sonia Suggested')
				.getByRole('button', {name: 'Sonia Suggested More Actions'}),
		).toBeVisible();

		// ⚠ As-built (RS-A, spec Known deviations): with the dial ON an
		// assigned Assistant gets a blocking error dialog on workflow-page
		// load — the "Reviewers Suggested by Author" panel's mount fetch
		// (GET reviewers/suggestions?approved=false) is refused 401.
		//
		// ⚠ SPEC CONTRADICTION (live-probed 2026-07-11): the spec's RS-A
		// part (b) — "the Assistant has NO Add Reviewer button at all, the
		// whole reviewer-assignment action layer renders empty" — does NOT
		// reproduce in the seeded-scenario environment. The assigned
		// Funding-coordinator Assistant KEEPS the Add Reviewer button and
		// can even open the picker, which lists the open suggestion. Only
		// RS-A part (a), the blocking error dialog, reproduces; it is
		// dial-gated (asserted absent with the dial off below). Actual
		// behavior is asserted here per the test-author contract; the
		// probe's A/B on the button is reported as a contradiction.
		const astCtx = await asUser(ast);
		const astPage = await astCtx.newPage();
		const rmAst = new ReviewerManagerPage(astPage);
		await astPage.goto(workflowUrl(submission.id, journalPath), {
			waitUntil: 'commit',
		});
		const errorDialog = astPage
			.locator('[data-cy="dialog"]')
			.filter({
				hasText: 'The current role does not have access to this operation.',
			});
		await expect(errorDialog).toBeVisible({timeout: 20_000});
		await errorDialog.getByRole('button', {name: 'OK', exact: true}).click();
		await expect(rmAst.manager).toBeVisible({timeout: 20_000});
		// Actual: the Add Reviewer affordance survives (spec RS-A (b) refuted).
		await expect(
			rmAst.manager.getByRole('button', {name: 'Add Reviewer', exact: true}),
		).toBeVisible();

		// --- The manager unticks the dial (Settings → Workflow → Review,
		// Setup — rule: Settings that modify behavior).
		const adminCtx = await asUser('admin');
		const adminPage = await adminCtx.newPage();
		const settings = new WorkflowSettingsPage(adminPage, journalPath);
		await settings.goto();
		let panel = await settings.openReviewSetupTab();
		const dial = panel.getByRole('checkbox', {
			name: 'Allow authors to suggest potential reviewers at submission process',
		});
		await dial.uncheck();
		await settings.saveForm(panel);

		// The editor's panel and picker block are gone — only "Locate a
		// Reviewer" remains.
		await rmEd.gotoWorkflow(submission.id, {journalPath});
		await expect(rmEd.suggestionManager).toHaveCount(0);
		const offModal = await rmEd.openAddReviewerModal();
		await expect(rmEd.suggestionsBlock(offModal)).toHaveCount(0);
		await expect(rmEd.selectPanel(offModal)).toContainText(
			'Locate a Reviewer',
		);
		await rmEd.closeModal(offModal);

		// ⚠ RS-A dial-gated A/B: with the dial OFF the suggestions panel is
		// not rendered, so its failing mount fetch never fires — the
		// Assistant loads the workflow with NO blocking error dialog, and
		// the Add Reviewer button is present (the reproducing half of RS-A,
		// the load-time error dialog, is what the dial gates).
		await rmAst.gotoWorkflow(submission.id, {journalPath});
		await expect(
			rmAst.manager.getByRole('button', {name: 'Add Reviewer', exact: true}),
		).toBeVisible();
		await expect(errorDialog).toHaveCount(0);
		await expect(rmAst.suggestionManager).toHaveCount(0);

		// A new submission's wizard goes straight from For the Editors to
		// Review — no Reviewer Suggestions step.
		const {submission: draft} = await pkpApi.createSubmission(
			draftSpec({
				tag: `${tag}d`,
				title: `Dial-off draft ${tag}`,
				journal: journalPath,
				submitter: au,
			}),
		);
		const auCtx = await asUser(au);
		const auPage = await auCtx.newPage();
		await auPage.goto(wizardUrl(draft.id, journalPath));
		await expect(auPage.locator('.submissionWizard')).toBeVisible({
			timeout: 20_000,
		});
		await expect(auPage.locator('.pkpSteps__step__label')).toHaveText([
			/Upload Files\s*$/,
			/Details\s*$/,
			/Contributors\s*$/,
			/For the Editors\s*$/,
			/Review\s*$/,
		]);

		// --- Re-enabling brings the same suggestion back, action menus
		// included — nothing was deleted.
		await settings.goto();
		panel = await settings.openReviewSetupTab();
		await panel
			.getByRole('checkbox', {
				name: 'Allow authors to suggest potential reviewers at submission process',
			})
			.check();
		await settings.saveForm(panel);

		await rmEd.gotoWorkflow(submission.id, {journalPath});
		const sonia = rmEd.suggestionRow('Sonia Suggested');
		await expect(sonia).toBeVisible();
		await expect(sonia).toContainText('Dial University');
		await expect(sonia).toContainText(`Dial reason ${tag}`);
		await expect(
			sonia.getByRole('button', {name: 'Sonia Suggested More Actions'}),
		).toBeVisible();
	});
});
