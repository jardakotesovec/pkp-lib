// @ts-check
const fs = require('fs');
const os = require('os');
const path = require('path');
const {test, expect} = require('../support/base-test.js');
const {EditorialWorkflowPage} = require('../../../../playwright/pages/EditorialWorkflowPage.js');
const {MediaFileManagerPage} = require('../pages/MediaFileManagerPage.js');

/**
 * Media files — docs/e2e/plans/media-files.md, rows 1–8.
 *
 * The surface under test is the Media tab (Vue MediaFileManager) on the
 * workflow page's Publication section, backed by
 * lib/pkp/api/v1/submissions/MediaFilesController.php and
 * lib/pkp/classes/submissionFile/VariantGroup.php (MAX_GROUP_SIZE=2,
 * common-field metadata sync). Feature landed Feb 2026 (ec86e2419e) —
 * no legacy coverage exists.
 *
 * Seeding: rows 2–8 use the `publications[].mediaFiles[]` scenario seed
 * (built this wave; parity entry at the end of
 * docs/scenario-processor-audit.md). Row 1 owns the batch-upload UI as
 * the behavior under test, so it seeds no media files.
 *
 * Implementation realities (verified against live sources):
 *  - The IMAGE genre is GENRE_CATEGORY_ARTWORK, so the Edit Metadata
 *    form exposes caption/credit/copyrightOwner/terms — NOT description
 *    (that's the SUPPLEMENTARY form). `caption` IS a common media-file
 *    field (Repository::getCommonMediaFileFields), so rows 2/4 assert
 *    sync on caption (+ description set via REST in row 2);
 *    `name` is deliberately NOT a common field and must never sync.
 *  - The manual-link modal's option list already EXCLUDES counterparts
 *    consumed by other groups (useMediaFileImageLinking
 *    getSelectedWebFileIds), so the variantGroupAtCapacity error
 *    (MAX_GROUP_SIZE=2) is unreachable through the UI's happy path.
 *    Row 3 asserts the UI filter AND surfaces the capacity guard via a
 *    direct REST PUT — the backend defense the row exists to prove.
 *  - There is no per-galley media linkage: media files attach to the
 *    PUBLICATION (assocType ASSOC_TYPE_PUBLICATION) and ArticleHandler
 *    ::download (pages/article/ArticleHandler.php:538-550) serves any
 *    publication media file under ANY of its galleys' URLs. Row 6
 *    exercises that sharing + galley-deletion survival.
 *  - Reader-side rendering only embeds WEB variants:
 *    plugins/generic/htmlArticleGalley/classes/HtmlGalleyHelper.php:55-66
 *    filters HIGH_RESOLUTION out of the embeddable files ("reserved for
 *    download/export use cases"); no template/theme references
 *    variantType. Row 8 asserts the web-variant embed and the high-res
 *    file's direct download reachability — theme exposure is round 2.
 *
 * No Mailpit assertions — none of the covered flows send mail.
 */

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures', 'files');

/** Worker- and run-unique tag (the local test DB is long-lived). */
function uniqueTag(suffix) {
	const rand = Math.random().toString(36).slice(2, 8);
	return `mf-w${test.info().parallelIndex}-${suffix}-${rand}`;
}

/**
 * Stage a uniquely-named copy of the bundled PNG fixture in the OS temp
 * dir so row 1 can upload two distinct files without adding repo
 * fixtures (the uploaded name drives the stored media-file name).
 *
 * @param {string} name  filename to upload as
 * @returns {string} absolute path of the staged file
 */
function stagePngFixture(name) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkp-media-files-'));
	const dst = path.join(dir, name);
	fs.copyFileSync(path.join(FIXTURES_DIR, 'dependent-image.png'), dst);
	return dst;
}

/**
 * A submission sitting at WORKFLOW_STAGE_ID_PRODUCTION via the
 * skipExternalReview → sendToProduction chain (same shape as
 * production-stage.spec.js). dbarnes is the editor participant; pass
 * `mediaFiles` / `galleys` / `published` through to publications[0].
 *
 * @param {{tag: string, title: string, submitter?: string,
 *   mediaFiles?: object[], galleys?: object[], published?: boolean}} opts
 */
