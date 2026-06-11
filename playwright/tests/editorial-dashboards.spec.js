// @ts-check
const {test, expect} = require('../support/base-test.js');
const {DashboardPage} = require('../pages/DashboardPage.js');

/**
 * Editorial dashboards — docs/e2e/plans/editorial-dashboards.md (10 rows).
 *
 * The shared publicknowledge lists accumulate hundreds of rows under
 * parallel workers, so every list assertion is tag-scoped presence/absence
 * (search by the test's unique tag first) — never counts, never unscoped
 * page-1 membership. The reviewer dashboard's API ignores searchPhrase and
 * pagination (it returns every assignment), so there presence/absence is
 * asserted directly against the fully-rendered list.
 *
 * Seeding notes (verified against the live Processors):
 * - Omitting `submitted` seeds a submitted-shaped stage-1 row WITHOUT
 *   firing SubmissionSubmitted — so section editors are NOT auto-assigned
 *   and `participants` is the exact assignment list. That's what makes
 *   needs-editor (participants: []) and per-editor assignedTo filtering
 *   reachable on publicknowledge, whose ART/REV sections auto-assign
 *   their section editors on a real submit.
 * - Scenarios with decisions submit for real (auto-assign fires), which
 *   is fine for the stage/declined rows.
 */

function uniqueTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

/**
 * Stage-1 submission assigned to exactly `participants` (no submit event,
 * no section-editor auto-assignment).
 */
function stageOneSpec({tag, title, participants, submitter = 'atester', section = 'ART'}) {
	return {
		tag,
		journal: 'publicknowledge',
		submitter,
		section,
		locale: 'en',
		participants,
		publications: [{metadata: {title: {en: title}}}],
	};
}

