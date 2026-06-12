// @ts-check
const path = require('path');
const {test, expect} = require('../support/base-test.js');
const {EditorialWorkflowPage} = require('../../../../playwright/pages/EditorialWorkflowPage.js');
const {setTinyMceContent, getTinyMceContent} = require('../support/tinymce.js');
const submissionInReview = require('../../../../playwright/fixtures/scenarios/submission-in-review.js');
const submissionPublished = require('../../../../playwright/fixtures/scenarios/submission-published.js');

/**
 * Publication amendments (Summary of Changes + update type) —
 * docs/e2e/plans/publication-amendments.md rows 1–6.
 *
 * Feature surfaces (verified against the May 2026 landing, eb14c0b9d3):
 *   - submissionFile.json `summaryOfChanges` — single-value rich-text on
 *     Review Revision uploads only; offered by the Vue FileMetadataForm
 *     mounted inside the legacy plupload wizard's step 2
 *     (useFileMetadataForm.js — fileStage gate at the
 *     reviewRevisionStages check) and persisted via the legacy
 *     saveMetadata op (SubmissionFilesMetadataForm.php:216-223).
 *   - "Amendment Notice" badge in FileManagerCellType.vue — type cell of
 *     any file manager row whose file is a revision carrying a summary.
 *   - publication.json multilingual `summaryOfChanges` + `updateType`
 *     enum (12 values; DB column default new_version —
 *     classes/migration/install/OJSMigration.php:249).
 *   - Editor-side fields live in two places:
 *       1. the Issue-entry form ("Publication Settings" panel,
 *          formId `issueEntry` — IssueEntryForm.php GROUP_VERSION_AND_UPDATES)
 *       2. the Schedule-for-Publication version form (formId `version` —
 *          useWorkflowVersionForm.js publish mode).
 *     Both wire the summaryOfChanges TinyMCE with an "Insert Content"
 *     toolbar button (useInsertSummaryOfChangesContent.js) on the
 *     SUBMISSION locale's editor only; the button opens
 *     InsertSummaryOfChangesModal which lists revision files that carry
 *     a summary ("Review (Round N) • date • filename") and appends the
 *     stored HTML into the submission-locale field value.
 *
 * Seeding notes:
 *   - Revision files cannot be seeded (Processor scope decision, same
 *     verdict as review-rounds-revisions) — rows 1/2/6 drive the
 *     author's plupload wizard, which IS row 1's behavior under test.
 *   - The plan's "publication updateType/summaryOfChanges seedable via
 *     publications[].metadata passthrough" turned out to be WRONG:
 *     PublicationsProcessor filters metadata through a METADATA_FIELDS
 *     allowlist (PublicationsProcessor.php:47-53) that includes neither
 *     key — unknown metadata is silently dropped. No row needs it
 *     (the DB default covers "v1 defaults to new_version" and the rest
 *     is UI-driven), so no Processor change was made.
 *   - The plan calls updateType a "required select"; the live form
 *     does NOT flag it required (useWorkflowVersionForm.js:333-339 has
 *     no isRequired) — it can't be empty anyway since the select has no
 *     blank option and defaults to new_version. Rows 3/4 assert the
 *     default + the 12 options instead of a required marker.
 */

/** File-stage constant (grep-verified: SubmissionFile.php). */
const FILE_REVIEW_REVISION = 15; // SubmissionFile::SUBMISSION_FILE_REVIEW_REVISION

/** Publication status ints — lib/pkp/classes/submission/PKPSubmission.php. */
const STATUS_QUEUED = 1;
const STATUS_PUBLISHED = 3;

/** UpdateType enum labels in enum-case order (UpdateType.php + submission.po). */
const UPDATE_TYPE_LABELS = [
	'Addendum',
	'Clarification',
	'Correction',
	'Corrigendum',
	'Erratum',
	'Expression of Concern',
	'New Edition',
	'New Version',
	'Partial Retraction',
	'Removal',
	'Retraction',
	'Withdrawal',
];

