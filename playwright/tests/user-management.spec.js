// @ts-check
const {test, expect} = require('../support/base-test.js');
const {UserManagementPage} = require('../pages/UserManagementPage.js');
const {setTinyMceContent} = require('../support/tinymce.js');

/**
 * User management — docs/e2e/plans/user-management.md rows 1–8.
 *
 * Every test runs on its OWN scratch journal with throwaway users seeded
 * through the journal scenario's `users[]` (entries carrying `password`
 * are CREATED by UserAssignmentProcessor; entries without it look up the
 * existing baseline user). Disable/remove/merge are destructive, so the
 * 16 shared seeded users are never the target of any mutation here —
 * dbarnes only ever acts as the scratch journal's manager (a per-journal
 * role) and admin (row 6) only drives the merge UI. Throwaways log in
 * through the real login form with non-default passwords, never via
 * `asUser` (charter principle 7 + the wave-8 user-profile convention).
 *
 * Surface ground truth (verified against live sources; see also the
 * UserManagementPage POM doc-comment):
 *  - Row actions (useUserAccessManagerConfig.js): Edit + Email always;
 *    on non-self rows Login As (user.canLoginAs), Remove User (any
 *    active group), Disable/Enable User, Merge user (user.canMergeUsers).
 *    The self row is gated by getCurrentUserId() !== user.id, so a
 *    manager's own row offers ONLY Edit + Email.
 *  - canLoginAs/canMergeUsers (classes/user/maps/Schema.php) resolve via
 *    Validation::getAdministrationLevel — a SITE ADMIN target is
 *    ADMINISTRATION_PROHIBITED for a non-admin manager, so Login As /
 *    Merge user are absent on the admin's row (row 7). NOTE (candidate
 *    app finding): Remove User / Disable User still RENDER on the admin
 *    row — useUserAccessManagerConfig gates them only on groups/self —
 *    while the legacy backend ops would reject with
 *    `grid.user.cannotAdminister`. Not asserted either way.
 *  - Email / disable ops open legacy UserGridHandler side modals
 *    (AjaxModalWrapper): form#sendEmailForm (subject required
 *    client-side via jquery.validate; the rich `message` textarea is
 *    HIDDEN once TinyMCE mounts, so jquery.validate's default
 *    `ignore: ':hidden'` skips it and an empty body round-trips to the
 *    server, which answers JSONMessage(false, validator.filled) —
 *    surfaced as a NATIVE alert() by Handler.handleJson) and
 *    form#userDisableForm (disableReason textarea; submit label OK via
 *    `button.submitFormButton`). Successful submits fire formSubmitted →
 *    AjaxModalWrapper closes the modal and the store refetches the list.
 *  - Remove User uses a Vue confirm dialog (manager.people.confirmRemove)
 *    and POSTs remove-user, which date_end's every active group in the
 *    context — the account itself survives site-wide. The row does NOT
 *    leave the list: the store queries status=all, and the collector
 *    widens userUserGroupStatus to ALL for status=all
 *    (lib/pkp/classes/user/Collector.php:500-502), so role-less users
 *    stay listed with an empty Roles cell (deviation from the plan's
 *    "disappears from the Users list" — the legacy grid only showed
 *    no-role users behind an explicit includeNoRole filter).
 *  - Merge user opens the legacy user grid in a side modal (title
 *    'Merge into this User'); the target row's hidden controls
 *    (a.show_extras, patterns.md pitfall 9) expose the 'Merge into this
 *    User' link → Vue confirm (OK) → mergeUsers POST. Repo::user()
 *    ->mergeUsers transfers groups/stage assignments to the target and
 *    DELETES the old user; the userMerged global event closes the modal
 *    and refetches the Vue list.
 *  - Single-role removal lives in the Edit-user wizard
 *    (UserInvitationUserGroupsTable "Remove Role" → confirm dialog →
 *    PUT users/{id}/endRole/{userGroupId}, immediate, no invitation);
 *    the last active role is guarded by user.removeRole.roleRemainMessage.
 *  - Disabled-account logins re-render the login form with
 *    user.login.accountDisabledWithReason in `.pkp_form_error`
 *    (LoginHandler.php:205, userLogin.tpl:34-38). Authorization failures
 *    on the page router redirect to /user/authorizationDenied
 *    (PKPPageRouter::handleAuthorizationFailure).
 *  - The list pages at 25 (UserAccessManagerStore countPerPage) and the
 *    "Current Users (N)" heading carries the fetch's itemCount.
 *  - Every scratch journal includes ONE extra row beyond the seeded
 *    users[]: ContextBuilderProcessor routes journal creation through
 *    PKPContextService::add(), which enrolls the creating user (admin)
 *    as the journal's first manager — parity with real journal
 *    creation. All count expectations below include that admin row.
 *
 * Mailpit discipline (charter principle 8): the only mail assertion
 * (row 2) is scoped by the throwaway recipient + the test's unique tag.
 * clearAll() is never called.
 */

