// @ts-check
const {expect} = require('@playwright/test');
const {BasePage} = require('./BasePage.js');

/**
 * POM for the submissions dashboards — shared across apps; the dashboard
 * page, its views, filters and search are driven by pkp-lib
 * (lib/ui-library/src/pages/dashboard/).
 *
 * Covers the three dashboard pages:
 *   /dashboard/editorial          (editors, managers, assistants, admin)
 *   /dashboard/reviewAssignments  (reviewers)
 *   /dashboard/mySubmissions      (authors)
 *
 * UI realities encoded here:
 * - The search box reacts to (debounced) keyup only — `fill()` never
 *   fires the search. `search()` uses `pressSequentially()`.
 * - The view heading is `${view name} (${count})` — match by name
 *   substring, never by count (the shared DB accumulates rows).
 * - Active filter chips render a remove button whose accessible name is
 *   `Clear filter: ${fieldLabel}: ${label}`.
 */
exports.DashboardPage = class DashboardPage extends BasePage {
	/**
	 * @param {import('@playwright/test').Page} page
	 * @param {{journal?: string}} [opts]
	 */
	constructor(page, {journal = 'publicknowledge'} = {}) {
		super(page);
		this.journal = journal;
		this.nav = page.locator('nav#app-nav');
		this.searchInput = page.locator('.pkpSearch__input');
		this.clearSearchButton = page.getByRole('button', {
			name: 'Clear search phrase',
		});
		this.filterButton = page.getByRole('button', {name: 'Filters', exact: true});
		this.clearFiltersButton = page.getByRole('button', {name: 'Clear Filters'});
		// Side modals (filters, workflow) — the wrapper reports
		// `visibility: hidden` during transitions; anchor assertions on
		// inner content and use this only for scoping.
		this.activeModal = page.locator('[data-cy="active-modal"]').first();
	}

	/**
	 * Build a dashboard URL.
	 *
	 * @param {'editorial'|'reviewAssignments'|'mySubmissions'} op
	 * @param {{view?: string, workflowSubmissionId?: number|string}} [opts]
	 */
	url(op, {view, workflowSubmissionId} = {}) {
		const params = new URLSearchParams();
		if (view) params.set('currentViewId', view);
		if (workflowSubmissionId) {
			params.set('workflowSubmissionId', String(workflowSubmissionId));
		}
		const query = params.toString();
		return `/index.php/${this.journal}/en/dashboard/${op}${query ? `?${query}` : ''}`;
	}

	/** @param {{view?: string, workflowSubmissionId?: number|string}} [opts] */
	async gotoEditorial(opts) {
		await this.page.goto(this.url('editorial', opts));
	}

	/** @param {{view?: string, workflowSubmissionId?: number|string}} [opts] */
	async gotoReviewAssignments(opts) {
		await this.page.goto(this.url('reviewAssignments', opts));
	}

	/** @param {{view?: string, workflowSubmissionId?: number|string}} [opts] */
	async gotoMySubmissions(opts) {
		await this.page.goto(this.url('mySubmissions', opts));
	}

	/**
	 * The page h1 — `${view name} (${count})`. Match by name, never count.
	 *
	 * @param {string|RegExp} name
	 */
	viewHeading(name) {
		return this.page.getByRole('heading', {name});
	}

	/**
	 * A table row containing the given marker text (typically a tagged
	 * submission title).
	 *
	 * @param {string} marker
	 */
	row(marker) {
		return this.page.getByRole('row').filter({hasText: marker});
	}

	/**
	 * A view entry in the side nav. Its text includes the count badge,
	 * e.g. "3 Assigned to me".
	 *
	 * @param {string} label
	 */
	navItem(label) {
		return this.nav.locator('a').filter({hasText: label});
	}

	/**
	 * Narrow the list server-side by a unique whitespace-free token.
	 * The search listens on debounced keyup — type it, don't fill it.
	 *
	 * @param {string} token
	 */
	async search(token) {
		await expect(this.searchInput).toBeVisible({timeout: 15_000});
		await this.searchInput.fill('');
		await this.searchInput.pressSequentially(token);
	}

	/** Clear the search phrase via the dedicated clear button. */
	async clearSearch() {
		await this.clearSearchButton.click();
	}

	/** Open the filters side modal. */
	async openFilters() {
		await this.filterButton.click();
	}

	/** Apply the filters configured in the open filters modal. */
	async applyFilters() {
		await this.activeModal
			.getByRole('button', {name: 'Apply Filters'})
			.click();
	}

	/**
	 * The remove button of an active-filter chip, e.g.
	 * filterChip('Section', 'Articles').
	 *
	 * @param {string} fieldLabel
	 * @param {string} label
	 */
	filterChip(fieldLabel, label) {
		return this.page.getByRole('button', {
			name: `Clear filter: ${fieldLabel}: ${label}`,
		});
	}
};