/** UI strings (grep-verified against the en locale .po files). */
const STR = {
	// submission.form.summaryOfChanges
	fileSummaryLabel: 'Summary of Changes (Amendment Notice)',
	// submission.files.amendmentNotice
	amendmentBadge: 'Amendment Notice',
	// publication.versionAndUpdates — the Issue-entry form group heading
	versionAndUpdates: 'Version and Updates',
	// common.insertContent — TinyMCE toolbar button + modal title
	insertContent: 'Insert Content',
	// common.insert — per-item button in the insert modal
	insert: 'Insert',
	// publication.insertContent.empty (apostrophe-agnostic match)
	insertEmpty: /No saved summaries found for this submission.s review revisions\./,
	// submission.stage.externalReviewWithRound with round=1
	round1Label: 'Review (Round 1)',
};

test.use({user: 'dbarnes'});

function uniqueTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

/** The bundled PDF every revision upload uses. */
function revisionFixturePath() {
	return path.resolve(__dirname, '..', 'fixtures', 'files', 'default-article.pdf');
}

/** The author's workflow surface for a submission. */
function authorWorkflowUrl(submissionId) {
	return `/index.php/publicknowledge/en/dashboard/mySubmissions?workflowSubmissionId=${submissionId}`;
}

/**
 * Workflow-page URL, optionally deep-linking a side-nav entry via
 * workflowMenuKey (e.g. `publication_{pubId}_issue` for the
 * "Publication Settings" / Issue-entry panel).
 *
 * @param {number} submissionId
 * @param {string} [menuKey]
 */
function workflowUrl(submissionId, menuKey) {
	const base = `/index.php/publicknowledge/en/dashboard/editorial?workflowSubmissionId=${submissionId}`;
	return menuKey ? `${base}&workflowMenuKey=${menuKey}` : base;
}

/** The workflow page's hosting side-modal. */
function workflowModal(page) {
	return page.locator('[data-cy="active-modal"]').first();
}

/**
 * Scenario spec: revisions requested on review round 1 — the gate that
 * unlocks the author's "Upload revisions" affordance (rows 1, 2, 6).
 */
function revisionsRequestedSpec({tag}) {
	return {
		...submissionInReview({tag, submitter: 'atester'}),
		decisions: [
			{type: 'sendExternalReview', by: 'dbarnes'},
			{type: 'requestRevisions', by: 'dbarnes'},
		],
	};
}

/**
 * Scenario spec: accepted + sent to production, publication left
 * unassigned (no versionStage) and unpublished — the state the
 * Schedule-for-Publication version form targets (rows 3, 5).
 */
function productionReadySpec({tag}) {
	const spec = submissionPublished({tag});
	spec.publications = [{metadata: spec.publications[0].metadata}];
	return spec;
}

/**
 * Drive the author-side "Upload revisions" plupload wizard end-to-end
 * (same flow review-rounds-revisions.spec.js proves), optionally
 * renaming the file and filling the step-2 "Summary of Changes
 * (Amendment Notice)" rich-text field — the Vue FileMetadataForm
 * mounted inside the legacy wizard (formId `submissionFileMetadataForm`;
 * the summary control id carries NO locale suffix because the field is
 * single-value).
 *
 * @param {import('@playwright/test').Page} authorPage
 * @param {{name?: string, summaryHtml?: string}} [opts]
 */
