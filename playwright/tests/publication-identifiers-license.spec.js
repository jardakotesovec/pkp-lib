// @ts-check
const {test, expect} = require('../../../../playwright/support/fixtures.js');
const {EditorialWorkflowPage} = require('../../../../playwright/pages/EditorialWorkflowPage.js');
const {setTinyMceContent, getTinyMceContent} = require('../support/tinymce.js');

/**
 * Publication identifiers & license —
 * docs/e2e/plans/publication-identifiers-license.md (8 rows).
 *
 * The feature under test is the cluster of per-publication panels that
 * carry identification + licensing metadata: Permissions & Disclosure
 * (copyrightHolder / copyrightYear / licenseUrl with the
 * Override-then-edit `optIntoEdit` gate), References (the CitationManager
 * raw-references pipeline, owned end-to-end by this plan), per-locale
 * Title & Abstract persistence, the Metadata panel's publisher-id field
 * (gated by Workflow > Metadata settings), and the Identifiers panel
 * (gated by any enabled pub-id plugin — URN here).
 *
 * Seeding notes:
 *   - "Draft VoR with issue" rows use a skipExternalReview →
 *     sendToProduction decision chain + a publications[0] entry with
 *     `published: false`. The seeded `issue` ref is only applied by the
 *     processor at publish time, so the actual issue assignment happens
 *     through the publish UI (Review Publishing Details modal) — same
 *     shape publish-unpublish.spec.js proved.
 *   - publicknowledge has NO journal-level default licenseUrl /
 *     copyrightHolderType, so the journal-default rows (4, 7) run on a
 *     scratch journal whose license defaults are set via a REST
 *     `PUT /contexts/{id}` (API-first setup; the Distribution settings
 *     *form* is owned by the distribution-settings plan).
 *   - Citations cannot be seeded by the scenario processor
 *     (publications[].metadata has no citations field); row 8 seeds them
 *     through the same REST endpoint the Add form posts to
 *     (importAdditionalCitations) — the UI add path itself is row 2's
 *     subject.
 *   - Plugin gating (row 6) uses the context scenario's `plugins`
 *     passthrough; the key is LazyLoadPlugin::getName() = lowercased
 *     class name (`urnpubidplugin`). `enablePublicationURN` is the
 *     setting URNPubIdPlugin::isObjectTypeEnabled('Publication') reads —
 *     it gates BOTH the Identifiers nav item (PKPDashboardHandler) and
 *     the `_components/identifier` form endpoint.
 *
 * Reader-side assertions (rows 1/2/4/7/8) use a fresh anonymous browser
 * context against the article landing page (article_details.tpl):
 *   - license block: `div.item.copyright` — non-CC licenseUrl renders
 *     `<a class="copyright" href="{licenseUrl}">Copyright (c) {year}
 *     {holder}</a>`; a CC licenseUrl renders the copyright statement
 *     <p> + the CC badge (`a[rel="license"]` pointing at the canonical
 *     CC URL from the locale string).
 *   - references block: `section.item.references` listing each
 *     citation row's rawCitation (with URLs auto-linked).
 *
 * Out of scope here (per plan): reader-side fr_CA rendering
 * (article-landing's multilingual row), DOI rows (doi-management),
 * URN depth (check digit / patterns — round 2), structured citation
 * editing / metadata lookup, copyrightYearBasis form variants
 * (distribution-settings).
 */

/** Publication status ints — lib/pkp/classes/submission/PKPSubmission.php. */
const STATUS_PUBLISHED = 3;

/** Bootstrap's published back issue (publicknowledge). */
const PK_ISSUE = {volume: 1, number: 2, year: 2014};
const PK_ISSUE_LABEL = 'Vol. 1 No. 2 (2014)';

/** Scratch-journal issue seeded `published: true` (today's datePublished). */
const SCRATCH_ISSUE = {volume: 1, number: '1', year: 2026};
const SCRATCH_ISSUE_LABEL = 'Vol. 1 No. 1 (2026)';

const CC_BY_4 = 'https://creativecommons.org/licenses/by/4.0/';
const CC_BY_NC_4 = 'https://creativecommons.org/licenses/by-nc/4.0/';

test.use({user: 'dbarnes'});

function uniqueTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

/**
 * Submission spec for an unpublished ("draft") VoR at the production
 * stage. skipExternalReview lands the submission in copyediting without
 * carrying a review round; sendToProduction then moves it to production —
 * the stage a real editor publishes from. The publication carries
 * title/abstract (abstract is publish-required by the default section
 * config) plus any per-row metadata overrides.
 *
 * @param {object} opts
 * @param {string} opts.tag
 * @param {string} [opts.journal='publicknowledge']
 * @param {object} [opts.metadata]  extra publications[0].metadata entries
 * @param {object} [opts.issue]     issue ref (applied by the publish UI)
 */
