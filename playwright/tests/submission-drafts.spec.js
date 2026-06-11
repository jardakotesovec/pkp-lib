// @ts-check
const path = require('path');
const {test, expect} = require('../support/base-test.js');
const {SubmissionWizardPage} = require('../pages/SubmissionWizardPage.js');

/**
 * Submission drafts — docs/e2e/plans/submission-drafts.md (6 rows).
 *
 * All tests run as atester (the baseline author-only user). Drafts are
 * seeded through the scenario endpoint with `submitted: false` (which
 * leaves the wizard's in-progress markers: submission_progress='start',
 * date_submitted NULL — see the SubmissionBuilderProcessor audit
 * fragment) except where the row explicitly exercises the wizard UI to
 * create the draft (rows 1 and 6).
 *
 * Parallel-safety: atester is shared across many specs, so every list
 * assertion is presence/absence scoped by this test's unique tag —
 * never counts, never exact membership.
 */

// Second bundled fixture (distinct from the default-article.pdf the
// scenario processor attaches) so file-persistence assertions can
// distinguish the file added by the test from the seeded one.
const DUMMY_FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'files', 'dummy.pdf');

function uniqueTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

/**
 * Minimal wizard-draft scenario spec: atester's in-progress submission
 * on publicknowledge. The processor appends " [tag]" to the title.
 */
function draftSpec({tag, title}) {
	return {
		tag,
		journal: 'publicknowledge',
		submitter: 'atester',
		section: 'ART',
		locale: 'en',
		submitted: false,
		publications: [{metadata: {title: {en: title}}}],
	};
}

const INCOMPLETE_VIEW =
	'/index.php/publicknowledge/en/dashboard/mySubmissions?currentViewId=incomplete-submissions';

/**
 * Scope a dashboard list to this test's rows. atester's views
 * accumulate rows from every parallel spec and the table paginates at
 * 30 per page, so tag-scoped presence assertions must narrow the list
 * server-side first. The search component listens on (debounced)
 * keyup — type the token, don't just fill it.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} token  whitespace-free unique marker (the test tag)
 */
async function searchList(page, token) {
	const search = page.locator('.pkpSearch__input');
	await expect(search).toBeVisible({timeout: 15_000});
	await search.fill('');
	await search.pressSequentially(token);
}

