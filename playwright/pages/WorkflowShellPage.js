// @ts-check
const {expect} = require('@playwright/test');
const {BasePage} = require('./BasePage.js');

/**
 * POM for the workflow panel's SHELL — the side modal that frames every
 * per-stage surface (docs/product/specs/workflow-stage-navigation.md):
 * the header (submission id / authors / title / stage indicator bubble /
 * header tool buttons), the left-hand stage menu (SideMenu with the
 * Workflow + Publication groups), the content-pane heading
 * ("Workflow: {stage}"), and the three content regions
 * (`workflow-primary-items`, `workflow-secondary-items`,
 * `workflow-action-items`).
 *
 * What fills each stage (file panels, reviewer tables, decisions) is
 * owned by other POMs (ReviewRoundPanel, FileStagePanel, ...); this one
 * stops at the shell.
 *
 * Shared across OJS/OMP/OPS — everything it touches renders from
 * lib/ui-library (WorkflowPage.vue, SideModalBody.vue, SideMenu.vue,
 * StageBubble.vue, WorkflowSubmissionStatus.vue).
 *
 * DOM realities encoded here:
 * - The side-modal wrapper `[data-cy="active-modal"]` computes as
 *   hidden (zero-height wrapper) — wait on content INSIDE it, never on
 *   the wrapper itself.
 * - Menu entries are `<a href="#">` elements (PanelMenu item template),
 *   so they match `getByRole('link', ...)`; each carries only its own
 *   label text (submenus are sibling lists), so exact-name matching is
 *   safe even for "Review" vs "Review Round 1".
 * - The current stage's colored stripe is a `border-stage-*` class on
 *   that entry's `<a>` (`!border-s-8` + `StageColors[stageId]`).
 * - The stage indicator dot is a `bg-stage-*` span inside the header
 *   (`StageBubble.vue` ExtendedStagesColorClass).
 * - The content heading is the `<h2>` right of the menu
 *   ("Workflow: {stage}"); it is CSS-uppercased, so match it
 *   case-insensitively.
 */
exports.WorkflowShellPage = class WorkflowShellPage extends BasePage {
	/**
	 * @param {import('@playwright/test').Page} page
	 * @param {{journalPath?: string}} [opts]
	 */
	constructor(page, {journalPath = 'publicknowledge'} = {}) {
		super(page);
		this.journalPath = journalPath;
	}

	/** The localized no-access sentence (user.authorization.accessibleWorkflowStage). */
	static get NO_ACCESS_SENTENCE() {
		return "You don't currently have access to that stage of the workflow.";
	}

	/** The workflow side modal (scoping root — do not assert visibility on it). */
	modal() {
		return this.page.locator('[data-cy="active-modal"]').first();
	}

	/**
	 * Open the EDITORIAL shell for a submission (dashboard/editorial
	 * deep link).
	 *
	 * @param {number|string} submissionId
	 */
	async gotoEditorial(submissionId) {
		await this.page.goto(
			`/index.php/${this.journalPath}/en/dashboard/editorial?workflowSubmissionId=${submissionId}`,
			{waitUntil: 'commit'},
		);
	}

	/**
	 * Open the author's TRACKING view for their own submission
	 * (dashboard/mySubmissions deep link).
	 *
	 * @param {number|string} submissionId
	 */
	async gotoTracking(submissionId) {
		await this.page.goto(
			`/index.php/${this.journalPath}/en/dashboard/mySubmissions?workflowSubmissionId=${submissionId}`,
			{waitUntil: 'commit'},
		);
	}

	/** The panel header (id / authors / title / bubble / header tools). */
	header() {
		return this.modal().locator('[data-cy="sidemodal-header"]').first();
	}

	/** The stage indicator's colored dot (assert its bg-stage-* class). */
	indicatorDot() {
		return this.header().locator('span[class*="bg-stage-"]').first();
	}

	/**
	 * A header tool button (Activity Log, Library, Preview, View).
	 *
	 * @param {string} name
	 */
	headerButton(name) {
		return this.header().getByRole('button', {name, exact: true});
	}

	/** The left-hand stage menu. */
	nav() {
		return this.modal().locator('nav').first();
	}

	/**
	 * A menu entry by its exact label ("Submission", "Review",
	 * "Review Round 2", "Copyediting", "Production", "Publication", ...).
	 *
	 * @param {string} label
	 */
	menuItem(label) {
		return this.nav().getByRole('link', {name: label, exact: true});
	}

	/**
	 * Select a menu entry.
	 *
	 * @param {string} label
	 */
	async clickMenu(label) {
		await this.menuItem(label).click();
	}

	/**
	 * The content-pane heading ("Workflow: {stage}"). CSS-uppercased in
	 * the DOM, hence the case-insensitive match; regex-escapes the text.
	 *
	 * @param {string} text e.g. 'Workflow: Review (Round 1)'
	 */
	contentHeading(text) {
		const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		return this.modal().getByRole('heading', {
			name: new RegExp(`^${escaped}$`, 'i'),
		});
	}

	/** The primary content column (status boxes + stage panels). */
	primaryItems() {
		return this.modal().locator('[data-cy="workflow-primary-items"]');
	}

	/** The side column (Participants etc.) — only rendered when non-empty. */
	secondaryItems() {
		return this.modal().locator('[data-cy="workflow-secondary-items"]');
	}

	/** The decision action rail — only rendered when non-empty. */
	actionItems() {
		return this.modal().locator('[data-cy="workflow-action-items"]');
	}

	/**
	 * Assert the currently-open stage renders ONLY the bare no-access
	 * sentence (rule 7): no "Status" box framing, no panels, no side
	 * column, no action buttons.
	 */
	async expectNoAccessOnly() {
		await expect(this.primaryItems()).toHaveText(
			new RegExp(
				`^\\s*${WorkflowShellPage.NO_ACCESS_SENTENCE.replace(/[.*+?^${}()|[\]\\']/g, '\\$&')}\\s*$`,
			),
			{timeout: 20_000},
		);
		await expect(
			this.primaryItems().getByRole('heading', {name: 'Status'}),
		).toHaveCount(0);
		await expect(this.secondaryItems()).toHaveCount(0);
		await expect(this.actionItems()).toHaveCount(0);
	}

	/**
	 * Assert the status box for a stage the submission hasn't reached
	 * (rule 8, first bullet): a "Status"-framed box reading
	 * "The {stage} stage has not yet been initiated."
	 *
	 * @param {string} stageName localized stage name, e.g. 'Copyediting'
	 */
	async expectStageNotStarted(stageName) {
		await expect(
			this.primaryItems().getByText(
				`The ${stageName} stage has not yet been initiated.`,
			),
		).toBeVisible({timeout: 20_000});
		await expect(
			this.primaryItems().getByRole('heading', {name: 'Status'}),
		).toBeVisible();
	}
};
