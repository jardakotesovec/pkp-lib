// @ts-check
const {test, expect} = require('../support/base-test.js');
const {DashboardPage} = require('../pages/DashboardPage.js');
const {LoginPage} = require('../pages/LoginPage.js');
const {ReviewerSubmissionPage} = require('../pages/ReviewerSubmissionPage.js');

/**
 * Editorial dashboards (Editor Dashboard + My Assignments as Reviewer,
 * plus the shared list machinery) — one test per canonical scenario of
 * docs/product/specs/editorial-dashboards.md (10 scenarios → 10 tests).
 * The dashboards are pkp-lib surfaces (lib/ui-library dashboard page +
 * PKPDashboardHandler), so the spec lives here — mirroring
 * author-dashboard.spec.js; scenario payloads use OJS vocabulary
 * (sections ART/REV) matching the app the suite runs against.
 *
 * Coverage per scenario:
 *   s1  manager triage: landing view "Assigned to me", the manager's 15
 *       sidebar views in fixed order with counts, "Active submissions"
 *       heading + count, unassigned rows included, the six columns, row
 *       anatomy (ID / authors—title / stage bubble / days / activity /
 *       View), View opens the workflow panel over the list and closing
 *       returns to the refreshed list
 *   s2  section-editor scoping: Active = own two assignments only, the
 *       13-view sidebar (no Needs editor / Declined), Filters panel
 *       without "Assigned To Editor", scope beats search (an unassigned
 *       submission's title finds nothing; an assigned one is found)
 *   s3  needs-editor lifecycle: count rises with a new unassigned
 *       submission; the row's "Assign Editor" opens the Assign
 *       Participant dialog over the list; assigning a Section editor
 *       removes the row and drops the badge without a reload
 *   s4  search semantics: author family name narrows the view (heading
 *       count follows), a bare number finds that submission id, clear
 *       restores, the same phrase on "All in copyediting stage" matches
 *       only copyediting rows — search never leaves the view
 *   s5  filters & the reset trap: Section chip narrows / removing it
 *       re-widens; Section + Days-30 chips narrow to nothing; a view
 *       switch clears the search box but ⚠ both chips survive and keep
 *       filtering (AD-G, ledger §2 row 201); Clear Filters recovers
 *   s6  multi-role guard: a manager-author's own row shows the
 *       noAccessBeingAuthor explanation and no View; with an
 *       editorial-capacity (Journal editor) assignment the same summary
 *       is replaced by the normal cell and View returns
 *   s7  reviewer queue: reviewer-only login lands on "Action Required
 *       by me"; invited row (respond-by line + Respond to request →
 *       request step) and accepted row (complete-by line + Finish
 *       review → mid-review); genuinely submitting the review moves the
 *       row out of Action Required, keeps it in All assignments and
 *       lands it under Completed with "Review submitted on {date}" +
 *       View
 *   s8  reviewer history: Declined ("Request declined on {date}", no
 *       button), Published (a finished review whose submission was
 *       published — gone from Completed), Archived (never-finished on a
 *       moved-on submission: the word "Incomplete", no button, absent
 *       from All assignments too); ⚠ the list controls render but the
 *       reviewer lists ignore them (ledger §2 row 2) — search / filter
 *       chip / ID sort change nothing
 *   s9  dashboards match hats: nav sections per role family, address
 *       access denied cross-role ("The current role does not have
 *       access to this operation."), role-priority landing (editorial →
 *       reviewer → author), and a dual-hat user's two pages each showing
 *       only that hat's rows
 *   s10 the address is the state: view + section chip + phrase + open
 *       workflow panel restored for a colleague from the copied URL,
 *       login-first for a signed-out recipient, and the invalid-view
 *       fallback (silent "Assigned to me", corrected address, search
 *       dropped, ⚠ chip kept — AD-G again)
 *
 * As-built deviations the suite records but does NOT walk here (no
 * canonical scenario reaches them — see the spec's Known deviations):
 *  - "Assigned To Editor" inert on assigned/review-state views
 *    (proposed ledger row 204) — no scenario applies that filter;
 *  - the Journal-manager-group assignment NOT lifting the multi-role
 *    guard (proposed row 205) — s6 walks the Journal-editor-group lift;
 *  - the unenrolled site admin's degraded viewless page (proposed row
 *    206) and the legacy tasks-popup 500 (row 67) — no scenario.
 *
 * Parallel-safety: every test runs on its own scratch journal with
 * throwaway users (counts and view badges are exact, and no seeded user
 * gains roles anywhere); tags are single hyphenless alphanumeric tokens
 * riding in titles/family names; no Mailpit reads. The dashboard search
 * is TYPED (pressSequentially) never fill()ed — programmatic fill
 * desyncs the store (DashboardPage.search does this). While a
 * deep-linked workflow panel is open the background list stays in its
 * initial Loading state, so list assertions happen only after closing
 * the panel.
 */

const TITLE = {
	editorial: 'Editor Dashboard',
	reviewer: 'My Assignments as Reviewer',
	author: 'My Submissions as Author',
};

/** A unique, hyphenless, alphanumeric tag (parallel isolation). */
function uniqueTag(prefix = 'edd') {
	const workerLetter = String.fromCharCode(
		97 + (test.info().parallelIndex % 26),
	);
	let suffix = '';
	while (suffix.length < 6) {
		suffix += Math.random().toString(36).replace(/[^a-z0-9]/g, '');
	}
	return `${prefix}${workerLetter}${suffix.slice(0, 6)}`;
}

/** A throwaway scratch-journal user spec (password rule: username×2). */
function throwawayUser(username, givenName, familyName, roles) {
	return {
		username,
		password: username + username,
		email: `${username}@mailinator.com`,
		givenName,
		familyName,
		roles,
	};
}

/**
 * Two sections so the Filters panel renders its Section field (hidden
 * on single-section journals — Fields & validation).
 */
function twoSections() {
	return [
		{abbrev: {en: 'ART'}, title: {en: 'Articles'}},
		{abbrev: {en: 'REV'}, title: {en: 'Reviews'}, abstractsNotRequired: true},
	];
}

/**
 * Scenario spec for a submission. Omitting `submitted` keeps the
 * legacy submitted shape WITHOUT firing AssignEditors — the genuine
 * needs-editor state when no participants are given.
 */
