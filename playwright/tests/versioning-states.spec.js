// @ts-check
const {test, expect} = require('../support/base-test.js');
const {EditorialWorkflowPage} = require('../../../../playwright/pages/EditorialWorkflowPage.js');
const {setTinyMceContent} = require('../support/tinymce.js');
const submissionPublished = require('../../../../playwright/fixtures/scenarios/submission-published.js');

/**
 * Publication versioning — per-version states & gating.
 * docs/e2e/plans/publication-versioning.md rows 4–8 (rows 1–2 live in
 * the sibling versioning.spec.js; row 3 in
 * publication-language-change.spec.js).
 *
 * Seeding: the submission scenario's `publications[]` supports
 * multi-entry version seeding — entry i>0 goes through
 * Repo::publication()->version() (clones metadata/authors, derives
 * versionMajor/Minor from `versionIsMinor`), and per-entry
 * `published: true` publishes that entry. `twoVersionSpec()` below
 * seeds the canonical [v1 VoR 1.0 published, v2 VoR 1.1 draft] pair.
 *
 * Navigation: each version's Publication panels are addressed
 * deterministically via the `workflowMenuKey` query param
 * (`publication_{publicationId}_titleAbstract`) — the workflow store
 * reads it on load and navigateToMenu auto-expands the version's
 * side-nav group (useWorkflowMenu.js watch + useSideMenu
 * setActiveItemKey). That avoids nav-click gymnastics on collapsed
 * version groups (only the LATEST version's group is expanded by
 * default).
 *
 * Status-indicator semantics (WorkflowPublicationVersionControl.vue):
 *   - STATUS_PUBLISHED                        → "Published"
 *   - STATUS_QUEUED + is currentPublicationId → "Unscheduled"
 *   - STATUS_QUEUED + NOT current             → "Unpublished"
 * With [v1 published, v2 draft] the current publication is v1 (last
 * PUBLISHED one — Repository::getCurrentPublicationIdByPublications),
 * so the draft v2 reads "Unpublished"; once nothing is published the
 * current pointer moves to the latest (v2) which then reads
 * "Unscheduled".
 *
 * Row 5 scope note: the editorial UI does NOT disable fields on a
 * published version — workflowConfigEditorialOJS.js shows the
 * WorkflowPublicationEditWarning banner and leaves the form editable
 * for editors (canEditPublication = canCurrentUserChangeMetadata).
 * The hard lock ("…can not be edited", WorkflowPublicationEditDisabled)
 * is author-dashboard config only (workflowConfigAuthorOJS.js). The
 * test asserts the live editorial behavior: warning banner on the
 * published version, no banner + working edits on the draft.
 */

// Publication status ints — see lib/pkp/classes/submission/PKPSubmission.php.
const STATUS_QUEUED = 1;
const STATUS_PUBLISHED = 3;

/** UI strings (grep-verified against the en locale .po files). */
const STR = {
	// publication.editorEditWarning (lib/pkp/locale/en/submission.po)
	editWarning:
		'Warning: This version has been published. Editing it may impact the published content.',
	// submission.list.changeSubmissionLanguage.currentLanguage — the
	// change-language widget's leading text; its absence proves the
	// whole widget (not just the Change button) is gone.
	currentLanguage: 'Current Submission Language:',
	statusPublished: 'Published',
	statusUnpublished: 'Unpublished',
	statusUnscheduled: 'Unscheduled',
};

test.use({user: 'dbarnes'});

/**
 * Tag scoped to worker + random suffix so parallel workers don't
 * collide on the shared submissions list (whitespace-free; see
 * patterns.md tag conventions).
 */
function uniqueTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

/**
 * Workflow-page URL, optionally deep-linking a side-nav entry via
 * workflowMenuKey (e.g. `publication_{pubId}_titleAbstract`).
 *
 * @param {number} submissionId
 * @param {string} [menuKey]
 */
function workflowUrl(submissionId, menuKey) {
	const base = `/index.php/publicknowledge/en/dashboard/editorial?workflowSubmissionId=${submissionId}`;
	return menuKey ? `${base}&workflowMenuKey=${menuKey}` : base;
}

/**
 * Scenario spec: published VoR 1.0 + draft VoR 1.1 on one submission.
 * The scenario response's `publications` array echoes both entries in
 * seed order: [0] = v1 (status 3), [1] = v2 (status 1).
 *
 * @param {{tag: string, v2?: object}} opts  `v2` merges into the draft entry
 */
function twoVersionSpec({tag, v2 = {}}) {
	const spec = submissionPublished({tag});
	spec.publications = [
		spec.publications[0],
		{versionStage: 'VoR', versionIsMinor: true, ...v2},
	];
	return spec;
}

/** The workflow page's hosting side-modal. */
function workflowModal(page) {
	return page.locator('[data-cy="active-modal"]').first();
}

