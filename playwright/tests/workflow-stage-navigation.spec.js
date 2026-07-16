// @ts-check
const {test, expect} = require('../support/base-test.js');
const {DashboardPage} = require('../pages/DashboardPage.js');
const {WorkflowShellPage} = require('../pages/WorkflowShellPage.js');

/**
 * Workflow stage navigation (the workflow panel's shell) — one test per
 * canonical scenario of docs/product/specs/workflow-stage-navigation.md
 * (6 scenarios → 6 tests). The shell (WorkflowPage.vue, the stage menu,
 * the status boxes, the legacy workflow routes) is pkp-lib, so the spec
 * lives here; scenario payloads use OJS vocabulary (publicknowledge /
 * ART) matching the bootstrap context the suite runs against.
 *
 * Coverage per scenario:
 *   s1  section-editor tour: open from the dashboard row; header shows
 *       ID + authors + title + "Review (Round 1)" bubble (dot class
 *       bg-stage-in-review); all four stages in the menu with the
 *       colored stripe on the Review round entry; Copyediting → the
 *       "not yet been initiated" Status box and nothing else;
 *       Submission → "currently in the Review stage." above the
 *       desk-review panels; back to the round → working stage
 *   s2  rounds unfold: two round entries; fresh open lands on Round 2
 *       (stripe there, not on Round 1); Round 1 reads "advanced to the
 *       next round of review" above its historical Reviewers table; on
 *       an accepted sibling, Round 1 instead names the Copyediting
 *       stage it now sits in
 *   s3  assistant vs uncovered stages (scratch journal; a throwaway
 *       assistant holding copyeditor + layoutEditor roles = coverage
 *       exactly {Copyediting, Production}): landing follows the
 *       submission into Review where the bare no-access sentence
 *       renders (no Status box, no side column, no actions — rule 7);
 *       Submission likewise; the menu still lists all four stages;
 *       Copyediting and Production open normally (not-initiated boxes)
 *   s4  unassigned manager baseline: walks all four stages, each
 *       showing panels or a status note and never the no-access
 *       sentence; header offers Activity Log and Library
 *   s5  legacy addresses: workflow/access → dashboard with the panel
 *       open; a stage-named bookmark (workflow/submission on a
 *       Review-stage submission) lands at the DEFAULT landing, not the
 *       bookmarked stage (⚠ as-built, ledger row 212 — the redirect
 *       chain drops the stage); logged out → login (legacy URL in
 *       `source`) then straight on into the open panel; an author is
 *       302'd to the authorizationDenied page reading the
 *       accessible-stage sentence, for the access op AND the
 *       stage-named op — never into the workflow
 *   s6  editor vs author on one Copyediting submission: same skeleton
 *       (header + "Copyediting" bubble + four-stage menu + Publication
 *       group), but the author's version menu offers no editor-only
 *       screens (Identifiers, Permissions & Disclosure, Publication
 *       Settings, JATS XML, Body Text), the author's header has
 *       Library but no Activity Log, and no decision rail renders in
 *       the author view (positive control: the editor's rail is there)
 *
 * As-built deviations the suite records but does NOT walk here (no
 * canonical scenario reaches them — see the spec's Known deviations):
 *  - ledger row 211 (manager-as-reviewer UI blinding vs permissive
 *    server) needs a manager holding an active review assignment;
 *  - ledger row 212's second half (stage-named addresses stricter than
 *    their destination) needs an assistant hitting an uncovered
 *    stage-named op — s5 covers the stage-drop half;
 *  - ledger row 213 (selected parent Review entry misdescribes an
 *    active round) is reached by clicking the round-less Review entry,
 *    which no canonical scenario does.
 *
 * Parallel-safety: every submission is per-test; tags are single
 * hyphenless alphanumeric tokens riding in submission titles;
 * publicknowledge is used read-only + additively (s1, s2, s4, s5, s6);
 * s3 runs on a per-test scratch journal because it needs a throwaway
 * user with a custom role combination — no seeded user gains a role
 * anywhere; no Mailpit reads (the shell sends no mail — Side effects).
 */

test.use({user: 'sectioneditor.ana'}); // the default actor: an assigned section editor

const JOURNAL = 'publicknowledge';
const NO_ACCESS = WorkflowShellPage.NO_ACCESS_SENTENCE;

