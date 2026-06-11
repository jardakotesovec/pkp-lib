// @ts-check
const path = require('path');
const {test, expect} = require('../support/base-test.js');
const {SubmissionWizardPage} = require('../pages/SubmissionWizardPage.js');
const {getTinyMceContent} = require('../support/tinymce.js');

/**
 * Submission wizard — core. Implements all rows of
 * docs/e2e/plans/submission-wizard-core.md (OJS root repo).
 *
 * Wizard state is per-test: every test that needs an in-progress draft
 * STARTS it through the Begin Submission form. The plan originally
 * pencilled the submission scenario (`submitted: false`) in for these
 * rows, but the SubmissionBuilderProcessor's draft shape is not
 * wizard-resumable — it creates submissions with `submissionProgress`
 * already cleared (plus a dateSubmitted), so the wizard route shows the
 * "Submission complete" screen for them, not the wizard
 * (PKPSubmissionHandler::index routes on submissionProgress). Driving
 * the one-page start form is cheap (~2s) and is itself wizard surface,
 * so no Processor change was made (charter principle 3). The scenario
 * endpoint is still used where its shape IS accurate: the
 * `submitted: true` submission in the routing row.
 *
 * Verified-against-real-UI deviations from the plan's row text:
 *   - Row 1: the seeded publicknowledge sections (bootstrap.js →
 *     SectionProcessor) carry no `policy`, so the start form's
 *     conditional per-section policy reveal (OJS StartSubmission only
 *     adds `sectionDescription{id}` FieldHTML rows for sections with a
 *     non-empty localized policy) never renders on the read-only base
 *     journal. The reveal sub-assertion is dropped; the section radios
 *     themselves are covered.
 *   - Row 3: there is no rename in the wizard's file Edit modal — the
 *     PKPSubmissionFileForm holds only the genreId radio. The rename
 *     sub-assertion is replaced by genre editing via that modal.
 *   - Row 4: the wizard's Details form removes `prefix` and `subtitle`
 *     (PKP\components\forms\publication\Details), so "subtitle entry"
 *     is replaced by the keywords field (publicknowledge requests
 *     keywords during submission per the enriched bootstrap).
 */

const ARTICLE_FIXTURE = path.resolve(
	__dirname,
	'..',
	'fixtures',
	'files',
	'default-article.pdf',
);
const DUMMY_FIXTURE = path.resolve(
	__dirname,
	'..',
	'fixtures',
	'files',
	'dummy.pdf',
);

function uniqueTag() {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `swc-w${workerIndex}-${suffix}`;
}

/**
 * Sign a baseline user into a scratch journal. The cached storage state
 * is publicknowledge-scoped; scratch journals need a fresh form login.
 */
async function loginOnJournal(page, contextPath, username) {
	await page.goto(`/index.php/${contextPath}/en/login`);
	await page.locator('input#username').fill(username);
	await page.locator('input#password').fill(`${username}${username}`);
	await page.locator('form#login button').click();
	await page.waitForURL((url) => !url.pathname.includes('/login'), {
		timeout: 15_000,
	});
}

/**
 * Start a fresh publicknowledge draft as the current page user and
 * return the mounted wizard + the new submission id.
 */
async function startDraft(page, {title, section = 'Articles'}) {
	const wizard = new SubmissionWizardPage(page);
	await wizard.goto();
	await wizard.start({title, section});
	const id = wizard.currentSubmissionId();
	expect(id, 'submission id resolves from /submission?id=…').toBeTruthy();
	return {wizard, id};
}

test.use({user: 'atester'});