test.describe('editor views', () => {
	test.use({user: 'dbarnes'});

	// Row 1
	test('editor sees an assigned submission in "Assigned to me" with stage label', {tag: '@smoke'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('edd1');
		await pkpApi.createSubmission(
			stageOneSpec({
				tag,
				title: `Vasg-${tag}`,
				participants: [{user: 'dbarnes', role: 'editor'}],
			}),
		);

		const dashboard = new DashboardPage(page);
		await dashboard.gotoEditorial({view: 'assigned-to-me'});
		await expect(dashboard.viewHeading(/Assigned to me/)).toBeVisible({
			timeout: 15_000,
		});

		await dashboard.search(tag);
		const row = dashboard.row(`Vasg-${tag}`);
		await expect(row).toBeVisible({timeout: 15_000});
		await expect(row).toContainText('Submission'); // stage bubble

		// The view menu renders with counts: the Assigned-to-me entry
		// carries a numeric badge (≥ 1 thanks to the seeded row; exact
		// numbers are unknowable on the shared DB).
		await expect(dashboard.navItem('Assigned to me')).toContainText(/\d/);
	});

	// Row 2
	test('stage views bucket submissions by workflow stage', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('edd2');
		const base = {
			tag,
			journal: 'publicknowledge',
			submitter: 'atester',
			section: 'ART',
			locale: 'en',
			participants: [{user: 'dbarnes', role: 'editor'}],
		};
		await pkpApi.createSubmission({
			...base,
			decisions: [{type: 'sendExternalReview', by: 'dbarnes'}],
			publications: [{metadata: {title: {en: `Vrev-${tag}`}}}],
		});
		await pkpApi.createSubmission({
			...base,
			decisions: [
				{type: 'sendExternalReview', by: 'dbarnes'},
				{type: 'accept', by: 'dbarnes'},
			],
			publications: [{metadata: {title: {en: `Vced-${tag}`}}}],
		});
		await pkpApi.createSubmission({
			...base,
			decisions: [
				{type: 'sendExternalReview', by: 'dbarnes'},
				{type: 'accept', by: 'dbarnes'},
				{type: 'sendToProduction', by: 'dbarnes'},
			],
			publications: [{metadata: {title: {en: `Vprd-${tag}`}}}],
		});

		const dashboard = new DashboardPage(page);
		const matrix = [
			{
				view: 'external-review',
				heading: /All in review stage/,
				present: `Vrev-${tag}`,
				stage: 'Review (Round 1)',
				absent: [`Vced-${tag}`, `Vprd-${tag}`],
			},
			{
				view: 'copyediting',
				heading: /All in copyediting stage/,
				present: `Vced-${tag}`,
				stage: 'Copyediting',
				absent: [`Vrev-${tag}`, `Vprd-${tag}`],
			},
			{
				view: 'production',
				heading: /All in production stage/,
				present: `Vprd-${tag}`,
				stage: 'Production',
				absent: [`Vrev-${tag}`, `Vced-${tag}`],
			},
		];

		for (const {view, heading, present, stage, absent} of matrix) {
			await dashboard.gotoEditorial({view});
			await expect(dashboard.viewHeading(heading)).toBeVisible({
				timeout: 15_000,
			});
			await dashboard.search(tag);
			const row = dashboard.row(present);
			await expect(row).toBeVisible({timeout: 15_000});
			await expect(row).toContainText(stage);
			for (const marker of absent) {
				await expect(page.getByText(marker)).toHaveCount(0);
			}
		}
	});

	// Row 4
	test('search finds a submission by unique tag and by ID', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tagA = uniqueTag('edd4a');
		const tagB = uniqueTag('edd4b');
		const {submission} = await pkpApi.createSubmission(
			stageOneSpec({
				tag: tagA,
				title: `SrchA-${tagA}`,
				participants: [{user: 'dbarnes', role: 'editor'}],
			}),
		);
		await pkpApi.createSubmission(
			stageOneSpec({
				tag: tagB,
				title: `SrchB-${tagB}`,
				participants: [{user: 'dbarnes', role: 'editor'}],
			}),
		);

		const dashboard = new DashboardPage(page);
		await dashboard.gotoEditorial({view: 'assigned-to-me'});

		// Tag search narrows the list to the tagged submission.
		await dashboard.search(tagA);
		await expect(dashboard.row(`SrchA-${tagA}`)).toBeVisible({
			timeout: 15_000,
		});
		await expect(page.getByText(`SrchB-${tagB}`)).toHaveCount(0, {
			timeout: 15_000,
		});

		// Numeric ID search resolves the same submission.
		await dashboard.search(String(submission.id));
		await expect(dashboard.row(`SrchA-${tagA}`)).toBeVisible({
			timeout: 15_000,
		});
		await expect(page).toHaveURL(new RegExp(`searchPhrase=${submission.id}`));

		// Clearing the search restores the unfiltered list: the control
		// submission (just seeded, so at the top of the date-sorted list)
		// reappears and the search phrase empties (the URL keeps an empty
		// searchPhrase= param behind).
		await dashboard.clearSearch();
		await expect(page).not.toHaveURL(
			new RegExp(`searchPhrase=${submission.id}`),
		);
		await expect(dashboard.searchInput).toHaveValue('');
		await expect(dashboard.row(`SrchB-${tagB}`)).toBeVisible({
			timeout: 15_000,
		});
	});

	// Row 5
	test('section filter narrows the list and survives reload', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('edd5');
		await pkpApi.createSubmission(
			stageOneSpec({
				tag,
				title: `Vart-${tag}`,
				section: 'ART',
				participants: [{user: 'dbarnes', role: 'editor'}],
			}),
		);
		await pkpApi.createSubmission(
			stageOneSpec({
				tag,
				title: `Vrws-${tag}`,
				section: 'REV',
				participants: [{user: 'dbarnes', role: 'editor'}],
			}),
		);

		const dashboard = new DashboardPage(page);
		await dashboard.gotoEditorial({view: 'assigned-to-me'});
		await dashboard.search(tag);
		await expect(dashboard.row(`Vart-${tag}`)).toBeVisible({timeout: 15_000});
		await expect(dashboard.row(`Vrws-${tag}`)).toBeVisible({timeout: 15_000});

		// Filter by the Articles section.
		await dashboard.openFilters();
		await dashboard.activeModal.getByLabel('Articles').check();
		await dashboard.applyFilters();

		// Active-filter chip + narrowed list + filter in the URL.
		await expect(dashboard.filterChip('Section', 'Articles')).toBeVisible({
			timeout: 15_000,
		});
		await expect(dashboard.row(`Vart-${tag}`)).toBeVisible({timeout: 15_000});
		await expect(page.getByText(`Vrws-${tag}`)).toHaveCount(0, {
			timeout: 15_000,
		});
		await expect(page).toHaveURL(/sectionIds/);

		// The filter persists in URL query params across reload.
		await page.reload();
		await expect(dashboard.filterChip('Section', 'Articles')).toBeVisible({
			timeout: 15_000,
		});
		await expect(dashboard.row(`Vart-${tag}`)).toBeVisible({timeout: 15_000});
		await expect(page.getByText(`Vrws-${tag}`)).toHaveCount(0);

		// Clear filters restores both rows (search stays applied).
		await dashboard.clearFiltersButton.click();
		await expect(dashboard.row(`Vrws-${tag}`)).toBeVisible({timeout: 15_000});
		await expect(dashboard.row(`Vart-${tag}`)).toBeVisible();
		await expect(page).not.toHaveURL(/sectionIds/);
	});

	// Row 10
	test('opening a row launches the workflow modal; closing returns to the filtered list', {tag: '@smoke'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('edd10');
		const {submission} = await pkpApi.createSubmission({
			tag,
			journal: 'publicknowledge',
			submitter: 'atester',
			section: 'ART',
			locale: 'en',
			participants: [{user: 'dbarnes', role: 'editor'}],
			decisions: [{type: 'sendExternalReview', by: 'dbarnes'}],
			publications: [{metadata: {title: {en: `Vwfl-${tag}`}}}],
		});

		const dashboard = new DashboardPage(page);
		await dashboard.gotoEditorial({view: 'external-review'});
		await dashboard.search(tag);
		const row = dashboard.row(`Vwfl-${tag}`);
		await expect(row).toBeVisible({timeout: 15_000});

		// Open the workflow modal from the row. (exact: true — the row also
		// carries an "Assign Re*view*ers" action that substring-matches.)
		await row.getByRole('button', {name: 'View', exact: true}).click();
		await expect(page).toHaveURL(
			new RegExp(`workflowSubmissionId=${submission.id}`),
		);
		// (The side-modal wrapper reports `visibility: hidden`; anchor on
		// inner content.)
		await expect(
			dashboard.activeModal.getByText(`Vwfl-${tag}`).first(),
		).toBeVisible({timeout: 20_000});

		// Close the modal: back on the dashboard with view + search intact.
		await dashboard.activeModal.getByRole('button', {name: 'Close'}).click();
		await expect(page).not.toHaveURL(/workflowSubmissionId=/);
		await expect(page).toHaveURL(/currentViewId=external-review/);
		await expect(page).toHaveURL(new RegExp(`searchPhrase=${tag}`));
		await expect(dashboard.row(`Vwfl-${tag}`)).toBeVisible({timeout: 15_000});
	});
});