test.use({user: 'dbarnes'});

function uniqueTag(suffix) {
	const rand = Math.random().toString(36).slice(2, 8);
	return `um-w${test.info().parallelIndex}-${suffix}-${rand}`;
}

/**
 * Throwaway user derived from the tag. The familyName embeds the tag so
 * the full name is searchable by a unique whitespace-free token; the
 * password is non-default so an accidental asUser(username) fails loudly
 * (wave-8 convention).
 *
 * @param {string} tag
 * @param {number} [n]
 * @param {{affiliation?: string}} [extra]
 */
function throwawayUser(tag, n = 1, extra = {}) {
	const clean = tag.replace(/[^a-z0-9]/gi, '');
	const username = `u${n}${clean}`;
	const givenName = `Given${n}`;
	const familyName = `Fam${n}${clean}`;
	return {
		username,
		email: `${username}@mailinator.com`,
		password: `pw-${tag}`,
		givenName,
		familyName,
		fullName: `${givenName} ${familyName}`,
		...extra,
	};
}

/** users[] spec entry for a throwaway (drops the derived fullName). */
function userSpec(user, roles) {
	const {fullName, ...spec} = user;
	return {...spec, roles};
}

/**
 * Fresh, explicitly-anonymous page. `browser.newContext()` inherits the
 * file-level storageState (patterns.md rule 8 — it bit two wave-6
 * agents), so the empty state is passed explicitly. Caller closes the
 * context.
 *
 * @param {import('@playwright/test').Browser} browser
 * @param {string} baseURL
 */
async function freshAnonymousPage(browser, baseURL) {
	const context = await browser.newContext({
		baseURL,
		storageState: {cookies: [], origins: []},
	});
	return context.newPage();
}

/**
 * Drive the journal-level login form; asserting the outcome (dashboard
 * vs error vs disabled message) is the caller's job.
 *
 * @param {import('@playwright/test').Page} page
 */
async function login(page, contextPath, username, password) {
	await page.goto(`/index.php/${contextPath}/login`);
	await page.locator('input#username').fill(username);
	await page.locator('input#password').fill(password);
	await page.locator('form#login button').click();
}

/** Wait until the login form's redirect lands anywhere but /login. */
async function expectLoggedIn(page) {
	await page.waitForURL((url) => !url.pathname.includes('/login'), {
		timeout: 20_000,
		waitUntil: 'commit',
	});
}

