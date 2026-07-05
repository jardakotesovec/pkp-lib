// @ts-check
const {expect} = require('@playwright/test');
const {BasePage} = require('./BasePage.js');

/**
 * The 3.6 invitation framework (shared across OJS/OMP/OPS): the manager's
 * send wizard + pending-invitation manager, and the public accept/decline
 * wizard the invitee drives from the emailed link.
 *
 * Two surfaces, one POM (instantiate against whichever page/context is
 * acting):
 *   - MANAGER side — `new InvitationPage(managerPage, path)`: `gotoCreate()`
 *     mounts the real send wizard (VUE-user-invitation-page) to prove
 *     reachability, then `createInvitation()` drives the exact create-side
 *     API the wizard store POSTs — add → populate(roles+name) → getMailable →
 *     populate(emailComposer) → invite. The emailComposer step is REQUIRED:
 *     without it `getMailable()` leaves the body empty and the sent mail
 *     carries NO accept/decline URLs (spec Open-Q5, live-confirmed) — so the
 *     wizard (and this helper) always populate it from the composed mailable.
 *   - INVITEE side — `new InvitationPage(anonPage, path)`: `acceptAsNewUser()`
 *     drives the real 3-step accept wizard (account details → your details →
 *     review) for a brand-new account; `acceptAsExistingUser()` drives the
 *     1-step review; `confirmDecline()` drives the decline confirmation POST.
 *   - MANAGER list — `gotoManager()` opens Users & Roles (the
 *     <user-invitation-manager> list) and `cancelInvitation()` drives the
 *     row menu → confirm dialog → cancel PUT.
 *
 * There are NO data-cy hooks in the invitation Vue components — everything is
 * located by role + accessible name (button labels are the en `.po` strings).
 */