test.describe('admin views', () => {
	test.use({user: 'admin'});

	// Row 3
	test('unassigned submission shows in "Needs editor" for admin, hidden from unassigned section editor', {tag: '@regression'}, async ({page, pkpApi, asUser}) => {
		const tag = uniqueTag('edd3');
		await pkpApi.createSubmission(
			stageOneSpec({tag, title: `Vneed-${tag}`, participants: []}),
		);

		const dashboard = new DashboardPage(page);

		// Admin: the needs-editor view exists and lists the submission...
		await dashboard.gotoEditorial({view: 'needs-editor'});
		await expect(dashboard.viewHeading(/Needs editor/)).toBeVisible({
			timeout: 15_000,
		});
		await dashboard.search(tag);
		await expect(dashboard.row(`Vneed-${tag}`)).toBeVisible({timeout: 15_000});

		// ...and the Active view (all queued submissions) includes it too.
		await dashboard.gotoEditorial({view: 'active'});
		await expect(dashboard.viewHeading(/Active submissions/)).toBeVisible({
			timeout: 15_000,
		});
		await dashboard.search(tag);
		await expect(dashboard.row(`Vneed-${tag}`)).toBeVisible({timeout: 15_000});

		// dbuskins (section editor, not assigned): no needs-editor view in
		// the menu, and the Active view is assigned-only — the submission
		// is absent ("No Items" bounds the negative).
		const sectionEditorCtx = await asUser('dbuskins');
		const sectionEditorPage = await sectionEditorCtx.newPage();
		const sectionEditorDashboard = new DashboardPage(sectionEditorPage);
		await sectionEditorDashboard.gotoEditorial({view: 'active'});
		await expect(
			sectionEditorDashboard.viewHeading(/Active submissions/),
		).toBeVisible({timeout: 15_000});
		await expect(
			sectionEditorDashboard.nav.getByText('Needs editor'),
		).toHaveCount(0);
		await sectionEditorDashboard.search(tag);
		await expect(sectionEditorPage.getByText('No Items')).toBeVisible({
			timeout: 15_000,
		});
		await expect(sectionEditorPage.getByText(`Vneed-${tag}`)).toHaveCount(0);
	});

	// Row 6
	test('admin filters Active view by assigned editor', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('edd6');
		await pkpApi.createSubmission(
			stageOneSpec({
				tag,
				title: `Vbus-${tag}`,
				participants: [{user: 'dbuskins', role: 'sectionEditor'}],
			}),
		);
		await pkpApi.createSubmission(
			stageOneSpec({
				tag,
				title: `Vino-${tag}`,
				section: 'REV',
				participants: [{user: 'minoue', role: 'sectionEditor'}],
			}),
		);

		const dashboard = new DashboardPage(page);
		await dashboard.gotoEditorial({view: 'active'});
		await dashboard.search(tag);
		await expect(dashboard.row(`Vbus-${tag}`)).toBeVisible({timeout: 15_000});
		await expect(dashboard.row(`Vino-${tag}`)).toBeVisible({timeout: 15_000});

		// Pick dbuskins in the Assigned To Editor autosuggest.
		await dashboard.openFilters();
		const assignedTo = dashboard.activeModal.getByLabel('Assigned To Editor');
		await assignedTo.click();
		await assignedTo.pressSequentially('Buskins');
		await dashboard.activeModal
			.getByRole('option', {name: /Buskins/})
			.click();
		await dashboard.applyFilters();

		// Only dbuskins' tagged submission survives the filter.
		await expect(
			dashboard.filterChip('Assigned To Editor', 'David Buskins'),
		).toBeVisible({timeout: 15_000});
		await expect(dashboard.row(`Vbus-${tag}`)).toBeVisible({timeout: 15_000});
		await expect(page.getByText(`Vino-${tag}`)).toHaveCount(0, {
			timeout: 15_000,
		});
		await expect(page).toHaveURL(/assignedTo/);
	});

	// Row 7. The Declined view is offered to admins/managers (and authors
	// on mySubmissions) only — section editors like dbarnes get no
	// Declined view — so the editorial-side check runs as admin.
	test('declined submission moves to the Declined view', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('edd7');
		await pkpApi.createSubmission({
			tag,
			journal: 'publicknowledge',
			submitter: 'atester',
			section: 'ART',
			locale: 'en',
			participants: [{user: 'dbarnes', role: 'editor'}],
			decisions: [{type: 'initialDecline', by: 'dbarnes'}],
			publications: [{metadata: {title: {en: `Vdcl-${tag}`}}}],
		});

		const dashboard = new DashboardPage(page);

		// Absent from Active ("No Items" bounds the negative)...
		await dashboard.gotoEditorial({view: 'active'});
		await dashboard.search(tag);
		await expect(page.getByText('No Items')).toBeVisible({timeout: 15_000});
		await expect(page.getByText(`Vdcl-${tag}`)).toHaveCount(0);

		// ...present in Declined with the declined status label.
		await dashboard.gotoEditorial({view: 'declined'});
		await expect(dashboard.viewHeading(/Declined/)).toBeVisible({
			timeout: 15_000,
		});
		await dashboard.search(tag);
		const row = dashboard.row(`Vdcl-${tag}`);
		await expect(row).toBeVisible({timeout: 15_000});
		await expect(row).toContainText('Declined');
	});
});