test.describe('Submission drafts', () => {
	test.use({user: 'atester'});

	test('save for later: saved screen shows account email, email links back to the draft wizard', {tag: '@regression'}, async ({page, pkpMail}) => {
		const tag = uniqueTag('sdl');
		const title = `Savelater-${tag}`;

		const wizard = new SubmissionWizardPage(page);
		await wizard.goto();
		await wizard.start({title, section: 'Articles'});
		const submissionId = wizard.currentSubmissionId();
		expect(submissionId).toBeTruthy();

		// Move to Details and set the publication title so the
		// saved-for-later email's {$submissionTitle} variable (current
		// publication's full title) carries the tag — that's the unique
		// marker the Mailpit assertion scopes on (principle 8).
		await wizard.expectStep('Upload Files');
		await wizard.continueStep();
		await wizard.expectStep('Details');
		await wizard.setTitle(title, 'en');

		// Save for Later (footer button; an identical button sits in the
		// page heading — scope to the footer). The handler first flushes
		// outstanding autosaves (incl. the title we just set), then PUTs
		// /saveForLater and redirects to the saved screen.
		await page
			.locator('.submissionWizard__footer')
			.getByRole('button', {name: 'Save for Later'})
			.click();

		await expect(
			page.getByRole('heading', {name: 'Saved for Later'}),
		).toBeVisible({timeout: 20_000});
		// The saved screen confirms where the resume link was emailed.
		await expect(
			page.getByText('atester@mailinator.com'),
		).toBeVisible();
		// And links back to the draft by author/title.
		await expect(page.getByRole('link', {name: new RegExp(title)})).toBeVisible();

		// SubmissionSavedForLater email: recipient + tag scoped.
		const [message] = await pkpMail.find({
			to: 'atester@mailinator.com',
			contains: tag,
			timeoutMs: 15_000,
		});
		expect(message.Subject).toContain('Resume your submission');

		const full = await pkpMail.fullMessage(message.ID);
		const link = pkpMail.extractLink(full.HTML, title);
		expect(link).toContain(`id=${submissionId}`);

		// Following the link reopens the wizard on the same draft.
		await page.goto(link);
		await expect(page.locator('.submissionWizard')).toBeVisible({timeout: 20_000});
		expect(wizard.currentSubmissionId()).toBe(submissionId);
	});

	test('incomplete submissions view lists drafts and the Complete submission action resumes the wizard', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('sdv');
		const {submission: draftA} = await pkpApi.createSubmission(
			draftSpec({tag, title: `IncA-${tag}`}),
		);
		await pkpApi.createSubmission(draftSpec({tag, title: `IncB-${tag}`}));

		await page.goto(INCOMPLETE_VIEW);
		await expect(
			page.getByRole('heading', {name: /Incomplete submissions/}),
		).toBeVisible({timeout: 15_000});
		await searchList(page, tag);

		const rowA = page.getByRole('row').filter({hasText: `IncA-${tag}`});
		const rowB = page.getByRole('row').filter({hasText: `IncB-${tag}`});
		await expect(rowA).toBeVisible({timeout: 15_000});
		await expect(rowB).toBeVisible();
		// Incomplete status badge on the draft rows.
		await expect(rowA).toContainText('Incomplete');
		await expect(rowB).toContainText('Incomplete');

		// The continue action ("Complete submission") redirects into the
		// wizard for that draft.
		await rowA.getByRole('button', {name: 'Complete submission'}).click();
		await page.waitForURL(new RegExp(`/submission\\?id=${draftA.id}`), {
			timeout: 20_000,
			waitUntil: 'commit',
		});
		await expect(page.locator('.submissionWizard')).toBeVisible({timeout: 20_000});
	});

	test('draft edits (details title, uploaded file) persist into a fresh session', {tag: '@regression'}, async ({page, pkpApi, asUser}) => {
		const tag = uniqueTag('sdp');
		const {submission} = await pkpApi.createSubmission(
			draftSpec({tag, title: `Persist-${tag}`}),
		);
		const editedTitle = `Persist-${tag} edited`;

		// Session 1: resume the draft, upload a second file, edit the title.
		await page.goto(`/index.php/publicknowledge/submission?id=${submission.id}`);
		await expect(page.locator('.submissionWizard')).toBeVisible({timeout: 20_000});
		const wizard = new SubmissionWizardPage(page);
		await wizard.expectStep('Upload Files');

		// The seeded draft already carries the default Article Text file;
		// upload dummy.pdf so the persistence assertion targets a file
		// this session added.
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
			fileInput.setInputFiles(DUMMY_FIXTURE),
		]);
		expect(uploadResp.ok()).toBeTruthy();
		const newItem = page
			.locator('.listPanel__item--submissionFile')
			.filter({hasText: 'dummy.pdf'});
		await expect(newItem).toBeVisible({timeout: 15_000});
		// Assign the primary genre so the file is fully shaped.
		const genreButton = newItem
			.locator('.listPanel--submissionFiles__setGenreButton')
			.filter({hasText: 'Article Text'})
			.first();
		if (await genreButton.isVisible().catch(() => false)) {
			await Promise.all([
				page.waitForResponse(
					(res) =>
						res.request().method() === 'POST' &&
						/\/api\/v1\/submissions\/\d+\/files\/\d+/.test(res.url()) &&
						res.ok(),
					{timeout: 15_000},
				),
				genreButton.click(),
			]);
		}

		// Edit the title on Details. The wizard autosaves on step change;
		// advance one step and poll the REST API until the edited title
		// is persisted server-side — deterministic without guessing the
		// autosave transport.
		await wizard.continueStep();
		await wizard.expectStep('Details');
		await wizard.setTitle(editedTitle, 'en');
		await wizard.continueStep();
		await wizard.expectStep('Contributors');
		await expect
			.poll(
				async () => {
					const res = await page.request.get(
						`/index.php/publicknowledge/api/v1/submissions/${submission.id}`,
					);
					if (!res.ok()) {
						return '';
					}
					const body = await res.json();
					return JSON.stringify(
						body.publications?.map((pub) => pub.fullTitle) ?? [],
					);
				},
				{timeout: 20_000},
			)
			.toContain(editedTitle);

		// Session 2: a fresh browser context (new cookies snapshot, no
		// shared in-memory state) reopens the draft.
		const freshCtx = await asUser('atester');
		const freshPage = await freshCtx.newPage();
		await freshPage.goto(`/index.php/publicknowledge/submission?id=${submission.id}`);
		await expect(freshPage.locator('.submissionWizard')).toBeVisible({timeout: 20_000});

		// File added in session 1 is still listed on Upload Files.
		const freshWizard = new SubmissionWizardPage(freshPage);
		await freshWizard.expectStep('Upload Files');
		await expect(
			freshPage
				.locator('.listPanel__item--submissionFile')
				.filter({hasText: 'dummy.pdf'}),
		).toBeVisible({timeout: 15_000});

		// Title edit is still present on Details (TinyMCE content).
		// Walk forward — in a fresh session only the first step has
		// started, so the rail's Details pill isn't clickable yet.
		await freshWizard.continueStep();
		await freshWizard.expectStep('Details');
		await freshPage.waitForFunction(
			({id, value}) => {
				const editor = window.tinymce?.get(id);
				return Boolean(editor?.initialized) && editor.getContent().includes(value);
			},
			{id: 'titleAbstract-title-control-en', value: editedTitle},
			{timeout: 15_000},
		);
	});

	test('cancel from the wizard confirms, shows the cancelled screen and removes the draft', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('sdc');
		const {submission: target} = await pkpApi.createSubmission(
			draftSpec({tag, title: `CancelMe-${tag}`}),
		);
		// Control draft: still listed afterwards, bounding the absence
		// assertion on the cancelled one.
		await pkpApi.createSubmission(draftSpec({tag, title: `CancelKeep-${tag}`}));

		await page.goto(`/index.php/publicknowledge/submission?id=${target.id}`);
		await expect(page.locator('.submissionWizard')).toBeVisible({timeout: 20_000});

		// The footer Cancel link-button (only rendered for the submitting
		// author / managers — atester is the author here).
		await page.locator('#cancelSubmission').click();

		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible({timeout: 10_000});
		await expect(dialog).toContainText('Are you sure you wish to cancel this submission?');
		await dialog.getByRole('button', {name: 'OK'}).click();

		// Lands on the "Submission cancelled" screen.
		await expect(
			page.getByRole('heading', {name: 'Submission cancelled'}),
		).toBeVisible({timeout: 20_000});

		// The draft is gone from the incomplete list; the control draft
		// is still there (positive control first to bound the wait).
		await page.goto(INCOMPLETE_VIEW);
		await searchList(page, tag);
		await expect(
			page.getByRole('row').filter({hasText: `CancelKeep-${tag}`}),
		).toBeVisible({timeout: 15_000});
		await expect(
			page.getByRole('row').filter({hasText: `CancelMe-${tag}`}),
		).toHaveCount(0);
	});

	test('author bulk-deletes own incomplete drafts; submitted submissions offer no delete checkbox', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('sdd');
		await pkpApi.createSubmission(draftSpec({tag, title: `DelA-${tag}`}));
		await pkpApi.createSubmission(draftSpec({tag, title: `DelB-${tag}`}));
		// A real submitted submission (fires Repo::submission()->submit())
		// to prove submitted rows are not deletable.
		await pkpApi.createSubmission({
			tag,
			journal: 'publicknowledge',
			submitter: 'atester',
			section: 'ART',
			locale: 'en',
			submitted: true,
			publications: [{metadata: {title: {en: `DelSubmitted-${tag}`}}}],
		});

		// The Active view shows both wizard drafts and submitted queued
		// submissions, so the no-checkbox assertion on the submitted row
		// can sit next to the deletable drafts.
		await page.goto(
			'/index.php/publicknowledge/en/dashboard/mySubmissions?currentViewId=active',
		);
		await searchList(page, tag);
		const rowA = page.getByRole('row').filter({hasText: `DelA-${tag}`});
		const rowB = page.getByRole('row').filter({hasText: `DelB-${tag}`});
		const rowSubmitted = page.getByRole('row').filter({hasText: `DelSubmitted-${tag}`});
		await expect(rowA).toBeVisible({timeout: 15_000});
		await expect(rowB).toBeVisible();
		await expect(rowSubmitted).toBeVisible();

		// Enable bulk-delete selection via the More Actions dropdown
		// (headlessui menu — items are role=menuitem, portal to the page).
		await page.getByRole('button', {name: 'More Actions'}).click();
		await page
			.getByRole('menuitem', {name: 'Delete Incomplete Submissions'})
			.click();

		// Selection checkboxes appear on the (deletable) draft rows only.
		await expect(rowA.getByRole('checkbox')).toBeVisible({timeout: 10_000});
		await expect(rowB.getByRole('checkbox')).toBeVisible();
		await expect(rowSubmitted.getByRole('checkbox')).toHaveCount(0);

		// The checkbox input is sr-only inside a styled <label>; the
		// icon span intercepts pointer events, so click the label and
		// assert the input state.
		await rowA.locator('label').first().click();
		await expect(rowA.getByRole('checkbox')).toBeChecked();
		await rowB.locator('label').first().click();
		await expect(rowB.getByRole('checkbox')).toBeChecked();

		await page
			.getByRole('button', {name: 'Delete Incomplete Submissions'})
			.click();

		// Confirm dialog carries the incomplete.bulkDelete copy.
		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible({timeout: 10_000});
		await expect(dialog).toContainText('Confirm Delete of Incomplete Submissions');
		await expect(dialog).toContainText(
			'Are you sure you want to delete the selected items?',
		);
		// useFetch tunnels DELETE through POST + X-Http-Method-Override
		// (pkp/pkp-lib#5981) — match on the POST.
		await Promise.all([
			page.waitForResponse(
				(res) =>
					res.request().method() === 'POST' &&
					res.url().includes('/_submissions') &&
					res.ok(),
				{timeout: 20_000},
			),
			dialog.getByRole('button', {name: 'Confirm'}).click(),
		]);

		// List updates: drafts gone, the submitted one (not deletable,
		// not selected) is still listed — positive control bounding the
		// absence assertions.
		await expect(rowSubmitted).toBeVisible({timeout: 15_000});
		await expect(rowA).toHaveCount(0, {timeout: 15_000});
		await expect(rowB).toHaveCount(0);
	});

	test('abandoning the wizard after the start form still leaves an incomplete draft listed', {tag: '@regression'}, async ({page}) => {
		const tag = uniqueTag('sda');
		const title = `Abandon-${tag}`;

		const wizard = new SubmissionWizardPage(page);
		await wizard.goto();
		await wizard.start({title, section: 'Articles'});
		const submissionId = wizard.currentSubmissionId();
		expect(submissionId).toBeTruthy();

		// Navigate away without saving or continuing — the start form
		// already persisted the submission.
		await page.goto(INCOMPLETE_VIEW);
		await searchList(page, tag);
		const row = page.getByRole('row').filter({hasText: title});
		await expect(row).toBeVisible({timeout: 15_000});
		await expect(row).toContainText('Incomplete');
		await expect(
			row.getByRole('button', {name: 'Complete submission'}),
		).toBeVisible();
	});
});
