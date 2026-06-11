// @ts-check
const {test, expect} = require('../../../../playwright/support/fixtures.js');
const {EditorialWorkflowPage} = require('../../../../playwright/pages/EditorialWorkflowPage.js');
const {setTinyMceContent} = require('../support/tinymce.js');
const submissionInReview = require('../../../../playwright/fixtures/scenarios/submission-in-review.js');

/**
 * Playwright port of the publication-metadata-editing slice of
 * AmwandengaSubmission.cy.js test 3 ("Editor can edit publication
 * details"). The Cypress source drives a full tour of Title & Abstract,
 * Metadata, Permissions, Issue, Contributors, Galleys — we reduce that
 * to the smallest set that proves the Publication panel persists edits
 * round-trip:
 *   - Title & Abstract: title (TinyMCE) + abstract (TinyMCE)
 *   - Metadata:         keywords (autosuggest)
 *
 * Scope deviation — scenario seed:
 *   The roadmap suggests `submissionPublished({tag})` so the R portion
 *   can walk the public article page. Probing that confirmed the UI
 *   surfaces a `WorkflowPublicationEditWarning` on a published publication
 *   (status=STATUS_PUBLISHED) — editing is blocked without creating a
 *   new version. Rather than entangle this spec with versioning UX
 *   (which belongs to row #29), we seed `submissionInReview({tag})`
 *   — its draft-state publication (status=STATUS_QUEUED, versionStage=AO,
 *   "Author Original 1.0") accepts edits directly.
 *
 * Scope deviation — reader verification:
 *   R ("updated values appear on article page") is dropped here because
 *   the draft publication has no public URL. The publish/unpublish flow
 *   and reader verification live in row #28 (publish-unpublish).
 *
 * A second test covers the Contributors panel — the most user-visible
 * of the per-panel save surfaces — by adding a new author and
 * verifying the publication's authors list round-trips via REST.
 *
 * Plan ownership (N-test absorption rule — one row per test):
 *   - test 1 (title/abstract/keywords) → editor-metadata-editing row 1
 *   - test 2 (basic add contributor, en-only name) → contributors row 1
 *   - test 3 (add contributor with multilingual name, country, role) →
 *     editor-metadata-editing row 2. Differentiated from test 2 by the
 *     FormLocales toggle + fr_CA name fields: it proves the contributor
 *     form's multilingual plumbing end-to-end (visibleLocales starts as
 *     [submission.locale]; the locale toggle exposes the fr_CA inputs).
 *     Broader contributor CRUD/ordering stays with the contributors plan.
 *
 * Galleys is exercised end-to-end by row #51 (galleys.spec.js). The
 * remaining two panels (Permissions, Issue) share the same `pkpForm`
 * save infrastructure as Title & Abstract / Contributors and aren't
 * separately tested here — the Permissions panel's `optIntoEdit`
 * gate (FieldText with Override-then-edit semantics on
 * copyrightHolder + copyrightYear) and the Issue panel's stacked-form
 * Save targeting under the dashboard dialog turned out non-trivial
 * to drive reliably from Playwright. The same field types are
 * exercised across other rows (#11 wizard copyright covers
 * copyrightNotice multilingual, #16 wizard config covers FieldText +
 * required validation, #28 publish-unpublish exercises the Issue
 * dropdown via `publishCurrentPanel`); the panel save infrastructure
 * is proven by the Title & Abstract round-trip in test 1. Reopen if
 * a regression surfaces on those panels' field-specific bindings.
 */
