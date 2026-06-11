// @ts-check
const fs = require('fs');
const os = require('os');
const path = require('path');
const {test, expect} = require('../support/base-test.js');
const {EditorialWorkflowPage} = require('../../../../playwright/pages/EditorialWorkflowPage.js');
const {FileStagePanel, fixtureFilePath} = require('../pages/FileStagePanel.js');
const {waitForJQueryIdle} = require('../support/jquery.js');
const submissionDraft = require('../../../../playwright/fixtures/scenarios/submission-draft.js');

/**
 * Submission files — docs/e2e/plans/submission-files.md, rows 2–8 (row 1
 * is the upload/download filename round-trip already implemented in
 * filenames.spec.js).
 *
 * The surface under test is the SUBMISSION_FILES FileManager panel
 * ("Submission Files") on the stage-1 workflow page, plus the legacy
 * flows its actions open: the 3-step FileUploadWizardHandler ("Upload
 * Submission File", incl. the revise-an-existing-file select), the
 * editMetadata modal ("Edit a file" — Vue FileMetadataForm + Dependent
 * Files grid for html/xml mimetypes), the delete confirmation, the File
 * Information Center (History/Notes tabs) and the downloadAllFiles
 * archive.
 *
 * Seeding: every test creates its own stage-1 submission via the
 * submission scenario (submission-draft fixture); each seeded submission
 * carries the default "Article Text" file (default-article.pdf), which
 * rows 3–7 operate on directly — only the behavior under test drives
 * the UI. Row 8 seeds with submitter atester to exercise the author's
 * SUBMISSION_FILES permission set (FILE_LIST + FILE_EDIT +
 * FILE_DOWNLOAD_ALL — no upload, no delete, no notes).
 *
 * Implementation notes (verified against live sources):
 *  - Per-row actions live in the headlessui More Actions menu; labels
 *    are "Update File Details" / "More Information" / "Delete"
 *    (useFileManagerConfig#getItemActions), NOT the plan's shorthand.
 *  - Dependent files are only supported for text/html and xml
 *    mimetypes (Repo::submissionFile()->supportsDependentFiles), so
 *    row 5 first uploads the bundled sample-article.html and attaches
 *    the image to THAT file, not to the seeded PDF.
 *  - A revision upload edits the existing submission_file row in place
 *    (fileId swap + name overwrite — SubmissionFilesUploadForm::execute),
 *    so row 4 asserts same-id/new-name/new-bytes, not a second row.
 *  - downloadAllFiles streams a zip named
 *    {submissionId}--submission-files.zip (FileApiHandler; the double
 *    dash is a Str::kebab artifact on "{id}-Submission Files").
 *
 * No Mailpit assertions in this plan — none of the covered flows send
 * mail.
 */

/** Verified against lib/pkp/classes/submissionFile/SubmissionFile.php. */
const FILE_STAGE_SUBMISSION = 2; // SubmissionFile::SUBMISSION_FILE_SUBMISSION

const SEEDED_FILE = 'default-article.pdf';

/**
 * Worker- and run-unique tag (the local test DB is long-lived, so the
 * random part keeps re-runs from matching leftover rows).
 *
 * @param {string} suffix
 */
function uniqueTag(suffix) {
	const rand = Math.random().toString(36).slice(2, 8);
	return `sf-w${test.info().parallelIndex}-${suffix}-${rand}`;
}

/** Author dashboard deep-link to a submission's workflow view. */
function authorWorkflowUrl(submissionId) {
	return `/index.php/publicknowledge/en/dashboard/mySubmissions?workflowSubmissionId=${submissionId}`;
}

/**
 * GET the submission's files at a file stage with a logged-in context.
 *
 * @param {import('@playwright/test').APIRequestContext} requestContext
 * @param {number} submissionId
 * @param {number} [fileStage]
 */