async function uploadRevisionAsAuthor(authorPage, {name, summaryHtml} = {}) {
	const uploadButton = authorPage
		.getByRole('button', {name: 'Upload revisions', exact: true})
		.first();
	await expect(uploadButton).toBeVisible({timeout: 15_000});
	await uploadButton.click();

	const wizard = authorPage
		.getByRole('dialog', {name: 'Upload Review File'})
		.first();
	await expect(wizard).toBeVisible({timeout: 10_000});

	// Step 1 — genre + file.
	await wizard
		.locator('select[name=genreId]')
		.selectOption({label: 'Article Text'});
	await wizard.locator('input[type=file]').setInputFiles(revisionFixturePath());
	await expect(wizard.getByText('Change File')).toBeVisible({timeout: 15_000});
	await wizard.locator('button#continueButton').click();

	// Step 2 — the Vue metadata form (name prefilled from the filename).
	await expect(
		wizard.locator('label[for$="-name-control-en"]'),
	).toBeVisible({timeout: 10_000});

	// The summary field is offered on every revision upload (fileStage
	// REVIEW_REVISION) and is single-value: exactly one control, with no
	// locale-suffixed siblings.
	await expect(
		wizard.getByText(STR.fileSummaryLabel, {exact: true}),
	).toBeVisible();
	await expect(
		wizard.locator('#submissionFileMetadataForm-summaryOfChanges-control'),
	).toBeAttached();
	await expect(
		wizard.locator('[id^="submissionFileMetadataForm-summaryOfChanges-control-"]'),
	).toHaveCount(0);

	if (name) {
		await wizard
			.locator('#submissionFileMetadataForm-name-control-en')
			.fill(name);
	}
	if (summaryHtml) {
		await setTinyMceContent(
			authorPage,
			'submissionFileMetadataForm-summaryOfChanges-control',
			summaryHtml,
		);
	}
	await wizard.locator('button#continueButton').click();

	// Step 3 — confirm; same button id, label now "Complete".
	await expect(wizard.getByText(/File Added/i)).toBeVisible({timeout: 10_000});
	await wizard.locator('button#continueButton').click();
	await expect(wizard).toBeHidden({timeout: 15_000});
}

/**
 * Fetch the submission's review-revision files (fileStage 15) with the
 * given page's session. summaryOfChanges is apiSummary so it rides the
 * list response.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} submissionId
 */
async function fetchRevisionFiles(page, submissionId) {
	const res = await page.request.get(
		`/index.php/publicknowledge/api/v1/submissions/${submissionId}/files?fileStages[]=${FILE_REVIEW_REVISION}`,
	);
	if (!res.ok()) {
		throw new Error(`GET revision files: ${res.status()} ${await res.text()}`);
	}
	const body = await res.json();
	return body.items || body;
}

/**
 * Fetch one publication's FULL representation (summaryOfChanges is not
 * apiSummary, so the publications LIST omits it).
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} submissionId
 * @param {number} publicationId
 */
async function fetchPublication(page, submissionId, publicationId) {
	const res = await page.request.get(
		`/index.php/publicknowledge/api/v1/submissions/${submissionId}/publications/${publicationId}`,
	);
	if (!res.ok()) {
		throw new Error(
			`GET publication ${publicationId}: ${res.status()} ${await res.text()}`,
		);
	}
	return res.json();
}

/**
 * Open the Issue-entry ("Publication Settings") panel for a publication
 * and wait for its Version and Updates group — the panel hosting the
 * publication-side Summary of Changes + Update Type fields.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} submissionId
 * @param {number} publicationId
 * @returns {import('@playwright/test').Locator} the workflow modal
 */
async function openIssueEntryPanel(page, submissionId, publicationId) {
	await page.goto(
		workflowUrl(submissionId, `publication_${publicationId}_issue`),
	);
	const modal = workflowModal(page);
	await expect(modal.getByText(STR.versionAndUpdates)).toBeVisible({
		timeout: 20_000,
	});
	return modal;
}

/**
 * Click the summary field's Insert Content toolbar button and return
 * the insert side-modal's locator once visible.
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} scope  container holding the field
 */
async function openInsertModal(page, scope) {
	await scope
		.getByRole('button', {name: STR.insertContent, exact: true})
		.first()
		.click();
	const dialog = page.getByRole('dialog', {name: STR.insertContent});
	await expect(dialog).toBeVisible({timeout: 10_000});
	return dialog;
}