test.describe('Publication metadata editing', () => {
	test('editor updates publication title, abstract, and keywords; changes persist on reload', async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag(test.info(), 'metadata');
		const spec = submissionInReview({tag});
		const {submission} = await pkpApi.createSubmission(spec);

		const newTitle = `Updated title ${tag}`;
		const newAbstract =
			`<p>Updated abstract for ${tag} — rewritten by the editor.</p>`;
		const newKeyword = `kw-${tag}`;

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		// The workflow page renders itself inside a reka-ui dialog tagged
		// `[data-cy="active-modal"]`. Its side-nav exposes the Publication
		// sub-items (Title & Abstract, Metadata, Contributors, …) as
		// anchors with href="#". The anchor text is padded with
		// whitespace, so use getByText with exact:true — filter's
		// hasText applies against the raw textContent and mismatches.
		const modal = page.locator('[data-cy="active-modal"]');
		const sideNav = modal.locator('nav a');

		// --- Title & Abstract ---
		await sideNav.getByText('Title & Abstract', {exact: true}).first().click();
		// The heading `Publication:  Title & Abstract` confirms the panel
		// mounted before we start touching TinyMCE editors (which rely on
		// their initialization hook for setContent to land).
		await expect(
			modal.getByRole('heading', {name: /Title & Abstract/}),
		).toBeVisible({timeout: 10_000});

		await setTinyMceContent(page, 'titleAbstract-title-control-en', newTitle);
		await setTinyMceContent(
			page,
			'titleAbstract-abstract-control-en',
			newAbstract,
		);

		await modal.getByRole('button', {name: 'Save', exact: true}).click();
		// The Vue form toasts via [role="status"] containing "Saved" on
		// success (Cypress used the same assertion — see
		// AmwandengaSubmission.cy.js#307).
		await expect(page.locator('[role="status"]').filter({hasText: 'Saved'}))
			.toBeVisible({timeout: 15_000});

		// --- Metadata (keywords) ---
		await sideNav.getByText('Metadata', {exact: true}).first().click();
		await expect(modal.getByRole('heading', {name: /Metadata/})).toBeVisible({
			timeout: 10_000,
		});

		// Keyword FieldControlledVocab autosuggest: type + Enter to commit
		// a tag. Matches the Cypress flow in AmwandengaSubmission.cy.js#313.
		const keywordInput = modal.locator('#metadata-keywords-control-en');
		await keywordInput.fill(newKeyword);
		await keywordInput.press('Enter');
		// Per-keyword chips render as "Remove <keyword>" buttons in the
		// selected list; asserting the one for our new keyword is a
		// clean ready signal before we save.
		await expect(
			modal.getByRole('button', {name: `Remove ${newKeyword}`}),
		).toBeVisible({timeout: 10_000});

		await modal.getByRole('button', {name: 'Save', exact: true}).click();
		await expect(page.locator('[role="status"]').filter({hasText: 'Saved'}))
			.toBeVisible({timeout: 15_000});

		// --- Reload & verify persistence ---
		// The publication API is the source of truth — fetching it
		// confirms the edits landed independently of any UI caching.
		const pub = await fetchCurrentPublication(page, submission.id);
		expect(pub.fullTitle?.en || pub.title?.en).toContain(newTitle);
		// Abstract round-trips as HTML; the added sentence is the
		// stable substring to assert on.
		expect(pub.abstract?.en || '').toContain(`Updated abstract for ${tag}`);
		// Keywords round-trip as {name: string} objects on the publication
		// payload (see ControlledVocab::asShallowArray → nameTransformer).
		const keywordNames = (pub.keywords?.en || []).map((k) =>
			typeof k === 'string' ? k : k?.name,
		);
		expect(keywordNames).toContain(newKeyword);

		// And — separately — the workflow page itself re-renders the new
		// title after a full page reload (guards against any stale
		// in-memory state vs what the API returns). The title appears
		// as a sub-header beneath the submitter name; plain-text match
		// is enough since the tag makes it globally unique on the page.
		await page.reload();
		await expect(page.getByText(newTitle).first()).toBeVisible({
			timeout: 15_000,
		});
	});

	test('editor adds a new contributor via the Contributors panel', async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag(test.info(), 'contrib');
		const spec = submissionInReview({tag});
		const {submission} = await pkpApi.createSubmission(spec);

		const givenName = `New${tag.replace(/[^a-z0-9]/gi, '')}`;
		const familyName = `Contributor`;
		const email = `contrib-${tag}@mailinator.com`.toLowerCase();

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		const modal = page.locator('[data-cy="active-modal"]');
		const sideNav = modal.locator('nav a');

		// ContributorManager mounts under the Contributors side-nav
		// entry; its container carries `data-cy="contributor-manager"`.
		await sideNav.getByText('Contributors', {exact: true}).first().click();
		const contributorManager = page.locator(
			'[data-cy="contributor-manager"]',
		);
		await expect(contributorManager).toBeVisible({timeout: 10_000});

		// "Add Contributor" opens ContributorsEditModal — a stacked
		// SideModal. ModalManager's `data-cy="active-modal"` migrates to
		// whichever side-modal is on top, so we anchor on the
		// contributor form's email input directly (per the patterns.md
		// note: the modal wrapper reports visibility:hidden during the
		// open transition).
		await contributorManager
			.getByRole('button', {name: 'Add Contributor', exact: true})
			.click();

		const emailInput = page.locator('input[name="email"]').last();
		await expect(emailInput).toBeVisible({timeout: 15_000});

		// Fill multilingual + scalar fields. Multilingual ones follow
		// `name-locale` (givenName-en, familyName-en); email + country
		// are scalars.
		await page.locator('input[name="givenName-en"]').last().fill(givenName);
		await page.locator('input[name="familyName-en"]').last().fill(familyName);
		await emailInput.fill(email);
		await page.locator('select[name="country"]').last().selectOption('CA');

		// `contributorRoles` is a FieldOptions (multi-checkbox group)
		// with a required validator — at least one of Author /
		// Translator must be ticked or the form refuses to submit. The
		// inputs render as `name="contributorRoles[]"`; pick the first
		// "Author"-labelled checkbox.
		await page
			.locator('label', {hasText: 'Author'})
			.locator('input[type="checkbox"]')
			.first()
			.check({force: true});

		// Save the contributor form. Race with the contributor POST —
		// the publication's authors collection endpoint.
		await Promise.all([
			page.waitForResponse(
				(res) =>
					/\/api\/v1\/submissions\/\d+\/publications\/\d+\/contributors/.test(
						res.url(),
					) &&
					res.ok(),
				{timeout: 20_000},
			),
			page
				.getByRole('button', {name: 'Save', exact: true})
				.last()
				.click(),
		]);

		// Modal closes; contributor list refreshes with the new row.
		// The display name is the standard "Given Family" composite.
		await expect(
			contributorManager.getByText(`${givenName} ${familyName}`),
		).toBeVisible({timeout: 15_000});

		// REST round-trip: the publication's authors list now includes
		// the new contributor.
		const pub = await fetchCurrentPublication(page, submission.id);
		const authors = pub.authors || [];
		const match = authors.find(
			(a) => (a.email || '').toLowerCase() === email,
		);
		expect(match, `author with email ${email} should exist`).toBeTruthy();
		expect(match.givenName?.en).toBe(givenName);
		expect(match.familyName?.en).toBe(familyName);
	});

	test('editor adds a contributor with a multilingual name via the Contributors panel', async ({
		pkpApi,
		asUser,
	}) => {
		// editor-metadata-editing plan row 2 — the single add-contributor
		// flow with the full field set: multilingual (en + fr_CA) name,
		// email, country, and the required contributor-role checkbox.
		const tag = uniqueTag(test.info(), 'contrib2');
		const spec = submissionInReview({tag});
		const {submission} = await pkpApi.createSubmission(spec);

		const suffix = tag.replace(/[^a-z0-9]/gi, '');
		const givenNameEn = `Given${suffix}`;
		const givenNameFr = `Prenom${suffix}`;
		const familyNameEn = 'Contributorson';
		const familyNameFr = 'Contributeur';
		const email = `contrib2-${tag}@mailinator.com`.toLowerCase();

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		const modal = page.locator('[data-cy="active-modal"]');
		const sideNav = modal.locator('nav a');
		await sideNav.getByText('Contributors', {exact: true}).first().click();
		const contributorManager = page.locator('[data-cy="contributor-manager"]');
		await expect(contributorManager).toBeVisible({timeout: 10_000});

		await contributorManager
			.getByRole('button', {name: 'Add Contributor', exact: true})
			.click();

		// ContributorsEditModal opens with the accessible name
		// "Add Contributor" (grid.action.addContributor) — scope all the
		// form interactions to it (the workflow page is a dialog too).
		const addModal = page.getByRole('dialog', {name: 'Add Contributor'});
		const emailInput = addModal.locator('input[name="email"]');
		await expect(emailInput).toBeVisible({timeout: 15_000});

		// Multilingual fields start with visibleLocales =
		// [submission.locale] (useForm#setLocalesForSubmission). The
		// FormLocales toggle ("French (Canada)") exposes the fr_CA inputs.
		await addModal
			.locator('.pkpFormLocales button')
			.filter({hasText: 'French'})
			.click();
		const givenNameFrInput = addModal.locator('input[name="givenName-fr_CA"]');
		await expect(givenNameFrInput).toBeVisible({timeout: 10_000});

		await addModal.locator('input[name="givenName-en"]').fill(givenNameEn);
		await givenNameFrInput.fill(givenNameFr);
		await addModal.locator('input[name="familyName-en"]').fill(familyNameEn);
		await addModal
			.locator('input[name="familyName-fr_CA"]')
			.fill(familyNameFr);
		await emailInput.fill(email);
		await addModal.locator('select[name="country"]').selectOption('IS');

		// Required contributor-role checkbox (FieldOptions
		// `contributorRoles[]`, renders only when the journal has more
		// than one role — Author/Translator in the baseline journal).
		await addModal
			.locator('label', {hasText: 'Author'})
			.locator('input[type="checkbox"]')
			.first()
			.check({force: true});

		await Promise.all([
			page.waitForResponse(
				(res) =>
					/\/api\/v1\/submissions\/\d+\/publications\/\d+\/contributors/.test(
						res.url(),
					) &&
					res.request().method() === 'POST' &&
					res.ok(),
				{timeout: 20_000},
			),
			addModal.getByRole('button', {name: 'Save', exact: true}).click(),
		]);

		// Manager list refreshes with the new contributor row.
		await expect(
			contributorManager.getByText(`${givenNameEn} ${familyNameEn}`),
		).toBeVisible({timeout: 15_000});

		// REST round-trip: both locales of the name, the country, and the
		// contributor role landed on the publication's author.
		const pub = await fetchCurrentPublication(page, submission.id);
		const match = (pub.authors || []).find(
			(a) => (a.email || '').toLowerCase() === email,
		);
		expect(match, `author with email ${email} should exist`).toBeTruthy();
		expect(match.givenName?.en).toBe(givenNameEn);
		expect(match.givenName?.fr_CA).toBe(givenNameFr);
		expect(match.familyName?.en).toBe(familyNameEn);
		expect(match.familyName?.fr_CA).toBe(familyNameFr);
		expect(match.country).toBe('IS');
		expect(
			JSON.stringify(match.contributorRoles ?? []),
			'contributor role round-trips on the author payload',
		).toContain('Author');
	});
});