/** A unique, hyphenless, alphanumeric tag (parallel isolation). */
function uniqueTag(prefix = 'wsn') {
	const workerLetter = String.fromCharCode(
		97 + (test.info().parallelIndex % 26),
	);
	let suffix = '';
	while (suffix.length < 6) {
		suffix += Math.random().toString(36).replace(/[^a-z0-9]/g, '');
	}
	return `${prefix}${workerLetter}${suffix.slice(0, 6)}`;
}

/**
 * Scenario spec for a SUBMITTED submission (single AO/unpublished
 * publication carrying the tag in its title).
 */
function submittedSpec({
	tag,
	title,
	journal = JOURNAL,
	submitter = 'author.alex',
	participants,
	decisions,
	reviewRounds,
}) {
	return {
		tag,
		journal,
		submitter,
		section: 'ART',
		locale: 'en',
		submitted: true,
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
			},
		],
	};
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
 * A submission in external review (round 1) on publicknowledge:
 * submitter author.alex, editor.diana decides, sectioneditor.ana an
 * assigned section editor.
 */
function inReviewSpec({tag, title}) {
	return submittedSpec({
		tag,
		title,
		participants: [
			{user: 'editor.diana', role: 'editor'},
			{user: 'sectioneditor.ana', role: 'sectionEditor'},
		],
		decisions: [{type: 'sendExternalReview', by: 'editor.diana'}],
		reviewRounds: [{reviewers: []}],
	});
}