function mediaStageSpec({tag, title, submitter = 'atester', mediaFiles, galleys, published = false}) {
	/** @type {Record<string, any>} */
	const publication = {
		metadata: {
			title: {en: title},
			abstract: {en: '<p>Media-files e2e submission.</p>'},
		},
	};
	if (mediaFiles) publication.mediaFiles = mediaFiles;
	if (galleys) publication.galleys = galleys;
	if (published) {
		publication.versionStage = 'VoR';
		publication.issue = {volume: 1, number: 2, year: 2014}; // bootstrap's published issue
		publication.published = true;
	}
	return {
		tag,
		journal: 'publicknowledge',
		submitter,
		section: 'ART',
		locale: 'en',
		participants: [{user: 'dbarnes', role: 'editor'}],
		decisions: [
			{type: 'skipExternalReview', by: 'dbarnes'},
			{type: 'sendToProduction', by: 'dbarnes'},
		],
		publications: [publication],
	};
}

/**
 * CSRF token from the authenticated page's state — required for
 * non-GET REST calls made via page.request (same pattern as
 * publication-identifiers-license.spec.js).
 */
async function csrfToken(page) {
	const token = await page.evaluate(
		// @ts-ignore pkp is a page global
		() => window.pkp?.currentUser?.csrfToken,
	);
	expect(token, 'csrf token from page state').toBeTruthy();
	return token;
}

/** REST base for a publication's media files. */
function mediaApiPath(submissionId, publicationId, suffix = '') {
	return `/index.php/publicknowledge/api/v1/submissions/${submissionId}/publications/${publicationId}/mediaFiles${suffix}`;
}

/** Map a fetchMediaFiles() result by primary-locale name. */
function byName(items) {
	/** @type {Record<string, any>} */
	const map = {};
	for (const item of items) {
		map[item.name.en] = item;
	}
	return map;
}

/**
 * Fresh anonymous request context. `browser.newContext()` inherits the
 * file-level storageState (patterns.md rule 8), so reader-side checks
 * must pass an explicit empty state.
 */
async function anonContext(browser, baseURL) {
	return browser.newContext({
		storageState: {cookies: [], origins: []},
		baseURL,
	});
}

/**
 * Extract the rewritten media download URL for `fileName` from a served
 * HTML galley body (HtmlGalleyHelper rewrites src="fileName" to the
 * article/download URL carrying the media file's id).
 *
 * @returns {{url: string, fileId: number}}
 */
function extractMediaDownloadUrl(html, fileName) {
	const srcMatch = html.match(
		new RegExp(`src="([^"]*article\\/download[^"]*\\/(\\d+)\\/${fileName.replace(/\./g, '\\.')})"`),
	);
	expect(srcMatch, `rewritten media src for ${fileName} in galley HTML`).toBeTruthy();
	const m = /** @type {RegExpMatchArray} */ (srcMatch);
	return {url: m[1], fileId: Number(m[2])};
}

test.use({user: 'dbarnes'});