test.describe('reviewer dashboard', () => {
	test.use({user: 'jjanssen'});

	// Row 8. The reviewer assignments endpoint ignores searchPhrase and
	// pagination (it returns the reviewer's full list), so rows are
	// asserted against the fully-rendered list: the tagged positive row
	// bounds the fetch before any absence assertion.
	test('reviewer dashboard buckets assignments by state', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('edd8');
		const base = {
			tag,
			journal: 'publicknowledge',
			submitter: 'atester',
			section: 'ART',
			locale: 'en',
			participants: [{user: 'dbarnes', role: 'editor'}],
			decisions: [{type: 'sendExternalReview', by: 'dbarnes'}],
		};
		await pkpApi.createSubmission({
			...base,
			reviewRounds: [
				{reviewers: [{user: 'jjanssen', method: 'anonymous', status: 'invited'}]},
			],
			publications: [{metadata: {title: {en: `Vinv-${tag}`}}}],
		});
		await pkpApi.createSubmission({
			...base,
			reviewRounds: [
				{
					reviewers: [
						{
							user: 'jjanssen',
							method: 'anonymous',
							status: 'completed',
							recommendation: 'accept',
						},
					],
				},
			],
			publications: [{metadata: {title: {en: `Vcmp-${tag}`}}}],
		});

		const dashboard = new DashboardPage(page);

		// Invited assignment sits under Action Required with the
		// respond-by deadline (the response due date).
		await dashboard.gotoReviewAssignments({view: 'reviewer-action-required'});
		await expect(dashboard.viewHeading(/Action Required by me/)).toBeVisible({
			timeout: 15_000,
		});
		const invitedRow = dashboard.row(`Vinv-${tag}`);
		await expect(invitedRow).toBeVisible({timeout: 30_000});
		await expect(invitedRow).toContainText(
			/Please accept or decline this request by .+/,
		);
		await expect(page.getByText(`Vcmp-${tag}`)).toHaveCount(0);

		// Completed assignment sits under Completed with its submit date.
		await dashboard.gotoReviewAssignments({
			view: 'reviewer-assignments-completed',
		});
		await expect(dashboard.viewHeading(/Completed/)).toBeVisible({
			timeout: 15_000,
		});
		const completedRow = dashboard.row(`Vcmp-${tag}`);
		await expect(completedRow).toBeVisible({timeout: 30_000});
		await expect(completedRow).toContainText(/Review submitted on .+/);
		await expect(page.getByText(`Vinv-${tag}`)).toHaveCount(0);
	});
});