function submissionSpec({
	tag,
	title,
	journal,
	submitter,
	section = 'ART',
	participants,
	decisions,
	reviewRounds,
	publication,
	submitted,
}) {
	return {
		tag,
		journal,
		submitter,
		section,
		locale: 'en',
		...(submitted === undefined ? {} : {submitted}),
		...(participants ? {participants} : {}),
		...(decisions ? {decisions} : {}),
		...(reviewRounds ? {reviewRounds} : {}),
		publications: [
			{
				versionStage: 'AO',
				published: false,
				metadata: {
					title: {en: title},
					abstract: {en: `<p>Abstract for ${tag}.</p>`},
				},
				...(publication ?? {}),
			},
		],
	};
}

/** The workflow side modal the View button opens over the list. */
function workflowModal(page) {
	return page.locator('[data-cy="active-modal"]').first();
}

/** Open a row's workflow panel via its Actions "View" button. */
async function openRowView(dash, marker) {
	await dash
		.row(marker)
		.getByRole('button', {name: 'View', exact: true})
		.click();
	await expect(workflowModal(dash.page)).toContainText(marker, {
		timeout: 20_000,
	});
}

/** Close the workflow panel (side modal header close button). */
async function closeWorkflow(page) {
	await workflowModal(page)
		.getByRole('button', {name: 'Close', exact: true})
		.first()
		.click();
}

/**
 * A row's Editorial Activity cell on the EDITOR dashboard. The ID
 * column renders as the row header, so the <td> cells are Submissions /
 * Stage / Days / Editorial Activity / Actions — activity is the fourth.
 */
function activityCell(row) {
	return row.getByRole('cell').nth(3);
}

/** A fresh, genuinely-anonymous context (test.use user would leak in). */
async function anonymousPage(browser, baseURL) {
	const ctx = await browser.newContext({
		baseURL,
		storageState: {cookies: [], origins: []},
	});
	return {ctx, page: await ctx.newPage()};
}

