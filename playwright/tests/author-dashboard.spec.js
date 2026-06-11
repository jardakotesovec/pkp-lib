// @ts-check
const {test, expect} = require('../support/base-test.js');

/**
 * Author dashboard — docs/e2e/plans/author-dashboard.md (6 rows).
 *
 * The author's surface is /dashboard/mySubmissions. atester (the
 * baseline author-only user) is shared with many parallel specs, so
 * every list assertion is presence/absence scoped by this test's
 * unique tag — never counts. Row 2, which needs a tag-scoped truth
 * table across four views, runs on its own scratch journal with a
 * throwaway submitter so no sibling test can leak rows into any view.
 */

function uniqueTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

function mySubmissionsUrl({journal = 'publicknowledge', view, workflowSubmissionId} = {}) {
	const params = new URLSearchParams();
	if (view) params.set('currentViewId', view);
	if (workflowSubmissionId) params.set('workflowSubmissionId', String(workflowSubmissionId));
	const query = params.toString();
	return `/index.php/${journal}/en/dashboard/mySubmissions${query ? `?${query}` : ''}`;
}

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

/** Plain submitted stage-1 submission on publicknowledge. */
function submittedSpec({tag, title, submitter = 'atester', journal = 'publicknowledge', section = 'ART'}) {
	return {
		tag,
		journal,
		submitter,
		section,
		locale: 'en',
		submitted: true,
		publications: [{metadata: {title: {en: title}}}],
	};
}