test.describe('Submission wizard — core', () => {
	test(
		'Begin Submission form surface',
		{tag: '@regression'},
		async ({page}) => {
			const tag = uniqueTag();
			const wizard = new SubmissionWizardPage(page);
			await wizard.goto();

			await expect(
				page.getByRole('heading', {name: 'Make a Submission'}),
			).toBeVisible();

			// Shipped beginSubmissionHelp guidance renders above the form
			// ("Before you begin" FieldHTML).
			await expect(page.getByText('Before you begin')).toBeVisible();
			await expect(
				page.getByText(
					'Thank you for submitting to the Journal of Public Knowledge',
				),
			).toBeVisible();

			// Submission-language radios — both supported submission
			// locales of the bootstrapped journal.
			await expect(page.getByText('Submission Language')).toBeVisible();
			await expect(
				page.locator('label', {hasText: 'English'}).first(),
			).toBeVisible();
			await expect(
				page.locator('label', {hasText: 'French (Canada)'}).first(),
			).toBeVisible();

			// Section radios for both seeded sections. (The per-section
			// policy reveal is not asserted: the seeded sections carry no
			// policy text — see spec header.)
			await expect(
				page.locator('label', {hasText: 'Articles'}).first(),
			).toBeVisible();
			await expect(
				page.locator('label', {hasText: 'Reviews'}).first(),
			).toBeVisible();

			// Checklist confirmation + privacy consent.
			await expect(page.getByText('Submission Checklist')).toBeVisible();
			await expect(
				page.getByText(
					'Yes, my submission meets all of these requirements.',
				),
			).toBeVisible();
			await expect(page.getByText('Privacy Consent')).toBeVisible();
			await expect(
				page.getByText('Yes, I agree to have my data collected'),
			).toBeVisible();

			// Title is required: submitting the empty form surfaces the
			// required-field error on the title field (field error ids
			// follow `{formId}-{fieldName}-error`).
			await page
				.getByRole('button', {name: 'Begin Submission'})
				.click();
			await expect(
				page.locator('#startSubmission-title-error'),
			).toContainText('This field is required.', {timeout: 15_000});

			// Completing the form lands on wizard step 1 (Upload Files).
			await wizard.start({title: `Start form ${tag}`, section: 'Articles'});
			await wizard.expectStep('Upload Files');
		},
	);

	test(
		'Full happy path: submit and acknowledge',
		{tag: ['@smoke', '@regression']},
		async ({page, asUser, pkpMail}) => {
			const tag = uniqueTag();
			const title = `Happy path ${tag}`;

			const {wizard, id} = await startDraft(page, {title});

			// Step 1 — Upload Files: dropzone upload + Article Text genre.
			await wizard.expectStep('Upload Files');
			const fileItem = await wizard.uploadFile(ARTICLE_FIXTURE);
			await expect(
				fileItem.getByText('What kind of file is this?'),
			).toBeVisible();
			await wizard.assignPrimaryGenre(fileItem, 'Article Text');

			// Step 2 — Details: title (pre-seeded from the start form) +
			// abstract (required for the Articles section).
			await wizard.continueStep();
			await wizard.expectStep('Details');
			await wizard.setTitle(title);
			await wizard.setDetailsField(
				'abstract',
				`<p>Happy-path abstract ${tag}.</p>`,
			);

			// Step 3 — Contributors: the submitter is pre-seeded.
			await wizard.continueStep();
			await wizard.expectStep('Contributors');
			await expect(
				wizard.contributorItem('Author Tester'),
			).toBeVisible();

			// Step 4 — For the Editors: keywords/citations are 'request'
			// (optional) on the bootstrapped journal; nothing blocks.
			await wizard.continueStep();
			await wizard.expectStep('For the Editors');

			// Step 5 — Reviewer Suggestions: present (enriched default
			// reviewerSuggestionEnabled) and skippable.
			await wizard.continueStep();
			await wizard.expectStep('Reviewer Suggestions');

			// Step 6 — Review, then submit through the confirm dialog.
			await wizard.continueStep();
			await wizard.expectStep('Review');
			await wizard.submit();

			// "Submission complete" screen with the three next-step links.
			await expect(
				page.getByRole('heading', {name: 'Submission complete'}),
			).toBeVisible();
			await expect(
				page.getByRole('link', {name: 'Review this submission'}),
			).toBeVisible();
			await expect(
				page.getByRole('link', {name: 'Create a new submission'}),
			).toBeVisible();
			await expect(
				page.getByRole('link', {name: 'Return to your dashboard'}),
			).toBeVisible();

			// Submission acknowledgement email, scoped by recipient + tag
			// (the body embeds the submission title).
			const [ack] = await pkpMail.find({
				to: 'atester@mailinator.com',
				contains: tag,
				subject: 'Thank you for your submission',
				timeoutMs: 20_000,
			});
			expect(ack).toBeTruthy();

			// dbarnes finds the submission in the editorial dashboard.
			// The dashboard opens on "Assigned to me"; switch to the
			// all-active view before searching (search scopes to the
			// current view).
			const editorCtx = await asUser('dbarnes');
			const editorPage = await editorCtx.newPage();
			await editorPage.goto(
				'/index.php/publicknowledge/en/dashboard/editorial',
			);
			await editorPage
				.getByRole('link', {name: 'Active submissions'})
				.click();
			await expect(
				editorPage.getByRole('heading', {name: /Active submissions/}),
			).toBeVisible({timeout: 20_000});
			// The Search component reacts to keyup (250ms debounce), so a
			// plain fill() never triggers the filtered fetch — type real
			// keystrokes instead.
			const searchInput = editorPage.getByPlaceholder(
				/Search submissions/,
			);
			await searchInput.click();
			await searchInput.pressSequentially(tag);
			await expect(editorPage.getByText(title).first()).toBeVisible({
				timeout: 20_000,
			});

			// The uploaded Article Text survived submit (file intact).
			const filesRes = await editorCtx.request.get(
				`/index.php/publicknowledge/api/v1/submissions/${id}/files?fileStages[]=2`,
			);
			expect(filesRes.ok()).toBeTruthy();
			const files = (await filesRes.json()).items ?? [];
			expect(files.length).toBe(1);
			expect(JSON.stringify(files[0].name)).toContain(
				'default-article.pdf',
			);
		},
	);

	test(
		'Files step interactions',
		{tag: '@regression'},
		async ({page}) => {
			const tag = uniqueTag();
			const {wizard} = await startDraft(page, {title: `Files ${tag}`});
			await wizard.expectStep('Upload Files');

			// Primary upload: the genre prompt appears and offers the
			// primary genre as a one-click button.
			const first = await wizard.uploadFile(ARTICLE_FIXTURE);
			await expect(
				first.getByText('What kind of file is this?'),
			).toBeVisible();
			await wizard.assignPrimaryGenre(first, 'Article Text');

			// Second file takes a non-primary genre via the "Other" modal.
			const second = await wizard.uploadFile(DUMMY_FIXTURE);
			const genreForm = await wizard.openFileGenreForm(second);

			// Dependent-file genres are filtered out of the wizard
			// (PKPSubmissionHandler::getSubmissionFilesListPanel) — none
			// of the three dependent defaults is offered.
			for (const dependent of ['Image', 'HTML Stylesheet', 'Multimedia']) {
				await expect(
					genreForm.locator('label', {hasText: dependent}),
				).toHaveCount(0);
			}
			// Non-dependent genres are: primary + supplementary.
			await expect(
				genreForm.locator('label', {hasText: 'Article Text'}).first(),
			).toBeVisible();
			await wizard.saveFileGenre(genreForm, second, 'Data Set');

			// Editing a saved file re-opens the same genre form (there is
			// no rename in the wizard — the form holds only the genre).
			await second.getByRole('button', {name: 'Edit'}).click();
			const editForm = page
				.locator('[data-cy="active-modal"] form')
				.filter({has: page.locator('input[name="genreId"]')})
				.first();
			await expect(
				editForm.locator('input[name="genreId"]').first(),
			).toBeVisible({timeout: 15_000});
			await wizard.saveFileGenre(editForm, second, 'Transcripts');

			// Delete the second file; the primary one stays.
			await wizard.removeFile(second);
			await expect(wizard.fileItem('default-article.pdf')).toBeVisible();
		},
	);

	test(
		'Details step entry and autosave',
		{tag: '@regression'},
		async ({page}) => {
			const tag = uniqueTag();
			const title = `Details ${tag}`;
			const updatedTitle = `${title} updated`;
			const abstract = `Autosaved abstract ${tag}`;
			const keyword = `keyword${tag}`;

			const {wizard, id} = await startDraft(page, {title});
			await wizard.continueStep();
			await wizard.expectStep('Details');

			await wizard.setTitle(updatedTitle);
			await wizard.setDetailsField('abstract', `<p>${abstract}</p>`);
			// Keywords (controlled vocab, requested on publicknowledge):
			// type + Enter adds a free-text entry.
			const keywordInput = page.locator(
				'#titleAbstract-keywords-control-en',
			);
			await keywordInput.fill(keyword);
			await keywordInput.press('Enter');

			// Autosave fires on step change; race the publication PUT.
			await Promise.all([
				page.waitForResponse(
					(res) =>
						res.request().method() === 'POST' &&
						/\/api\/v1\/submissions\/\d+\/publications\/\d+$/.test(
							res.url(),
						) &&
						res.ok(),
					{timeout: 20_000},
				),
				wizard.continueStep(),
			]);
			await wizard.expectStep('Contributors');

			// The footer's "last saved" autosave indicator surfaces.
			await expect(
				page.locator('.submissionWizard__lastSaved'),
			).toContainText('Last saved', {timeout: 15_000});

			// Re-opening the wizard restores the entered values from the
			// server. Navigate to the bare wizard URL (no #step hash) so
			// the wizard deterministically mounts at step 1 — a fresh
			// mount resets startedSteps, so later steps aren't reachable
			// through the rail until walked to again.
			await page.goto(
				`/index.php/publicknowledge/submission?id=${id}`,
			);
			await expect(page.locator('.submissionWizard')).toBeVisible();
			await wizard.expectStep('Upload Files');
			await wizard.continueStep();
			await wizard.expectStep('Details');
			expect(
				await getTinyMceContent(page, 'titleAbstract-title-control-en'),
			).toContain(updatedTitle);
			expect(
				await getTinyMceContent(
					page,
					'titleAbstract-abstract-control-en',
				),
			).toContain(abstract);
			await expect(page.getByText(keyword).first()).toBeVisible();
		},
	);

	test(
		'Contributors step CRUD',
		{tag: '@regression'},
		async ({page}) => {
			const tag = uniqueTag();
			const {wizard} = await startDraft(page, {
				title: `Contributors ${tag}`,
			});
			await wizard.continueStep();
			await wizard.continueStep();
			await wizard.expectStep('Contributors');

			// The submitter is pre-seeded as the primary contact.
			const submitterItem = wizard.contributorItem('Author Tester');
			await expect(submitterItem).toBeVisible();
			await expect(
				submitterItem.getByText('Primary Contact', {exact: true}),
			).toBeVisible();

			// Add a second contributor.
			const bobGiven = `Bob${tag}`;
			await wizard.addContributor({
				givenName: bobGiven,
				familyName: 'Contributor',
				email: `bob-${tag}@mailinator.com`,
			});
			const bobItem = wizard.contributorItem(bobGiven);

			// Edit: change the family name through the Edit modal.
			await bobItem.getByRole('button', {name: 'Edit'}).click();
			const familyInput = page
				.locator('input[name="familyName-en"]')
				.last();
			await expect(familyInput).toBeVisible({timeout: 15_000});
			await expect(familyInput).toHaveValue('Contributor');
			await familyInput.fill('Edited');
			await Promise.all([
				page.waitForResponse(
					(res) =>
						/\/api\/v1\/submissions\/\d+\/publications\/\d+\/contributors\/\d+/.test(
							res.url(),
						) && res.ok(),
					{timeout: 20_000},
				),
				page
					.getByRole('button', {name: 'Save', exact: true})
					.last()
					.click(),
			]);
			await expect(
				wizard.contributorItem(`${bobGiven} Edited`),
			).toBeVisible({timeout: 15_000});

			// Set the new contributor as primary contact — the badge moves.
			await bobItem
				.getByRole('button', {name: 'Set Primary Contact'})
				.click();
			await expect(
				bobItem.getByText('Primary Contact', {exact: true}),
			).toBeVisible({timeout: 15_000});
			await expect(
				submitterItem.getByRole('button', {
					name: 'Set Primary Contact',
				}),
			).toBeVisible();

			// Add + delete a third contributor.
			const carolGiven = `Carol${tag}`;
			await wizard.addContributor({
				givenName: carolGiven,
				familyName: 'Temporary',
				email: `carol-${tag}@mailinator.com`,
			});
			const carolItem = wizard.contributorItem(carolGiven);
			await carolItem.getByRole('button', {name: 'Delete'}).click();
			const dialog = page.getByRole('dialog');
			await expect(dialog).toContainText(carolGiven);
			await dialog
				.getByRole('button', {name: 'Delete Contributor'})
				.click();
			await expect(carolItem).toHaveCount(0, {timeout: 15_000});

			// Review step reflects the final list.
			await wizard.continueStep();
			await wizard.continueStep();
			await wizard.continueStep();
			await wizard.expectStep('Review');
			const panel = wizard.reviewPanel('Contributors');
			await expect(panel).toContainText('Author Tester');
			await expect(panel).toContainText(`${bobGiven} Edited`);
			await expect(panel).not.toContainText(carolGiven);
			// Bob carries the Primary Contact badge in the summary.
			await expect(
				panel
					.locator('li', {hasText: bobGiven})
					.getByText('Primary Contact', {exact: true}),
			).toBeVisible();
		},
	);

	test(
		'Review step summaries and edit jump-back',
		{tag: '@regression'},
		async ({page}) => {
			const tag = uniqueTag();
			const title = `Review ${tag}`;
			const {wizard} = await startDraft(page, {title});

			// Minimal real state so every panel has a summary to show.
			const fileItem = await wizard.uploadFile(ARTICLE_FIXTURE);
			await wizard.assignPrimaryGenre(fileItem, 'Article Text');
			await wizard.continueStep();
			await wizard.expectStep('Details');
			await wizard.setTitle(title);
			await wizard.setDetailsField(
				'abstract',
				`<p>Review abstract ${tag}.</p>`,
			);
			await wizard.continueStep();
			await wizard.continueStep();
			await wizard.continueStep();
			await wizard.expectStep('Reviewer Suggestions');
			await wizard.continueStep();
			await wizard.expectStep('Review');

			// Per-section summaries. Details / For the Editors render one
			// panel per metadata locale; anchor the English variants.
			const filesPanel = wizard.reviewPanel('Files');
			await expect(filesPanel).toContainText('default-article.pdf');
			await expect(filesPanel).toContainText('Article Text');

			const detailsPanel = wizard.reviewPanel(/^Details \(English\)/);
			await expect(detailsPanel).toContainText(title);
			await expect(detailsPanel).toContainText(`Review abstract ${tag}`);

			const contributorsPanel = wizard.reviewPanel('Contributors');
			await expect(contributorsPanel).toContainText('Author Tester');

			const editorsPanel = wizard.reviewPanel(
				/^For the Editors \(English\)/,
			);
			await expect(editorsPanel).toBeVisible();

			// Each Edit control jumps back to its owning step with state
			// intact; the Review pill stays started so we can jump back.
			await filesPanel.getByRole('button', {name: 'Edit'}).click();
			await wizard.expectStep('Upload Files');
			await expect(wizard.fileItem('default-article.pdf')).toBeVisible();

			await wizard.gotoStep('Review');
			await wizard.expectStep('Review');
			await detailsPanel.getByRole('button', {name: 'Edit'}).click();
			await wizard.expectStep('Details');
			expect(
				await getTinyMceContent(page, 'titleAbstract-title-control-en'),
			).toContain(title);

			await wizard.gotoStep('Review');
			await wizard.expectStep('Review');
			await contributorsPanel
				.getByRole('button', {name: 'Edit'})
				.click();
			await wizard.expectStep('Contributors');
			await expect(
				wizard.contributorItem('Author Tester'),
			).toBeVisible();

			await wizard.gotoStep('Review');
			await wizard.expectStep('Review');
			await editorsPanel.getByRole('button', {name: 'Edit'}).click();
			await wizard.expectStep('For the Editors');
		},
	);

	test(
		'Step navigation and page titles',
		{tag: '@regression'},
		async ({page}) => {
			const tag = uniqueTag();
			const title = `Steps ${tag}`;
			const {wizard} = await startDraft(page, {title});

			// Page title follows titleWithStep ("Make a Submission: {$step}")
			// in both the page heading and the document title.
			const heading = page.locator('h1.app__pageHeading');
			await wizard.expectStep('Upload Files');
			await expect(heading).toContainText(
				'Make a Submission: Upload Files',
			);
			await expect(page).toHaveTitle(/Make a Submission: Upload Files/);

			// Continue / Back walk.
			await wizard.continueStep();
			await wizard.expectStep('Details');
			await expect(heading).toContainText('Make a Submission: Details');
			await expect(page).toHaveTitle(/Make a Submission: Details/);
			// Title was carried over from the Start form.
			expect(
				await getTinyMceContent(page, 'titleAbstract-title-control-en'),
			).toContain(title);

			await wizard.back();
			await wizard.expectStep('Upload Files');
			await expect(heading).toContainText(
				'Make a Submission: Upload Files',
			);

			// Enter data, walk on, then revisit through the step menu —
			// previously entered data is retained.
			await wizard.continueStep();
			await wizard.expectStep('Details');
			await wizard.setTitle(`${title} nav`);
			await wizard.continueStep();
			await wizard.expectStep('Contributors');
			await expect(heading).toContainText(
				'Make a Submission: Contributors',
			);

			await wizard.gotoStep('Details');
			await wizard.expectStep('Details');
			expect(
				await getTinyMceContent(page, 'titleAbstract-title-control-en'),
			).toContain(`${title} nav`);

			await wizard.gotoStep('Contributors');
			await wizard.expectStep('Contributors');
		},
	);

	test(
		'Default guidance copy renders per step',
		{tag: '@regression'},
		async ({page}) => {
			const tag = uniqueTag();
			const wizard = new SubmissionWizardPage(page);
			await wizard.goto();

			// beginSubmissionHelp (default.submission.step.beforeYouBegin)
			// on the Begin Submission form.
			await expect(
				page.getByText(
					'Thank you for submitting to the Journal of Public Knowledge',
				),
			).toBeVisible();

			await wizard.start({title: `Guidance ${tag}`, section: 'Articles'});

			// uploadFilesHelp on Upload Files.
			await wizard.expectStep('Upload Files');
			await expect(
				page.getByText(
					'Provide any files our editorial team may need to evaluate your submission',
				),
			).toBeVisible();

			// detailsHelp on Details.
			await wizard.continueStep();
			await wizard.expectStep('Details');
			await expect(
				page.getByText(
					'Please provide the following details to help us manage your submission',
				),
			).toBeVisible();

			// contributorsHelp on Contributors.
			await wizard.continueStep();
			await wizard.expectStep('Contributors');
			await expect(
				page.getByText(
					'Add details for all of the contributors to this submission',
				),
			).toBeVisible();

			// forTheEditorsHelp on For the Editors.
			await wizard.continueStep();
			await wizard.expectStep('For the Editors');
			await expect(
				page.getByText(
					'Please provide the following details in order to help our editorial team manage your submission',
				),
			).toBeVisible();

			// reviewerSuggestionsHelp on Suggest Reviewers (OJS app schema).
			await wizard.continueStep();
			await wizard.expectStep('Reviewer Suggestions');
			await expect(
				page.getByText(
					'you have the option to suggest several potential reviewers',
				),
			).toBeVisible();

			// reviewHelp on Review.
			await wizard.continueStep();
			await wizard.expectStep('Review');
			await expect(
				page.getByText(
					'Review the information you have entered before you complete your submission',
				),
			).toBeVisible();
		},
	);

	test(
		'"Submit as" role picker for multi-role user',
		{tag: '@regression'},
		async ({pkpApi, browser, baseURL}) => {
			const tag = uniqueTag();

			// Scratch journal where dbarnes holds two submitting roles —
			// no seeded publicknowledge user has more than one user group,
			// and the base journal is read-only. Group choice matters
			// twice over: the Submit As radio only offers groups with
			// access to the submission stage (so 'manager' is out — the
			// Journal manager group carries no stage assignments in
			// registry/userGroups.xml), while the POST /submissions
			// validator only accepts manager- or author-role groups (so
			// editor/sectionEditor choices 400 with invalidSubmitAs —
			// pkp/pkp-lib#10929 tracks that mismatch). Author + Translator
			// (both ROLE_ID_AUTHOR, both stage 1) satisfy both sides. The
			// extra manager role doesn't reach the radio (no stage
			// assignment) — it's there so dbarnes can read the
			// participants endpoint for the recorded-role assertion.
			const {context} = await pkpApi.createJournal({
				tag,
				users: [
					{
						username: 'dbarnes',
						roles: ['author', 'translator', 'manager'],
					},
				],
			});

			const ctx = await browser.newContext({
				baseURL,
				// Explicit empty state: the test-runner-wrapped newContext()
				// inherits the file-level user's storageState otherwise.
				storageState: {cookies: [], origins: []},
			});
			try {
				const page = await ctx.newPage();
				await loginOnJournal(page, context.path, 'dbarnes');

				const wizard = new SubmissionWizardPage(page, context.path);
				await wizard.goto();

				// The user-group radio renders with both groups.
				await expect(page.getByText('Submit As')).toBeVisible();
				const authorOption = page.getByRole('radio', {
					name: 'Author',
					exact: true,
				});
				const translatorOption = page.getByRole('radio', {
					name: 'Translator',
					exact: true,
				});
				await expect(authorOption).toBeVisible();
				await expect(translatorOption).toBeVisible();

				// Pick the non-default group, then start.
				await translatorOption.check();
				await wizard.start({title: `Submit as ${tag}`});
				const id = wizard.currentSubmissionId();
				expect(id).toBeTruthy();

				// The chosen role is recorded on the started submission's
				// stage-1 assignment.
				const res = await page.request.get(
					`/index.php/${context.path}/api/v1/submissions/${id}/participants/1`,
				);
				expect(res.ok(), `participants GET ${res.status()}`).toBe(true);
				const participants = await res.json();
				const dbarnes = participants.find(
					(p) => p.userName === 'dbarnes' || p.username === 'dbarnes',
				);
				expect(dbarnes, 'dbarnes appears as a participant').toBeTruthy();
				const groupNames = (dbarnes.stageAssignments ?? []).map((sa) =>
					JSON.stringify(sa.stageAssignmentUserGroup?.name ?? ''),
				);
				expect(
					groupNames.some((name) => name.includes('Translator')),
					`stage assignment records the chosen group: ${groupNames}`,
				).toBe(true);
			} finally {
				await ctx.close();
			}
		},
	);

	test(
		'Single-section journal hides section picker',
		{tag: '@regression'},
		async ({pkpApi, browser, baseURL}) => {
			const tag = uniqueTag();

			// Scratch journal keeps its single default "Articles" section.
			const {context} = await pkpApi.createJournal({
				tag,
				users: [{username: 'dbarnes', roles: ['manager']}],
			});

			const ctx = await browser.newContext({
				baseURL,
				// Explicit empty state: the test-runner-wrapped newContext()
				// inherits the file-level user's storageState otherwise.
				storageState: {cookies: [], origins: []},
			});
			try {
				const page = await ctx.newPage();
				await loginOnJournal(page, context.path, 'dbarnes');

				const wizard = new SubmissionWizardPage(page, context.path);
				await wizard.goto();
				await expect(
					page.getByRole('button', {name: 'Begin Submission'}),
				).toBeVisible();

				// No section radio renders — the section is a hidden field.
				await expect(
					page.locator('input[name="sectionId"][type="radio"]'),
				).toHaveCount(0);
				await expect(
					page.locator('input[name="sectionId"][type="hidden"]'),
				).toHaveCount(1);

				await wizard.start({title: `Single section ${tag}`});
				const id = wizard.currentSubmissionId();
				expect(id).toBeTruthy();

				// The started submission still targets that section.
				const sectionsRes = await page.request.get(
					`/index.php/${context.path}/api/v1/sections`,
				);
				expect(sectionsRes.ok()).toBeTruthy();
				const sectionsBody = await sectionsRes.json();
				const sections = sectionsBody.items ?? sectionsBody;
				expect(sections.length).toBe(1);

				const subRes = await page.request.get(
					`/index.php/${context.path}/api/v1/submissions/${id}`,
				);
				expect(subRes.ok()).toBeTruthy();
				const submission = await subRes.json();
				expect(submission.publications[0].sectionId).toBe(
					sections[0].id,
				);
			} finally {
				await ctx.close();
			}
		},
	);

	test(
		'Wizard routing by submission state',
		{tag: '@regression'},
		async ({page, pkpApi}) => {
			const tag = uniqueTag();

			// In-progress draft (UI-started; see spec header for why the
			// scenario's `submitted: false` shape can't stand in here).
			const {id: draftId} = await startDraft(page, {
				title: `Routing draft ${tag}`,
			});

			// Navigate away, then re-open the wizard URL: the draft routes
			// back into the wizard at step 1.
			await page.goto(
				'/index.php/publicknowledge/en/dashboard/mySubmissions',
			);
			await page.goto(
				`/index.php/publicknowledge/submission?id=${draftId}`,
			);
			await expect(page.locator('.submissionWizard')).toBeVisible();
			const wizard = new SubmissionWizardPage(page);
			await wizard.expectStep('Upload Files');

			// A submitted submission's wizard URL shows the "Submission
			// complete" screen instead.
			const {submission} = await pkpApi.createSubmission({
				tag,
				journal: 'publicknowledge',
				submitter: 'atester',
				section: 'ART',
				locale: 'en',
				submitted: true,
				publications: [
					{
						versionStage: 'AO',
						metadata: {
							title: {en: `Routing submitted ${tag}`},
							abstract: {en: `<p>Submitted ${tag}.</p>`},
						},
						published: false,
					},
				],
			});
			await page.goto(
				`/index.php/publicknowledge/submission?id=${submission.id}`,
			);
			await expect(
				page.getByRole('heading', {name: 'Submission complete'}),
			).toBeVisible();
			await expect(
				page.getByRole('link', {name: 'Review this submission'}),
			).toBeVisible();
			await expect(
				page.getByRole('link', {name: 'Create a new submission'}),
			).toBeVisible();
			await expect(
				page.getByRole('link', {name: 'Return to your dashboard'}),
			).toBeVisible();
		},
	);

	test(
		'Wizard access control',
		{tag: '@regression'},
		async ({page, asUser}) => {
			const tag = uniqueTag();
			const {id} = await startDraft(page, {
				title: `Access control ${tag}`,
			});
			const wizardUrl = `/index.php/publicknowledge/submission?id=${id}`;

			// A user with no stage assignment is denied.
			const reviewerCtx = await asUser('jjanssen');
			const reviewerPage = await reviewerCtx.newPage();
			await reviewerPage.goto(wizardUrl);
			await expect(reviewerPage).toHaveURL(/authorizationDenied/);
			// Reviewer-only users fail the wizard's role assignment, so
			// the role-based denial message renders
			// (user.authorization.roleBasedAccessDenied).
			await expect(
				reviewerPage.getByText(
					'The current role does not have access to this operation.',
				),
			).toBeVisible();

			// The submitter retains access.
			await page.goto(wizardUrl);
			await expect(page.locator('.submissionWizard')).toBeVisible();
		},
	);

	test(
		'Confirm dialog cancel path',
		{tag: '@regression'},
		async ({page}) => {
			const tag = uniqueTag();
			const title = `Confirm ${tag}`;

			// Complete draft: file + required metadata.
			const {wizard} = await startDraft(page, {title});
			const fileItem = await wizard.uploadFile(ARTICLE_FIXTURE);
			await wizard.assignPrimaryGenre(fileItem, 'Article Text');
			await wizard.continueStep();
			await wizard.expectStep('Details');
			await wizard.setTitle(title);
			await wizard.setDetailsField(
				'abstract',
				`<p>Confirm abstract ${tag}.</p>`,
			);
			await wizard.continueStep();
			await wizard.continueStep();
			await wizard.continueStep();
			await wizard.continueStep();
			await wizard.expectStep('Review');

			// Submit opens the confirmation dialog with the journal-name
			// copy from getConfirmSubmitMessage + the submission title.
			const dialog = await wizard.openSubmitDialog();
			await expect(dialog).toContainText(
				'will be submitted to Journal of Public Knowledge',
			);
			await expect(dialog).toContainText(title);

			// Cancel returns to an editable wizard.
			await dialog.getByRole('button', {name: 'Cancel'}).click();
			await expect(dialog).toHaveCount(0, {timeout: 10_000});
			await wizard.expectStep('Review');
			await wizard.gotoStep('Details');
			await wizard.expectStep('Details');
			expect(
				await getTinyMceContent(page, 'titleAbstract-title-control-en'),
			).toContain(title);

			// Confirming completes the submission.
			await wizard.gotoStep('Review');
			await wizard.expectStep('Review');
			await wizard.submit();
			await expect(
				page.getByRole('heading', {name: 'Submission complete'}),
			).toBeVisible();
		},
	);

	test(
		'Entry points route to the start form',
		{tag: '@regression'},
		async ({page, browser, baseURL}) => {
			// Dashboard side menu → "Start A New Submission".
			await page.goto(
				'/index.php/publicknowledge/en/dashboard/mySubmissions',
			);
			await page
				.getByRole('link', {name: 'Start A New Submission'})
				.click();
			await expect(page).toHaveURL(/\/submission/);
			await expect(
				page.getByRole('heading', {name: 'Make a Submission'}),
			).toBeVisible();
			await expect(
				page.getByRole('button', {name: 'Begin Submission'}),
			).toBeVisible();

			// Journal front-end "Make a new submission" link.
			await page.goto('/index.php/publicknowledge/about/submissions');
			await page
				.getByRole('link', {name: 'Make a new submission'})
				.click();
			await expect(
				page.getByRole('heading', {name: 'Make a Submission'}),
			).toBeVisible();

			// Anonymous visitors are sent through login first and return.
			const anonCtx = await browser.newContext({
				baseURL,
				// Explicit empty state: the test-runner-wrapped newContext()
				// inherits the file-level user's storageState otherwise.
				storageState: {cookies: [], origins: []},
			});
			try {
				const anonPage = await anonCtx.newPage();
				await anonPage.goto('/index.php/publicknowledge/submission');
				await expect(anonPage).toHaveURL(/\/login/);
				await anonPage.locator('input#username').fill('atester');
				await anonPage
					.locator('input#password')
					.fill('atesteratester');
				await anonPage.locator('form#login button').click();
				await anonPage.waitForURL(
					(url) => !url.pathname.includes('/login'),
					{timeout: 15_000},
				);
				await expect(
					anonPage.getByRole('heading', {name: 'Make a Submission'}),
				).toBeVisible();
				await expect(
					anonPage.getByRole('button', {name: 'Begin Submission'}),
				).toBeVisible();
			} finally {
				await anonCtx.close();
			}
		},
	);
});