test.describe('Editorial dashboards', () => {
	test('s1: A Journal Manager triages the journal — landing view, the 15 sidebar views with counts, row anatomy, the workflow panel over the list', async ({
		asUser,
		pkpApi,
	}) => {
		test.slow(); // scratch journal + 2 seeds + panel round-trip
		const tag = uniqueTag('edda');
		const mg = `mg${tag}`;
		const au = `au${tag}`;
		const {context} = await pkpApi.createJournal({
			tag,
			users: [
				throwawayUser(mg, 'Mona', 'Manager', ['manager']),
				throwawayUser(au, 'Tara', 'Triage', ['author']),
			],
		});
		const journalPath = context.path;
		const titleU = `Unassigned ${tag}u`;
		const titleB = `Second ${tag}b`;
		const {submission: subU} = await pkpApi.createSubmission(
			submissionSpec({tag: `${tag}u`, title: titleU, journal: journalPath, submitter: au}),
		);
		await pkpApi.createSubmission(
			submissionSpec({tag: `${tag}b`, title: titleB, journal: journalPath, submitter: au}),
		);

		const ctx = await asUser(mg);
		const page = await ctx.newPage();
		const dash = new DashboardPage(page, {journal: journalPath});

		// Opening the dashboard without naming a view lands on the first
		// view, "Assigned to me" (rule 8).
		await dash.gotoEditorial();
		await expect(dash.viewHeading('Assigned to me (0)')).toBeVisible({
			timeout: 20_000,
		});

		// The manager's full editorial view set, in rule 4's fixed order,
		// each with its (clean-slate exact) count badge.
		await expect(dash.viewLinks('editorial')).toHaveText([
			/^\s*0\s*Assigned to me/,
			/^\s*2\s*Active submissions/,
			/^\s*2\s*Needs editor/,
			/^\s*2\s*All in submission stage/,
			/^\s*0\s*Needs reviews/,
			/^\s*0\s*Awaiting reviews/,
			/^\s*0\s*Reviews submitted/,
			/^\s*0\s*Reviews overdue/,
			/^\s*0\s*Author revisions submitted/,
			// ⚠ SPEC CONTRADICTION (reported): rule 4 labels this view
			// "All in peer review" (submission.dashboard.view.reviewExternal)
			// but as-built TYPE_REVIEW_EXTERNAL renders
			// submission.dashboard.view.reviewAll = "All in review stage"
			// (lib/pkp/classes/submission/Repository.php mapDashboardViews).
			/^\s*0\s*All in review stage/,
			/^\s*0\s*All in copyediting stage/,
			/^\s*0\s*All in production stage/,
			/^\s*0\s*Scheduled for publication/,
			/^\s*0\s*Published/,
			/^\s*0\s*Declined/,
		]);

		// "Active submissions": heading = name + shown count (rule 7), the
		// whole journal including unassigned rows (rule 5).
		await dash.navItem('Active submissions').click();
		await expect(dash.viewHeading('Active submissions (2)')).toBeVisible();

		// The six columns of the editor table (rule 14).
		await expect(dash.page.getByRole('columnheader')).toHaveText([
			/ID/,
			/Submissions/,
			/Stage/,
			/Days/,
			/Editorial Activity/,
			/Actions/,
		]);

		// Row anatomy: ID, authors — title, stage bubble, days since last
		// activity, a next-step Editorial Activity ("Assign Editor" on an
		// unassigned row) and the View button (rule 14).
		const row = dash.row(titleU);
		await expect(row).toBeVisible();
		await expect(row).toContainText(String(subU.id));
		await expect(row).toContainText('Triage'); // the author's name
		await expect(row.getByText('Submission', {exact: true})).toBeVisible(); // stage bubble
		await expect(row.getByRole('cell').nth(2)).toHaveText(/^\d+$/); // days
		await expect(
			activityCell(row).getByRole('button', {name: 'Assign Editor'}),
		).toBeVisible();

		// View slides the workflow open over the list; closing returns to
		// the same list, refreshed (rule 13 / Side effects).
		await openRowView(dash, titleU);
		const refetched = page.waitForResponse(
			(r) => r.url().includes('/_submissions') && r.ok(),
			{timeout: 20_000},
		);
		await closeWorkflow(page);
		await refetched;
		await expect(dash.viewHeading('Active submissions (2)')).toBeVisible({
			timeout: 20_000,
		});
		await expect(dash.row(titleU)).toBeVisible();
		await expect(dash.row(titleB)).toBeVisible();
	});

	test('s2: A Section Editor sees only their own desk — scoped views, 13-view sidebar, no Assigned To Editor filter, scope beats search', async ({
		asUser,
		pkpApi,
	}) => {
		test.slow(); // scratch journal + 4 seeds
		const tag = uniqueTag('eddb');
		const se = `se${tag}`;
		const au = `au${tag}`;
		const {context} = await pkpApi.createJournal({
			tag,
			sections: twoSections(),
			users: [
				throwawayUser(se, 'Sonia', 'Sectioneditor', ['sectionEditor']),
				throwawayUser(au, 'Aldo', 'Author', ['author']),
			],
		});
		const journalPath = context.path;
		const mine = [`Mydesk ${tag}a`, `Mydesk ${tag}b`];
		for (const [i, title] of mine.entries()) {
			await pkpApi.createSubmission(
				submissionSpec({
					tag: `${tag}m${i}`,
					title,
					journal: journalPath,
					submitter: au,
					participants: [{user: se, role: 'sectionEditor'}],
				}),
			);
		}
		const foreignTitle = `Foreign ${tag}c`;
		await pkpApi.createSubmission(
			submissionSpec({
				tag: `${tag}c`,
				title: foreignTitle,
				journal: journalPath,
				submitter: au,
			}),
		);

		const ctx = await asUser(se);
		const page = await ctx.newPage();
		const dash = new DashboardPage(page, {journal: journalPath});
		await dash.gotoEditorial({view: 'active'});

		// "Active submissions" is scoped to their own editorial-capacity
		// assignments: exactly the two, never the unassigned one (rule 5).
		await expect(dash.viewHeading('Active submissions (2)')).toBeVisible({
			timeout: 20_000,
		});
		await expect(dash.row(mine[0])).toBeVisible();
		await expect(dash.row(mine[1])).toBeVisible();
		await expect(dash.row(foreignTitle)).toHaveCount(0);

		// The Section Editor sidebar: 13 views — no "Needs editor", no
		// "Declined" (rules 4 and 6).
		await expect(dash.viewLinks('editorial')).toHaveText([
			/^\s*2\s*Assigned to me/,
			/^\s*2\s*Active submissions/,
			/^\s*2\s*All in submission stage/,
			/^\s*0\s*Needs reviews/,
			/^\s*0\s*Awaiting reviews/,
			/^\s*0\s*Reviews submitted/,
			/^\s*0\s*Reviews overdue/,
			/^\s*0\s*Author revisions submitted/,
			// "All in review stage" — as-built label, see s1's note.
			/^\s*0\s*All in review stage/,
			/^\s*0\s*All in copyediting stage/,
			/^\s*0\s*All in production stage/,
			/^\s*0\s*Scheduled for publication/,
			/^\s*0\s*Published/,
		]);

		// The Filters panel offers Section and Days — but no "Assigned To
		// Editor" field (manager/admin only — Fields & validation).
		await dash.openFilters();
		await expect(
			dash.activeModal.getByRole('checkbox', {name: 'Articles'}),
		).toBeVisible({timeout: 15_000});
		await expect(
			dash.activeModal.getByText('Days since last activity'),
		).toBeVisible();
		await expect(
			dash.activeModal.getByText('Assigned To Editor'),
		).toHaveCount(0);
		await page.keyboard.press('Escape');
		await expect(
			dash.activeModal.getByText('Days since last activity'),
		).toBeHidden({timeout: 15_000});

		// Scope beats search (rule 9): the unassigned submission's exact
		// title finds nothing; an assigned one's title is found (control).
		await dash.search(foreignTitle);
		await expect(dash.viewHeading('Active submissions (0)')).toBeVisible({
			timeout: 20_000,
		});
		await expect(page.getByText('No Items')).toBeVisible();
		// Positive control: an assigned submission's unique title token IS
		// found (the phrase OR-splits on whitespace, so search by the
		// row's unique token rather than the two-word title).
		await dash.search(`${tag}a`);
		await expect(dash.viewHeading('Active submissions (1)')).toBeVisible({
			timeout: 20_000,
		});
		await expect(dash.row(mine[0])).toBeVisible();
	});

	test('s3: Needs editor, cleared by assigning — the count rises, Assign Editor opens the participant form over the list, assigning empties the view', async ({
		asUser,
		pkpApi,
	}) => {
		test.slow(); // scratch journal + mid-test seed + legacy form
		const tag = uniqueTag('eddc');
		const mg = `mg${tag}`;
		const se = `se${tag}`;
		const au = `au${tag}`;
		const {context} = await pkpApi.createJournal({
			tag,
			users: [
				throwawayUser(mg, 'Marta', 'Managing', ['manager']),
				throwawayUser(se, 'Selma', 'Assignee', ['sectionEditor']),
				throwawayUser(au, 'Astrid', 'Newcomer', ['author']),
			],
		});
		const journalPath = context.path;

		const ctx = await asUser(mg);
		const page = await ctx.newPage();
		const dash = new DashboardPage(page, {journal: journalPath});
		await dash.gotoEditorial();
		await expect(dash.navItem('Needs editor')).toHaveText(
			/^\s*0\s*Needs editor/,
			{timeout: 20_000},
		);

		// An author submits a new manuscript; the count rises by one.
		const title = `Fresh manuscript ${tag}`;
		await pkpApi.createSubmission(
			submissionSpec({tag, title, journal: journalPath, submitter: au}),
		);
		await dash.gotoEditorial({view: 'needs-editor'});
		await expect(dash.navItem('Needs editor')).toHaveText(
			/^\s*1\s*Needs editor/,
			{timeout: 20_000},
		);
		await expect(dash.viewHeading('Needs editor (1)')).toBeVisible();

		// The row's Editorial Activity offers "Assign Editor"; it opens the
		// participant-assignment form right over the list (rule 14).
		const row = dash.row(title);
		await activityCell(row)
			.getByRole('button', {name: 'Assign Editor'})
			.click();
		const modal = page.getByRole('dialog', {name: 'Assign Participant'});
		await expect(modal).toBeVisible({timeout: 15_000});
		const form = modal.locator('#addParticipantForm').last();
		await expect(form).toBeVisible({timeout: 15_000});

		// Assign the Section editor.
		await form
			.locator('select[name="filterUserGroupId"]')
			.selectOption({label: 'Section editor'});
		await form.locator('input[name="name"]').fill('Assignee');
		await form.getByRole('button', {name: 'Search', exact: true}).click();
		const userRow = modal.locator('tr', {hasText: 'Selma Assignee'}).first();
		await expect(userRow).toBeVisible({timeout: 15_000});
		await userRow.locator('input[name="userId"]').check();
		await modal.getByRole('button', {name: 'OK', exact: true}).click();
		await expect(modal).toBeHidden({timeout: 20_000});

		// The list refreshes without a reload: the submission has left
		// "Needs editor" and the sidebar count drops (Side effects).
		await expect(dash.row(title)).toHaveCount(0, {timeout: 20_000});
		await expect(dash.viewHeading('Needs editor (0)')).toBeVisible({
			timeout: 20_000,
		});
		await expect(dash.navItem('Needs editor')).toHaveText(
			/^\s*0\s*Needs editor/,
			{timeout: 20_000},
		);
	});

	test('s4: Search within a view — family name narrows, a bare number finds the ID, clearing restores, and search never leaves the view', async ({
		asUser,
		pkpApi,
	}) => {
		test.slow(); // scratch journal + 3 seeds incl. a copyediting chain
		const tag = uniqueTag('eddd');
		const mg = `mg${tag}`;
		const ed = `ed${tag}`;
		const aa = `aa${tag}`;
		const ab = `ab${tag}`;
		const famA = `Fam${tag}`;
		const {context} = await pkpApi.createJournal({
			tag,
			users: [
				throwawayUser(mg, 'Magda', 'Searcher', ['manager']),
				throwawayUser(ed, 'Edgar', 'Editor', ['editor']),
				throwawayUser(aa, 'Alba', famA, ['author']),
				// NB: must not CONTAIN `Fam${tag}` — the search matches by
				// substring, so a "Bfam…" name would match the famA phrase.
				throwawayUser(ab, 'Bruno', `Other${tag}`, ['author']),
			],
		});
		const journalPath = context.path;
		const titleA1 = `Alpha ${tag}p1`;
		const titleA2 = `Copyedit ${tag}p2`;
		const titleB = `Beta ${tag}p3`;
		await pkpApi.createSubmission(
			submissionSpec({tag: `${tag}p1`, title: titleA1, journal: journalPath, submitter: aa}),
		);
		await pkpApi.createSubmission(
			submissionSpec({
				tag: `${tag}p2`,
				title: titleA2,
				journal: journalPath,
				submitter: aa,
				participants: [{user: ed, role: 'editor'}],
				decisions: [
					{type: 'sendExternalReview', by: ed},
					{type: 'accept', by: ed},
				],
				reviewRounds: [{reviewers: []}],
			}),
		);
		const {submission: subB} = await pkpApi.createSubmission(
			submissionSpec({tag: `${tag}p3`, title: titleB, journal: journalPath, submitter: ab}),
		);

		const ctx = await asUser(mg);
		const page = await ctx.newPage();
		const dash = new DashboardPage(page, {journal: journalPath});
		await dash.gotoEditorial({view: 'active'});
		await expect(dash.viewHeading('Active submissions (3)')).toBeVisible({
			timeout: 20_000,
		});

		// The search box carries the canonical label (Fields & validation).
		await expect(dash.searchInput).toHaveAttribute(
			'placeholder',
			'Search submissions, ID, authors, keywords, etc.',
		);

		// An author family name narrows to that author's submissions and
		// the heading count shrinks to match (rules 7 and 9).
		await dash.search(famA);
		await expect(dash.viewHeading('Active submissions (2)')).toBeVisible({
			timeout: 20_000,
		});
		await expect(dash.row(titleA1)).toBeVisible();
		await expect(dash.row(titleA2)).toBeVisible();
		await expect(dash.row(titleB)).toHaveCount(0);

		// A bare submission number finds that exact submission (rule 9).
		await dash.search(String(subB.id));
		await expect(dash.viewHeading('Active submissions (1)')).toBeVisible({
			timeout: 20_000,
		});
		await expect(dash.row(titleB)).toBeVisible();

		// Clearing the phrase restores the full view.
		await dash.clearSearch();
		await expect(dash.viewHeading('Active submissions (3)')).toBeVisible({
			timeout: 20_000,
		});

		// The same phrase on "All in copyediting stage" matches only
		// copyediting submissions — search never leaves the view (rule 9).
		await dash.gotoEditorial({view: 'copyediting'});
		await expect(
			dash.viewHeading('All in copyediting stage (1)'),
		).toBeVisible({timeout: 20_000});
		await dash.search(famA);
		await expect(
			dash.viewHeading('All in copyediting stage (1)'),
		).toBeVisible({timeout: 20_000});
		await expect(dash.row(titleA2)).toBeVisible();
		await expect(dash.row(titleA1)).toHaveCount(0);
	});

	test('s5: Filters and the reset trap — chips narrow and re-widen; a view switch clears the search but ⚠ the chips survive and keep filtering (AD-G)', async ({
		asUser,
		pkpApi,
	}) => {
		test.slow(); // scratch journal + filter panel round-trips
		const tag = uniqueTag('edde');
		const mg = `mg${tag}`;
		const au = `au${tag}`;
		const {context} = await pkpApi.createJournal({
			tag,
			sections: twoSections(),
			users: [
				throwawayUser(mg, 'Mira', 'Filtering', ['manager']),
				throwawayUser(au, 'Anka', 'Writer', ['author']),
			],
		});
		const journalPath = context.path;
		const artTitle = `Artone ${tag}a`;
		const revTitle = `Revone ${tag}b`;
		await pkpApi.createSubmission(
			submissionSpec({tag: `${tag}a`, title: artTitle, journal: journalPath, submitter: au, section: 'ART'}),
		);
		await pkpApi.createSubmission(
			submissionSpec({tag: `${tag}b`, title: revTitle, journal: journalPath, submitter: au, section: 'REV'}),
		);

		const ctx = await asUser(mg);
		const page = await ctx.newPage();
		const dash = new DashboardPage(page, {journal: journalPath});
		await dash.gotoEditorial({view: 'active'});
		await dash.search(tag);
		await expect(dash.viewHeading('Active submissions (2)')).toBeVisible({
			timeout: 20_000,
		});

		// A Section filter narrows the list to the ticked section and
		// renders a removable chip (rule 10).
		await dash.openFilters();
		await dash.activeModal.getByRole('checkbox', {name: 'Articles'}).check();
		await dash.applyFilters();
		await expect(dash.filterChip('Section', 'Articles')).toBeVisible({
			timeout: 15_000,
		});
		await expect(dash.viewHeading('Active submissions (1)')).toBeVisible({
			timeout: 20_000,
		});
		await expect(dash.row(artTitle)).toBeVisible();
		await expect(dash.row(revTitle)).toHaveCount(0);

		// Removing the chip re-runs the list without it — re-widened.
		await dash.filterChip('Section', 'Articles').click();
		await expect(dash.viewHeading('Active submissions (2)')).toBeVisible({
			timeout: 20_000,
		});
		await expect(dash.row(revTitle)).toBeVisible();

		// Section + "Days since last activity" at 30: two chips, and the
		// list narrows (both seeds are fresh, so >30 days matches none).
		await dash.openFilters();
		await dash.activeModal.getByRole('checkbox', {name: 'Articles'}).check();
		const slider = dash.activeModal.getByRole('slider');
		await expect(slider).toBeVisible({timeout: 15_000});
		for (let i = 0; i < 30; i++) {
			await slider.press('ArrowRight');
		}
		await dash.applyFilters();
		await expect(dash.filterChip('Section', 'Articles')).toBeVisible({
			timeout: 15_000,
		});
		await expect(
			dash.filterChip('Days since last activity', '30'),
		).toBeVisible();
		await expect(dash.viewHeading('Active submissions (0)')).toBeVisible({
			timeout: 20_000,
		});
		await expect(page.getByText('No Items')).toBeVisible();

		// Switch views: the search box empties, but ⚠ the chips survive
		// and keep filtering the new view (rule 8; AD-G, ledger §2 row
		// 201 — as-built, do NOT expect the intended reset).
		await dash.navItem('All in submission stage').click();
		await expect(
			dash.viewHeading('All in submission stage (0)'),
		).toBeVisible({timeout: 20_000});
		await expect(dash.searchInput).toHaveValue('');
		await expect(dash.filterChip('Section', 'Articles')).toBeVisible();
		await expect(
			dash.filterChip('Days since last activity', '30'),
		).toBeVisible();
		await dash.search(tag);
		await expect(page.getByText('No Items')).toBeVisible({timeout: 20_000});

		// "Clear Filters" drops them all and the list recovers.
		await dash.clearFiltersButton.click();
		await expect(dash.filterChip('Section', 'Articles')).toHaveCount(0, {
			timeout: 15_000,
		});
		await expect(
			dash.viewHeading('All in submission stage (2)'),
		).toBeVisible({timeout: 20_000});
		await expect(dash.row(artTitle)).toBeVisible();
		await expect(dash.row(revTitle)).toBeVisible();
	});

	test("s6: An editor's own submission stays at arm's length — the author guard replaces the summary and hides View until an editorial assignment lifts it", async ({
		asUser,
		pkpApi,
	}) => {
		test.slow(); // scratch journal + 2 seeds
		const tag = uniqueTag('eddf');
		const ma = `ma${tag}`;
		const {context} = await pkpApi.createJournal({
			tag,
			users: [
				// Genuinely enrolled in ALL the groups involved: manager (the
				// journal-wide hat), Journal editor (the editorial-capacity
				// group whose assignment lifts the guard — rule 15) and
				// author (the guard's trigger).
				throwawayUser(ma, 'Marlo', 'Ownwork', ['manager', 'editor', 'author']),
			],
		});
		const journalPath = context.path;
		const lockedTitle = `Locked ${tag}x`;
		const liftedTitle = `Lifted ${tag}y`;
		await pkpApi.createSubmission(
			submissionSpec({tag: `${tag}x`, title: lockedTitle, journal: journalPath, submitter: ma}),
		);
		// The same manager-author, but ALSO stage-assigned in an editorial
		// capacity (Journal editor group): the guard yields (rule 15).
		await pkpApi.createSubmission(
			submissionSpec({
				tag: `${tag}y`,
				title: liftedTitle,
				journal: journalPath,
				submitter: ma,
				participants: [{user: ma, role: 'editor'}],
			}),
		);

		const ctx = await asUser(ma);
		const page = await ctx.newPage();
		const dash = new DashboardPage(page, {journal: journalPath});
		await dash.gotoEditorial({view: 'active'});
		await expect(dash.viewHeading('Active submissions (2)')).toBeVisible({
			timeout: 20_000,
		});

		// Their own row is listed, but Editorial Activity is the
		// explanation and the View button is withheld (rule 15 —
		// exact-text live-probed 2026-07-16).
		const locked = dash.row(lockedTitle);
		await expect(locked).toBeVisible();
		await expect(activityCell(locked)).toContainText(
			'You cannot access this submission as a Journal Manager since you are the author. To view it, go to "My Submissions"',
		);
		await expect(
			locked.getByRole('button', {name: 'View', exact: true}),
		).toHaveCount(0);

		// With an editorial-capacity assignment too, the same user's row
		// shows the normal summary and View returns.
		const lifted = dash.row(liftedTitle);
		await expect(lifted).toBeVisible();
		await expect(activityCell(lifted)).not.toContainText(
			'You cannot access this submission',
		);
		await expect(
			lifted.getByRole('button', {name: 'View', exact: true}),
		).toBeVisible();
		await openRowView(dash, liftedTitle);
		await closeWorkflow(page);
		await expect(dash.viewHeading('Active submissions (2)')).toBeVisible({
			timeout: 20_000,
		});
	});

	test('s7: A reviewer works the queue — landing on Action Required, respond/finish rows, and a submitted review moving to Completed', async ({
		browser,
		baseURL,
		pkpApi,
	}) => {
		test.slow(); // scratch journal + real login + the reviewer wizard
		const tag = uniqueTag('eddg');
		const rv = `rv${tag}`;
		const ed = `ed${tag}`;
		const au = `au${tag}`;
		const {context} = await pkpApi.createJournal({
			tag,
			users: [
				throwawayUser(rv, 'Rhea', 'Queueworker', ['reviewer']),
				throwawayUser(ed, 'Edam', 'Editor', ['editor']),
				throwawayUser(au, 'Avery', 'Author', ['author']),
			],
		});
		const journalPath = context.path;
		const invitedTitle = `Invited ${tag}i`;
		const acceptedTitle = `Accepted ${tag}a`;
		const {submission: subI} = await pkpApi.createSubmission(
			submissionSpec({
				tag: `${tag}i`,
				title: invitedTitle,
				journal: journalPath,
				submitter: au,
				participants: [{user: ed, role: 'editor'}],
				decisions: [{type: 'sendExternalReview', by: ed}],
				reviewRounds: [{reviewers: [{user: rv, status: 'invited'}]}],
			}),
		);
		const {submission: subA} = await pkpApi.createSubmission(
			submissionSpec({
				tag: `${tag}a`,
				title: acceptedTitle,
				journal: journalPath,
				submitter: au,
				participants: [{user: ed, role: 'editor'}],
				decisions: [{type: 'sendExternalReview', by: ed}],
				reviewRounds: [{reviewers: [{user: rv, status: 'accepted'}]}],
			}),
		);

		// A reviewer-only user signs in and lands on "My Assignments as
		// Reviewer", view "Action Required by me" (rules 2 and 8).
		const {ctx, page} = await anonymousPage(browser, baseURL);
		const login = new LoginPage(page);
		await login.login(rv, rv + rv, journalPath);
		await page.waitForURL(/dashboard\/reviewAssignments/, {
			timeout: 20_000,
			waitUntil: 'commit',
		});
		const dash = new DashboardPage(page, {journal: journalPath});
		await expect(dash.viewHeading('Action Required by me (2)')).toBeVisible({
			timeout: 20_000,
		});

		// The fresh request: respond-by line + "Respond to request", which
		// opens the review's request step (rule 17).
		const invitedRow = dash.row(invitedTitle);
		await expect(invitedRow).toContainText(
			/Please accept or decline this request by/,
		);
		const wizard = new ReviewerSubmissionPage(page);
		await invitedRow
			.getByRole('button', {name: 'Respond to request', exact: true})
			.click();
		await page.waitForURL(new RegExp(`reviewer/submission/${subI.id}`), {
			timeout: 20_000,
			waitUntil: 'commit',
		});
		await expect(wizard.step1Form).toBeVisible({timeout: 20_000});

		// The accepted review: complete-by line + "Finish review", opening
		// mid-review (step 2).
		await dash.gotoReviewAssignments();
		const acceptedRow = dash.row(acceptedTitle);
		await expect(acceptedRow).toContainText(
			/Please complete this review by/,
			{timeout: 20_000},
		);
		await acceptedRow
			.getByRole('button', {name: 'Finish review', exact: true})
			.click();
		await page.waitForURL(new RegExp(`reviewer/submission/${subA.id}`), {
			timeout: 20_000,
			waitUntil: 'commit',
		});
		await expect(wizard.step2Form).toBeVisible({timeout: 20_000});

		// Genuinely submit the review through the wizard.
		await wizard.continueToStep3();
		await wizard.fillStep3Comments({
			toAuthor: `<p>Reviewer comments ${tag}</p>`,
		});
		await wizard.selectRecommendation('Revisions Required');
		await wizard.submitReview();

		// The row leaves "Action Required by me", stays in "All
		// assignments" and lands under "Completed" with the submitted line
		// and a View button (rules 16–17).
		await dash.gotoReviewAssignments();
		await expect(dash.viewHeading('Action Required by me (1)')).toBeVisible({
			timeout: 20_000,
		});
		await expect(dash.row(invitedTitle)).toBeVisible();
		await expect(dash.row(acceptedTitle)).toHaveCount(0);
		await dash.navItem('All assignments').click();
		await expect(dash.row(acceptedTitle)).toBeVisible({timeout: 20_000});
		await dash.navItem('Completed').click();
		const doneRow = dash.row(acceptedTitle);
		await expect(doneRow).toBeVisible({timeout: 20_000});
		await expect(doneRow).toContainText(/Review submitted on/);
		await expect(
			doneRow.getByRole('button', {name: 'View', exact: true}),
		).toBeVisible();
		await ctx.close();
	});

	test("s8: A reviewer's history sorts itself — Declined, Published, Archived membership, and ⚠ the inert list controls (ledger §2 row 2)", async ({
		asUser,
		pkpApi,
	}) => {
		test.slow(); // scratch journal + 4 seeded chains
		const tag = uniqueTag('eddh');
		const rv = `rv${tag}`;
		const ed = `ed${tag}`;
		const au = `au${tag}`;
		const {context} = await pkpApi.createJournal({
			tag,
			sections: twoSections(),
			issues: [{volume: 1, number: 1, year: 2026, published: true}],
			users: [
				throwawayUser(rv, 'Hilda', 'Historian', ['reviewer']),
				throwawayUser(ed, 'Edna', 'Editor', ['editor']),
				throwawayUser(au, 'Alvar', 'Author', ['author']),
			],
		});
		const journalPath = context.path;
		const declinedTitle = `Declinedreq ${tag}d`;
		const publishedTitle = `Publishedrev ${tag}p`;
		const archivedTitle = `Movedon ${tag}m`;
		const activeTitle = `Stillopen ${tag}s`;
		await pkpApi.createSubmission(
			submissionSpec({
				tag: `${tag}d`,
				title: declinedTitle,
				journal: journalPath,
				submitter: au,
				participants: [{user: ed, role: 'editor'}],
				decisions: [{type: 'sendExternalReview', by: ed}],
				reviewRounds: [{reviewers: [{user: rv, status: 'declined'}]}],
			}),
		);
		await pkpApi.createSubmission(
			submissionSpec({
				tag: `${tag}p`,
				title: publishedTitle,
				journal: journalPath,
				submitter: au,
				participants: [{user: ed, role: 'editor'}],
				decisions: [
					{type: 'sendExternalReview', by: ed},
					{type: 'accept', by: ed},
					{type: 'sendToProduction', by: ed},
				],
				reviewRounds: [
					{
						reviewers: [
							{user: rv, status: 'completed', recommendation: 'accept'},
						],
					},
				],
				publication: {
					versionStage: 'VoR',
					metadata: {
						title: {en: publishedTitle},
						abstract: {en: `<p>Published abstract ${tag}.</p>`},
					},
					issue: 'latest',
					published: true,
				},
			}),
		);
		await pkpApi.createSubmission(
			submissionSpec({
				tag: `${tag}m`,
				title: archivedTitle,
				journal: journalPath,
				submitter: au,
				participants: [{user: ed, role: 'editor'}],
				decisions: [
					{type: 'sendExternalReview', by: ed},
					{type: 'accept', by: ed},
				],
				reviewRounds: [{reviewers: [{user: rv, status: 'accepted'}]}],
			}),
		);
		await pkpApi.createSubmission(
			submissionSpec({
				tag: `${tag}s`,
				title: activeTitle,
				journal: journalPath,
				submitter: au,
				participants: [{user: ed, role: 'editor'}],
				decisions: [{type: 'sendExternalReview', by: ed}],
				reviewRounds: [{reviewers: [{user: rv, status: 'accepted'}]}],
			}),
		);

		const ctx = await asUser(rv);
		const page = await ctx.newPage();
		const dash = new DashboardPage(page, {journal: journalPath});

		// Declined: the declined-on line and no action button (rule 17).
		await dash.gotoReviewAssignments({
			view: 'reviewer-assignments-declined',
		});
		await expect(dash.viewHeading('Declined (1)')).toBeVisible({
			timeout: 20_000,
		});
		const declinedRow = dash.row(declinedTitle);
		await expect(declinedRow).toContainText(/Request declined on/);
		await expect(declinedRow.getByRole('button')).toHaveCount(0);

		// Published: the finished review whose submission was published —
		// and it has moved OUT of Completed (rule 16).
		await dash.gotoReviewAssignments({
			view: 'reviewer-assignments-published',
		});
		await expect(dash.viewHeading('Published (1)')).toBeVisible({
			timeout: 20_000,
		});
		await expect(dash.row(publishedTitle)).toBeVisible();
		await dash.gotoReviewAssignments({
			view: 'reviewer-assignments-completed',
		});
		await expect(dash.viewHeading('Completed (0)')).toBeVisible({
			timeout: 20_000,
		});
		await expect(dash.row(publishedTitle)).toHaveCount(0);

		// Archived: the never-finished review on a moved-on submission —
		// the single word "Incomplete", nothing to act on (rule 17).
		await dash.gotoReviewAssignments({
			view: 'reviewer-assignments-archived',
		});
		await expect(dash.viewHeading('Archived (1)')).toBeVisible({
			timeout: 20_000,
		});
		const archivedRow = dash.row(archivedTitle);
		await expect(archivedRow).toContainText('Incomplete');
		await expect(archivedRow.getByRole('button')).toHaveCount(0);

		// "All assignments": the open review is there; the archived
		// incomplete is missing too (⚠ Open questions #4 — as-built), as
		// are declined and published.
		await dash.gotoReviewAssignments({view: 'reviewer-assignments-all'});
		await expect(dash.viewHeading('All assignments (1)')).toBeVisible({
			timeout: 20_000,
		});
		await expect(dash.row(activeTitle)).toBeVisible();
		await expect(dash.row(archivedTitle)).toHaveCount(0);
		await expect(dash.row(declinedTitle)).toHaveCount(0);
		await expect(dash.row(publishedTitle)).toHaveCount(0);

		// ⚠ The list controls are cosmetic as-built (rule 18, ledger §2
		// row 2 — test the AS-BUILT behavior): a search phrase that
		// matches nothing leaves the list untouched…
		const ignored = page.waitForResponse(
			(r) =>
				r.url().includes('reviewerAssignments') &&
				r.url().includes('searchPhrase') &&
				r.ok(),
			{timeout: 20_000},
		);
		await dash.search('zzznomatch');
		await ignored;
		await expect(dash.row(activeTitle)).toBeVisible();

		// …the sortable ID column updates the request but not the list…
		const sortIgnored = page.waitForResponse(
			(r) =>
				r.url().includes('reviewerAssignments') &&
				r.url().includes('orderBy') &&
				r.ok(),
			{timeout: 20_000},
		);
		await dash.sortButton('ID').click();
		await sortIgnored;
		await expect(dash.row(activeTitle)).toBeVisible();

		// …and a Section filter chip renders while filtering nothing (the
		// active submission is in ART; filter by Reviews).
		await dash.openFilters();
		await dash.activeModal.getByRole('checkbox', {name: 'Reviews'}).check();
		const filterIgnored = page.waitForResponse(
			(r) => r.url().includes('reviewerAssignments') && r.ok(),
			{timeout: 20_000},
		);
		await dash.applyFilters();
		await filterIgnored;
		await expect(dash.filterChip('Section', 'Reviews')).toBeVisible({
			timeout: 15_000,
		});
		await expect(dash.row(activeTitle)).toBeVisible();
	});

	test('s9: Dashboards match hats — nav sections per role, denied by address across roles, role-priority landing, and one page per hat', async ({
		browser,
		baseURL,
		asUser,
		pkpApi,
	}) => {
		test.slow(); // scratch journal + three real logins
		const tag = uniqueTag('eddi');
		const se = `se${tag}`;
		const rv = `rv${tag}`;
		const both = `bo${tag}`;
		const ed = `ed${tag}`;
		const au = `au${tag}`;
		const {context} = await pkpApi.createJournal({
			tag,
			users: [
				throwawayUser(se, 'Signe', 'Editoronly', ['sectionEditor']),
				throwawayUser(rv, 'Runa', 'Revieweronly', ['reviewer']),
				throwawayUser(both, 'Bodil', 'Bothhats', ['sectionEditor', 'reviewer']),
				throwawayUser(ed, 'Egon', 'Editor', ['editor']),
				throwawayUser(au, 'Alma', 'Author', ['author']),
			],
		});
		const journalPath = context.path;
		const editHatTitle = `Edithat ${tag}x`;
		const reviewHatTitle = `Reviewhat ${tag}y`;
		await pkpApi.createSubmission(
			submissionSpec({
				tag: `${tag}x`,
				title: editHatTitle,
				journal: journalPath,
				submitter: au,
				participants: [{user: both, role: 'sectionEditor'}],
			}),
		);
		await pkpApi.createSubmission(
			submissionSpec({
				tag: `${tag}y`,
				title: reviewHatTitle,
				journal: journalPath,
				submitter: au,
				participants: [{user: ed, role: 'editor'}],
				decisions: [{type: 'sendExternalReview', by: ed}],
				reviewRounds: [{reviewers: [{user: both, status: 'accepted'}]}],
			}),
		);
		const deniedText =
			'The current role does not have access to this operation.';

		// A Section Editor without the Reviewer role: lands on the Editor
		// Dashboard, has no reviewer section, and is denied the reviewer
		// address (Actors & permissions; rule 2).
		{
			const {ctx, page} = await anonymousPage(browser, baseURL);
			await new LoginPage(page).login(se, se + se, journalPath);
			await page.waitForURL(/dashboard\/editorial/, {
				timeout: 20_000,
				waitUntil: 'commit',
			});
			const dash = new DashboardPage(page, {journal: journalPath});
			await expect(
				dash.nav.getByText(TITLE.editorial, {exact: true}),
			).toBeVisible({timeout: 20_000});
			await expect(dash.nav.getByText(TITLE.reviewer)).toHaveCount(0);
			await page.goto(dash.url('reviewAssignments'));
			await expect(page.getByText(deniedText)).toBeVisible({
				timeout: 20_000,
			});
			await ctx.close();
		}

		// A reviewer-only user: the reverse — and typing the Editor
		// Dashboard address gets the no-access page, never an error screen.
		{
			const {ctx, page} = await anonymousPage(browser, baseURL);
			await new LoginPage(page).login(rv, rv + rv, journalPath);
			await page.waitForURL(/dashboard\/reviewAssignments/, {
				timeout: 20_000,
				waitUntil: 'commit',
			});
			const dash = new DashboardPage(page, {journal: journalPath});
			await expect(
				dash.nav.getByText(TITLE.reviewer, {exact: true}),
			).toBeVisible({timeout: 20_000});
			await expect(dash.nav.getByText(TITLE.editorial)).toHaveCount(0);
			await page.goto(dash.url('editorial'));
			await expect(page.getByText(deniedText)).toBeVisible({
				timeout: 20_000,
			});
			await ctx.close();
		}

		// An author-only user lands last in the ladder: My Submissions.
		{
			const {ctx, page} = await anonymousPage(browser, baseURL);
			await new LoginPage(page).login(au, au + au, journalPath);
			await page.waitForURL(/dashboard\/mySubmissions/, {
				timeout: 20_000,
				waitUntil: 'commit',
			});
			await ctx.close();
		}

		// A Section Editor who also reviews: both sections, and each page
		// shows only that hat's rows (rules 1 and 5).
		const bothCtx = await asUser(both);
		const bothPage = await bothCtx.newPage();
		const dash = new DashboardPage(bothPage, {journal: journalPath});
		await dash.gotoEditorial({view: 'active'});
		await expect(
			dash.nav.getByText(TITLE.editorial, {exact: true}),
		).toBeVisible({timeout: 20_000});
		await expect(
			dash.nav.getByText(TITLE.reviewer, {exact: true}),
		).toBeVisible();
		await expect(dash.viewHeading('Active submissions (1)')).toBeVisible({
			timeout: 20_000,
		});
		await expect(dash.row(editHatTitle)).toBeVisible();
		await expect(dash.row(reviewHatTitle)).toHaveCount(0);
		await dash.gotoReviewAssignments();
		await expect(dash.viewHeading('Action Required by me (1)')).toBeVisible({
			timeout: 20_000,
		});
		await expect(dash.row(reviewHatTitle)).toBeVisible();
		await expect(dash.row(editHatTitle)).toHaveCount(0);
	});

	test('s10: The address restores the screen — view + chip + phrase + open panel for a colleague, login-first when signed out, and the invalid-view fallback', async ({
		browser,
		baseURL,
		asUser,
		pkpApi,
	}) => {
		test.slow(); // scratch journal + three sessions
		const tag = uniqueTag('eddj');
		const m1 = `mA${tag}`;
		const m2 = `mB${tag}`;
		const ed = `ed${tag}`;
		const rv = `rv${tag}`;
		const au = `au${tag}`;
		const {context} = await pkpApi.createJournal({
			tag,
			sections: twoSections(),
			users: [
				throwawayUser(m1, 'Milla', 'Sharer', ['manager']),
				throwawayUser(m2, 'Mette', 'Colleague', ['manager']),
				throwawayUser(ed, 'Espen', 'Editor', ['editor']),
				throwawayUser(rv, 'Rikke', 'Latereviewer', ['reviewer']),
				throwawayUser(au, 'Asta', 'Author', ['author']),
			],
		});
		const journalPath = context.path;
		const title = `Overdue ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			submissionSpec({
				tag,
				title,
				journal: journalPath,
				submitter: au,
				section: 'ART',
				participants: [{user: ed, role: 'editor'}],
				decisions: [{type: 'sendExternalReview', by: ed}],
				reviewRounds: [
					{
						reviewers: [
							{
								user: rv,
								status: 'accepted',
								responseDueDate: '2025-01-01',
								reviewDueDate: '2025-01-01',
							},
						],
					},
				],
			}),
		);

		// The sharer composes the screen: Reviews overdue + Section chip +
		// search phrase + the submission's workflow panel open.
		const ctx1 = await asUser(m1);
		const page1 = await ctx1.newPage();
		const dash1 = new DashboardPage(page1, {journal: journalPath});
		await dash1.gotoEditorial({view: 'reviews-overdue'});
		await expect(dash1.viewHeading('Reviews overdue (1)')).toBeVisible({
			timeout: 20_000,
		});
		await dash1.openFilters();
		await dash1.activeModal.getByRole('checkbox', {name: 'Articles'}).check();
		await dash1.applyFilters();
		await expect(dash1.filterChip('Section', 'Articles')).toBeVisible({
			timeout: 15_000,
		});
		await dash1.search(tag);
		await expect(dash1.viewHeading('Reviews overdue (1)')).toBeVisible({
			timeout: 20_000,
		});
		await openRowView(dash1, title);
		await expect(page1).toHaveURL(
			new RegExp(`workflowSubmissionId=${submission.id}`),
		);
		const sharedUrl = page1.url();

		// A colleague with the same role opens the copied address: same
		// view, same chip and phrase, same open panel (rule 13).
		const ctx2 = await asUser(m2);
		const page2 = await ctx2.newPage();
		const dash2 = new DashboardPage(page2, {journal: journalPath});
		await page2.goto(sharedUrl);
		await expect(workflowModal(page2)).toContainText(title, {
			timeout: 20_000,
		});
		// (While the deep-linked panel is open the background list is
		// still in its initial Loading state — assert it only after
		// closing the panel.)
		await closeWorkflow(page2);
		await expect(dash2.viewHeading('Reviews overdue (1)')).toBeVisible({
			timeout: 20_000,
		});
		await expect(dash2.filterChip('Section', 'Articles')).toBeVisible();
		await expect(dash2.searchInput).toHaveValue(tag);
		await expect(dash2.row(title)).toBeVisible();
		const restoredUrl = page2.url(); // clean state URL (no panel)

		// A signed-out recipient is asked to log in first, then lands on
		// that same screen (rule 13).
		{
			const {ctx, page} = await anonymousPage(browser, baseURL);
			await page.goto(sharedUrl);
			await page.waitForURL(/\/login/, {timeout: 20_000});
			const login = new LoginPage(page);
			await login.submitCredentials(m2, m2 + m2);
			await expect(workflowModal(page)).toContainText(title, {
				timeout: 30_000,
			});
			await expect(page).toHaveURL(
				new RegExp(`workflowSubmissionId=${submission.id}`),
			);
			await ctx.close();
		}

		// Editing the address to a view that doesn't exist lands safely on
		// "Assigned to me": no error, the address corrects itself, the
		// search phrase is dropped, ⚠ but the section chip sticks (rule 8;
		// AD-G).
		const bogusUrl = restoredUrl.replace(
			/currentViewId=[^&]+/,
			'currentViewId=doesNotExist',
		);
		expect(bogusUrl).not.toBe(restoredUrl);
		await page2.goto(bogusUrl);
		await expect(dash2.viewHeading(/Assigned to me/)).toBeVisible({
			timeout: 20_000,
		});
		await page2.waitForURL(/currentViewId=assigned-to-me/, {
			timeout: 20_000,
		});
		await expect(dash2.searchInput).toHaveValue('');
		expect(page2.url()).not.toContain('searchPhrase');
		await expect(dash2.filterChip('Section', 'Articles')).toBeVisible();
	});
});