function draftVorSpec({tag, journal = 'publicknowledge', metadata = {}, issue}) {
	return {
		tag,
		journal,
		submitter: 'rvaca',
		section: 'ART',
		locale: 'en',
		participants: [{user: 'dbarnes', role: 'editor'}],
		decisions: [
			{type: 'skipExternalReview', by: 'dbarnes'},
			{type: 'sendToProduction', by: 'dbarnes'},
		],
		publications: [
			{
				versionStage: 'VoR',
				metadata: {
					title: {en: 'Identifiers-license article'},
					abstract: {
						en: `<p>Publication identifiers &amp; license coverage for ${tag}.</p>`,
					},
					...metadata,
				},
				...(issue ? {issue} : {}),
				published: false,
			},
		],
	};
}

/**
 * Submission spec for a plain submitted stage-1 submission. The
 * publications block is REQUIRED even though these rows never publish:
 * publication titles are only seeded through publications[].metadata,
 * and the publication PUT every panel save issues validates the full
 * entity — a title-less publication 400s with "title required" on the
 * first save (run-1 finding).
 *
 * @param {object} opts
 * @param {string} opts.tag
 * @param {string} [opts.journal='publicknowledge']
 */
function stage1Spec({tag, journal = 'publicknowledge'}) {
	return {
		tag,
		journal,
		submitter: 'rvaca',
		section: 'ART',
		locale: 'en',
		submitted: true,
		participants: [{user: 'dbarnes', role: 'editor'}],
		publications: [
			{
				versionStage: 'AO',
				metadata: {
					title: {en: 'Identifiers-license stage-1 article'},
					abstract: {
						en: `<p>Stage-1 submission for identifier panels (${tag}).</p>`,
					},
				},
				published: false,
			},
		],
	};
}

/** The workflow page's hosting side-modal. */
function workflowModal(page) {
	return page.locator('[data-cy="active-modal"]').first();
}

/**
 * Save the currently-open publication panel form and wait for the
 * publication PUT to land (sent as POST + X-Http-Method-Override by
 * useFetch, so accept either verb). Stronger than the "Saved" toast
 * under parallel load — see patterns.md "Parallel-load lessons".
 */
async function savePublicationPanel(page) {
	await Promise.all([
		page.waitForResponse(
			(res) =>
				/\/api\/v1\/submissions\/\d+\/publications\/\d+(\?|$)/.test(
					res.url(),
				) &&
				['PUT', 'POST'].includes(res.request().method()) &&
				res.ok(),
			{timeout: 20_000},
		),
		workflowModal(page)
			.getByRole('button', {name: 'Save', exact: true})
			.click(),
	]);
}

/**
 * Fill a Permissions & Disclosure FieldText, clicking its per-field
 * "Override" button first when the field ships disabled (`optIntoEdit`
 * is true whenever the publication has no value yet — the gate the
 * editor-metadata-editing wave couldn't drive; the trick is scoping the
 * Override click to the field's own `.pkpFormField--text` wrapper).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} inputName  e.g. 'copyrightHolder-en' / 'licenseUrl'
 * @param {string} value
 */
async function overrideAndFill(page, inputName, value) {
	const modal = workflowModal(page);
	const input = modal.locator(`input[name="${inputName}"]`);
	await expect(input).toBeVisible({timeout: 15_000});
	if (await input.isDisabled()) {
		await modal
			.locator('.pkpFormField--text', {
				has: page.locator(`input[name="${inputName}"]`),
			})
			.getByRole('button', {name: 'Override', exact: true})
			.click();
		await expect(input).toBeEnabled({timeout: 10_000});
	}
	await input.fill(value);
}

/**
 * Fetch the submission's current publication JSON via the REST API
 * (the page's session cookies authenticate the call).
 */
async function fetchCurrentPublication(page, submissionId, journalPath = 'publicknowledge') {
	const subRes = await page.request.get(
		`/index.php/${journalPath}/api/v1/submissions/${submissionId}`,
	);
	if (!subRes.ok()) {
		throw new Error(
			`GET submission ${submissionId} failed: ${subRes.status()} ${await subRes.text()}`,
		);
	}
	const sub = await subRes.json();
	const pubRes = await page.request.get(
		`/index.php/${journalPath}/api/v1/submissions/${submissionId}/publications/${sub.currentPublicationId}`,
	);
	if (!pubRes.ok()) {
		throw new Error(
			`GET publication ${sub.currentPublicationId} failed: ${pubRes.status()} ${await pubRes.text()}`,
		);
	}
	return pubRes.json();
}