/**
 * Satisfy the Issue-entry form's required issue assignment. The form
 * embeds the issue-assignment fields (useWorkflowPublicationFormIssue):
 * on an issue-less publication the assignment radio preloads as
 * "current/back issue" (IssueAssignment::defaultAssignment) with the
 * required Issue select empty, and client-side validation blocks ANY
 * save of the form — including a summary-only edit — with "Issue: This
 * field is required." until an issue is picked.
 *
 * @param {import('@playwright/test').Locator} modal
 */
async function satisfyRequiredIssueAssignment(modal) {
	const issueSelect = modal.locator('select[name="issueId"]');
	await expect(issueSelect).toBeVisible({timeout: 15_000});
	await issueSelect.selectOption({label: 'Vol. 1 No. 2 (2014)'});
}

/**
 * Save the Issue-entry form and wait for the publication PUT to settle
 * (Form.vue tunnels PUT through POST + X-Http-Method-Override; match
 * the bare publications URL so the form's own `_components/issue`
 * refetch can't satisfy the wait).
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} modal
 * @param {number} publicationId
 */
async function saveIssueEntryForm(page, modal, publicationId) {
	const saved = page.waitForResponse(
		(r) =>
			new RegExp(`/publications/${publicationId}$`).test(r.url().split('?')[0]) &&
			r.request().method() === 'POST' &&
			r.ok(),
		{timeout: 20_000},
	);
	await modal.getByRole('button', {name: 'Save', exact: true}).click();
	await saved;
}