test.describe('Workflow stage navigation', () => {
	test('s1: a Section Editor tours the stage menu — header anatomy, the round stripe, a not-yet-initiated stage, a passed stage, back to the working round', async ({
		page,
		pkpApi,
	}) => {
		test.slow(); // dashboard search + a four-stop menu tour
		const tag = uniqueTag('wsna');
		const title = `Stage menu tour ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			inReviewSpec({tag, title}),
		);

		// Open from the dashboard: search the tag, press the row's View.
		const dash = new DashboardPage(page);
		await dash.gotoEditorial();
		await dash.search(tag);
		await dash
			.row(tag)
			.getByRole('button', {name: 'View', exact: true})
			.click();

		// Header anatomy (rules 1–2): ID above the title area, the author
		// list as the heading, the full title beneath, and the stage
		// indicator bubble "Review (Round 1)" with the in-review dot.
		const shell = new WorkflowShellPage(page);
		const header = shell.header();
		await expect(header).toContainText(String(submission.id), {
			timeout: 20_000,
		});
		await expect(header.getByRole('heading', {level: 1})).toContainText(
			'Author', // author.alex's family name (authorsStringShort)
		);
		await expect(header).toContainText(title);
		await expect(header).toContainText('Review (Round 1)');
		await expect(shell.indicatorDot()).toHaveClass(/bg-stage-in-review/);

		// The menu lists all four stages plus the round entry (rule 3),
		// and the colored stripe sits on the current round (rule 4).
		for (const stage of [
			'Submission',
			'Review',
			'Copyediting',
			'Production',
		]) {
			await expect(shell.menuItem(stage)).toBeVisible();
		}
		await expect(shell.menuItem('Review Round 1')).toBeVisible();
		await expect(shell.menuItem('Review Round 1')).toHaveClass(
			/border-stage-in-review/,
		);

		// Copyediting hasn't been reached: a Status box reading the
		// not-initiated sentence and nothing else — no other primary
		// panel, no action rail (rule 8, first bullet).
		await shell.clickMenu('Copyediting');
		await expect(
			shell.contentHeading('Workflow: Copyediting'),
		).toBeVisible();
		await shell.expectStageNotStarted('Copyediting');
		// "Nothing else": the primary column holds only the ever-present
		// submission-language line (shell chrome on every stage view)
		// and the Status box — the $-anchor proves no panel follows.
		await expect(shell.primaryItems()).toHaveText(
			/^\s*(Current Submission Language:[^]*?)?Status\s+The Copyediting stage has not yet been initiated\.\s*$/,
		);
		await expect(shell.actionItems()).toHaveCount(0);

		// Submission is a passed stage: the Status box names the current
		// stage, above that stage's read-only panels (rule 8, second
		// bullet).
		await shell.clickMenu('Submission');
		await expect(
			shell.contentHeading('Workflow: Submission'),
		).toBeVisible();
		await expect(
			shell
				.primaryItems()
				.getByText('The submission is currently in the Review stage.'),
		).toBeVisible();
		await expect(
			shell.modal().getByText('Submission Files').first(),
		).toBeVisible();

		// Back on the round: the working stage (its Round Status box).
		await shell.clickMenu('Review Round 1');
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible();
		await expect(
			shell.modal().getByRole('heading', {name: 'Round 1 Status'}),
		).toBeVisible();
	});

	test('s2: review rounds unfold in the menu — fresh open lands on Round 2, Round 1 explains the advance, and names the stage once accepted', async ({
		page,
		pkpApi,
	}) => {
		test.slow(); // two seeded submissions, two panel visits
		const tag = uniqueTag('wsnb');
		const roundsTitle = `Two rounds ${tag}r`;
		const acceptedTitle = `Accepted rounds ${tag}a`;
		// A: round 2 in progress (round 1 reviewed by paul, revisions
		// requested, new round opened).
		const {submission: subRounds} = await pkpApi.createSubmission(
			submittedSpec({
				tag: `${tag}r`,
				title: roundsTitle,
				participants: [
					{user: 'editor.diana', role: 'editor'},
					{user: 'sectioneditor.ana', role: 'sectionEditor'},
				],
				decisions: [
					{type: 'sendExternalReview', by: 'editor.diana'},
					{type: 'requestRevisions', by: 'editor.diana'},
					{type: 'newExternalRound', by: 'editor.diana'},
				],
				reviewRounds: [
					{
						reviewers: [
							{
								user: 'reviewer.paul',
								method: 'anonymous',
								status: 'completed',
								recommendation: 'pendingRevisions',
							},
						],
					},
					{reviewers: []},
				],
			}),
		);
		// B: same shape, then accepted → now sits in Copyediting.
		const {submission: subAccepted} = await pkpApi.createSubmission(
			submittedSpec({
				tag: `${tag}a`,
				title: acceptedTitle,
				participants: [
					{user: 'editor.diana', role: 'editor'},
					{user: 'sectioneditor.ana', role: 'sectionEditor'},
				],
				decisions: [
					{type: 'sendExternalReview', by: 'editor.diana'},
					{type: 'requestRevisions', by: 'editor.diana'},
					{type: 'newExternalRound', by: 'editor.diana'},
					{type: 'accept', by: 'editor.diana'},
				],
				reviewRounds: [
					{
						reviewers: [
							{
								user: 'reviewer.paul',
								method: 'anonymous',
								status: 'completed',
								recommendation: 'pendingRevisions',
							},
						],
					},
					{reviewers: []},
				],
			}),
		);

		// Fresh open of A lands on Round 2 — the current round carries
		// the stripe, Round 1 doesn't (rules 4 and 9).
		const shell = new WorkflowShellPage(page);
		await shell.gotoEditorial(subRounds.id);
		await expect(
			shell.contentHeading('Workflow: Review (Round 2)'),
		).toBeVisible({timeout: 20_000});
		await expect(shell.menuItem('Review Round 1')).toBeVisible();
		await expect(shell.menuItem('Review Round 2')).toBeVisible();
		await expect(shell.menuItem('Review Round 2')).toHaveClass(
			/border-stage-in-review/,
		);
		await expect(shell.menuItem('Review Round 1')).not.toHaveClass(
			/border-stage-in-review/,
		);

		// Round 1 (still in Review): the advanced-to-next-round message
		// above the round's historical content (rule 8, third bullet).
		await shell.clickMenu('Review Round 1');
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible();
		await expect(
			shell
				.primaryItems()
				.getByText(
					'The submission has been advanced to the next round of review',
				),
		).toBeVisible();
		// Historical content: round 1's Reviewers table still lists paul.
		await expect(
			shell.modal().getByText('Paul Reviewer').first(),
		).toBeVisible();

		// After acceptance (B): Round 1 explains the advance AND names
		// the stage the submission now sits in.
		await shell.gotoEditorial(subAccepted.id);
		await expect(
			shell.contentHeading('Workflow: Copyediting'),
		).toBeVisible({timeout: 20_000});
		await shell.clickMenu('Review Round 1');
		await expect(
			shell
				.primaryItems()
				.getByText(
					'The submission advanced to the next review round, was accepted, and is currently in the Copyediting stage.',
				),
		).toBeVisible();
	});

	test('s3: an Assistant hits a stage their role doesn\'t cover — bare no-access sentence on Review and Submission, normal panels on Copyediting and Production', async ({
		asUser,
		pkpApi,
	}) => {
		test.slow(); // scratch journal + multi-stage walk
		const tag = uniqueTag('wsnc');
		const ed = `ed${tag}`;
		const as = `as${tag}`;
		const au = `au${tag}`;
		// The scenario's assistant covers ONLY Copyediting + Production:
		// no single default assistant group does, so the throwaway holds
		// copyeditor (stage 4) + layoutEditor (stage 5) and is assigned
		// through both groups — coverage union exactly {4, 5} (rule 6).
		const {context} = await pkpApi.createJournal({
			tag,
			users: [
				throwawayUser(ed, 'Edla', 'Editor', ['editor']),
				throwawayUser(as, 'Asta', 'Assistant', [
					'copyeditor',
					'layoutEditor',
				]),
				throwawayUser(au, 'Aza', 'Author', ['author']),
			],
		});
		const journalPath = context.path;
		const title = `Uncovered stages ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				journal: journalPath,
				submitter: au,
				participants: [
					{user: ed, role: 'editor'},
					{user: as, role: 'copyeditor'},
					{user: as, role: 'layoutEditor'},
				],
				decisions: [{type: 'sendExternalReview', by: ed}],
				reviewRounds: [{reviewers: []}],
			}),
		);

		const ctx = await asUser(as);
		const page = await ctx.newPage();
		const shell = new WorkflowShellPage(page, {journalPath});
		await shell.gotoEditorial(submission.id);

		// The landing follows the submission's state (rule 9, last
		// sentence): the current review round — where this viewer gets
		// the bare no-access sentence, nothing else (rule 7).
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});
		await shell.expectNoAccessOnly();

		// The menu never hides or locks an entry (rule 3).
		for (const stage of [
			'Submission',
			'Review',
			'Copyediting',
			'Production',
		]) {
			await expect(shell.menuItem(stage)).toBeVisible();
		}

		// Submission is uncovered too — same bare sentence.
		await shell.clickMenu('Submission');
		await expect(
			shell.contentHeading('Workflow: Submission'),
		).toBeVisible();
		await shell.expectNoAccessOnly();

		// Covered stages open normally: the not-yet-initiated Status box
		// (with its framing) instead of the sentence.
		await shell.clickMenu('Copyediting');
		await shell.expectStageNotStarted('Copyediting');
		await expect(shell.primaryItems().getByText(NO_ACCESS)).toHaveCount(0);

		await shell.clickMenu('Production');
		await shell.expectStageNotStarted('Production');
		await expect(shell.primaryItems().getByText(NO_ACCESS)).toHaveCount(0);
	});

	test('s4: a Journal Manager oversees without an assignment — every stage shows panels or a status note, never the no-access sentence; Activity Log and Library offered', async ({
		asUser,
		pkpApi,
	}) => {
		test.slow(); // four-stage walk
		const tag = uniqueTag('wsnd');
		const title = `Manager oversight ${tag}`;
		// manager.maya is NOT a participant (and not a section editor, so
		// the submit-time auto-assignment can't catch her either).
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				participants: [{user: 'editor.diana', role: 'editor'}],
				decisions: [{type: 'sendExternalReview', by: 'editor.diana'}],
				reviewRounds: [{reviewers: []}],
			}),
		);

		const ctx = await asUser('manager.maya');
		const page = await ctx.newPage();
		const shell = new WorkflowShellPage(page);
		await shell.gotoEditorial(submission.id);

		// Lands on the working round (rule 9) with its panels.
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});
		await expect(
			shell.modal().getByRole('heading', {name: 'Round 1 Status'}),
		).toBeVisible();
		await expect(shell.modal().getByText(NO_ACCESS)).toHaveCount(0);

		// Header tools for the unassigned-manager baseline (permissions
		// table row d): Activity Log and Library.
		await expect(shell.headerButton('Activity Log')).toBeVisible();
		await expect(shell.headerButton('Library')).toBeVisible();

		// The passed Submission stage: status note above read-only panels.
		await shell.clickMenu('Submission');
		await expect(
			shell
				.primaryItems()
				.getByText('The submission is currently in the Review stage.'),
		).toBeVisible();
		await expect(shell.modal().getByText(NO_ACCESS)).toHaveCount(0);

		// The unreached stages: their status notes, never the sentence.
		await shell.clickMenu('Copyediting');
		await shell.expectStageNotStarted('Copyediting');
		await expect(shell.modal().getByText(NO_ACCESS)).toHaveCount(0);

		await shell.clickMenu('Production');
		await shell.expectStageNotStarted('Production');
		await expect(shell.modal().getByText(NO_ACCESS)).toHaveCount(0);
	});

	test('s5: old workflow addresses find their way home — entry-check and stage-named bookmarks, the login bounce, and the author\'s access-denied page', async ({
		page,
		browser,
		baseURL,
		asUser,
		pkpApi,
	}) => {
		test.slow(); // three actors, six navigations
		const tag = uniqueTag('wsne');
		const title = `Old bookmark ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			inReviewSpec({tag, title}),
		);
		const shell = new WorkflowShellPage(page);
		const accessUrl = `/index.php/${JOURNAL}/en/workflow/access/${submission.id}`;

		// (a) The entry-check bookmark, signed in as the assigned section
		// editor: lands on the editorial dashboard with the panel open
		// (rule 11).
		await page.goto(accessUrl, {waitUntil: 'commit'});
		await page.waitForURL(/dashboard\/editorial\?/, {
			timeout: 20_000,
			waitUntil: 'commit',
		});
		await expect(page).toHaveURL(
			new RegExp(`workflowSubmissionId=${submission.id}`),
		);
		await expect(shell.modal()).toContainText(title, {timeout: 20_000});

		// (b) A stage-named bookmark (the Submission stage of a
		// Review-stage submission): same destination, but ⚠ as-built the
		// stage is dropped on the way (ledger row 212) — the panel opens
		// at the rule-9 default landing (the current review round), NOT
		// the bookmarked stage.
		await page.goto(
			`/index.php/${JOURNAL}/en/workflow/submission/${submission.id}`,
			{waitUntil: 'commit'},
		);
		await page.waitForURL(/dashboard\/editorial\?/, {
			timeout: 20_000,
			waitUntil: 'commit',
		});
		await expect(
			shell.contentHeading('Workflow: Review (Round 1)'),
		).toBeVisible({timeout: 20_000});
		await expect(
			shell.contentHeading('Workflow: Submission'),
		).toHaveCount(0);
		// The panel itself records the default landing in the address.
		await expect(page).toHaveURL(/workflowMenuKey=workflow_3_\d+/, {
			timeout: 20_000,
		});

		// (c) Followed while signed out: the bookmark first asks for
		// login (carrying itself in `source`), then continues on to the
		// open panel.
		const anonCtx = await browser.newContext({
			baseURL,
			storageState: {cookies: [], origins: []},
		});
		const anonPage = await anonCtx.newPage();
		await anonPage.goto(accessUrl, {waitUntil: 'commit'});
		await anonPage.waitForURL(/\/login/, {
			timeout: 20_000,
			waitUntil: 'commit',
		});
		await expect(anonPage).toHaveURL(/source=.*workflow%2Faccess/);
		await anonPage.locator('input#username').fill('sectioneditor.ana');
		await anonPage
			.locator('input#password')
			.fill('sectioneditor.anasectioneditor.ana');
		await anonPage.locator('form#login button').click();
		await anonPage.waitForURL(/dashboard\/editorial\?/, {
			timeout: 20_000,
			waitUntil: 'commit',
		});
		await expect(anonPage).toHaveURL(
			new RegExp(`workflowSubmissionId=${submission.id}`),
		);
		await expect(
			new WorkflowShellPage(anonPage).modal(),
		).toContainText(title, {timeout: 20_000});
		await anonCtx.close();

		// (d) An author (the submitter) never reaches the dashboard: both
		// op families 302 to the access-denied page reading the
		// accessible-stage sentence.
		const authorCtx = await asUser('author.alex');
		const authorPage = await authorCtx.newPage();
		for (const legacyOp of [
			`workflow/access/${submission.id}`,
			`workflow/externalReview/${submission.id}`,
		]) {
			await authorPage.goto(`/index.php/${JOURNAL}/en/${legacyOp}`, {
				waitUntil: 'commit',
			});
			await authorPage.waitForURL(/user\/authorizationDenied/, {
				timeout: 20_000,
				waitUntil: 'commit',
			});
			await expect(authorPage).toHaveURL(
				/message=user\.authorization\.accessibleWorkflowStage/,
			);
			await expect(authorPage.getByText(NO_ACCESS)).toBeVisible();
		}
	});

	test('s6: an author and a Section Editor open the same submission — shared skeleton, slimmer author version menu, no Activity Log, no decision rail', async ({
		page,
		asUser,
		pkpApi,
	}) => {
		test.slow(); // two actors, two panel walks
		const tag = uniqueTag('wsnf');
		const title = `Two dressings ${tag}`;
		const {submission} = await pkpApi.createSubmission(
			submittedSpec({
				tag,
				title,
				participants: [
					{user: 'editor.diana', role: 'editor'},
					{user: 'sectioneditor.ana', role: 'sectionEditor'},
				],
				decisions: [
					{type: 'sendExternalReview', by: 'editor.diana'},
					{type: 'accept', by: 'editor.diana'},
				],
				reviewRounds: [{reviewers: []}],
			}),
		);

		// --- The assigned Section Editor's editorial shell. ---
		const shell = new WorkflowShellPage(page);
		await shell.gotoEditorial(submission.id);
		await expect(shell.header()).toContainText(title, {timeout: 20_000});
		await expect(shell.header()).toContainText('Copyediting');
		await expect(shell.indicatorDot()).toHaveClass(/bg-stage-copyediting/);
		for (const stage of [
			'Submission',
			'Review',
			'Copyediting',
			'Production',
		]) {
			await expect(shell.menuItem(stage)).toBeVisible();
		}
		await expect(shell.menuItem('Publication')).toBeVisible();
		// Header tools: Activity Log (assigned section editor on the
		// current stage) + Library.
		await expect(shell.headerButton('Activity Log')).toBeVisible();
		await expect(shell.headerButton('Library')).toBeVisible();
		// The decision rail renders for the editor (positive control for
		// the author-side absence below).
		await expect(shell.actionItems()).toBeVisible();
		// The version's editorial menu roster includes the editor-only
		// screens. (On publicknowledge no pub-id plugin is enabled, so
		// "Identifiers" is absent from BOTH dressings — the editor/author
		// contrast is carried by the production-bound entries.)
		await shell.nav().getByText(/1\.0/).first().click();
		for (const item of [
			'Title & Abstract',
			'Contributors',
			'Metadata',
			'JATS XML',
			'Body Text',
			'Galleys',
			'Media',
			'Permissions & Disclosure',
			'Publication Settings',
		]) {
			await expect(
				shell.nav().getByText(item, {exact: true}),
			).toBeVisible();
		}

		// --- The author's tracking view of the same submission. ---
		const authorCtx = await asUser('author.alex');
		const authorPage = await authorCtx.newPage();
		const authorShell = new WorkflowShellPage(authorPage);
		await authorShell.gotoTracking(submission.id);
		await expect(authorShell.header()).toContainText(title, {
			timeout: 20_000,
		});

		// Same skeleton: the same Copyediting indicator, the same
		// four-stage menu, a Publication group.
		await expect(authorShell.header()).toContainText('Copyediting');
		await expect(authorShell.indicatorDot()).toHaveClass(
			/bg-stage-copyediting/,
		);
		for (const stage of [
			'Submission',
			'Review',
			'Copyediting',
			'Production',
		]) {
			await expect(authorShell.menuItem(stage)).toBeVisible();
		}
		await expect(authorShell.menuItem('Publication')).toBeVisible();

		// Header: Library but no Activity Log (permissions table row d).
		await expect(authorShell.headerButton('Library')).toBeVisible();
		await expect(authorShell.headerButton('Activity Log')).toHaveCount(0);

		// No decision rail anywhere in the author view — neither the rail
		// container nor the editor's Copyediting decision button.
		await expect(authorShell.actionItems()).toHaveCount(0);
		await expect(
			authorShell
				.modal()
				.getByRole('button', {name: 'Send To Production'}),
		).toHaveCount(0);

		// The author's version menu offers fewer screens: the author
		// pages are there, the editor-only ones are not.
		await authorShell.nav().getByText(/1\.0/).first().click();
		for (const item of [
			'Title & Abstract',
			'Contributors',
			'Metadata',
			'Galleys',
			'Media',
		]) {
			await expect(
				authorShell.nav().getByText(item, {exact: true}),
			).toBeVisible();
		}
		for (const never of [
			'Identifiers',
			'Permissions & Disclosure',
			'Publication Settings',
			'JATS XML',
			'Body Text',
			'Create New Version',
		]) {
			await expect(
				authorShell.nav().getByText(never, {exact: true}),
			).toHaveCount(0);
		}
	});
});