test.describe('User management', () => {
	// Row 1
	test(
		'users list renders seeded users and search narrows results',
		{tag: '@smoke'},
		async ({page, pkpApi}) => {
			const tag = uniqueTag('list');
			const u1 = throwawayUser(tag, 1, {affiliation: 'Scenario Lab One'});
			const u2 = throwawayUser(tag, 2, {affiliation: 'Scenario Lab Two'});
			const {context} = await pkpApi.createJournal({
				tag,
				name: {en: `User mgmt ${tag}`},
				users: [
					{username: 'dbarnes', roles: ['manager']},
					userSpec(u1, ['author']),
					userSpec(u2, ['reviewer']),
				],
			});

			const um = new UserManagementPage(page, context.path);
			await um.goto();

			// Columns (scoped to the users table — the Invitations table
			// above shares the Name/Email headers).
			for (const column of ['Name', 'Email', 'Roles', 'Start Date', 'Affiliation']) {
				await expect(
					um.usersTable.getByRole('columnheader', {name: column, exact: true}),
				).toBeVisible();
			}

			// All seeded users counted (3 seeded + the auto-enrolled admin
			// manager) and rendered with their data.
			await expect(um.usersHeading(4)).toBeVisible();
			const row1 = um.rowFor(u1.fullName);
			await expect(row1).toBeVisible();
			await expect(row1).toContainText(u1.email);
			await expect(row1).toContainText('Author');
			await expect(row1).toContainText('Scenario Lab One');
			const row2 = um.rowFor(u2.fullName);
			await expect(row2).toContainText('Reviewer');
			await expect(um.rowFor('Daniel Barnes')).toContainText('Journal manager');

			// Search by (unique) family name narrows to one row.
			await um.search(u1.familyName);
			await expect(um.usersHeading(1)).toBeVisible();
			await expect(um.rowFor(u1.fullName)).toBeVisible();
			await expect(um.rowFor(u2.fullName)).toHaveCount(0);

			// Clearing the search restores the full list and count.
			await um.clearSearch();
			await expect(um.usersHeading(4)).toBeVisible();
			await expect(um.rowFor(u2.fullName)).toBeVisible();

			// Search by email narrows to the matching user.
			await um.search(u2.email);
			await expect(um.usersHeading(1)).toBeVisible();
			await expect(um.rowFor(u2.fullName)).toBeVisible();
			await expect(um.rowFor(u1.fullName)).toHaveCount(0);
		},
	);

	// Row 2
	test(
		'email a user from the row action',
		{tag: '@regression'},
		async ({page, pkpApi, pkpMail}) => {
			const tag = uniqueTag('mail');
			const u1 = throwawayUser(tag, 1);
			const subject = `Hello-${tag}`;
			const bodyText = `Row action email body ${tag}`;
			const {context} = await pkpApi.createJournal({
				tag,
				name: {en: `User mgmt ${tag}`},
				users: [
					{username: 'dbarnes', roles: ['manager']},
					userSpec(u1, ['author']),
				],
			});

			const um = new UserManagementPage(page, context.path);
			await um.goto();
			await um.clickRowAction(um.rowFor(u1.fullName), 'Email');

			const form = um.activeModal.locator('form#sendEmailForm');
			await expect(form).toBeVisible({timeout: 15_000});
			// The To display names the target user.
			await expect(form.locator('input[name="user"]')).toHaveValue(
				new RegExp(u1.email),
			);

			// Empty subject: client-side jquery.validate blocks the submit
			// (error label renders after the deferred showErrors); the
			// modal stays open.
			await form.locator('button.submitFormButton').click();
			await expect(form.locator('label.error')).toBeVisible();
			await expect(form).toBeVisible();

			// Subject filled, body still empty: the hidden TinyMCE-backed
			// textarea escapes client-side validation, the server rejects
			// with validator.filled, surfaced as a native alert().
			await form.locator('input[name="subject"]').fill(subject);
			let alertText = '';
			page.once('dialog', async (dialog) => {
				alertText = dialog.message();
				await dialog.accept();
			});
			await form.locator('button.submitFormButton').click();
			await expect.poll(() => alertText, {timeout: 15_000}).toContain(
				'This field is required.',
			);
			await expect(form).toBeVisible();

			// Body via TinyMCE → send succeeds, modal closes.
			const messageId = await form
				.locator('textarea[name="message"]')
				.getAttribute('id');
			if (!messageId) {
				throw new Error('sendEmailForm message textarea has no id');
			}
			await setTinyMceContent(page, messageId, `<p>${bodyText}</p>`);
			await form.locator('button.submitFormButton').click();
			await expect(um.activeModal).toHaveCount(0, {timeout: 15_000});

			// Delivery, scoped to the throwaway recipient + unique tag.
			const [message] = await pkpMail.find({
				to: u1.email,
				contains: tag,
				timeoutMs: 20_000,
			});
			expect(message.Subject).toBe(subject);
		},
	);

	// Row 3
	test(
		'disable a user with a reason; enable restores access',
		{tag: '@regression'},
		async ({page, pkpApi, browser, baseURL}) => {
			const tag = uniqueTag('dis');
			const u1 = throwawayUser(tag, 1);
			const reason = `disabled-${tag}`;
			const {context} = await pkpApi.createJournal({
				tag,
				name: {en: `User mgmt ${tag}`},
				users: [
					{username: 'dbarnes', roles: ['manager']},
					userSpec(u1, ['author']),
				],
			});

			const um = new UserManagementPage(page, context.path);
			await um.goto();
			const row = um.rowFor(u1.fullName);
			await um.clickRowAction(row, 'Disable User');

			// Disable modal records a reason (title: "Disable {fullName}").
			await expect(um.activeModal).toContainText(`Disable ${u1.fullName}`);
			const form = um.activeModal.locator('form#userDisableForm');
			await expect(form).toBeVisible({timeout: 15_000});
			await form.locator('textarea[name="disableReason"]').fill(reason);
			await form.locator('button.submitFormButton').click();
			await expect(um.activeModal).toHaveCount(0, {timeout: 15_000});

			// The refetched row carries the disabled marker (the
			// text-negative DisableUser icon in the Name cell).
			await expect(row.locator('span.text-negative')).toBeVisible();

			// Disabled login is rejected with the recorded reason.
			const anon = await freshAnonymousPage(browser, baseURL);
			await login(anon, context.path, u1.username, u1.password);
			await expect(anon.locator('.pkp_form_error')).toContainText(
				`Your account has been disabled for the following reason: ${reason}`,
			);

			// The row action now reads Enable User; enabling restores login.
			await um.clickRowAction(row, 'Enable User');
			await expect(um.activeModal).toContainText(`Enable ${u1.fullName}`);
			const enableForm = um.activeModal.locator('form#userDisableForm');
			await expect(enableForm).toBeVisible({timeout: 15_000});
			await enableForm.locator('button.submitFormButton').click();
			await expect(um.activeModal).toHaveCount(0, {timeout: 15_000});
			await expect(row.locator('span.text-negative')).toHaveCount(0);

			await login(anon, context.path, u1.username, u1.password);
			await anon.waitForURL(/\/dashboard\//, {
				timeout: 20_000,
				waitUntil: 'commit',
			});
			await anon.context().close();
		},
	);

	// Row 4
	test(
		'remove a single role from a multi-role user via the edit-user wizard',
		{tag: '@regression'},
		async ({page, pkpApi, browser, baseURL}) => {
			const tag = uniqueTag('role');
			const u1 = throwawayUser(tag, 1);
			const {context} = await pkpApi.createJournal({
				tag,
				name: {en: `User mgmt ${tag}`},
				users: [
					{username: 'dbarnes', roles: ['manager']},
					userSpec(u1, ['manager', 'author']),
				],
			});

			// Baseline: the throwaway's manager gate is OPEN (so the
			// post-removal denial below proves the gate actually closed).
			const anon = await freshAnonymousPage(browser, baseURL);
			await login(anon, context.path, u1.username, u1.password);
			await expectLoggedIn(anon);
			await anon.goto(`/index.php/${context.path}/dashboard/editorial`);
			await expect(anon).toHaveURL(/\/dashboard\/editorial/);

			// Manager opens the Edit-user wizard from the row.
			const um = new UserManagementPage(page, context.path);
			await um.goto();
			const row = um.rowFor(u1.fullName);
			await expect(row).toContainText('Journal manager');
			await expect(row).toContainText('Author');
			await um.clickRowAction(row, 'Edit');
			await page.waitForURL(/\/management\/settings\/user\/\d+/, {
				timeout: 20_000,
				waitUntil: 'commit',
			});
			await expect(
				page.getByRole('heading', {
					name: /STEP 1 - Enter details and invite for roles/,
				}),
			).toBeVisible({timeout: 15_000});

			// Remove the Journal manager role. The current-role rows are
			// the ones carrying a Remove Role button (the pre-rendered
			// empty add-role row contains every role name inside its
			// <select> options, hence the has-button filter).
			const removeButton = page.getByRole('button', {
				name: 'Remove Role',
				exact: true,
			});
			const managerRow = page
				.locator('tr')
				.filter({hasText: 'Journal manager'})
				.filter({has: removeButton});
			await managerRow
				.getByRole('button', {name: 'Remove Role', exact: true})
				.click();
			const confirm = page.getByRole('dialog');
			await expect(confirm).toContainText(
				'Are you sure you want to remove this role?',
			);
			await confirm
				.getByRole('button', {name: 'Remove Role', exact: true})
				.click();

			// reloadCurrentUser re-renders the role table: the ended role
			// shows the removed badge, the Author role keeps its button.
			await expect(page.getByText('User Removed From Role')).toBeVisible({
				timeout: 15_000,
			});
			await expect(removeButton).toHaveCount(1);

			// Last-role guard: removing the only remaining role is blocked.
			await removeButton.click();
			const guard = page.getByRole('dialog');
			await expect(guard).toContainText(
				'At least one role must be assigned to the user.',
			);
			await guard.getByRole('button', {name: 'Close', exact: true}).click();

			// The users list shows only the remaining role.
			await um.goto();
			const refreshedRow = um.rowFor(u1.fullName);
			await expect(refreshedRow).toContainText('Author');
			await expect(refreshedRow).not.toContainText('Journal manager');

			// The removed role's gate is closed; the kept role's stays open.
			await anon.goto(`/index.php/${context.path}/dashboard/editorial`);
			await expect(anon).toHaveURL(/\/user\/authorizationDenied/);
			await anon.goto(`/index.php/${context.path}/dashboard/mySubmissions`);
			await expect(anon).toHaveURL(/\/dashboard\/mySubmissions/);
			await anon.context().close();
		},
	);

	// Row 5
	test(
		'remove a user from the journal strips all roles but keeps the account',
		{tag: '@regression'},
		async ({page, pkpApi, browser, baseURL}) => {
			const tag = uniqueTag('rmv');
			const u1 = throwawayUser(tag, 1);
			const {context} = await pkpApi.createJournal({
				tag,
				name: {en: `User mgmt ${tag}`},
				users: [
					{username: 'dbarnes', roles: ['manager']},
					userSpec(u1, ['manager', 'author']),
				],
			});

			const um = new UserManagementPage(page, context.path);
			await um.goto();
			// dbarnes + u1 + the auto-enrolled admin manager.
			await expect(um.usersHeading(3)).toBeVisible();

			const row = um.rowFor(u1.fullName);
			await expect(row).toContainText('Journal manager');
			await expect(row).toContainText('Author');
			await um.clickRowAction(row, 'Remove User');
			const confirm = page.getByRole('dialog');
			await expect(confirm).toContainText(
				'unenroll the user from all roles within this journal',
			);
			await confirm.getByRole('button', {name: 'OK', exact: true}).click();
			await expect(confirm).toBeHidden();

			// Every role is stripped. The row itself stays listed (the
			// store queries status=all, which also matches users whose
			// only group assignments are ended — see file doc-comment),
			// so the strip shows as an emptied Roles cell…
			await expect(row).not.toContainText('Journal manager');
			await expect(row).not.toContainText('Author');
			await expect(um.usersHeading(3)).toBeVisible();
			// …and as the Remove action disappearing from the row menu
			// (it requires an active group assignment).
			const labels = await um.rowActionLabels(row);
			expect(labels).not.toContain('Remove User');
			await um.closeRowMenu();

			// The account still authenticates site-wide…
			const anon = await freshAnonymousPage(browser, baseURL);
			await login(anon, context.path, u1.username, u1.password);
			await expectLoggedIn(anon);
			await anon.goto(`/index.php/${context.path}/user/profile`);
			await expect(anon.locator('#profileTabs')).toBeVisible({
				timeout: 15_000,
			});

			// …but every role-gated journal surface is closed.
			await anon.goto(
				`/index.php/${context.path}/management/settings/access`,
			);
			await expect(anon).toHaveURL(/\/user\/authorizationDenied/);
			await anon.goto(`/index.php/${context.path}/dashboard/mySubmissions`);
			await expect(anon).toHaveURL(/\/user\/authorizationDenied/);
			await anon.context().close();
		},
	);

	// Row 6
	test(
		'merge users reassigns content to the target account',
		{tag: '@regression'},
		async ({pkpApi, asUser, browser, baseURL}) => {
			const tag = uniqueTag('mrg');
			const uA = throwawayUser(tag, 1);
			const uB = throwawayUser(tag, 2);
			const title = `Merge-target-${tag}`;
			const {context} = await pkpApi.createJournal({
				tag,
				name: {en: `User mgmt ${tag}`},
				users: [userSpec(uA, ['author']), userSpec(uB, ['author'])],
			});
			await pkpApi.createSubmission({
				tag,
				journal: context.path,
				submitter: uA.username,
				section: 'ART',
				locale: 'en',
				submitted: true,
				publications: [{metadata: {title: {en: title}}}],
			});

			const mySubmissionsUrl = `/index.php/${context.path}/en/dashboard/mySubmissions?currentViewId=active`;

			// Baseline: B's dashboard does NOT carry A's submission.
			const bPage = await freshAnonymousPage(browser, baseURL);
			await login(bPage, context.path, uB.username, uB.password);
			await expectLoggedIn(bPage);
			await bPage.goto(mySubmissionsUrl);
			await expect(
				bPage.getByRole('heading', {name: /Active submissions/}),
			).toBeVisible({timeout: 15_000});
			await expect(bPage.getByText(title)).toHaveCount(0);

			// Site admin merges A into B from A's row action.
			const adminCtx = await asUser('admin');
			const adminPage = await adminCtx.newPage();
			const um = new UserManagementPage(adminPage, context.path);
			await um.goto();
			// uA + uB + the auto-enrolled admin manager (admin himself).
			await expect(um.usersHeading(3)).toBeVisible();
			await um.clickRowAction(um.rowFor(uA.fullName), 'Merge user');

			// The side modal hosts the legacy user grid re-titled "Merge
			// into this User"; B's row exposes the merge link behind its
			// own show_extras toggle (patterns.md pitfall 9).
			await expect(um.activeModal).toContainText('Merge into this User', {
				timeout: 15_000,
			});
			const bRow = um.activeModal.locator('tr.gridRow', {
				hasText: uB.username,
			});
			await expect(bRow).toBeVisible();
			await bRow.locator('a.show_extras').click();
			await um.activeModal
				.getByRole('link', {name: 'Merge into this User'})
				.click();

			// Legacy RemoteActionConfirmationModal bridges to a Vue dialog
			// naming both accounts; OK fires the merge. The side modal is
			// itself role="dialog" (patterns.md pitfall 6), so scope by
			// the confirm dialog's accessible name.
			const confirm = adminPage.getByRole('dialog', {name: 'Confirm'});
			await expect(confirm).toContainText(uA.username);
			await expect(confirm).toContainText(uB.username);
			await confirm.getByRole('button', {name: 'OK', exact: true}).click();

			// userMerged closes the modal and refetches the list: A gone,
			// B remains.
			await expect(um.activeModal).toHaveCount(0, {timeout: 20_000});
			await expect(um.usersHeading(2)).toBeVisible({timeout: 15_000});
			await expect(um.rowFor(uA.fullName)).toHaveCount(0);
			await expect(um.rowFor(uB.fullName)).toBeVisible();

			// A's account is deleted: the username no longer authenticates.
			const anonA = await freshAnonymousPage(browser, baseURL);
			await login(anonA, context.path, uA.username, uA.password);
			await expect(anonA.locator('.pkp_form_error')).toContainText(
				'Invalid username/email or password. Please try again.',
			);
			await anonA.context().close();

			// A's submission now attributes to B (stage assignment was
			// transferred by Repo::user()->mergeUsers).
			await bPage.goto(mySubmissionsUrl);
			await expect(bPage.getByText(title)).toBeVisible({timeout: 15_000});
			await bPage.context().close();
		},
	);

	// Row 7
	test(
		'row actions are gated for the own row and protected users',
		{tag: '@regression'},
		async ({page, pkpApi}) => {
			const tag = uniqueTag('gate');
			const u1 = throwawayUser(tag, 1);
			const {context} = await pkpApi.createJournal({
				tag,
				name: {en: `User mgmt ${tag}`},
				users: [
					{username: 'dbarnes', roles: ['manager']},
					userSpec(u1, ['author']),
				],
			});

			const um = new UserManagementPage(page, context.path);
			await um.goto();
			// The third row is the site admin: journal creation enrolls
			// him as the first Journal manager, so his row is present
			// without any explicit seeding.
			await expect(um.usersHeading(3)).toBeVisible();

			// Own row: Edit + Email only (self gate in
			// useUserAccessManagerConfig.js).
			expect(await um.rowActionLabels(um.rowFor('Daniel Barnes'))).toEqual([
				'Edit',
				'Email',
			]);
			await um.closeRowMenu();

			// Plain throwaway row: the manager has full administration, so
			// every action renders (config order).
			expect(await um.rowActionLabels(um.rowFor(u1.fullName))).toEqual([
				'Edit',
				'Email',
				'Login As',
				'Remove User',
				'Disable User',
				'Merge user',
			]);
			await um.closeRowMenu();

			// Site-admin row: canLoginAs/canMergeUsers deny for a non-admin
			// manager (ADMINISTRATION_PROHIBITED), so Login As and Merge
			// user are absent while Edit + Email remain.
			const adminLabels = await um.rowActionLabels(um.rowFor('admin'));
			expect(adminLabels).toContain('Edit');
			expect(adminLabels).toContain('Email');
			expect(adminLabels).not.toContain('Login As');
			expect(adminLabels).not.toContain('Merge user');
			await um.closeRowMenu();
		},
	);

	// Row 8
	test(
		'users list paginates past the page size and keeps counts consistent',
		{tag: '@regression'},
		async ({page, pkpApi}) => {
			const tag = uniqueTag('pag');
			const clean = tag.replace(/[^a-z0-9]/gi, '');
			// Page size is 25 (UserAccessManagerStore countPerPage); 26
			// throwaways + dbarnes + the auto-enrolled admin manager = 28
			// rows → two pages.
			const seeded = Array.from({length: 26}, (_, i) =>
				throwawayUser(tag, i + 1),
			);
			const {context} = await pkpApi.createJournal({
				tag,
				name: {en: `User mgmt ${tag}`},
				users: [
					{username: 'dbarnes', roles: ['manager']},
					...seeded.map((user) => userSpec(user, ['author'])),
				],
			});

			const um = new UserManagementPage(page, context.path);
			await um.goto();

			// Total matches the seeded users; first page is full.
			await expect(um.usersHeading(28)).toBeVisible();
			await expect(um.showingText(1, 25, 28)).toBeVisible();
			await expect(um.usersTable.locator('tbody tr')).toHaveCount(25);

			// Past the boundary and back.
			await um.nextPageButton.click();
			await expect(um.showingText(26, 28, 28)).toBeVisible();
			await expect(um.usersTable.locator('tbody tr')).toHaveCount(3);
			await expect(um.usersHeading(28)).toBeVisible();
			await um.previousPageButton.click();
			await expect(um.showingText(1, 25, 28)).toBeVisible();
			await expect(um.usersTable.locator('tbody tr')).toHaveCount(25);

			// Search by the shared tag token: all 26 throwaways match
			// (dbarnes and admin drop out), still paginated.
			await um.search(clean);
			await expect(um.usersHeading(26)).toBeVisible();
			await expect(um.showingText(1, 25, 26)).toBeVisible();
			await um.pageButton(2).click();
			await expect(um.showingText(26, 26, 26)).toBeVisible();
			await expect(um.usersTable.locator('tbody tr')).toHaveCount(1);
			await um.previousPageButton.click();
			await expect(um.showingText(1, 25, 26)).toBeVisible();

			// Narrow to a single user: count updates, pagination collapses
			// (Pagination renders only when pageCount > 1).
			await um.search(seeded[6].familyName);
			await expect(um.usersHeading(1)).toBeVisible();
			await expect(um.showingText(1, 1, 1)).toBeVisible();
			await expect(um.nextPageButton).toHaveCount(0);
			await expect(um.rowFor(seeded[6].fullName)).toBeVisible();

			// Clearing restores the full count.
			await um.clearSearch();
			await expect(um.usersHeading(28)).toBeVisible();
			await expect(um.showingText(1, 25, 28)).toBeVisible();
		},
	);
});