test.describe('Publication amendments', () => {
	// Row 1
	test('author revision upload offers Summary of Changes; Amendment Notice badge tracks it', {tag: '@smoke'}, async ({page, pkpApi, asUser}) => {
		const tag = uniqueTag('amend1');
		const {submission} = await pkpApi.createSubmission(
			revisionsRequestedSpec({tag}),
		);

		const authorCtx = await asUser('atester');
		const authorPage = await authorCtx.newPage();
		await authorPage.goto(authorWorkflowUrl(submission.id));

		// First revision: summary filled in the step-2 metadata form (the
		// helper also asserts the field is offered and single-value).
		await uploadRevisionAsAuthor(authorPage, {
			name: `With summary ${tag}`,
			summaryHtml: `<p>Corrected <strong>figures</strong> ${tag}</p>`,
		});
		// Second revision: no summary.
		await uploadRevisionAsAuthor(authorPage, {name: `No summary ${tag}`});

		// saveMetadata persisted the summary on file 1 only.
		const files = await fetchRevisionFiles(authorPage, submission.id);
		expect(files).toHaveLength(2);
		const withSummary = files.find((f) =>
			JSON.stringify(f.name).includes('With summary'),
		);
		const withoutSummary = files.find((f) =>
			JSON.stringify(f.name).includes('No summary'),
		);
		expect(withSummary, 'renamed revision w/ summary should exist').toBeTruthy();
		expect(withoutSummary, 'renamed revision w/o summary should exist').toBeTruthy();
		expect(withSummary.summaryOfChanges).toContain('<strong>figures</strong>');
		expect(withSummary.summaryOfChanges).toContain(tag);
		expect(withoutSummary.summaryOfChanges ?? '').toBe('');

		// Editor's Revisions Uploaded manager: badge on the summary-carrying
		// row only (FileManagerCellType gates on file.summaryOfChanges).
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);
		const revisionsPanel = workflowModal(page).getByRole('table', {
			name: 'Revisions Uploaded',
		});
		await expect(revisionsPanel).toBeVisible({timeout: 20_000});
		const rowWith = revisionsPanel
			.locator('tr', {hasText: `With summary ${tag}`})
			.first();
		const rowWithout = revisionsPanel
			.locator('tr', {hasText: `No summary ${tag}`})
			.first();
		await expect(rowWith).toBeVisible({timeout: 15_000});
		await expect(
			rowWith.getByText(STR.amendmentBadge, {exact: true}),
		).toBeVisible();
		await expect(rowWithout).toBeVisible();
		await expect(
			rowWithout.getByText(STR.amendmentBadge, {exact: true}),
		).toHaveCount(0);
	});

	// Row 2
	test('editor inserts a revision summary into the publication Summary of Changes', {tag: '@regression'}, async ({page, pkpApi, asUser}) => {
		const tag = uniqueTag('amend2');
		const {submission, publications} = await pkpApi.createSubmission(
			revisionsRequestedSpec({tag}),
		);
		const pubId = publications[0].id;

		// Row-1 state: a revision file carrying a summary, assoc'd to its
		// round (default file name kept: default-article.pdf).
		const authorCtx = await asUser('atester');
		const authorPage = await authorCtx.newPage();
		await authorPage.goto(authorWorkflowUrl(submission.id));
		await uploadRevisionAsAuthor(authorPage, {
			summaryHtml: `<p>Revised <em>methods</em> ${tag}</p>`,
		});

		// Editor: the Issue-entry panel's summary field exposes the Insert
		// Content toolbar button (submission locale's editor).
		const modal = await openIssueEntryPanel(page, submission.id, pubId);
		const insertDialog = await openInsertModal(page, modal);

		// The modal lists exactly the one summary-carrying revision file,
		// with the round label, the upload date, and the file name in the
		// item description ("Review (Round 1) • {date} • {name}").
		const item = insertDialog.locator('.insertContent__item');
		await expect(item).toHaveCount(1, {timeout: 15_000});
		await expect(item).toContainText(`Revised methods ${tag}`); // plain-text preview
		await expect(item).toContainText(STR.round1Label);
		await expect(item).toContainText('default-article.pdf');
		await expect(item).toContainText(String(new Date().getFullYear()));

		// Insert appends the stored HTML — markup preserved — into the
		// submission-locale field.
		await item.getByRole('button', {name: STR.insert, exact: true}).click();
		await expect(insertDialog).toBeHidden({timeout: 10_000});
		const fieldHtml = await getTinyMceContent(
			page,
			'issueEntry-summaryOfChanges-control-en',
		);
		expect(fieldHtml).toContain('<em>methods</em>');
		expect(fieldHtml).toContain(tag);

		// …and persists through the form save (the form's embedded issue
		// assignment is required — satisfy it first, see helper).
		await satisfyRequiredIssueAssignment(modal);
		await saveIssueEntryForm(page, modal, pubId);
		const pub = await fetchPublication(page, submission.id, pubId);
		expect(pub.summaryOfChanges.en).toContain('<em>methods</em>');
		expect(pub.summaryOfChanges.en).toContain(tag);
	});

	// Row 3
	test('Schedule for Publication version form carries update type + summary of changes', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('amend3');
		const {submission, publications} = await pkpApi.createSubmission(
			productionReadySpec({tag}),
		);
		const v1 = publications[0];
		expect(v1.status).toBe(STATUS_QUEUED);

		const workflow = new EditorialWorkflowPage(page);
		await page.goto(
			workflowUrl(submission.id, `publication_${v1.id}_titleAbstract`),
		);
		const reviewDetails = await workflow.openPublishingDetailsModal();

		// Update Type: a select offering the 12 UpdateType enum options in
		// enum order, defaulting to New Version. (The plan said "required
		// select" — the live field carries no required flag; the default
		// guarantees a value instead. See spec header.)
		const updateTypeSelect = reviewDetails.locator('select[name="updateType"]');
		await expect(updateTypeSelect).toBeVisible({timeout: 15_000});
		await expect(updateTypeSelect.locator('option')).toHaveText(
			UPDATE_TYPE_LABELS,
		);
		await expect(updateTypeSelect).toHaveValue('new_version');

		// Summary of Changes is multilingual on the publication side: the
		// submission-locale control mounts by default and the form-locale
		// switcher exposes the journal's second metadata locale.
		await expect(
			reviewDetails.locator('#version-summaryOfChanges-control-en'),
		).toBeAttached();
		await reviewDetails
			.locator('button.pkpFormLocales__locale', {hasText: /French/})
			.first()
			.click();
		await expect(
			reviewDetails.locator('#version-summaryOfChanges-control-fr_CA'),
		).toBeAttached({timeout: 10_000});

		// Choose values and Confirm. The Confirm PUT persists version stage
		// + update type + summary onto the publication; the follow-up
		// publish confirmation (legacy "Schedule For Publication" modal) is
		// dismissed without publishing — row 4 owns the publish itself.
		// versionIsMinor must be 'false' here: no VoR version exists yet,
		// so the Minor option is disabled (updateMinorOptionAvailability).
		await updateTypeSelect.selectOption('corrigendum');
		await setTinyMceContent(
			page,
			'version-summaryOfChanges-control-en',
			`<p>Schedule summary ${tag}</p>`,
		);
		const publishModal = await workflow.confirmPublishingDetails(reviewDetails, {
			versionIsMinor: 'false',
		});
		await page
			.getByRole('dialog', {name: 'Schedule For Publication'})
			.getByRole('button', {name: 'Close', exact: true})
			.click();
		await expect(publishModal).toBeHidden({timeout: 10_000});

		// REST round-trip: the chosen values landed on the publication.
		const pub = await fetchPublication(page, submission.id, v1.id);
		expect(pub.updateType).toBe('corrigendum');
		expect(pub.summaryOfChanges.en).toContain(`Schedule summary ${tag}`);
		expect(pub.versionStage).toBe('VoR');
	});

	// Row 4
	test('update type across versions: v1 defaults to new version, v2 publishes as correction', {tag: ['@regression', '@slow']}, async ({page, pkpApi}) => {
		// Create-version dialog + full publish flow + three workflow loads —
		// give it the slow budget under parallel load.
		test.slow();
		const tag = uniqueTag('amend4');
		const {submission, publications} = await pkpApi.createSubmission(
			submissionPublished({tag}),
		);
		const v1 = publications[0];

		// v1 published through the scenario carries the DB-default
		// new_version and no summary.
		let v1Full = await fetchPublication(page, submission.id, v1.id);
		expect(v1Full.status).toBe(STATUS_PUBLISHED);
		expect(v1Full.updateType).toBe('new_version');
		expect(v1Full.summaryOfChanges?.en ?? '').toBe('');

		// Create New Version (VoR minor → 1.1 draft) and reload — the
		// side-nav only lists the new entry after a reload (POM caveat).
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);
		await workflow.createNewVersion({
			versionStage: 'VoR',
			versionIsMinor: 'true',
		});
		const all = await workflow.fetchPublications(submission.id);
		expect(all).toHaveLength(2);
		const v2 = all.find((p) => p.id !== v1.id);

		// Schedule v2: updateType=correction + a summary, then commit the
		// publish (back issue → immediate publish, button label "Publish").
		await page.goto(
			workflowUrl(submission.id, `publication_${v2.id}_titleAbstract`),
		);
		const reviewDetails = await workflow.openPublishingDetailsModal();
		await reviewDetails
			.locator('select[name="updateType"]')
			.selectOption('correction');
		await setTinyMceContent(
			page,
			'version-summaryOfChanges-control-en',
			`<p>Corrected v2 ${tag}</p>`,
		);
		const publishModal = await workflow.confirmPublishingDetails(reviewDetails);
		await publishModal
			.getByRole('button', {name: 'Publish', exact: true})
			.click();
		await expect(publishModal).toBeHidden({timeout: 20_000});

		// v2 carries correction + the summary; v1 is untouched.
		const v2Full = await fetchPublication(page, submission.id, v2.id);
		expect(v2Full.status).toBe(STATUS_PUBLISHED);
		expect(v2Full.updateType).toBe('correction');
		expect(v2Full.summaryOfChanges.en).toContain(`Corrected v2 ${tag}`);
		expect(`${v2Full.versionMajor}.${v2Full.versionMinor}`).toBe('1.1');
		v1Full = await fetchPublication(page, submission.id, v1.id);
		expect(v1Full.updateType).toBe('new_version');
		expect(v1Full.summaryOfChanges?.en ?? '').toBe('');
	});

	// Row 5
	test('insert modal shows its empty state without revision files; manual entry still saves', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('amend5');
		// Accepted + in production, but no review-revision files exist (the
		// scenario only seeds the stage-1 Article Text file).
		const {submission, publications} = await pkpApi.createSubmission(
			productionReadySpec({tag}),
		);
		const pubId = publications[0].id;

		const modal = await openIssueEntryPanel(page, submission.id, pubId);
		const insertDialog = await openInsertModal(page, modal);
		await expect(insertDialog.getByText(STR.insertEmpty)).toBeVisible({
			timeout: 15_000,
		});
		await expect(insertDialog.locator('.insertContent__item')).toHaveCount(0);
		await insertDialog
			.getByRole('button', {name: 'Close', exact: true})
			.click();
		await expect(insertDialog).toBeHidden({timeout: 10_000});

		// Manual entry into the same field saves normally (the form's
		// embedded issue assignment is required — satisfy it first).
		await setTinyMceContent(
			page,
			'issueEntry-summaryOfChanges-control-en',
			`<p>Manual summary ${tag}</p>`,
		);
		await satisfyRequiredIssueAssignment(modal);
		await saveIssueEntryForm(page, modal, pubId);
		const pub = await fetchPublication(page, submission.id, pubId);
		expect(pub.summaryOfChanges.en).toContain(`Manual summary ${tag}`);
	});

	// Row 6
	test('insert fills only the submission locale on a bilingual journal', {tag: '@regression'}, async ({page, pkpApi, asUser}) => {
		const tag = uniqueTag('amend6');
		const {submission, publications} = await pkpApi.createSubmission(
			revisionsRequestedSpec({tag}),
		);
		const pubId = publications[0].id;

		const authorCtx = await asUser('atester');
		const authorPage = await authorCtx.newPage();
		await authorPage.goto(authorWorkflowUrl(submission.id));
		await uploadRevisionAsAuthor(authorPage, {
			summaryHtml: `<p>Locale isolation ${tag}</p>`,
		});

		// publicknowledge is bilingual (en + fr_CA); expose the French
		// column of the multilingual field.
		const modal = await openIssueEntryPanel(page, submission.id, pubId);
		await modal
			.locator('button.pkpFormLocales__locale', {hasText: /French/})
			.first()
			.click();
		await expect(
			modal.locator('#issueEntry-summaryOfChanges-control-fr_CA'),
		).toBeAttached({timeout: 10_000});

		// The Insert Content button registers on the submission locale's
		// editor only — one button even with both locale editors mounted.
		await expect(
			modal.getByRole('button', {name: STR.insertContent, exact: true}),
		).toHaveCount(1);

		const insertDialog = await openInsertModal(page, modal);
		const item = insertDialog.locator('.insertContent__item');
		await expect(item).toHaveCount(1, {timeout: 15_000});
		await item.getByRole('button', {name: STR.insert, exact: true}).click();
		await expect(insertDialog).toBeHidden({timeout: 10_000});

		// en holds the inserted content; fr_CA stays empty (single-value
		// file summary → submission-locale publication field only).
		expect(
			await getTinyMceContent(page, 'issueEntry-summaryOfChanges-control-en'),
		).toContain(tag);
		expect(
			await getTinyMceContent(page, 'issueEntry-summaryOfChanges-control-fr_CA'),
		).toBe('');

		await satisfyRequiredIssueAssignment(modal);
		await saveIssueEntryForm(page, modal, pubId);
		const pub = await fetchPublication(page, submission.id, pubId);
		expect(pub.summaryOfChanges.en).toContain(tag);
		expect(pub.summaryOfChanges.fr_CA ?? '').toBe('');
	});
});