/**
 * CSRF token from the authenticated page's state — required for
 * non-GET REST calls made via page.request (same pattern as
 * reviewer-response.spec.js / doi-crossref.spec.js).
 */
async function csrfToken(page) {
	const token = await page.evaluate(
		// @ts-ignore pkp is a page global
		() => window.pkp?.currentUser?.csrfToken,
	);
	expect(token, 'csrf token from page state').toBeTruthy();
	return token;
}

/**
 * Open the public article landing page in a fresh anonymous context.
 * Caller closes the returned context.
 *
 * @returns {Promise<{ctx: import('@playwright/test').BrowserContext, page: import('@playwright/test').Page}>}
 */
async function openArticleAsAnonymous({browser, baseURL, journalPath, submissionId}) {
	const ctx = await browser.newContext({baseURL});
	const page = await ctx.newPage();
	const resp = await page.goto(
		`/index.php/${journalPath}/article/view/${submissionId}`,
	);
	expect(resp?.status(), 'public article page should render').toBe(200);
	return {ctx, page};
}

/**
 * Scratch journal with a published issue + license defaults, for the
 * journal-default license rows (4, 7). The context scenario has no
 * licenseUrl/copyrightHolderType passthrough, so defaults are written
 * through the real contexts REST API as dbarnes (journal manager) —
 * API-first setup; the Distribution settings form belongs to the
 * distribution-settings plan.
 *
 * @returns {Promise<{path: string, id: number, name: string}>}
 */
async function createLicensedScratchJournal({pkpApi, page, tag, licenseUrl}) {
	const {context} = await pkpApi.createJournal({
		tag,
		publishingMode: 0, // open access — anonymous readers allowed
		users: [{username: 'dbarnes', roles: ['manager', 'editor']}],
		issues: [{...SCRATCH_ISSUE, published: true}],
	});

	// Any backend page exposes window.pkp.currentUser.csrfToken; the
	// editorial dashboard is the cheapest authenticated surface.
	await page.goto(`/index.php/${context.path}/dashboard/editorial`);
	const token = await csrfToken(page);
	const putRes = await page.request.put(
		`/index.php/${context.path}/api/v1/contexts/${context.id}`,
		{
			headers: {'X-Csrf-Token': token},
			data: {
				licenseUrl,
				copyrightHolderType: 'context',
			},
		},
	);
	expect(
		putRes.ok(),
		`PUT context license defaults: ${putRes.status()} ${await putRes.text()}`,
	).toBe(true);

	return {
		path: context.path,
		id: context.id,
		name: context.name?.en ?? `Scratch context ${tag}`,
	};
}