test.describe('Media files', () => {
	// Scenario seeding + side-modal round-trips under parallel server
	// load need more than the 60s default — a ceiling, not a wait.
	test.describe.configure({timeout: 120_000});

	// Row 1 — the batch-upload UI is the behavior under test (no seeded
	// media files).
	test('batch upload gates submit on per-file genre and variant type', {tag: '@smoke'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('upload');
		const webName = `web-photo-${tag}.png`;
		const hiresName = `hires-photo-${tag}.png`;
		const {submission, publications} = await pkpApi.createSubmission(
			mediaStageSpec({tag, title: `Vmf1-${tag}`}),
		);

		await new EditorialWorkflowPage(page).goto(submission.id);
		const media = new MediaFileManagerPage(page);
		await media.open();

		// Empty state bounds the post-upload positives.
		await expect(media.table).toContainText('No Items');
		await expect(media.batchLinkButton()).toBeVisible();

		// Add Media File → Upload Media File side modal with the dropzone.
		const modal = await media.openAddModal();
		await expect(modal.getByText('Click to upload files')).toBeVisible();
		const submit = media.uploadFilesButton(modal);

		// First file: card renders (name + genre/variant selects) once the
		// temporaryFiles upload settles; submit stays disabled (no genre)
		// and the variant select is gated off until a variant-supporting
		// genre is picked.
		await media.addFileToUploader(modal, stagePngFixture(webName), 1);
		await expect(modal.getByText(webName)).toBeVisible();
		await expect(submit).toBeDisabled();
		const variantSelects = media.uploaderVariantSelects(modal);
		await expect(variantSelects.nth(0)).toBeDisabled();

		// Second file joins the batch; submit still disabled.
		await media.addFileToUploader(modal, stagePngFixture(hiresName), 2);
		await expect(modal.getByText(hiresName)).toBeVisible();
		await expect(submit).toBeDisabled();

		// File 1: Image genre unlocks its variant select (defaults to web).
		const genreSelects = media.uploaderGenreSelects(modal);
		await genreSelects.nth(0).selectOption({label: 'Image'});
		await expect(variantSelects.nth(0)).toBeEnabled();
		await expect(variantSelects.nth(0)).toHaveValue('web');
		// …but file 2 still has no genre, so the batch can't submit.
		await expect(submit).toBeDisabled();

		// File 2: pick Image + High resolution, then switch to a
		// non-variant genre — the variant select disables AND resets to
		// web (useFileMediaUploader#onGenreChange); switch back and
		// re-pick High resolution.
		await genreSelects.nth(1).selectOption({label: 'Image'});
		await expect(variantSelects.nth(1)).toBeEnabled();
		await variantSelects.nth(1).selectOption({label: 'High resolution'});
		await genreSelects.nth(1).selectOption({label: 'Multimedia'});
		await expect(variantSelects.nth(1)).toBeDisabled();
		await expect(variantSelects.nth(1)).toHaveValue('web');
		await expect(submit).toBeEnabled(); // every file has a genre now
		await genreSelects.nth(1).selectOption({label: 'Image'});
		await variantSelects.nth(1).selectOption({label: 'High resolution'});

		// Submit posts the batch to POST …/mediaFiles and closes the modal.
		const uploadResponse = page.waitForResponse(
			(r) =>
				r.request().method() === 'POST' &&
				r.url().includes('/mediaFiles') &&
				r.ok(),
			{timeout: 30_000},
		);
		await submit.click();
		await uploadResponse;
		await expect(modal).toBeHidden({timeout: 15_000});

		// Uploaded rows render with name, type badges, size and date.
		const webRow = media.row(webName);
		const hiresRow = media.row(hiresName);
		await expect(webRow).toBeVisible({timeout: 20_000});
		await expect(hiresRow).toBeVisible();
		await expect(webRow).toContainText('Image');
		await expect(webRow).not.toContainText('High resolution');
		await expect(hiresRow).toContainText('Image');
		await expect(hiresRow).toContainText('High resolution');
		await expect(webRow).toContainText(/\d+(\.\d+)?\s*(B|KB|MB)/);
		await expect(webRow).toContainText(/20\d\d/);

		// REST: two SUBMISSION_FILE_MEDIA rows, correct variant types,
		// ungrouped.
		const files = byName(
			await media.fetchMediaFiles(submission.id, publications[0].id),
		);
		expect(Object.keys(files)).toHaveLength(2);
		expect(files[webName].variantType).toBe('web');
		expect(files[hiresName].variantType).toBe('high_resolution');
		expect(files[webName].variantGroupId).toBeNull();
		expect(files[hiresName].variantGroupId).toBeNull();
	});

	// Row 2
	test('batch-link pairs web files with high-res and syncs common metadata', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('batchlink');
		const caption = `Common caption ${tag}`;
		const description = `Common description ${tag}`;
		const {submission, publications} = await pkpApi.createSubmission(
			mediaStageSpec({
				tag,
				title: `Vmf2-${tag}`,
				mediaFiles: [
					{variantType: 'web', name: 'web-alpha.png'},
					{variantType: 'web', name: 'web-beta.png'},
					{variantType: 'high_resolution', name: 'hires-alpha.png'},
					{variantType: 'high_resolution', name: 'hires-beta.png'},
					// Genre decoy: high-res of a different genre must never be
					// offered for IMAGE web files (genreId filter in
					// useMediaFileImageLinking#getHighResOptionsForWebFile).
					{variantType: 'high_resolution', genre: 'ARTICLE', name: 'decoy-article.png'},
				],
			}),
		);
		const publicationId = publications[0].id;
		const seeded = byName(publications[0].mediaFiles.map((f) => ({...f, name: {en: f.name}})));

		await new EditorialWorkflowPage(page).goto(submission.id);
		const media = new MediaFileManagerPage(page);
		await media.open();

		// Give the future PRIMARY (web-alpha) common metadata via REST so
		// the link's metadata propagation is observable.
		const token = await csrfToken(page);
		const putRes = await page.request.put(
			mediaApiPath(submission.id, publicationId, `/${seeded['web-alpha.png'].id}`),
			{
				headers: {'X-Csrf-Token': token},
				data: {caption, description: {en: description}},
			},
		);
		expect(putRes.ok(), `PUT primary metadata: ${putRes.status()} ${await putRes.text()}`).toBe(true);

		// Batch Link Media: only WEB files list on the left…
		const modal = await media.openBatchLinkModal();
		await expect(modal.getByRole('rowheader')).toHaveText([
			'web-alpha.png',
			'web-beta.png',
		]);

		// …and each row offers the genre-matched high-res files plus the
		// explicit no-link option (the ARTICLE decoy is filtered out).
		const selectAlpha = media.batchLinkSelectFor(modal, 'web-alpha.png');
		await expect(selectAlpha.locator('option')).toHaveText([
			'hires-alpha.png',
			'hires-beta.png',
			'No high-resolution file',
		]);

		// Picking hires-alpha for web-alpha removes it from web-beta's
		// options (a high-res can only serve one web file).
		await selectAlpha.selectOption({label: 'hires-alpha.png'});
		const selectBeta = media.batchLinkSelectFor(modal, 'web-beta.png');
		await expect(selectBeta.locator('option')).toHaveText([
			'hires-beta.png',
			'No high-resolution file',
		]);
		await selectBeta.selectOption({label: 'hires-beta.png'});

		const linkResponse = page.waitForResponse(
			(r) =>
				r.request().method() === 'POST' &&
				r.url().includes('/mediaFiles/link') &&
				r.ok(),
			{timeout: 30_000},
		);
		await modal.getByRole('button', {name: 'Link Media', exact: true}).click();
		await linkResponse;
		await expect(modal).toBeHidden({timeout: 15_000});

		// The pairs render grouped — one <tbody> holds both files.
		await expect(media.groupBody('web-alpha.png', 'hires-alpha.png')).toHaveCount(1, {timeout: 20_000});
		await expect(media.groupBody('web-beta.png', 'hires-beta.png')).toHaveCount(1);

		// REST: pairwise variant groups; the primary's COMMON fields were
		// applied to its sibling (caption + description), while `name`
		// stayed the sibling's own (NOT a common field).
		const files = byName(await media.fetchMediaFiles(submission.id, publicationId));
		expect(files['web-alpha.png'].variantGroupId).not.toBeNull();
		expect(files['hires-alpha.png'].variantGroupId).toBe(files['web-alpha.png'].variantGroupId);
		expect(files['web-beta.png'].variantGroupId).not.toBeNull();
		expect(files['hires-beta.png'].variantGroupId).toBe(files['web-beta.png'].variantGroupId);
		expect(files['web-beta.png'].variantGroupId).not.toBe(files['web-alpha.png'].variantGroupId);
		expect(files['decoy-article.png'].variantGroupId).toBeNull();

		expect(files['hires-alpha.png'].caption).toBe(caption);
		expect(files['hires-alpha.png'].description.en).toBe(description);
		expect(files['hires-alpha.png'].name.en).toBe('hires-alpha.png');
		expect(files['hires-beta.png'].caption ?? '').toBe(''); // its primary had none
	});

	// Row 3
	test('manual link offers only free counterparts; the API enforces group capacity', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('manlink');
		const {submission, publications} = await pkpApi.createSubmission(
			mediaStageSpec({
				tag,
				title: `Vmf3-${tag}`,
				mediaFiles: [
					{variantType: 'web', name: 'pair-web.png', group: 'pair'},
					{variantType: 'high_resolution', name: 'pair-hires.png', group: 'pair'},
					{variantType: 'web', name: 'spare-web.png'},
					{variantType: 'high_resolution', name: 'spare-hires.png'},
					{variantType: 'high_resolution', name: 'third-hires.png'},
				],
			}),
		);
		const publicationId = publications[0].id;
		const seededByName = byName(
			publications[0].mediaFiles.map((f) => ({...f, name: {en: f.name}})),
		);

		await new EditorialWorkflowPage(page).goto(submission.id);
		const media = new MediaFileManagerPage(page);
		await media.open();

		// Manually Link Media on the spare high-res: the select offers the
		// free web file but NOT the one already consumed by the seeded
		// pair (getSelectedWebFileIds exclusion).
		await media.clickRowAction('spare-hires.png', 'Manually Link Media');
		const modal = page
			.locator('[data-cy="active-modal"]')
			.filter({hasText: 'Select the media file to link as its counterpart'})
			.first();
		await expect(modal.getByText('Manually Link Media').first()).toBeVisible({timeout: 15_000});
		await expect(modal.locator('input[name="currentFile"]')).toHaveValue('spare-hires.png');
		const targetSelect = modal.locator('select[name="targetSubmissionFileId"]');
		await expect(targetSelect.locator('option')).toHaveText([
			'spare-web.png',
			'No web version file',
		]);

		// Linking the spare pair succeeds (PUT …/mediaFiles/{id}/link).
		const linkResponse = page.waitForResponse(
			(r) => r.url().includes('/link') && r.request().method() !== 'GET' && r.ok(),
			{timeout: 30_000},
		);
		await targetSelect.selectOption({label: 'spare-web.png'});
		await modal.getByRole('button', {name: 'Link Media', exact: true}).click();
		await linkResponse;
		await expect(modal).toBeHidden({timeout: 15_000});

		await expect(media.groupBody('spare-web.png', 'spare-hires.png')).toHaveCount(1, {timeout: 20_000});
		let files = byName(await media.fetchMediaFiles(submission.id, publicationId));
		expect(files['spare-hires.png'].variantGroupId).toBe(files['spare-web.png'].variantGroupId);
		expect(files['spare-hires.png'].variantGroupId).not.toBeNull();

		// Capacity guard: the UI filter makes a full pair unreachable
		// through the modal, so the MAX_GROUP_SIZE=2 backend defense is
		// exercised at the API seam — linking a third file into the full
		// pair is rejected with variantGroupAtCapacity.
		const token = await csrfToken(page);
		const capacityRes = await page.request.put(
			mediaApiPath(submission.id, publicationId, `/${seededByName['third-hires.png'].id}/link`),
			{
				headers: {'X-Csrf-Token': token},
				data: {targetSubmissionFileId: seededByName['pair-web.png'].id},
			},
		);
		expect(capacityRes.status()).toBe(400);
		const capacityBody = await capacityRes.json();
		expect(capacityBody.error).toContain(
			'The variant group already has the maximum number of files.',
		);

		// Nothing changed for the full pair or the third file.
		files = byName(await media.fetchMediaFiles(submission.id, publicationId));
		expect(files['third-hires.png'].variantGroupId).toBeNull();
		expect(files['pair-hires.png'].variantGroupId).toBe(files['pair-web.png'].variantGroupId);
	});

	// Row 4
	test('editing metadata propagates common fields to the linked sibling, never the name', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('metasync');
		const renamed = `renamed-web-${tag}.png`;
		const syncedCaption = `Synced caption ${tag}`;
		const {submission, publications} = await pkpApi.createSubmission(
			mediaStageSpec({
				tag,
				title: `Vmf4-${tag}`,
				mediaFiles: [
					{variantType: 'web', name: 'pair-web.png', group: 'pair'},
					{variantType: 'high_resolution', name: 'pair-hires.png', group: 'pair'},
				],
			}),
		);
		const publicationId = publications[0].id;

		await new EditorialWorkflowPage(page).goto(submission.id);
		const media = new MediaFileManagerPage(page);
		await media.open();

		// Edit Metadata on the web file. IMAGE is an ARTWORK-category
		// genre, so the form is name + caption/credit/copyrightOwner/terms
		// (no description field — that's the SUPPLEMENTARY form).
		await media.clickRowAction('pair-web.png', 'Edit Metadata');
		const modal = page
			.locator('[data-cy="active-modal"]')
			.filter({hasText: 'Name of the file'})
			.first();
		const nameInput = modal.locator('input[id$="-name-control-en"]');
		await expect(nameInput).toHaveValue('pair-web.png', {timeout: 15_000});
		await nameInput.fill(renamed);
		await modal.locator('textarea[name="caption"]').fill(syncedCaption);

		const saveResponse = page.waitForResponse(
			(r) => r.url().includes('/mediaFiles/') && r.request().method() !== 'GET' && r.ok(),
			{timeout: 30_000},
		);
		await modal.getByRole('button', {name: 'Save', exact: true}).click();
		await saveResponse;
		await expect(modal).toBeHidden({timeout: 15_000});

		// The list shows the new name; the sibling keeps its own.
		await expect(media.row(renamed)).toBeVisible({timeout: 20_000});
		await expect(media.row('pair-hires.png')).toBeVisible();

		// REST: caption synced onto the sibling
		// (VariantGroup::applyMetadataToSiblings); name did NOT sync
		// (excluded from getCommonMediaFileFields).
		const files = byName(await media.fetchMediaFiles(submission.id, publicationId));
		expect(files[renamed].caption).toBe(syncedCaption);
		expect(files['pair-hires.png'].caption).toBe(syncedCaption);
		expect(files['pair-hires.png'].name.en).toBe('pair-hires.png');
	});

	// Row 5
	test('deleting one file of a pair ungroups the survivor; deleting a solo file removes its row', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('delete');
		const {submission, publications} = await pkpApi.createSubmission(
			mediaStageSpec({
				tag,
				title: `Vmf5-${tag}`,
				mediaFiles: [
					{variantType: 'web', name: 'pair-web.png', group: 'pair'},
					{variantType: 'high_resolution', name: 'pair-hires.png', group: 'pair'},
					{variantType: 'web', name: 'solo.png'},
				],
			}),
		);
		const publicationId = publications[0].id;

		await new EditorialWorkflowPage(page).goto(submission.id);
		const media = new MediaFileManagerPage(page);
		await media.open();
		await expect(media.groupBody('pair-web.png', 'pair-hires.png')).toHaveCount(1, {timeout: 20_000});

		// Delete one half of the pair (the confirm dialog names the file —
		// asserted inside the POM helper).
		await media.deleteFile('pair-web.png');

		// The survivor remains, ungrouped (variant_groups row cleaned up →
		// variantGroupId null); the solo file is untouched.
		await expect(media.row('pair-hires.png')).toBeVisible();
		await expect(media.row('solo.png')).toBeVisible();
		let files = byName(await media.fetchMediaFiles(submission.id, publicationId));
		expect(Object.keys(files)).toHaveLength(2);
		expect(files['pair-hires.png'].variantGroupId).toBeNull();
		expect(files['solo.png'].variantGroupId).toBeNull();

		// Deleting a solo (ungrouped) file just removes its row.
		await media.deleteFile('solo.png');
		await expect(media.row('pair-hires.png')).toBeVisible();
		files = byName(await media.fetchMediaFiles(submission.id, publicationId));
		expect(Object.keys(files)).toHaveLength(1);
		expect(files['pair-hires.png']).toBeTruthy();
	});

	// Row 6 — media files attach to the PUBLICATION, not to a galley:
	// ArticleHandler::download serves any publication media file under
	// any of its galleys' URLs, and the HTML-galley rewrite
	// (HtmlGalleyHelper) embeds the same file from every HTML galley.
	// Deleting one galley therefore leaves the other galley's reference
	// fully intact. (No per-galley link/unlink surface exists — verified
	// in code; see the plan row note.)
	test('one media file serves two galleys; deleting a galley leaves the other intact', {tag: '@regression'}, async ({page, pkpApi, browser, baseURL}) => {
		const tag = uniqueTag('twogalleys');
		const {submission, publications} = await pkpApi.createSubmission(
			mediaStageSpec({
				tag,
				title: `Vmf6-${tag}`,
				published: true,
				galleys: [
					{label: 'HTML A', file: 'sample-article.html'},
					{label: 'HTML B', file: 'sample-article.html'},
				],
				// Default fixture/name: dependent-image.png — the file the
				// sample-article.html fixture references by name.
				mediaFiles: [{variantType: 'web'}],
			}),
		);
		const publication = publications[0];
		const [galleyA, galleyB] = publication.galleys;
		const mediaFileId = publication.mediaFiles[0].id;

		// Reader side — explicit empty storageState (rule 8).
		const anonCtx = await anonContext(browser, baseURL);
		const galleyContentUrl = (galley) =>
			`/index.php/publicknowledge/en/article/download/${submission.id}/${galley.id}/${galley.submissionFileId}`;

		// The galley page itself renders (htmlArticleGalley display).
		const viewRes = await anonCtx.request.get(
			`/index.php/publicknowledge/en/article/view/${submission.id}/${galleyA.id}`,
		);
		expect(viewRes.status(), 'galley A view page').toBe(200);

		// Both galleys' rewritten HTML reference the SAME media file id,
		// each through its own galley download URL, and both URLs serve
		// the PNG bytes anonymously.
		const mediaUrls = {};
		for (const galley of [galleyA, galleyB]) {
			const contentRes = await anonCtx.request.get(galleyContentUrl(galley));
			expect(contentRes.status(), `galley ${galley.label} content`).toBe(200);
			const html = await contentRes.text();
			const {url, fileId} = extractMediaDownloadUrl(html, 'dependent-image.png');
			expect(fileId).toBe(mediaFileId);
			expect(url).toContain(`/${galley.id}/`);
			const imgRes = await anonCtx.request.get(url);
			expect(imgRes.status(), `media download via galley ${galley.label}`).toBe(200);
			expect(imgRes.headers()['content-type']).toContain('image/png');
			mediaUrls[galley.label] = url;
		}

		// Editor deletes galley A (galley CRUD stays available on a
		// published publication — same surface galleys.spec.js covers).
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);
		await workflow.openPublicationPanel('Galleys');
		await workflow.deleteGalley('HTML A');

		// Galley A's media URL is gone with its galley… (the galley row is
		// what 404s — the media file itself is publication-level)
		const goneRes = await anonCtx.request.get(mediaUrls['HTML A']);
		expect(goneRes.status()).toBe(404);

		// …while galley B's reference still serves, and the publication
		// still owns the media file.
		const survivorRes = await anonCtx.request.get(mediaUrls['HTML B']);
		expect(survivorRes.status()).toBe(200);
		expect(survivorRes.headers()['content-type']).toContain('image/png');
		const media = new MediaFileManagerPage(page);
		const files = await media.fetchMediaFiles(submission.id, publication.id);
		expect(files).toHaveLength(1);
		expect(files[0].id).toBe(mediaFileId);

		await anonCtx.close();
	});

	// Row 7
	test('author sees the Media tab read-only', {tag: '@regression'}, async ({pkpApi, asUser}) => {
		const tag = uniqueTag('author');
		const {submission, publications} = await pkpApi.createSubmission(
			mediaStageSpec({
				tag,
				title: `Vmf7-${tag}`,
				submitter: 'atester',
				mediaFiles: [{variantType: 'web', name: 'author-view.png'}],
			}),
		);
		const publicationId = publications[0].id;

		const authorCtx = await asUser('atester');
		const authorPage = await authorCtx.newPage();
		await authorPage.goto(
			`/index.php/publicknowledge/en/dashboard/mySubmissions?workflowSubmissionId=${submission.id}`,
		);

		// MEDIA_FILE_LIST: the Media panel renders with the seeded file…
		const media = new MediaFileManagerPage(authorPage);
		await media.open();
		const row = media.row('author-view.png');
		await expect(row).toBeVisible({timeout: 20_000});
		await expect(row).toContainText('Image');

		// …but authors get no write affordances (author role maps to
		// MEDIA_FILE_LIST only in MediaFileManagerConfigurations): no top
		// actions, no per-row More Actions menu at all.
		await expect(media.addButton()).toHaveCount(0);
		await expect(media.batchLinkButton()).toHaveCount(0);
		await expect(
			media.table.getByRole('button', {name: /More Actions/i}),
		).toHaveCount(0);

		// Server side agrees: a write attempt is rejected by
		// PublicationWritePolicy (PublicationCanBeEditedPolicy — atester
		// can't edit the publication). PKP's API maps authorization
		// failures to HTTP 401 (not 403) — see patterns.md wave-2 notes.
		const token = await csrfToken(authorPage);
		const files = await media.fetchMediaFiles(submission.id, publicationId);
		const deleteRes = await authorPage.request.delete(
			mediaApiPath(submission.id, publicationId, `/${files[0].id}`),
			{headers: {'X-Csrf-Token': token}},
		);
		expect(deleteRes.status()).toBe(401);
		// The file survived the rejected delete.
		expect(await media.fetchMediaFiles(submission.id, publicationId)).toHaveLength(1);
	});

	// Row 8 — reader-side variant serving as it exists today: HTML
	// galleys embed ONLY the web variant (HtmlGalleyHelper filters out
	// HIGH_RESOLUTION — "reserved for download/export use cases"); no
	// theme exposes a high-res link, but the download endpoint serves
	// the high-res file for the published article (ArticleHandler's
	// publication-media gate). Theme/srcset exposure: round 2.
	test('reader gets the web variant in the galley; the high-res variant serves on direct download', {tag: '@regression'}, async ({pkpApi, browser, baseURL}) => {
		const tag = uniqueTag('hires');
		const {submission, publications} = await pkpApi.createSubmission(
			mediaStageSpec({
				tag,
				title: `Vmf8-${tag}`,
				published: true,
				galleys: [{label: 'HTML', file: 'sample-article.html'}],
				// BOTH variants carry the name the HTML references — the
				// embed rewrite must pick the WEB one (the high-res file is
				// excluded from the embeddable set, so it can never win the
				// by-name dedupe).
				mediaFiles: [
					{variantType: 'web', group: 'pair'}, // name defaults to dependent-image.png
					{variantType: 'high_resolution', name: 'dependent-image.png', group: 'pair'},
				],
			}),
		);
		const publication = publications[0];
		const galley = publication.galleys[0];
		const seededMedia = publication.mediaFiles;
		const webFile = seededMedia.find((f) => f.variantType === 'web');
		const hiresFile = seededMedia.find((f) => f.variantType === 'high_resolution');

		// Seed sanity: the pair is one variant group.
		expect(webFile.variantGroupId).not.toBeNull();
		expect(hiresFile.variantGroupId).toBe(webFile.variantGroupId);

		const anonCtx = await anonContext(browser, baseURL);

		// The served galley HTML rewrites the image reference to the WEB
		// variant's download URL — not the high-res sibling's.
		const contentRes = await anonCtx.request.get(
			`/index.php/publicknowledge/en/article/download/${submission.id}/${galley.id}/${galley.submissionFileId}`,
		);
		expect(contentRes.status(), 'galley content').toBe(200);
		const html = await contentRes.text();
		const {url: webUrl, fileId: embeddedId} = extractMediaDownloadUrl(
			html,
			'dependent-image.png',
		);
		expect(embeddedId).toBe(webFile.id);
		expect(html).not.toContain(`/${hiresFile.id}/dependent-image.png`);

		// The web variant serves anonymously through the rewritten URL…
		const webRes = await anonCtx.request.get(webUrl);
		expect(webRes.status()).toBe(200);
		expect(webRes.headers()['content-type']).toContain('image/png');

		// …and the high-res variant is reachable on direct download under
		// the same galley (the download/export use case the embed filter
		// reserves it for).
		const hiresRes = await anonCtx.request.get(
			`/index.php/publicknowledge/en/article/download/${submission.id}/version/${publication.id}/${galley.id}/${hiresFile.id}`,
		);
		expect(hiresRes.status()).toBe(200);
		expect(hiresRes.headers()['content-type']).toContain('image/png');

		await anonCtx.close();
	});
});