async function fetchStageFiles(requestContext, submissionId, fileStage = FILE_STAGE_SUBMISSION) {
	const res = await requestContext.get(
		`/index.php/publicknowledge/api/v1/submissions/${submissionId}/files?fileStages[]=${fileStage}`,
	);
	expect(res.ok(), `GET files (stage ${fileStage}): ${res.status()}`).toBe(true);
	const body = await res.json();
	return body.items || body;
}

/**
 * Stage a uniquely-named copy of the dummy.pdf fixture in the OS temp
 * dir, with a unique marker appended after the PDF body (finfo keys the
 * mimetype off the %PDF magic at offset 0, so trailing bytes don't
 * change detection). The marker makes "the download serves THIS upload"
 * provable byte-for-byte.
 *
 * @param {string} name    filename to upload as (drives the stored name)
 * @param {string} marker  unique content marker appended to the bytes
 * @returns {string} absolute path of the staged file
 */
function stagePdfFixture(name, marker) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkp-submission-files-'));
	const dst = path.join(dir, name);
	fs.copyFileSync(fixtureFilePath('dummy.pdf'), dst);
	fs.appendFileSync(dst, `\n%${marker}\n`);
	return dst;
}

test.use({user: 'dbarnes'});

test.describe('Submission files', () => {
	// Scenario seeding + multiple legacy wizard/modal round-trips per
	// test legitimately exceed the default 60s under parallel load (same
	// rationale as copyediting-stage.spec.js) — raise the ceiling, not a
	// wait: fast runs stay fast.
	test.describe.configure({timeout: 120_000});

	// Row 2
	test('editor uploads and deletes a file at the submission stage', {tag: '@smoke'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('updel');
		const marker = `upload-marker-${tag}`;
		const uploadName = `upload-${tag}.pdf`;
		const {submission} = await pkpApi.createSubmission(submissionDraft({tag}));

		await new EditorialWorkflowPage(page).goto(submission.id);
		const panel = new FileStagePanel(page, 'Submission Files');
		await panel.expectVisible();
		await expect(panel.row(SEEDED_FILE)).toBeVisible({timeout: 15_000});

		// Upload (FILE_UPLOAD) opens the 3-step wizard: genre + plupload
		// file → metadata → confirm.
		const wizard = await panel.openDirectUploadWizard('Upload Submission File');
		await panel.driveUploadWizard(wizard, {
			filePath: stagePdfFixture(uploadName, marker),
		});

		// The new row renders with name, upload date and type badge.
		const row = panel.row(uploadName);
		await expect(row).toBeVisible({timeout: 20_000});
		await expect(row).toContainText(/\d{4}/); // upload date (year)
		await expect(row).toContainText('Article Text'); // genre/type

		// REST: two files at the submission stage now.
		expect(await fetchStageFiles(page.request, submission.id)).toHaveLength(2);

		// Delete via More Actions → confirm. The seeded file survives.
		await panel.deleteFile(uploadName);
		await expect(panel.row(SEEDED_FILE)).toBeVisible();
		const after = await fetchStageFiles(page.request, submission.id);
		expect(after).toHaveLength(1);
		expect(JSON.stringify(after[0].name)).toContain(SEEDED_FILE);
	});

	// Row 3
	test('renaming a file via the edit-metadata modal persists', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('rename');
		const newName = `renamed-${tag}.pdf`;
		const {submission} = await pkpApi.createSubmission(submissionDraft({tag}));

		await new EditorialWorkflowPage(page).goto(submission.id);
		const panel = new FileStagePanel(page, 'Submission Files');
		await panel.expectVisible();

		// More Actions → Update File Details opens the metadata modal;
		// the multilingual name field is prefilled with the current name.
		const modal = await panel.openEditModal(SEEDED_FILE);
		const nameInput = panel.editModalNameInput(modal);
		await expect(nameInput).toHaveValue(SEEDED_FILE);
		await nameInput.fill(newName);
		await panel.saveEditModal(modal);

		// The list shows the new name (the old one is gone)…
		await expect(panel.row(newName)).toBeVisible({timeout: 20_000});
		await expect(panel.row(SEEDED_FILE)).toHaveCount(0);

		// …the rename persisted server-side…
		const files = await fetchStageFiles(page.request, submission.id);
		expect(files).toHaveLength(1);
		expect(files[0].name.en).toBe(newName);

		// …and the download serves it (Content-Disposition carries the
		// new name; FileApiHandler::downloadFile uses the stored name).
		const href = await panel.fileLink(newName).getAttribute('href');
		expect(href, 'renamed row should expose a download url').toBeTruthy();
		const download = await page.request.get(String(href));
		expect(download.ok(), `download: ${download.status()}`).toBe(true);
		expect(download.headers()['content-type']).toContain('pdf');
		expect(download.headers()['content-disposition'] || '').toContain(
			`renamed-${tag}`,
		);
	});

	// Row 4
	test('uploading a revision replaces the existing file', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('revise');
		const marker = `revision-marker-${tag}`;
		const revisionName = `revised-${tag}.pdf`;
		const {submission} = await pkpApi.createSubmission(submissionDraft({tag}));

		// Baseline: the single seeded file and its id.
		const before = await fetchStageFiles(page.request, submission.id);
		expect(before).toHaveLength(1);
		const seededFileId = before[0].id;

		await new EditorialWorkflowPage(page).goto(submission.id);
		const panel = new FileStagePanel(page, 'Submission Files');
		await panel.expectVisible();

		// The upload wizard's "revision of an existing file" select
		// targets the seeded Article Text; picking it disables the genre
		// select (the revision inherits genre + submission-file row).
		const wizard = await panel.openDirectUploadWizard('Upload Submission File');
		await panel.driveUploadWizard(wizard, {
			filePath: stagePdfFixture(revisionName, marker),
			reviseFileName: SEEDED_FILE,
		});

		// Still a single row — revised in place, not duplicated. The name
		// follows the revision upload (SubmissionFilesUploadForm::execute
		// overwrites it with the uploaded filename).
		await expect(panel.row(revisionName)).toBeVisible({timeout: 20_000});
		await expect(panel.row(SEEDED_FILE)).toHaveCount(0);
		const after = await fetchStageFiles(page.request, submission.id);
		expect(after).toHaveLength(1);
		expect(after[0].id).toBe(seededFileId); // same submission file row
		expect(after[0].name.en).toBe(revisionName);

		// The download serves the NEW bytes — the staged revision carries
		// a unique marker the original fixture doesn't.
		const href = await panel.fileLink(revisionName).getAttribute('href');
		expect(href, 'revised row should expose a download url').toBeTruthy();
		const download = await page.request.get(String(href));
		expect(download.ok(), `download: ${download.status()}`).toBe(true);
		const body = await download.body();
		expect(body.includes(Buffer.from(`%${marker}`))).toBe(true);
	});

	// Row 5 — dependent files are gated on html/xml mimetypes
	// (Repo::submissionFile()->supportsDependentFiles), so the test
	// uploads an HTML article first and attaches the image to it.
	test('dependent files attach through the edit modal', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('dep');
		const htmlName = 'sample-article.html';
		const imageName = 'dependent-image.png';
		const {submission} = await pkpApi.createSubmission(submissionDraft({tag}));

		await new EditorialWorkflowPage(page).goto(submission.id);
		const panel = new FileStagePanel(page, 'Submission Files');
		await panel.expectVisible();

		// Stage the HTML main file via the upload wizard.
		const uploadWizard = await panel.openDirectUploadWizard(
			'Upload Submission File',
		);
		await panel.driveUploadWizard(uploadWizard, {
			filePath: fixtureFilePath(htmlName),
		});
		await expect(panel.row(htmlName)).toBeVisible({timeout: 20_000});

		// The HTML file's edit modal renders the Dependent Files grid
		// (the seeded PDF would not — mimetype gate).
		const modal = await panel.openEditModal(htmlName);
		await expect(modal.getByText('Dependent Files').first()).toBeVisible({
			timeout: 15_000,
		});

		// The grid's "Upload File" action stacks the dependent-file
		// wizard ("Upload a Dependent File"); its genre list holds the
		// dependent genres (Image, Multimedia, HTML Stylesheet).
		await modal.locator('a:has-text("Upload File")').first().click();
		const depWizard = page
			.getByRole('dialog', {name: 'Upload a Dependent File'})
			.first();
		await expect(depWizard).toBeVisible({timeout: 15_000});
		await panel.driveUploadWizard(depWizard, {
			filePath: fixtureFilePath(imageName),
			genreLabel: 'Image',
		});

		// The image lists in the Dependent Files grid…
		await expect(
			modal.locator('tr', {hasText: imageName}).first(),
		).toBeVisible({timeout: 20_000});
		await panel.closeModal(modal);

		// …but not as a standalone row in the stage file list (UI), and
		// the submission-stage file list is unchanged server-side.
		await expect(panel.row(imageName)).toHaveCount(0);
		const stageFiles = await fetchStageFiles(page.request, submission.id);
		expect(stageFiles).toHaveLength(2); // seeded PDF + HTML article
		expect(JSON.stringify(stageFiles.map((f) => f.name))).not.toContain(
			imageName,
		);
	});

	// Row 6
	test('File Information Center shows notes and history', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('infocenter');
		const noteText = `Editorial note on the manuscript file ${tag}`;
		const {submission} = await pkpApi.createSubmission(submissionDraft({tag}));

		await new EditorialWorkflowPage(page).goto(submission.id);
		const panel = new FileStagePanel(page, 'Submission Files');
		await panel.expectVisible();

		// More Actions → More Information opens the Information Center
		// modal (titled "Information Center: {fileName}").
		let modal = await panel.openInformationCenter(SEEDED_FILE);

		// History tab: the seeded file's upload event-log entry renders
		// in the event grid ("A file … was uploaded for submission …").
		await modal.getByRole('tab', {name: 'History'}).click();
		await waitForJQueryIdle(page);
		await expect(
			modal.getByText(/was uploaded for submission/).first(),
		).toBeVisible({timeout: 15_000});

		// Notes tab: add a note and see it render in the list.
		await modal.getByRole('tab', {name: 'Notes'}).click();
		await waitForJQueryIdle(page);
		const noteField = modal.locator('textarea[name="newNote"]');
		await expect(noteField).toBeVisible({timeout: 15_000});
		await noteField.fill(noteText);
		await modal.getByRole('button', {name: 'Add Note', exact: true}).click();
		await waitForJQueryIdle(page);
		await expect(modal.getByText(noteText).first()).toBeVisible({
			timeout: 15_000,
		});

		// The note persists: reopen the Information Center fresh.
		await panel.closeModal(modal);
		modal = await panel.openInformationCenter(SEEDED_FILE);
		await modal.getByRole('tab', {name: 'Notes'}).click();
		await waitForJQueryIdle(page);
		await expect(modal.getByText(noteText).first()).toBeVisible({
			timeout: 15_000,
		});
	});

	// Row 7
	test('Download All Files returns an archive', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('dlall');
		const marker = `dlall-marker-${tag}`;
		const uploadName = `archive-extra-${tag}.pdf`;
		const {submission} = await pkpApi.createSubmission(submissionDraft({tag}));

		await new EditorialWorkflowPage(page).goto(submission.id);
		const panel = new FileStagePanel(page, 'Submission Files');
		await panel.expectVisible();

		// Add a second file so the archive is a real multi-file bundle.
		const wizard = await panel.openDirectUploadWizard('Upload Submission File');
		await panel.driveUploadWizard(wizard, {
			filePath: stagePdfFixture(uploadName, marker),
		});
		await expect(panel.row(uploadName)).toBeVisible({timeout: 20_000});

		// "Download All Files" (bottom controls — only rendered when the
		// panel has files) streams a zip named
		// {submissionId}--submission-files.zip. The double dash is real:
		// FileApiHandler::downloadAllFiles builds "{id}-Submission Files"
		// and Str::kebab() inserts another dash before the capital S.
		// Cosmetic app quirk; assert tolerantly on id prefix + suffix.
		const download = await panel.downloadAll();
		expect(download.suggestedFilename()).toMatch(
			new RegExp(`^${submission.id}-+submission-files\\.zip$`),
		);
		const archivePath = await download.path();
		expect(archivePath, 'download should yield a readable file').toBeTruthy();
		const archive = fs.readFileSync(String(archivePath));
		// Zip entry names are stored verbatim in the local file headers —
		// both files made it into the archive.
		expect(archive.includes(Buffer.from(SEEDED_FILE))).toBe(true);
		expect(archive.includes(Buffer.from(uploadName))).toBe(true);

		// The single-file download link works alongside the archive.
		const href = await panel.fileLink(uploadName).getAttribute('href');
		expect(href, 'file row should expose a download url').toBeTruthy();
		const single = await page.request.get(String(href));
		expect(single.ok(), `download: ${single.status()}`).toBe(true);
		expect(single.headers()['content-type']).toContain('pdf');
	});

	// Row 8 — author permissions: SUBMISSION_FILES grants authors
	// FILE_LIST + FILE_EDIT + FILE_DOWNLOAD_ALL only
	// (useFileManagerConfig.js), enforced per stage assignment. atester
	// is the only seeded user whose author-side gates are meaningful
	// (see users.md).
	test('author file permissions at the submission stage', {tag: '@regression'}, async ({pkpApi, asUser}) => {
		const tag = uniqueTag('authperm');
		const {submission} = await pkpApi.createSubmission(
			submissionDraft({tag, submitter: 'atester'}),
		);

		const authorCtx = await asUser('atester');
		const authorPage = await authorCtx.newPage();
		await authorPage.goto(authorWorkflowUrl(submission.id));

		// FILE_LIST: the author sees the panel with the seeded file.
		const panel = new FileStagePanel(authorPage, 'Submission Files');
		await panel.expectVisible();
		await expect(panel.row(SEEDED_FILE)).toBeVisible({timeout: 20_000});

		// FILE_DOWNLOAD_ALL: the bottom "Download All Files" control is
		// offered… (presence asserted before the absence checks so the
		// panel is fully rendered)
		const downloadAllButton = panel.root().getByRole('button', {
			name: 'Download All Files',
		});
		await expect(downloadAllButton).toBeVisible({timeout: 15_000});

		// …but no FILE_UPLOAD: the top "Upload" action is absent.
		await expect(
			panel.root().getByRole('button', {name: 'Upload', exact: true}),
		).toHaveCount(0);

		// The row menu offers Edit (FILE_EDIT) but neither Delete nor
		// More Information (FILE_DELETE / FILE_SEE_NOTES are editorial).
		await panel.openRowMenu(SEEDED_FILE);
		const editItem = authorPage.getByRole('menuitem', {
			name: 'Update File Details',
			exact: true,
		});
		await expect(editItem).toBeVisible({timeout: 10_000});
		await expect(
			authorPage.getByRole('menuitem', {name: 'Delete', exact: true}),
		).toHaveCount(0);
		await expect(
			authorPage.getByRole('menuitem', {name: 'More Information', exact: true}),
		).toHaveCount(0);

		// FILE_EDIT works end-to-end: the metadata modal opens with the
		// name field (server-side, ManageFileApiHandler role-assigns
		// AUTHOR for editMetadata).
		await editItem.click();
		const modal = authorPage
			.getByRole('dialog', {name: 'Edit a file'})
			.first();
		await expect(modal).toBeVisible({timeout: 15_000});
		await expect(panel.editModalNameInput(modal)).toHaveValue(SEEDED_FILE, {
			timeout: 15_000,
		});
		await panel.closeModal(modal);

		// FILE_DOWNLOAD_ALL works end-to-end: the archive downloads (see
		// row 7 on the kebab-case double dash in the suggested name).
		const download = await panel.downloadAll();
		expect(download.suggestedFilename()).toMatch(
			new RegExp(`^${submission.id}-+submission-files\\.zip$`),
		);
	});
});