test.describe('Publication identifiers & license', () => {
	// Row 1
	test('editor overrides copyright & license on a publication; reader sees the override', {tag: '@smoke'}, async ({page, pkpApi, browser, baseURL}) => {
		const tag = uniqueTag('pil1');
		// No license metadata in the seed — copyrightHolder/copyrightYear
		// ship valueless so their fields render disabled behind the
		// Override button (optIntoEdit). licenseUrl is directly editable
		// because publicknowledge has no journal-default licenseUrl.
		const {submission} = await pkpApi.createSubmission(
			draftVorSpec({tag, issue: PK_ISSUE}),
		);

		const holder = `Override Holder ${tag}`;
		const year = '2030';
		// Deliberately NOT a CC URL: the non-badge branch of
		// article_details.tpl links the entered URL directly, which is
		// the cleanest "reader sees the overridden license link" proof.
		const licenseUrl = `https://example.com/licenses/${tag}`;

		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);
		await workflow.openPublicationPanel('Permissions & Disclosure');
		await expect(
			workflowModal(page).getByRole('heading', {
				name: /Permissions & Disclosure/,
			}),
		).toBeVisible({timeout: 15_000});

		await overrideAndFill(page, 'copyrightHolder-en', holder);
		await overrideAndFill(page, 'copyrightYear', year);
		await overrideAndFill(page, 'licenseUrl', licenseUrl);
		await savePublicationPanel(page);

		// Persistence via the publications API.
		const pub = await fetchCurrentPublication(page, submission.id);
		expect(pub.copyrightHolder?.en).toBe(holder);
		expect(String(pub.copyrightYear)).toBe(year);
		expect(pub.licenseUrl).toBe(licenseUrl);

		// Publish from the same panel (Schedule For Publication →
		// Review Publishing Details → assign to the back issue → Publish).
		await workflow.publishCurrentPanel({issueLabel: PK_ISSUE_LABEL});
		const published = await workflow.fetchPublications(submission.id);
		expect(published[0].status).toBe(STATUS_PUBLISHED);

		// Anonymous reader: copyright statement + overridden license link.
		const {ctx, page: reader} = await openArticleAsAnonymous({
			browser,
			baseURL,
			journalPath: 'publicknowledge',
			submissionId: submission.id,
		});
		const copyrightBlock = reader.locator('.item.copyright');
		await expect(copyrightBlock).toBeVisible();
		await expect(
			copyrightBlock.locator(`a.copyright[href="${licenseUrl}"]`),
		).toBeVisible();
		await expect(copyrightBlock).toContainText(
			`Copyright (c) ${year} ${holder}`,
		);
		await ctx.close();
	});

	// Row 2
	test('editor adds raw references; reader sees the References section', {tag: '@regression'}, async ({page, pkpApi, browser, baseURL}) => {
		const tag = uniqueTag('pil2');
		const {submission} = await pkpApi.createSubmission(
			draftVorSpec({tag, issue: PK_ISSUE}),
		);
		const refs = [
			`Aalto, M. (2024). Raw reference one for ${tag}. Journal A.`,
			`Berg, N. (2023). Raw reference two for ${tag}. Journal B.`,
			`Cole, P. (2022). Raw reference three for ${tag}. Journal C.`,
		];

		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);
		// The citations nav entry is labelled with t('submission.citations')
		// = "References" (the "Structured References" heading lives inside
		// the panel's table).
		await workflow.openPublicationPanel('References');

		// CitationManager's add form: one textarea (one reference per
		// line, CitationListTokenizerFilter splits on newlines) + "Add",
		// posting to .../citations/importAdditionalCitations.
		const addInput = page.locator('#addCitations-rawCitations-control');
		await expect(addInput).toBeVisible({timeout: 15_000});
		await addInput.fill(refs.join('\n'));
		await Promise.all([
			page.waitForResponse(
				(res) =>
					res.url().includes('/citations/importAdditionalCitations') &&
					res.ok(),
				{timeout: 20_000},
			),
			workflowModal(page)
				.getByRole('button', {name: 'Add', exact: true})
				.click(),
		]);

		// Each pasted line lands as its own citation row.
		const table = workflowModal(page).getByRole('table', {
			name: 'Structured References',
		});
		for (const ref of refs) {
			await expect(table.getByText(ref, {exact: true})).toBeVisible({
				timeout: 15_000,
			});
		}

		// Persists across a full reload (publication API is the source of
		// truth; the re-rendered panel double-checks the UI binding).
		const pub = await fetchCurrentPublication(page, submission.id);
		const rawCitations = (pub.citations || []).map((c) =>
			typeof c === 'string' ? c : c?.rawCitation,
		);
		expect(rawCitations).toHaveLength(3);
		for (const ref of refs) {
			expect(rawCitations).toContain(ref);
		}
		await page.reload();
		await workflow.openPublicationPanel('References');
		await expect(
			workflowModal(page).getByText(refs[0], {exact: true}),
		).toBeVisible({timeout: 15_000});

		// Publish; the reader's References section lists all three.
		await workflow.publishCurrentPanel({issueLabel: PK_ISSUE_LABEL});
		const {ctx, page: reader} = await openArticleAsAnonymous({
			browser,
			baseURL,
			journalPath: 'publicknowledge',
			submissionId: submission.id,
		});
		const referencesSection = reader.locator('section.item.references');
		await expect(referencesSection).toBeVisible();
		await expect(
			referencesSection.getByRole('heading', {name: 'References'}),
		).toBeVisible();
		for (const ref of refs) {
			await expect(referencesSection).toContainText(ref);
		}
		await ctx.close();
	});

	// Row 3
	test('per-locale title and abstract round-trip on the Title & Abstract panel', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('pil3');
		const {submission} = await pkpApi.createSubmission(
			draftVorSpec({tag, issue: PK_ISSUE}),
		);
		const frTitle = `Titre francophone ${tag}`;
		const frAbstract = `<p>Résumé en français pour ${tag}.</p>`;

		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);
		await workflow.openPublicationPanel('Title & Abstract');
		await expect(
			workflowModal(page).getByRole('heading', {name: /Title & Abstract/}),
		).toBeVisible({timeout: 15_000});

		// Multilingual fields start with visibleLocales =
		// [submission.locale]; the FormLocales toggle ("French (Canada)")
		// exposes the fr_CA TinyMCE controls.
		await workflowModal(page)
			.locator('.pkpFormLocales button')
			.filter({hasText: 'French'})
			.click();
		await setTinyMceContent(page, 'titleAbstract-title-control-fr_CA', frTitle);
		await setTinyMceContent(
			page,
			'titleAbstract-abstract-control-fr_CA',
			frAbstract,
		);
		await savePublicationPanel(page);

		// API round-trip: fr_CA landed, en untouched (the seeded title
		// carries the tag appended by the scenario processor).
		let pub = await fetchCurrentPublication(page, submission.id);
		expect(pub.title?.fr_CA || pub.fullTitle?.fr_CA).toContain(frTitle);
		expect(pub.abstract?.fr_CA || '').toContain(`Résumé en français pour ${tag}`);
		expect(pub.title?.en || pub.fullTitle?.en).toContain(
			'Identifiers-license article',
		);
		expect(pub.title?.en || '').toContain(tag);

		// Reload: the panel re-renders the persisted fr_CA values.
		await page.reload();
		await workflow.openPublicationPanel('Title & Abstract');
		await expect(
			workflowModal(page).getByRole('heading', {name: /Title & Abstract/}),
		).toBeVisible({timeout: 15_000});
		await workflowModal(page)
			.locator('.pkpFormLocales button')
			.filter({hasText: 'French'})
			.click();
		const persistedFrTitle = await getTinyMceContent(
			page,
			'titleAbstract-title-control-fr_CA',
		);
		expect(persistedFrTitle).toContain(frTitle);

		// Publish succeeds with both locales intact (reader-side fr_CA
		// rendering is owned by article-landing's multilingual row).
		await workflow.publishCurrentPanel({issueLabel: PK_ISSUE_LABEL});
		pub = await fetchCurrentPublication(page, submission.id);
		expect(pub.status).toBe(STATUS_PUBLISHED);
		expect(pub.title?.fr_CA || '').toContain(frTitle);
		expect(pub.title?.en || '').toContain(tag);
	});

	// Row 4
	test('publishing without overrides applies journal default copyright and license', {tag: '@regression'}, async ({page, pkpApi, browser, baseURL}) => {
		// Settings PUT + workflow publish + reader nav legitimately push
		// past the 60s cap under parallel load.
		test.slow();
		const tag = uniqueTag('pil4');
		const journal = await createLicensedScratchJournal({
			pkpApi,
			page,
			tag,
			licenseUrl: CC_BY_NC_4,
		});

		// Draft VoR with NO license metadata of its own.
		const {submission} = await pkpApi.createSubmission(
			draftVorSpec({tag, journal: journal.path, issue: SCRATCH_ISSUE}),
		);

		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id, {journalPath: journal.path});
		await workflow.openPublicationPanel('Title & Abstract');
		await expect(
			workflowModal(page).getByRole('heading', {name: /Title & Abstract/}),
		).toBeVisible({timeout: 15_000});
		await workflow.publishCurrentPanel({issueLabel: SCRATCH_ISSUE_LABEL});

		// Publish backfills the journal defaults
		// (Repo::publication()->publish → _getContextLicenseFieldValue):
		//   copyrightHolderType 'context' → journal name;
		//   copyrightYearBasis default 'issue' → year of the issue's
		//   datePublished (stamped today by the issue processor);
		//   licenseUrl → the journal default.
		const currentYear = new Date().getFullYear();
		const pub = await fetchCurrentPublication(
			page,
			submission.id,
			journal.path,
		);
		expect(pub.status).toBe(STATUS_PUBLISHED);
		expect(pub.licenseUrl).toBe(CC_BY_NC_4);
		expect(Number(pub.copyrightYear)).toBe(currentYear);
		expect(pub.copyrightHolder?.en).toBe(journal.name);

		// Reader: journal-default copyright statement + the CC BY-NC 4.0
		// badge link (the badge's href is the canonical CC URL).
		const {ctx, page: reader} = await openArticleAsAnonymous({
			browser,
			baseURL,
			journalPath: journal.path,
			submissionId: submission.id,
		});
		const copyrightBlock = reader.locator('.item.copyright');
		await expect(copyrightBlock).toBeVisible();
		await expect(copyrightBlock).toContainText(
			`Copyright (c) ${currentYear} ${journal.name}`,
		);
		await expect(
			copyrightBlock.locator('a[rel="license"][href*="by-nc/4.0"]').first(),
		).toBeVisible();
		await ctx.close();
	});

	// Row 5
	test('publisher ID field appears after enabling it in metadata settings', {tag: '@regression'}, async ({page, pkpApi}) => {
		// Two UI surfaces (workflow settings + workflow panel) plus a
		// scratch-journal bootstrap — give it the slow budget.
		test.slow();
		const tag = uniqueTag('pil5');
		const {context} = await pkpApi.createJournal({
			tag,
			users: [{username: 'dbarnes', roles: ['manager', 'editor']}],
		});
		const {submission} = await pkpApi.createSubmission(
			stage1Spec({tag, journal: context.path}),
		);
		const publisherId = `pid-${tag}`;

		// Pre-check: with enablePublisherId unset, the Metadata panel has
		// no publisher-id field (PKPMetadataForm::enabled gate). Bound the
		// negative on the keywords control, which IS enabled by default.
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id, {journalPath: context.path});
		await workflow.openPublicationPanel('Metadata');
		await expect(
			workflowModal(page).locator('#metadata-keywords-control-en'),
		).toBeVisible({timeout: 15_000});
		await expect(
			workflowModal(page).locator('input[name="pub-id::publisher-id"]'),
		).toHaveCount(0);

		// Workflow > Submission > Metadata settings: tick "Enable for
		// Publications" under Publisher ID (FieldOptions enablePublisherId,
		// value 'publication') and save. Tab hooks are the PkpTabs
		// `#{name}-button` ids (same driving as wizard-config-reset).
		await page.goto(`/index.php/${context.path}/management/settings/workflow`);
		await page.locator('#submission-button').click();
		await page.locator('#metadata-button').click();
		const publisherIdCheckbox = page.locator(
			'input[name="enablePublisherId"][value="publication"]',
		);
		await expect(publisherIdCheckbox).toBeVisible({timeout: 15_000});
		await publisherIdCheckbox.check();
		const metadataForm = page.locator('form', {
			has: page.locator('input[name="enablePublisherId"]'),
		});
		await Promise.all([
			page.waitForResponse(
				(res) =>
					/\/api\/v1\/contexts\/\d+/.test(res.url()) &&
					['PUT', 'POST'].includes(res.request().method()) &&
					res.ok(),
				{timeout: 20_000},
			),
			metadataForm.getByRole('button', {name: 'Save', exact: true}).click(),
		]);

		// The Metadata panel now exposes the field; a value round-trips.
		await workflow.goto(submission.id, {journalPath: context.path});
		await workflow.openPublicationPanel('Metadata');
		const pubIdInput = workflowModal(page).locator(
			'input[name="pub-id::publisher-id"]',
		);
		await expect(pubIdInput).toBeVisible({timeout: 15_000});
		await pubIdInput.fill(publisherId);
		await savePublicationPanel(page);

		const pub = await fetchCurrentPublication(
			page,
			submission.id,
			context.path,
		);
		expect(pub['pub-id::publisher-id']).toBe(publisherId);

		// And the panel re-renders the persisted value after a reload.
		await page.reload();
		await workflow.openPublicationPanel('Metadata');
		await expect(
			workflowModal(page).locator('input[name="pub-id::publisher-id"]'),
		).toHaveValue(publisherId, {timeout: 15_000});
	});

	// Row 6
	test('identifiers tab is gated by a pub-id plugin; URN round-trips', {tag: '@regression'}, async ({page, pkpApi}) => {
		test.slow();
		const tag = uniqueTag('pil6');
		const urnPrefix = 'urn:nbn:de:0000-';
		const urn = `${urnPrefix}${tag}`;

		// Negative arm: publicknowledge has no pub-id plugin enabled
		// (DOIs are core, not a pubIds plugin), so the Publication
		// side-nav offers no Identifiers entry. Bound the negative on the
		// Title & Abstract entry being present.
		const {submission: pkSubmission} = await pkpApi.createSubmission(
			stage1Spec({tag: `${tag}-pk`}),
		);
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(pkSubmission.id);
		const pkNav = workflowModal(page).locator('nav a');
		await expect(
			pkNav.getByText('Title & Abstract', {exact: true}).first(),
		).toBeVisible({timeout: 15_000});
		await expect(pkNav.getByText('Identifiers', {exact: true})).toHaveCount(0);

		// Positive arm: scratch journal with the URN plugin enabled for
		// publications. With urnSuffix unset the plugin adds the manual
		// FieldTextUrn (no pattern field, no check number).
		//
		// urnCheckNo MUST be seeded explicitly (the settings form would
		// have written it): when the setting row is absent, getSetting
		// returns null and FieldTextUrn's typed bool $applyCheckNumber
		// throws (URNPubIdPlugin.php:387 → Field.php:83), the hook
		// wrapper swallows the TypeError, and the Identifiers form
		// silently ships with ZERO fields — app-bug finding from run 1,
		// reported in the plan.
		const {context} = await pkpApi.createJournal({
			tag,
			users: [{username: 'dbarnes', roles: ['manager', 'editor']}],
			plugins: {
				urnpubidplugin: {
					enabled: true,
					settings: {
						enablePublicationURN: true,
						urnPrefix,
						urnCheckNo: false,
					},
				},
			},
		});
		const {submission} = await pkpApi.createSubmission(
			stage1Spec({tag, journal: context.path}),
		);

		await workflow.goto(submission.id, {journalPath: context.path});
		const nav = workflowModal(page).locator('nav a');
		await expect(
			nav.getByText('Identifiers', {exact: true}).first(),
		).toBeVisible({timeout: 15_000});
		await workflow.openPublicationPanel('Identifiers');

		// URN value entry + save. The URN plugin validates the prefix
		// server-side (Publication::validate hook), so the value must
		// start with the seeded urnPrefix.
		const urnInput = workflowModal(page).locator(
			'input[name="pub-id::other::urn"]',
		);
		await expect(urnInput).toBeVisible({timeout: 15_000});
		await urnInput.fill(urn);
		await savePublicationPanel(page);

		const pub = await fetchCurrentPublication(
			page,
			submission.id,
			context.path,
		);
		expect(pub['pub-id::other::urn']).toBe(urn);

		// Round-trip: the panel re-renders the persisted URN.
		await page.reload();
		await workflow.openPublicationPanel('Identifiers');
		await expect(
			workflowModal(page).locator('input[name="pub-id::other::urn"]'),
		).toHaveValue(urn, {timeout: 15_000});
	});

	// Row 7
	test('clearing a license override restores journal defaults', {tag: '@regression'}, async ({page, pkpApi, browser, baseURL}) => {
		test.slow();
		const tag = uniqueTag('pil7');
		const journal = await createLicensedScratchJournal({
			pkpApi,
			page,
			tag,
			licenseUrl: CC_BY_4,
		});
		const overrideUrl = `https://example.com/licenses/${tag}`;

		// Draft VoR carrying explicit overrides — the fields render
		// enabled (no Override gate) because values exist.
		const {submission} = await pkpApi.createSubmission(
			draftVorSpec({
				tag,
				journal: journal.path,
				issue: SCRATCH_ISSUE,
				metadata: {
					copyrightHolder: {en: `Override Holder ${tag}`},
					copyrightYear: 2020,
					licenseUrl: overrideUrl,
				},
			}),
		);

		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id, {journalPath: journal.path});
		await workflow.openPublicationPanel('Permissions & Disclosure');
		const modal = workflowModal(page);
		await expect(
			modal.getByRole('heading', {name: /Permissions & Disclosure/}),
		).toBeVisible({timeout: 15_000});

		// Clear all three overrides and save.
		const holderInput = modal.locator('input[name="copyrightHolder-en"]');
		await expect(holderInput).toHaveValue(`Override Holder ${tag}`, {
			timeout: 15_000,
		});
		await holderInput.fill('');
		await modal.locator('input[name="copyrightYear"]').fill('');
		await modal.locator('input[name="licenseUrl"]').fill('');
		await savePublicationPanel(page);

		// The overrides are gone from the publication.
		let pub = await fetchCurrentPublication(page, submission.id, journal.path);
		expect(pub.licenseUrl ?? '').toBe('');
		expect(pub.copyrightYear ?? '').toBeFalsy();
		expect(pub.copyrightHolder?.en ?? '').toBe('');

		// Publish: the journal defaults fill back in.
		await workflow.publishCurrentPanel({issueLabel: SCRATCH_ISSUE_LABEL});
		const currentYear = new Date().getFullYear();
		pub = await fetchCurrentPublication(page, submission.id, journal.path);
		expect(pub.status).toBe(STATUS_PUBLISHED);
		expect(pub.licenseUrl).toBe(CC_BY_4);
		expect(Number(pub.copyrightYear)).toBe(currentYear);
		expect(pub.copyrightHolder?.en).toBe(journal.name);

		// Reader: the default CC BY 4.0 badge is back; the override URL
		// is nowhere on the license block.
		const {ctx, page: reader} = await openArticleAsAnonymous({
			browser,
			baseURL,
			journalPath: journal.path,
			submissionId: submission.id,
		});
		const copyrightBlock = reader.locator('.item.copyright');
		await expect(copyrightBlock).toBeVisible();
		await expect(
			copyrightBlock.locator('a[rel="license"][href*="licenses/by/4.0"]').first(),
		).toBeVisible();
		await expect(
			copyrightBlock.locator(`a[href="${overrideUrl}"]`),
		).toHaveCount(0);
		await ctx.close();
	});

	// Row 8
	test('editor edits and deletes references; reader updates', {tag: '@regression'}, async ({page, pkpApi, browser, baseURL}) => {
		test.slow();
		const tag = uniqueTag('pil8');
		const {submission} = await pkpApi.createSubmission(
			draftVorSpec({tag, issue: PK_ISSUE}),
		);
		const refA = `Dorn, Q. (2021). Editable reference for ${tag}. Journal D.`;
		const refB = `Eble, R. (2020). Deletable reference for ${tag}. Journal E.`;
		const refAEdited = `Dorn, Q. (2025). Edited reference for ${tag}. Journal D, 2nd ed.`;

		// Seed both references through the same REST endpoint the Add
		// form posts to — the add UI itself is row 2's subject; this
		// row's subject is edit + delete.
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);
		const seededPub = await fetchCurrentPublication(page, submission.id);
		const token = await csrfToken(page);
		const importRes = await page.request.post(
			`/index.php/publicknowledge/api/v1/submissions/${submission.id}/publications/${seededPub.id}/citations/importAdditionalCitations`,
			{
				headers: {'X-Csrf-Token': token},
				data: {rawCitations: `${refA}\n${refB}`},
			},
		);
		expect(
			importRes.ok(),
			`importAdditionalCitations: ${importRes.status()} ${await importRes.text()}`,
		).toBe(true);

		// Open the References panel on fresh state.
		await page.reload();
		await workflow.openPublicationPanel('References');
		const table = workflowModal(page).getByRole('table', {
			name: 'Structured References',
		});
		await expect(table.getByText(refA, {exact: true})).toBeVisible({
			timeout: 15_000,
		});
		await expect(table.getByText(refB, {exact: true})).toBeVisible();

		// --- Edit refA --- row actions are a portaled DropdownActions
		// menu ("More Actions" ellipsis → Edit / Delete menuitems); the
		// edit modal hosts the citationRawEditForm (PUT /citations/{id}).
		await table
			.locator('tr', {hasText: refA})
			.getByRole('button', {name: 'More Actions'})
			.click();
		await page.getByRole('menuitem', {name: 'Edit', exact: true}).click();
		const editModal = page.getByRole('dialog', {name: 'Edit citation'});
		const editInput = editModal.locator('#citation_raw-rawCitation-control');
		await expect(editInput).toBeVisible({timeout: 15_000});
		await expect(editInput).toHaveValue(refA);
		await editInput.fill(refAEdited);
		await Promise.all([
			page.waitForResponse(
				(res) =>
					/\/api\/v1\/citations\/\d+/.test(res.url()) &&
					['PUT', 'POST'].includes(res.request().method()) &&
					res.ok(),
				{timeout: 20_000},
			),
			editModal.getByRole('button', {name: 'Save', exact: true}).click(),
		]);
		await expect(table.getByText(refAEdited, {exact: true})).toBeVisible({
			timeout: 15_000,
		});
		await expect(table.getByText(refA, {exact: true})).toHaveCount(0);

		// --- Delete refB --- confirm dialog with a warnable OK.
		await table
			.locator('tr', {hasText: refB})
			.getByRole('button', {name: 'More Actions'})
			.click();
		await page.getByRole('menuitem', {name: 'Delete', exact: true}).click();
		const deleteDialog = page.locator('[data-cy="dialog"]');
		await expect(deleteDialog).toBeVisible({timeout: 10_000});
		await Promise.all([
			page.waitForResponse(
				(res) =>
					/\/api\/v1\/citations\/\d+/.test(res.url()) &&
					['DELETE', 'POST'].includes(res.request().method()) &&
					res.ok(),
				{timeout: 20_000},
			),
			deleteDialog.getByRole('button', {name: 'OK', exact: true}).click(),
		]);
		await expect(table.getByText(refB, {exact: true})).toHaveCount(0, {
			timeout: 15_000,
		});

		// API view agrees: a single citation row carrying the edit.
		const pub = await fetchCurrentPublication(page, submission.id);
		const rawCitations = (pub.citations || []).map((c) =>
			typeof c === 'string' ? c : c?.rawCitation,
		);
		expect(rawCitations).toEqual([refAEdited]);

		// Publish; the reader's References section reflects both changes.
		await workflow.publishCurrentPanel({issueLabel: PK_ISSUE_LABEL});
		const {ctx, page: reader} = await openArticleAsAnonymous({
			browser,
			baseURL,
			journalPath: 'publicknowledge',
			submissionId: submission.id,
		});
		const referencesSection = reader.locator('section.item.references');
		await expect(referencesSection).toBeVisible();
		await expect(referencesSection).toContainText(refAEdited);
		await expect(referencesSection).not.toContainText(refB);
		await expect(referencesSection).not.toContainText(refA);
		await ctx.close();
	});
});