/**
 * Fetch the submission's current publication JSON via the REST API.
 * OJS exposes publications under the submission resource; we pull the
 * submission first to get the current publication id, then fetch the
 * publication itself so we see the full metadata (title, abstract,
 * keywords) in the shape the form writes to.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} submissionId
 */
async function fetchCurrentPublication(page, submissionId) {
	const subRes = await page.request.get(
		`/index.php/publicknowledge/api/v1/submissions/${submissionId}`,
	);
	if (!subRes.ok()) {
		throw new Error(
			`GET submission ${submissionId} failed: ${subRes.status()} ${await subRes.text()}`,
		);
	}
	const sub = await subRes.json();
	const pubRes = await page.request.get(
		`/index.php/publicknowledge/api/v1/submissions/${submissionId}/publications/${sub.currentPublicationId}`,
	);
	if (!pubRes.ok()) {
		throw new Error(
			`GET publication ${sub.currentPublicationId} failed: ${pubRes.status()} ${await pubRes.text()}`,
		);
	}
	return pubRes.json();
}

/**
 * Build a tag scoped to this worker + test title so parallel workers
 * don't collide on the shared submissions list.
 *
 * @param {import('@playwright/test').TestInfo} info
 * @param {string} suffix
 */
function uniqueTag(info, suffix) {
	const slug = info.title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.slice(0, 16);
	return `t-w${info.parallelIndex}-${suffix}-${slug}`;
}