/** The Publication panel's left control strip (language + status widgets). */
function controlsLeft(page) {
	return workflowModal(page).locator('[data-cy="workflow-controls-left"]');
}

/**
 * Assert the change-language widget is absent from the current
 * Publication panel. The version-control Status widget renders AFTER
 * the change-language widget in the same controls-left items list
 * (workflowConfigEditorialOJS.js getPrimaryControlsLeft), so its text
 * bounds the negative: once the expected status label is visible, the
 * widget would have been there if it were eligible.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} statusText  expected status label for this version
 */
async function expectNoChangeLanguageWidget(page, statusText) {
	const controls = controlsLeft(page);
	await expect(controls.getByText(statusText, {exact: true})).toBeVisible({
		timeout: 15_000,
	});
	await expect(controls.getByText(STR.currentLanguage)).toHaveCount(0);
	await expect(
		controls.getByRole('button', {name: 'Change', exact: true}),
	).toHaveCount(0);
}

/**
 * Fetch one publication's FULL representation (the publications list
 * endpoint returns thin summaries without full multilingual fields).
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

test.describe('Versioning states', () => {
	// Row 4 — the change-language affordance is gated on
	// publications.length < 2 (workflowConfigEditorialOJS.js
	// getPrimaryControlsLeft), independent of published status. The
	// positive control (widget DOES appear on a 1-publication
	// submission after unpublish) is publication-language-change.spec.js.
	test('change-language is unavailable once multiple versions exist, even with nothing published', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('vst4');
		const {submission, publications} = await pkpApi.createSubmission(
			twoVersionSpec({tag}),
		);
		expect(publications).toHaveLength(2);
		const [v1, v2] = publications;
		expect(v1.status).toBe(STATUS_PUBLISHED);
		expect(v2.status).toBe(STATUS_QUEUED);

		// While v1 is published: widget absent on BOTH versions' panels
		// (here both clauses of the gate are false — this is the
		// plan-row seed state).
		await page.goto(workflowUrl(submission.id, `publication_${v1.id}_titleAbstract`));
		await expectNoChangeLanguageWidget(page, STR.statusPublished);
		await page.goto(workflowUrl(submission.id, `publication_${v2.id}_titleAbstract`));
		await expectNoChangeLanguageWidget(page, STR.statusUnpublished);

		// Unpublish v1 so NO version is published any more — the
		// submission leaves the published state and the only remaining
		// reason to hide the widget is publications.length >= 2.
		await page.goto(workflowUrl(submission.id, `publication_${v1.id}_titleAbstract`));
		await expect(
			controlsLeft(page).getByText(STR.statusPublished, {exact: true}),
		).toBeVisible({timeout: 15_000});
		const workflow = new EditorialWorkflowPage(page);
		await workflow.unpublishCurrentPanel();

		const after = await workflow.fetchPublications(submission.id);
		expect(after.every((p) => p.status === STATUS_QUEUED)).toBe(true);
		const sub = await workflow.fetchSubmission(submission.id);
		expect(sub.status).toBe(STATUS_QUEUED);

		// Fresh loads: still no Change affordance on either version.
		// (The current-publication pointer moved to the latest version,
		// so v2 now reads "Unscheduled" and v1 "Unpublished".)
		await page.goto(workflowUrl(submission.id, `publication_${v1.id}_titleAbstract`));
		await expectNoChangeLanguageWidget(page, STR.statusUnpublished);
		await page.goto(workflowUrl(submission.id, `publication_${v2.id}_titleAbstract`));
		await expectNoChangeLanguageWidget(page, STR.statusUnscheduled);
	});

	// Row 5 — published version carries the edit warning (fields stay
	// editable for editors — see header note); the draft version has no
	// warning and round-trips a Title & Abstract edit that lands on v2
	// only.
	test('published version shows the edit warning; draft version saves edits without affecting v1', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('vst5');
		const {submission, publications} = await pkpApi.createSubmission(
			twoVersionSpec({tag}),
		);
		const [v1, v2] = publications;
		const modal = workflowModal(page);

		// v1 (published): warning banner; Save remains ENABLED for
		// editors — the published state warns, it does not lock
		// (locking is author-side config; see header note).
		await page.goto(workflowUrl(submission.id, `publication_${v1.id}_titleAbstract`));
		await expect(modal.getByText(STR.editWarning)).toBeVisible({
			timeout: 15_000,
		});
		await expect(
			modal.getByRole('button', {name: 'Save', exact: true}),
		).toBeEnabled();

		// v2 (draft): no warning banner (status indicator bounds the
		// negative), and an edit round-trips.
		await page.goto(workflowUrl(submission.id, `publication_${v2.id}_titleAbstract`));
		await expect(
			controlsLeft(page).getByText(STR.statusUnpublished, {exact: true}),
		).toBeVisible({timeout: 15_000});
		await expect(modal.getByText(STR.editWarning)).toHaveCount(0);

		const v2Title = `V2 draft ${tag}`;
		await setTinyMceContent(page, 'titleAbstract-title-control-en', v2Title);
		await modal.getByRole('button', {name: 'Save', exact: true}).click();
		await expect(
			page.locator('[role="status"]').filter({hasText: 'Saved'}),
		).toBeVisible({timeout: 15_000});

		// The edit landed on v2 and ONLY v2.
		const v1Full = await fetchPublication(page, submission.id, v1.id);
		const v2Full = await fetchPublication(page, submission.id, v2.id);
		expect(v2Full.title.en).toContain(v2Title);
		expect(v1Full.title.en).toContain('Published article');
		expect(v1Full.title.en).not.toContain(v2Title);
	});

	// Row 6 — the Create New Version dialog's stage/significance fields
	// (both are selects — useWorkflowVersionForm.js addFieldSelect, not
	// radios) drive the resulting version string.
	test('create-version dialog: stage and significance selects drive the version string', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('vst6');
		const {submission, publications} = await pkpApi.createSubmission(
			submissionPublished({tag}),
		);
		const v1Id = publications[0].id;

		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);
		const modal = workflowModal(page);
		const nav = modal.locator('nav');
		await expect(
			nav.getByText('Version of Record 1.0', {exact: true}),
		).toBeVisible({timeout: 15_000});

		// Open the dialog from the Publication side-menu action entry.
		await nav.getByText('Create New Version', {exact: true}).first().click();
		const dialog = page.locator('[data-cy="dialog"]');
		await expect(dialog).toBeVisible({timeout: 10_000});
		await expect(dialog).toContainText('Create New Version');

		// Metadata source defaults to the latest version.
		await expect(dialog.locator('select[name="versionSource"]')).toHaveValue(
			String(v1Id),
		);

		// Stage select offers the three JAV stages (labels from
		// VersionStage::label() + the stage code suffix).
		const stageSelect = dialog.locator('select[name="versionStage"]');
		await expect(stageSelect.locator('option')).toHaveText([
			'Author Original (AO)',
			'Published Manuscript Under Review (PMUR)',
			'Version of Record (VoR)',
		]);

		// Significance select reflects the stage choice: Minor is only
		// allowed when a version already exists at the chosen stage
		// (useWorkflowVersionForm.js updateMinorOptionAvailability). No
		// AO version exists → Minor disabled, Major forced; VoR (v1
		// exists) → Minor enabled and preselected.
		const minorSelect = dialog.locator('select[name="versionIsMinor"]');
		await expect(minorSelect.locator('option')).toHaveText([
			'Major Revision',
			'Minor Revision',
		]);
		await stageSelect.selectOption('AO');
		await expect(minorSelect.locator('option[value="true"]')).toBeDisabled();
		await expect(minorSelect).toHaveValue('false');
		await stageSelect.selectOption('VoR');
		await expect(minorSelect.locator('option[value="true"]')).toBeEnabled();
		await expect(minorSelect).toHaveValue('true');

		// Confirm VoR + Minor → Version of Record 1.1.
		const versionUrl = new RegExp(
			`/submissions/${submission.id}/publications/\\d+/version(?:\\?|$)`,
		);
		await Promise.all([
			page.waitForResponse((r) => versionUrl.test(r.url()) && r.ok(), {
				timeout: 20_000,
			}),
			dialog.getByRole('button', {name: 'Confirm', exact: true}).click(),
		]);

		// The side-nav only lists the new entry after a reload (Vue
		// store caches the publications list — see POM createNewVersion
		// caveat).
		await workflow.goto(submission.id);
		await expect(
			nav.getByText('Version of Record 1.1', {exact: true}),
		).toBeVisible({timeout: 15_000});

		// Second bump: VoR + Major → 2.0 (major increments, minor resets).
		await workflow.createNewVersion({
			versionStage: 'VoR',
			versionIsMinor: 'false',
		});
		await workflow.goto(submission.id);
		await expect(
			nav.getByText('Version of Record 2.0', {exact: true}),
		).toBeVisible({timeout: 15_000});
		await expect(
			nav.getByText('Version of Record 1.0', {exact: true}),
		).toBeVisible();
		await expect(
			nav.getByText('Version of Record 1.1', {exact: true}),
		).toBeVisible();

		const all = await workflow.fetchPublications(submission.id);
		expect(
			all.map((p) => `${p.versionMajor}.${p.versionMinor}`).sort(),
		).toEqual(['1.0', '1.1', '2.0']);
	});

	// Row 7 — the Publication side menu lists every version with its
	// own sub-item set; the per-version status indicator distinguishes
	// the published v1 from the draft v2; v1's panel carries the
	// published-content warning.
	test('publication menu lists all versions with per-version status', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('vst7');
		const {submission, publications} = await pkpApi.createSubmission(
			twoVersionSpec({tag}),
		);
		const [v1, v2] = publications;

		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);
		const modal = workflowModal(page);
		const nav = modal.locator('nav');

		// Both version entries + the create action under the
		// Publication menu group.
		await expect(
			nav.getByText('Version of Record 1.0', {exact: true}),
		).toBeVisible({timeout: 15_000});
		await expect(
			nav.getByText('Version of Record 1.1', {exact: true}),
		).toBeVisible();
		await expect(
			nav.getByText('Create New Version', {exact: true}),
		).toBeVisible();

		// v1 — status indicator "Published"; selecting it shows the
		// published-content warning. Deep-linking v1 expands its group
		// while the latest version's group stays expanded, so each
		// version exposes its own sub-item set in the nav (2x "Title &
		// Abstract").
		await page.goto(workflowUrl(submission.id, `publication_${v1.id}_titleAbstract`));
		await expect(
			controlsLeft(page).getByText(STR.statusPublished, {exact: true}),
		).toBeVisible({timeout: 15_000});
		await expect(modal.getByText(STR.editWarning)).toBeVisible();
		await expect(
			nav.getByText('Title & Abstract', {exact: true}),
		).toHaveCount(2);

		// v2 — draft, not the current publication while v1 is published
		// → status indicator "Unpublished"; no warning banner.
		await page.goto(workflowUrl(submission.id, `publication_${v2.id}_titleAbstract`));
		await expect(
			controlsLeft(page).getByText(STR.statusUnpublished, {exact: true}),
		).toBeVisible({timeout: 15_000});
		await expect(modal.getByText(STR.editWarning)).toHaveCount(0);
	});

	// Row 8 — reader-side resolution of a custom urlPath, including the
	// canonical redirect from the numeric URL and per-version URLs.
	// Everything is scenario-seeded (v1 + v2 both published); the
	// behavior under test is purely the anonymous reader's routing.
	test('custom urlPath resolves on the reader side alongside version URLs', {tag: '@regression'}, async ({pkpApi, browser, baseURL}) => {
		const tag = uniqueTag('vst8');
		const urlPath = `vp-${tag}`;
		const spec = twoVersionSpec({
			tag,
			v2: {
				metadata: {title: {en: `V2 ${tag}`}},
				issue: {volume: 1, number: 2, year: 2014},
				published: true,
			},
		});
		spec.publications[0].metadata.urlPath = urlPath;
		const {submission, publications} = await pkpApi.createSubmission(spec);
		const [v1, v2] = publications;
		expect(v1.status).toBe(STATUS_PUBLISHED);
		expect(v2.status).toBe(STATUS_PUBLISHED);

		const ctx = await browser.newContext({baseURL});
		const reader = await ctx.newPage();
		try {
			// 1. The urlPath URL renders the article's current version
			//    (v2 — Repo::publication()->version() clones urlPath onto
			//    new versions, so the current publication's best id IS the
			//    urlPath and no redirect happens).
			const respPath = await reader.goto(
				`/index.php/publicknowledge/article/view/${urlPath}`,
			);
			expect(respPath?.status()).toBe(200);
			await expect(reader.locator('h1').first()).toContainText(`V2 ${tag}`);
			// The version picker links v1 — version URLs work alongside
			// the urlPath (notice wording is owned by versioning.spec.js
			// row 1).
			await expect(
				reader.locator('.versions').locator(`a[href*="/version/${v1.id}"]`),
			).toHaveCount(1);

			// 2. The numeric URL still resolves — via the canonical
			//    redirect to the urlPath form (ArticleHandler::initialize
			//    redirects when the requested id differs from getBestId).
			const respNumeric = await reader.goto(
				`/index.php/publicknowledge/article/view/${submission.id}`,
			);
			expect(respNumeric?.status()).toBe(200);
			await expect(reader).toHaveURL(
				new RegExp(`/article/view/${urlPath}(?:$|[/?])`),
			);
			await expect(reader.locator('h1').first()).toContainText(`V2 ${tag}`);

			// 3. The versioned URL on top of the urlPath reaches v1 after
			//    the v2 publish.
			const respV1 = await reader.goto(
				`/index.php/publicknowledge/article/view/${urlPath}/version/${v1.id}`,
			);
			expect(respV1?.status()).toBe(200);
			await expect(reader.locator('h1').first()).toContainText(
				'Published article',
			);

			// 4. …and v2's own version URL renders v2.
			const respV2 = await reader.goto(
				`/index.php/publicknowledge/article/view/${urlPath}/version/${v2.id}`,
			);
			expect(respV2?.status()).toBe(200);
			await expect(reader.locator('h1').first()).toContainText(`V2 ${tag}`);
		} finally {
			await ctx.close();
		}
	});
});