test.describe('Author dashboard', () => {
	test.use({user: 'atester'});

	test('my-submissions lists own submissions with stage labels and offers no editorial views', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('adl');
		await pkpApi.createSubmission(submittedSpec({tag, title: `Mine-${tag}`}));
		await pkpApi.createSubmission(
			submittedSpec({tag, title: `Other-${tag}`, submitter: 'svogt'}),
		);

		await page.goto(mySubmissionsUrl({view: 'active'}));
		await expect(
			page.getByRole('heading', {name: /Active submissions/}),
		).toBeVisible({timeout: 15_000});
		await searchList(page, tag);

		// Own submission with its stage label; the other user's
		// submission never renders for atester (both carry the same
		// tag, so the search alone can't explain its absence).
		const mineRow = page.getByRole('row').filter({hasText: `Mine-${tag}`});
		await expect(mineRow).toBeVisible({timeout: 15_000});
		await expect(mineRow).toContainText('Submission'); // stage bubble
		await expect(page.getByText(`Other-${tag}`)).toHaveCount(0);

		// The author-only nav offers the my-submissions views but none
		// of the editorial-role views.
		const nav = page.locator('nav#app-nav');
		await expect(nav.getByText('Incomplete submissions')).toBeVisible();
		await expect(nav.getByText('Needs editor')).toHaveCount(0);
		await expect(nav.getByText('Assigned to me')).toHaveCount(0);
	});

	test('views filter by submission state on a scratch journal (tag-scoped presence/absence)', {tag: '@regression'}, async ({pkpApi, asUser}) => {
		const tag = uniqueTag('adv');
		// Throwaway submitter: unique per test, so the four views on the
		// scratch journal contain ONLY this test's rows for that user.
		const username = `u${tag.replace(/[^a-z0-9]/gi, '')}`;
		const {context} = await pkpApi.createJournal({
			tag,
			name: {en: `Author views ${tag}`},
			users: [
				{username, password: username + username, roles: ['author']},
				{username: 'dbarnes', roles: ['editor']},
			],
			issues: [{volume: 1, number: 1, year: 2025, published: true}],
		});

		const base = {
			tag,
			journal: context.path,
			submitter: username,
			section: 'ART',
			locale: 'en',
		};
		await pkpApi.createSubmission({
			...base,
			submitted: false,
			publications: [{metadata: {title: {en: `Vinc-${tag}`}}}],
		});
		await pkpApi.createSubmission({
			...base,
			submitted: true,
			publications: [{metadata: {title: {en: `Vact-${tag}`}}}],
		});
		await pkpApi.createSubmission({
			...base,
			participants: [{user: 'dbarnes', role: 'editor'}],
			decisions: [{type: 'initialDecline', by: 'dbarnes'}],
			publications: [{metadata: {title: {en: `Vdec-${tag}`}}}],
		});
		// Published: walk the real decision chain into production first
		// so the row carries the Published stage badge (publishing a
		// stage-1 submission would leave the badge at "Submission").
		await pkpApi.createSubmission({
			...base,
			participants: [{user: 'dbarnes', role: 'editor'}],
			decisions: [
				{type: 'skipExternalReview', by: 'dbarnes'},
				{type: 'sendToProduction', by: 'dbarnes'},
			],
			publications: [
				{
					metadata: {title: {en: `Vpub-${tag}`}},
					issue: 'latest',
					published: true,
				},
			],
		});

		const ctx = await asUser(username);
		const authorPage = await ctx.newPage();

		// Each view shows exactly its own tag-scoped row (with the right
		// status badge) and not the rows seeded for the other states.
		// Note (verified against the real UI): the Active view's
		// collector is status=QUEUED + assigned, which INCLUDES the
		// incomplete wizard draft — so the draft's absence is asserted
		// on the declined/published views instead.
		const matrix = [
			{
				view: 'incomplete-submissions',
				heading: /Incomplete submissions/,
				present: [`Vinc-${tag}`],
				badge: 'Incomplete',
				absent: [`Vact-${tag}`, `Vdec-${tag}`, `Vpub-${tag}`],
			},
			{
				view: 'active',
				heading: /Active submissions/,
				present: [`Vact-${tag}`],
				badge: 'Submission',
				absent: [`Vdec-${tag}`, `Vpub-${tag}`],
			},
			{
				view: 'declined',
				heading: /Declined/,
				present: [`Vdec-${tag}`],
				badge: 'Declined',
				absent: [`Vinc-${tag}`, `Vact-${tag}`, `Vpub-${tag}`],
			},
			{
				view: 'published',
				heading: /Published/,
				present: [`Vpub-${tag}`],
				badge: 'Published',
				absent: [`Vinc-${tag}`, `Vact-${tag}`, `Vdec-${tag}`],
			},
		];

		for (const {view, heading, present, badge, absent} of matrix) {
			await authorPage.goto(mySubmissionsUrl({journal: context.path, view}));
			await expect(
				authorPage.getByRole('heading', {name: heading}),
			).toBeVisible({timeout: 15_000});
			for (const marker of present) {
				const row = authorPage.getByRole('row').filter({hasText: marker});
				await expect(row).toBeVisible({timeout: 15_000});
				await expect(row).toContainText(badge);
			}
			for (const marker of absent) {
				await expect(authorPage.getByText(marker)).toHaveCount(0);
			}
		}
	});

	test('title search narrows the list; non-matching query shows the empty state', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('ads');
		await pkpApi.createSubmission(submittedSpec({tag, title: `SearchA-${tag}`}));
		await pkpApi.createSubmission(submittedSpec({tag, title: `SearchB-${tag}`}));

		await page.goto(mySubmissionsUrl({view: 'active'}));
		const search = page.locator('.pkpSearch__input');
		await expect(search).toBeVisible({timeout: 15_000});

		// The search component listens on keyup (debounced), so type the
		// phrase — fill() alone never fires the search. Single
		// whitespace-free token: searchPhrase OR-joins on spaces.
		await search.pressSequentially(`SearchA-${tag}`);
		await expect(
			page.getByRole('row').filter({hasText: `SearchA-${tag}`}),
		).toBeVisible({timeout: 15_000});
		await expect(page.getByText(`SearchB-${tag}`)).toHaveCount(0, {
			timeout: 15_000,
		});

		// Non-matching query: the table renders its empty state.
		await search.fill('');
		await search.pressSequentially(`none-${tag}`);
		await expect(page.getByText('No Items')).toBeVisible({timeout: 15_000});
		await expect(page.getByText(`SearchA-${tag}`)).toHaveCount(0);
	});

	test('author workflow view: status + files, no decision controls, no reviewer identities', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('adw');
		const {submission} = await pkpApi.createSubmission({
			tag,
			journal: 'publicknowledge',
			submitter: 'atester',
			section: 'ART',
			locale: 'en',
			participants: [{user: 'dbarnes', role: 'editor'}],
			decisions: [{type: 'sendExternalReview', by: 'dbarnes'}],
			reviewRounds: [
				{
					reviewers: [
						{user: 'phudson', method: 'anonymous', status: 'invited'},
						{user: 'jjanssen', method: 'anonymous', status: 'accepted'},
					],
				},
			],
			publications: [{metadata: {title: {en: `Authorview-${tag}`}}}],
		});

		await page.goto(mySubmissionsUrl({workflowSubmissionId: submission.id}));
		// The side-modal wrapper reports `visibility: hidden`; anchor on
		// the rendered content instead and use the wrapper for scoping.
		const modal = page.locator('[data-cy="active-modal"]').first();
		await expect(modal.getByText(`Authorview-${tag}`).first()).toBeVisible({
			timeout: 20_000,
		});

		// Review stage (the active stage) — the author config renders
		// the revisions file list and discussions...
		await expect(modal.getByText('Revisions Uploaded').first()).toBeVisible({
			timeout: 15_000,
		});
		await expect(
			modal.locator('[data-cy="discussion-manager"]'),
		).toBeAttached();

		// ...but no editorial decision controls...
		for (const decision of ['Request Revisions', 'Accept Submission', 'Decline Submission', 'Send for Review']) {
			await expect(
				modal.getByRole('button', {name: decision}),
			).toHaveCount(0);
		}
		// ...and no reviewer identities (none of the assigned reviewers
		// has a completed review, so the redacted reviewer panel is
		// absent entirely).
		await expect(modal.getByText('Julie Janssen')).toHaveCount(0);
		await expect(modal.getByText('Paul Hudson')).toHaveCount(0);

		// Submission-stage view: the workflow side nav entries render as
		// href-less links; switching to Submission shows the submission
		// files (incl. the seeded Article Text file).
		await modal
			.getByRole('link', {name: 'Submission', exact: true})
			.first()
			.click();
		await expect(modal.getByText('Submission Files').first()).toBeVisible({
			timeout: 15_000,
		});
		await expect(modal.getByText('default-article.pdf').first()).toBeVisible({
			timeout: 15_000,
		});
	});

	test('revisions-requested decision surfaces in the view, the row alert and the author workflow', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('adr');
		const note = `Please-revise-${tag}`;
		const {submission} = await pkpApi.createSubmission({
			tag,
			journal: 'publicknowledge',
			submitter: 'atester',
			section: 'ART',
			locale: 'en',
			participants: [{user: 'dbarnes', role: 'editor'}],
			decisions: [
				{type: 'sendExternalReview', by: 'dbarnes'},
				{type: 'requestRevisions', by: 'dbarnes', toAuthor: `<p>${note}</p>`},
			],
			reviewRounds: [
				{reviewers: [{user: 'jjanssen', method: 'anonymous', status: 'accepted'}]},
			],
			publications: [{metadata: {title: {en: `Revreq-${tag}`}}}],
		});

		// The "Revisions requested" view lists the submission with the
		// revision alert + upload action.
		await page.goto(mySubmissionsUrl({view: 'revisions-requested'}));
		await expect(
			page.getByRole('heading', {name: /Revisions requested/}),
		).toBeVisible({timeout: 15_000});
		await searchList(page, tag);
		const row = page.getByRole('row').filter({hasText: `Revreq-${tag}`});
		await expect(row).toBeVisible({timeout: 15_000});
		await expect(row).toContainText('Revision requested');
		await expect(row.getByRole('button', {name: 'Submit revisions'})).toBeVisible();

		// Author workflow view: revisions-requested state + the
		// editor's notification (the decision's notifyAuthors email is
		// logged and listed under Notifications; its body carries the
		// tagged message).
		await page.goto(mySubmissionsUrl({workflowSubmissionId: submission.id}));
		// (Side-modal wrapper reports `visibility: hidden`; anchor on
		// content.)
		const modal = page.locator('[data-cy="active-modal"]').first();
		await expect(
			modal.getByRole('button', {name: 'Upload revisions'}).first(),
		).toBeVisible({timeout: 20_000});
		await expect(
			modal.getByText('Revisions have been requested.').first(),
		).toBeVisible();

		// The decision's notifyAuthors email is logged and listed under
		// Notifications; opening it shows the editor's tagged message.
		// (The list entries are href-less anchors — no link role.)
		await expect(modal.getByText('Notifications').first()).toBeVisible({
			timeout: 15_000,
		});
		await modal
			.getByText(/requestRevisions — notify author/)
			.first()
			.click();
		// The email body opens in a stacked legacy side-modal; anchor on
		// the tagged message text.
		await expect(page.getByText(note).first()).toBeVisible({timeout: 15_000});
	});

	test('author cannot open someone else’s submission; the same URL works for its owner', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('ada');
		const {submission: mine} = await pkpApi.createSubmission(
			submittedSpec({tag, title: `Own-${tag}`}),
		);
		const {submission: other} = await pkpApi.createSubmission(
			submittedSpec({tag, title: `Foreign-${tag}`, submitter: 'svogt'}),
		);

		// Authorization error on the other author's submission (the
		// workflow modal's data fetch is rejected server-side; OJS's
		// PolicyAuthorizer middleware answers HTTP 401 with the
		// api.403.unauthorized message for authenticated-but-unauthorized
		// requests).
		const apiResponse = await page.request.get(
			`/index.php/publicknowledge/api/v1/submissions/${other.id}`,
		);
		expect(apiResponse.status()).toBe(401);
		// The error body carries either the generic api.403.unauthorized
		// message or the policy's authorization-message key
		// (user.authorization.roleBasedAccessDenied).
		expect(String((await apiResponse.json()).error)).toMatch(/authoriz/i);

		// The direct dashboard URL opens the workflow modal shell, but
		// the submission load is denied — the UI surfaces an explicit
		// Error dialog and the foreign submission's content never
		// renders.
		await page.goto(mySubmissionsUrl({workflowSubmissionId: other.id}));
		const errorDialog = page.getByRole('dialog', {name: 'Error'});
		await expect(errorDialog).toBeVisible({timeout: 20_000});
		await expect(errorDialog).toContainText(
			'The current role does not have access to this operation.',
		);
		await expect(page.getByText(`Foreign-${tag}`)).toHaveCount(0);

		// The same URL shape works for the owner (atester's own
		// submission opens with its content). Anchor on inner content —
		// the side-modal wrapper reports `visibility: hidden`.
		await page.goto(mySubmissionsUrl({workflowSubmissionId: mine.id}));
		const modal = page.locator('[data-cy="active-modal"]').first();
		await expect(modal.getByText(`Own-${tag}`).first()).toBeVisible({
			timeout: 20_000,
		});
	});
});