test.describe('role gating', () => {
	test.use({user: 'atester'});

	// Row 9
	test('dashboard pages are role-gated', {tag: '@regression'}, async ({page, asUser}) => {
		const dashboard = new DashboardPage(page);

		// Author: denied the editorial dashboard (redirect to the
		// authorization-denied page)...
		await dashboard.gotoEditorial();
		await expect(page).toHaveURL(/authorizationDenied/);
		await expect(
			page.getByText('The current role does not have access to this operation.'),
		).toBeVisible({timeout: 15_000});

		// ...but reaches mySubmissions.
		await dashboard.gotoMySubmissions({view: 'active'});
		await expect(dashboard.viewHeading(/Active submissions/)).toBeVisible({
			timeout: 15_000,
		});

		// Reviewer-only user: denied editorial, reaches reviewAssignments.
		const reviewerCtx = await asUser('phudson');
		const reviewerPage = await reviewerCtx.newPage();
		const reviewerDashboard = new DashboardPage(reviewerPage);
		await reviewerDashboard.gotoEditorial();
		await expect(reviewerPage).toHaveURL(/authorizationDenied/);
		await reviewerDashboard.gotoReviewAssignments();
		await expect(
			reviewerDashboard.viewHeading(/Action Required by me/),
		).toBeVisible({timeout: 15_000});
	});
});