exports.InvitationPage = class InvitationPage extends BasePage {
	/**
	 * @param {import('@playwright/test').Page} page
	 * @param {string} contextPath  journal/press/server urlPath
	 */
	constructor(page, contextPath) {
		super(page);
		this.contextPath = contextPath;
		this.api = `/index.php/${contextPath}/api/v1/invitations`;

		// Send wizard (manager). "Search User" is both the step-rail pill
		// ("1 Search User") and the step-1 primary button — anchor exact.
		this.searchUserButton = page.getByRole('button', {name: 'Search User', exact: true});
		// Accept wizard (invitee)
		this.saveAndContinue = page.getByRole('button', {name: 'Save and continue'});
		this.acceptButton = page.getByRole('button', {name: 'Accept And Continue to OJS'});
		this.successButton = page.getByRole('button', {name: 'View All Submissions'});
		// Decline confirmation page
		this.declineHeading = page.getByRole('heading', {name: 'Decline Invitation'});
		this.confirmDeclineButton = page.getByRole('button', {name: 'Confirm Decline Invitation'});
		// "Invitation Unavailable" soft-landing page
		this.unavailableHeading = page.getByRole('heading', {name: 'Invitation Unavailable'});
		// Pending-invitation manager list
		this.invitationsHeading = page.getByRole('heading', {name: /Invitations \(\d+\)/});
	}

	// ── manager: send wizard ───────────────────────────────────────────────

	/** Open the real send wizard and confirm it mounted (step 1 button). */
	async gotoCreate() {
		await this.page.goto(
			`/index.php/${this.contextPath}/invitation/create/userRoleAssignment`,
		);
		await expect(this.searchUserButton).toBeVisible({timeout: 20_000});
	}

	/** The session CSRF token from a loaded backend page. */
	async csrf() {
		await this.page.waitForFunction(
			() => !!window.pkp?.currentUser?.csrfToken,
			null,
			{timeout: 15_000},
		);
		return this.page.evaluate(() => window.pkp.currentUser.csrfToken);
	}

	/**
	 * POST the create-side `add` (the wizard's first API call). Returns the
	 * raw response so callers can assert refusal (permission tests).
	 *
	 * @param {object} opts
	 * @param {string=} opts.inviteeEmail  new invitee (xor userId)
	 * @param {number=} opts.userId        existing user (xor inviteeEmail)
	 * @param {import('@playwright/test').APIRequestContext=} opts.request
	 * @param {string=} opts.csrf
	 */
	async add({inviteeEmail, userId, request, csrf}) {
		const req = request ?? this.page.request;
		const headers = {'Content-Type': 'application/json'};
		if (csrf) headers['X-Csrf-Token'] = csrf;
		return req.post(`${this.api}/add/userRoleAssignment`, {
			headers,
			data: {invitationData: userId ? {userId} : {inviteeEmail}},
		});
	}

	/**
	 * Drive the full create-side flow the send wizard performs — add →
	 * populate(roles + name) → getMailable → populate(emailComposer) →
	 * invite — and return `{invitationId, status, invitation, mailable}`
	 * (invitation = the invite response, PENDING with a 3-day expiry).
	 *
	 * @param {object} opts
	 * @param {string=} opts.inviteeEmail  new invitee (xor userId)
	 * @param {number=} opts.userId        existing user (xor inviteeEmail)
	 * @param {number} opts.userGroupId    the role (user group) to grant
	 * @param {import('@playwright/test').APIRequestContext=} opts.request
	 * @param {string=} opts.givenName     new-invitee given name (ignored for userId)
	 * @param {string=} opts.familyName    new-invitee family name (ignored for userId)
	 * @param {boolean=} opts.masthead
	 * @param {string=} opts.dateStart     YYYY-MM-DD (defaults today)
	 */
	async createInvitation({
		inviteeEmail,
		userId,
		userGroupId,
		request,
		givenName = 'Invited',
		familyName = 'Person',
		masthead = false,
		dateStart,
	}) {
		const req = request ?? this.page.request;
		const csrf = await this.csrf();
		const headers = {'X-Csrf-Token': csrf, 'Content-Type': 'application/json'};
		const start = dateStart ?? new Date().toISOString().slice(0, 10);

		const addRes = await this.add({inviteeEmail, userId, request: req, csrf});
		if (!addRes.ok()) {
			throw new Error(`invitation add failed: ${addRes.status()} ${await addRes.text()}`);
		}
		const {invitationId} = await addRes.json();

		const populatePayload = {
			userGroupsToAdd: [{userGroupId, dateStart: start, dateEnd: null, masthead}],
		};
		if (!userId) {
			populatePayload.givenName = {en: givenName};
			populatePayload.familyName = {en: familyName};
		}
		const pop = await req.put(`${this.api}/${invitationId}/populate`, {
			headers,
			data: {invitationData: populatePayload},
		});
		if (!pop.ok()) {
			throw new Error(`invitation populate failed: ${pop.status()} ${await pop.text()}`);
		}

		// The wizard's email step: seed the composer from the composed mailable
		// (its body carries the accept/decline URL template vars). Required —
		// see class note / spec Open-Q5.
		const mj = await (await req.get(`${this.api}/${invitationId}/getMailable`)).json();
		await req.put(`${this.api}/${invitationId}/populate`, {
			headers,
			data: {invitationData: {emailComposer: {subject: mj.mailable.subject, body: mj.mailable.body}}},
		});

		const invRes = await req.put(`${this.api}/${invitationId}/invite`, {headers, data: {}});
		const invitation = invRes.ok() ? await invRes.json() : null;
		return {invitationId, status: invRes.status(), invitation, mailable: mj.mailable};
	}

	/** Cancel an invitation via the create-side API (manager). */
	async cancelViaApi(invitationId, {request, csrf} = {}) {
		const req = request ?? this.page.request;
		const token = csrf ?? (await this.csrf());
		return req.put(`${this.api}/${invitationId}/cancel`, {
			headers: {'X-Csrf-Token': token, 'Content-Type': 'application/json'},
			data: {},
		});
	}

	/** GET the public receive endpoint (used to assert non-pending refusal). */
	async receiveViaApi(invitationId, key, {request} = {}) {
		const req = request ?? this.page.request;
		return req.get(`${this.api}/${invitationId}/key/${key}`);
	}

	// ── invitee: accept wizard ─────────────────────────────────────────────

	async gotoAccept(url) {
		return this.page.goto(url);
	}

	/**
	 * Drive the NEW-invitee 3-step accept wizard: account details
	 * (username/password/consent) → your details (name/country) → review →
	 * accept. Leaves the success modal on screen.
	 *
	 * @param {object} opts
	 * @param {string} opts.username
	 * @param {string} opts.password
	 * @param {string=} opts.givenName
	 * @param {string=} opts.familyName
	 * @param {string=} opts.country  ISO alpha-2 (defaults 'US')
	 */
	async acceptAsNewUser({username, password, givenName = 'Newby', familyName = 'Invitee', country = 'US'}) {
		// Step 1 — Create OJS account.
		await expect(this.saveAndContinue).toBeVisible({timeout: 20_000});
		await this.page.locator('input[name="username"]').fill(username);
		await this.page.locator('input[name="password"]').fill(password);
		await this.page.locator('input[name="privacyStatement"]').check();
		await this.saveAndContinue.click();

		// Step 2 — Enter details. The country select is a step-2-only field, so
		// its visibility gates that the wizard advanced (all step forms are in
		// the DOM; only the active step's are shown).
		const country2 = this.page.locator('select[name="userCountry"]');
		await expect(country2).toBeVisible({timeout: 20_000});
		const given = this.page.locator('input[name^="givenName"]');
		const givenCount = await given.count();
		for (let i = 0; i < givenCount; i++) await given.nth(i).fill(givenName);
		const family = this.page.locator('input[name^="familyName"]');
		const familyCount = await family.count();
		for (let i = 0; i < familyCount; i++) await family.nth(i).fill(familyName);
		await country2.selectOption(country);
		await this.saveAndContinue.click();

		// Step 3 — Review & create account.
		await expect(this.acceptButton).toBeVisible({timeout: 20_000});
		await this.acceptButton.click();
		await expect(this.successButton).toBeVisible({timeout: 20_000});
	}

	/**
	 * Drive the EXISTING-user 1-step accept (review → accept). Leaves the
	 * success modal on screen.
	 */
	async acceptAsExistingUser() {
		await expect(this.acceptButton).toBeVisible({timeout: 20_000});
		await this.acceptButton.click();
		await expect(this.successButton).toBeVisible({timeout: 20_000});
	}

	// ── invitee: decline ───────────────────────────────────────────────────

	async gotoDecline(url) {
		return this.page.goto(url);
	}

	/** Click the confirm-decline button (a real POST + CSRF form submit). */
	async confirmDecline() {
		await expect(this.confirmDeclineButton).toBeVisible({timeout: 15_000});
		await this.confirmDeclineButton.click();
	}

	// ── manager: pending-invitation list ───────────────────────────────────

	async gotoManager() {
		await this.page.goto(
			`/index.php/${this.contextPath}/management/settings/access`,
		);
		await expect(this.invitationsHeading).toBeVisible({timeout: 20_000});
	}

	/** A pending-invitation row located by visible text (email / name). */
	invitationRow(text) {
		return this.page.locator('tr', {hasText: text});
	}

	/**
	 * Cancel a pending invitation through the real UI: row More-Actions menu
	 * → "Cancel Invite" → confirm dialog "Cancel Invitation". Waits on the
	 * cancel request (tunnelled as POST via X-Http-Method-Override).
	 *
	 * @param {string} text  a unique cell value of the target row (the email)
	 */
	async cancelInvitation(text) {
		const row = this.invitationRow(text).first();
		await expect(row).toBeVisible({timeout: 20_000});
		await row.getByRole('button', {name: 'Invitation management options'}).click();
		await this.page.getByRole('menuitem', {name: 'Cancel Invite'}).click();
		const dialog = this.page.locator('[data-cy="dialog"]');
		await expect(dialog).toBeVisible({timeout: 10_000});
		const cancelResp = this.page.waitForResponse((r) =>
			/\/invitations\/\d+\/cancel/.test(r.url()),
		);
		await dialog.getByRole('button', {name: 'Cancel Invitation'}).click();
		await cancelResp;
	}

	// ── static: pull the action links out of the invitation email ──────────

	/** @param {string} html */
	static extractAcceptUrl(html) {
		const m = html.match(/href=['"]([^'"]*invitation\/accept[^'"]*)['"]/i);
		if (!m) throw new Error('accept URL not found in the invitation email');
		return m[1];
	}

	/** @param {string} html */
	static extractDeclineUrl(html) {
		const m = html.match(/href=['"]([^'"]*invitation\/decline[^'"]*)['"]/i);
		if (!m) throw new Error('decline URL not found in the invitation email');
		return m[1];
	}

	/** Parse `{id, key}` from an accept/decline URL. */
	static parseIdKey(url) {
		const id = url.match(/[?&]id=(\d+)/);
		const key = url.match(/[?&]key=([^&]+)/);
		return {id: id ? Number(id[1]) : null, key: key ? key[1] : null};
	}
};
