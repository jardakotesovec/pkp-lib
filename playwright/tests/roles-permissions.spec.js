// @ts-check
const {test, expect} = require('../support/base-test.js');
const {RolesSettingsPage} = require('../pages/RolesSettingsPage.js');
const {ParticipantManagerPage} = require('../pages/ParticipantManagerPage.js');
const {waitForJQueryIdle} = require('../support/jquery.js');

/**
 * Roles & permissions — docs/e2e/plans/roles-permissions.md (rows 1–7).
 *
 * Role mutations live on E0 scratch journals (charter principle 1);
 * row 6 is the only publicknowledge touch and is strictly read-only
 * navigation by shared seeded users.
 *
 * Verified-against-source notes baked into the assertions:
 *  - The Roles tab is the legacy UserGroupGridHandler grid
 *    (#roleGridContainer). Columns: Role Name | Permission level |
 *    Submission | Review | Copyediting | Production. Stage cells are
 *    selectStatusCell checkboxes wired to an immediate AjaxAction
 *    (assign/unassignStage), disabled for stages the row's permission
 *    level forbids (RoleDAO::getForbiddenStages — manager rows fully
 *    locked because manager-level groups are always-active on all
 *    stages server-side; reviewer rows only allow Review).
 *  - UserGroupForm fields: roleId (locked on edit), name/abbrev
 *    (multilingual fbv), assignedStages[] checkboxgroup, plus option
 *    checkboxes permitSelfRegistration / recommendOnly /
 *    permitMetadataEdit / masthead / permitSettings. The client
 *    handler (UserGroupFormHandler.js) hides options irrelevant to
 *    the selected level: permitSettings renders for Journal Manager
 *    only, permitSelfRegistration for Reviewer/Author/Reader.
 *  - Add Participant options come from
 *    Repo::userGroup()->getUserGroupsByStage(context, stageId)
 *    (AddParticipantForm::fetch, reviewer-level excluded) — the
 *    stage-assignment gate row 3 asserts. The workflow side nav's
 *    selectedStageId is what the Assign action posts (charter:
 *    workflowConfigEditorialOJS getSecondaryItems).
 *  - permitSelfRegistration surfaces: frontend /user/register renders
 *    one "Yes, request the {name} role." checkbox per self-reg
 *    reviewer group (userRegister.tpl; with a single group the label
 *    collapses to the generic opt-in phrasing), and the profile Roles
 *    tab (ProfileTabHandler → rolesForm.tpl → userGroupSelfRegistration
 *    .tpl) lists each self-reg group by name under "Register in
 *    {journal} as...".
 *  - CanAccessSettingsPolicy permits only site admins and managers
 *    whose group has permitSettings. ManagementHandler::authorize
 *    applies it to the WHOLE `settings` op except the announcements/
 *    userComments areas — so a permitSettings=false manager is denied
 *    on Users & Roles (settings/access) too. The plan row 5 text
 *    predicted "Users & Roles reachable"; the live code says
 *    otherwise (lib/pkp/pages/management/ManagementHandler.php
 *    authorize()) and the spec asserts the actual behavior, with the
 *    exempt announcements area as the reachable-manager-surface
 *    positive control.
 *  - Page-router authorization failures redirect logged-in users to
 *    /user/authorizationDenied?message=... (PKPPageRouter
 *    ::handleAuthorizationFailure) — the canonical denial assertion;
 *    anonymous users would bounce to /login instead, so a matching
 *    authorizationDenied URL doubles as a session-liveness check.
 *  - Role start dates: the invitation wizard's dateStart must be the
 *    SERVER-LOCAL date. `new Date().toISOString()` is UTC — after
 *    5 p.m. Pacific that's tomorrow, and finalize() keeps a future
 *    dateStart as-is (UserRoleAssignmentReceiveController), minting
 *    an inactive role. This spec formats the local date.
 *
 * Mailpit: row 5 reads mail scoped to a tag-unique throwaway
 * recipient; no clearAll (charter principle 8).
 */

/** Worker-scoped unique tag — journals.urlPath is varchar(32). */
function uniqueTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

/**
 * Server-local YYYY-MM-DD (NOT toISOString — that's UTC and rolls to
 * tomorrow during Pacific evenings; a future dateStart mints an
 * inactive role assignment).
 */
function localToday() {
	const now = new Date();
	const mm = String(now.getMonth() + 1).padStart(2, '0');
	const dd = String(now.getDate()).padStart(2, '0');
	return `${now.getFullYear()}-${mm}-${dd}`;
}

/**
 * Pull the `<a class='btn btn-accept' href='...'>` URL out of the
 * userRoleAssignmentInvitationNotify HTML body (single-quoted hrefs —
 * the shared pkpMail.extractLink expects double quotes; same local
 * helper as user-invitation.spec.js).
 *
 * @param {string} html
 */
function extractAcceptUrl(html) {
	const re =
		/<a[^>]+href=['"]([^'"]+)['"][^>]*class=['"][^'"]*btn-accept[^'"]*['"][^>]*>/i;
	const match = html.match(re);
	if (!match) {
		throw new Error('Accept Invitation link not found in mail body');
	}
	return match[1];
}

/** The journal-management settings areas gated by the settings op. */
const SETTINGS_AREAS = ['context', 'website', 'workflow', 'distribution', 'access'];

const DENIED_URL = /\/user\/authorizationDenied/;

/** The workflow side-modal's stage navigation. */
function workflowNav(page) {
	return page.locator('[data-cy="active-modal"]').first().locator('nav');
}

/**
 * Close an open legacy Assign Participant modal via its fbv Cancel
 * link and wait for the dialog to leave.
 *
 * @param {import('@playwright/test').Locator} modal
 * @param {import('@playwright/test').Locator} form
 */
async function closeAssignModal(modal, form) {
	await form.locator('a.cancelButton').click();
	await expect(modal).toBeHidden({timeout: 15_000});
}

/**
 * Open the Assign Participant form on the currently selected stage and
 * return its user-group filter select alongside the modal/form.
 *
 * @param {ParticipantManagerPage} pm
 */
async function openAssignRoleOptions(pm) {
	const {modal, form} = await pm.openAssignForm();
	const select = form.locator('select[name="filterUserGroupId"]');
	await expect(select).toBeVisible({timeout: 15_000});
	return {modal, form, select};
}

test.describe('Roles & permissions', () => {
	// Legacy grid + invite round-trips stack many full page loads; the
	// shared per-port PHP servers see multi-second tails under parallel
	// load. Raise the ceiling — fast runs finish as fast as before.
	test.describe.configure({timeout: 120_000});

	// Row 1
	test('roles grid lists default roles by permission level and stage-assignment edits persist', {tag: '@regression'}, async ({pkpApi, asUser}) => {
		const tag = uniqueTag('rp1');
		const {context} = await pkpApi.createJournal({
			tag,
			users: [{username: 'dbarnes', roles: ['manager']}],
		});

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const roles = new RolesSettingsPage(page);
		await roles.goto(context.path);

		// The grid carries the stage columns next to name + permission
		// level (scoped to the grid: the workflow nav reuses the same
		// stage words).
		for (const header of [
			'Role Name',
			'Permission level',
			'Submission',
			'Review',
			'Copyediting',
			'Production',
		]) {
			await expect(
				roles.grid.getByRole('columnheader', {name: header, exact: true}),
			).toBeVisible();
		}

		// Default roles grouped by permission level: the second column
		// labels each default group with its Role::ROLE_ID_* level.
		const expectedLevels = [
			['Journal manager', 'Journal Manager'],
			['Journal editor', 'Journal Manager'],
			['Production editor', 'Journal Manager'],
			['Section editor', 'Section Editor'],
			['Guest editor', 'Section Editor'],
			['Copyeditor', 'Assistant'],
			['Layout Editor', 'Assistant'],
			['Author', 'Author'],
			['Translator', 'Author'],
			['Reviewer', 'Reviewer'],
			['Reader', 'Reader'],
		];
		for (const [name, level] of expectedLevels) {
			const row = roles.rowByName(name);
			await expect(row).toHaveCount(1);
			await expect(roles.levelCell(row)).toHaveText(level);
		}

		// Forbidden-stage locking per level: manager-level rows are
		// fully locked (always-active server-side), reviewer rows allow
		// only Review, assistant rows are fully editable.
		const editorRow = roles.rowByName('Journal editor');
		for (const stageId of [1, 3, 4, 5]) {
			await expect(roles.stageCheckbox(editorRow, stageId)).toBeChecked();
			await expect(roles.stageCheckbox(editorRow, stageId)).toBeDisabled();
		}
		const reviewerRow = roles.rowByName('Reviewer');
		await expect(roles.stageCheckbox(reviewerRow, 3)).toBeChecked();
		await expect(roles.stageCheckbox(reviewerRow, 3)).toBeEnabled();
		for (const stageId of [1, 4, 5]) {
			await expect(roles.stageCheckbox(reviewerRow, stageId)).toBeDisabled();
		}

		// Copyeditor (assistant level): Copyediting on, Production off —
		// the registry defaults this toggle exercise relies on.
		const copyeditorRow = roles.rowByName('Copyeditor');
		await expect(roles.stageCheckbox(copyeditorRow, 4)).toBeChecked();
		await expect(roles.stageCheckbox(copyeditorRow, 5)).not.toBeChecked();
		await expect(roles.stageCheckbox(copyeditorRow, 5)).toBeEnabled();

		// --- Check Production on Copyeditor; survives a reload. -------
		await roles.toggleStage(copyeditorRow, 5);
		await roles.goto(context.path);
		await expect(
			roles.stageCheckbox(roles.rowByName('Copyeditor'), 5),
		).toBeChecked({timeout: 15_000});

		// --- Uncheck it again; the removal also persists. -------------
		await roles.toggleStage(roles.rowByName('Copyeditor'), 5);
		await roles.goto(context.path);
		await expect(
			roles.stageCheckbox(roles.rowByName('Copyeditor'), 5),
		).not.toBeChecked({timeout: 15_000});
		// Bounding positive: the untouched Copyediting assignment is
		// still there (the unassign didn't wipe the row's stages).
		await expect(
			roles.stageCheckbox(roles.rowByName('Copyeditor'), 4),
		).toBeChecked();
	});

	// Row 2
	test('manager creates, renames and deletes a custom assistant role', {tag: '@regression'}, async ({pkpApi, asUser}) => {
		const tag = uniqueTag('rp2');
		const nameA = `Crew Alpha ${tag}`;
		const nameB = `Crew Beta ${tag}`;
		const {context} = await pkpApi.createJournal({
			tag,
			users: [{username: 'dbarnes', roles: ['manager']}],
		});

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const roles = new RolesSettingsPage(page);
		await roles.goto(context.path);

		// --- Create: assistant level, Copyediting + Production. -------
		const createForm = await roles.openCreateForm();
		await roles.fillRoleForm(createForm, {
			permissionLevel: 'Assistant',
			name: nameA,
			abbrev: `CA${tag.slice(-4)}`,
			stages: [4, 5],
		});
		await roles.saveForm(createForm);

		await expect(roles.rows(nameA)).toHaveCount(1, {timeout: 15_000});
		const row = roles.rows(nameA).first();
		await expect(roles.levelCell(row)).toHaveText('Assistant');
		await expect(roles.stageCheckbox(row, 4)).toBeChecked();
		await expect(roles.stageCheckbox(row, 5)).toBeChecked();
		await expect(roles.stageCheckbox(row, 1)).not.toBeChecked();
		await expect(roles.stageCheckbox(row, 3)).not.toBeChecked();

		// Creation persisted (fresh page load, not just a grid refresh).
		await roles.goto(context.path);
		await expect(roles.rows(nameA)).toHaveCount(1);

		// --- Rename. The permission level is locked once created. The
		// resolver works around the grid's index-0 action-suppression
		// bug (see RolesSettingsPage#resolveActionableRowId).
		const rowId = await roles.resolveActionableRowId(nameA);
		const editForm = await roles.openEditForm(rowId);
		await expect(editForm.locator('select[name="roleId"]')).toBeDisabled();
		await expect(editForm.locator('input[name="name[en]"]')).toHaveValue(
			nameA,
		);
		await roles.fillRoleForm(editForm, {name: nameB});
		await roles.saveForm(editForm);
		await expect(roles.rows(nameB)).toHaveCount(1, {timeout: 15_000});
		await expect(roles.rows(nameA)).toHaveCount(0);

		// Rename persisted across reload.
		await roles.goto(context.path);
		await expect(roles.rows(nameB)).toHaveCount(1);
		await expect(roles.rows(nameA)).toHaveCount(0);

		// --- Delete (no members, non-default → allowed). Re-resolve the
		// row (positional ids shift on every load) and avoid the index-0
		// action bug. The grid does NOT drop the row in place — its
		// positional row ids can't be matched to the DataChangedEvent's
		// userGroupId (see RolesSettingsPage#deleteRole / the wave
		// ledger note) — so the authoritative assertion is the
		// post-reload absence.
		const deleteRowId = await roles.resolveActionableRowId(nameB);
		await roles.deleteRole(deleteRowId);
		await roles.goto(context.path);
		await expect(roles.rows(nameB)).toHaveCount(0);
	});

	// Row 3
	test('stage assignments gate which roles Add Participant offers', {tag: ['@regression', '@slow']}, async ({pkpApi, asUser}) => {
		const tag = uniqueTag('rp3');
		const roleName = `Stage Crew ${tag}`;
		const {context} = await pkpApi.createJournal({
			tag,
			users: [
				{username: 'dbarnes', roles: ['manager', 'editor']},
				{username: 'rvaca', roles: ['author']},
			],
		});

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();

		// Custom assistant role assigned ONLY to Copyediting — created
		// through the Roles grid (the configuration surface under test).
		const roles = new RolesSettingsPage(page);
		await roles.goto(context.path);
		const createForm = await roles.openCreateForm();
		await roles.fillRoleForm(createForm, {
			permissionLevel: 'Assistant',
			name: roleName,
			abbrev: `SC${tag.slice(-4)}`,
			stages: [4],
		});
		await roles.saveForm(createForm);
		await expect(roles.rows(roleName)).toHaveCount(1, {timeout: 15_000});

		// A submission that traversed review and sits in Copyediting,
		// so all three stages are navigable in the workflow side nav.
		const {submission} = await pkpApi.createSubmission({
			tag,
			journal: context.path,
			submitter: 'rvaca',
			section: 'ART',
			locale: 'en',
			participants: [{user: 'dbarnes', role: 'editor'}],
			decisions: [
				{type: 'sendExternalReview', by: 'dbarnes'},
				{type: 'accept', by: 'dbarnes'},
			],
			publications: [
				{
					versionStage: 'AO',
					metadata: {
						title: {en: `Stage gate ${tag}`},
						abstract: {en: '<p>Participant role-option gating.</p>'},
					},
					published: false,
				},
			],
		});

		const pm = new ParticipantManagerPage(page);
		await pm.gotoWorkflow(submission.id, {journalPath: context.path});
		await pm.expectVisible();

		// --- Copyediting (the current stage): the custom role is
		// offered. 'Journal editor' (stages 1,3,4,5) is the
		// always-present positive control in every probe below.
		let {modal, form, select} = await openAssignRoleOptions(pm);
		await expect(select.locator('option', {hasText: roleName})).toHaveCount(1);
		await expect(
			select.locator('option', {hasText: 'Journal editor'}),
		).toHaveCount(1);
		await closeAssignModal(modal, form);

		// --- Submission stage: absent. ---------------------------------
		await workflowNav(page).getByText('Submission', {exact: true}).click();
		({modal, form, select} = await openAssignRoleOptions(pm));
		await expect(select.locator('option', {hasText: roleName})).toHaveCount(0);
		await expect(
			select.locator('option', {hasText: 'Journal editor'}),
		).toHaveCount(1);
		await closeAssignModal(modal, form);

		// --- Review stage (round 1): absent. ----------------------------
		const nav = workflowNav(page);
		const roundItem = nav.getByText('Review Round 1', {exact: true});
		if (!(await roundItem.isVisible().catch(() => false))) {
			await nav.getByText('Review', {exact: true}).first().click();
		}
		await roundItem.click();
		({modal, form, select} = await openAssignRoleOptions(pm));
		await expect(select.locator('option', {hasText: roleName})).toHaveCount(0);
		await expect(
			select.locator('option', {hasText: 'Journal editor'}),
		).toHaveCount(1);
		await closeAssignModal(modal, form);
	});

	// Row 4
	test('permitSelfRegistration controls the registration form and profile role opt-ins', {tag: '@regression'}, async ({page, pkpApi, asUser}) => {
		const tag = uniqueTag('rp4');
		const roleName = `Guest Referee ${tag}`;
		const {context} = await pkpApi.createJournal({
			tag,
			users: [{username: 'dbarnes', roles: ['manager']}],
		});

		const managerCtx = await asUser('dbarnes');
		const managerPage = await managerCtx.newPage();
		const roles = new RolesSettingsPage(managerPage);
		await roles.goto(context.path);

		// Reviewer-level custom role with self-registration ON. The
		// permitSelfRegistration option only renders for levels in
		// UserGroupForm::getPermitSelfRegistrationRoles().
		const createForm = await roles.openCreateForm();
		await roles.fillRoleForm(createForm, {
			permissionLevel: 'Reviewer',
			name: roleName,
			abbrev: `GR${tag.slice(-4)}`,
			stages: [3],
			options: {permitSelfRegistration: true},
		});
		await roles.saveForm(createForm);
		await expect(roles.rows(roleName)).toHaveCount(1, {timeout: 15_000});

		// --- ON: the anonymous registration form offers the role. With
		// two self-reg reviewer groups the template renders the named
		// per-group prompt for each (userRegister.tpl).
		await page.goto(`/index.php/${context.path}/user/register`);
		await expect(
			page.getByText(`Yes, request the ${roleName} role.`),
		).toBeVisible({timeout: 15_000});
		await expect(
			page.getByText('Yes, request the Reviewer role.'),
		).toBeVisible();

		// --- ON: the profile Roles tab lists the role as an opt-in
		// checkbox under "Register in {journal} as...".
		await managerPage.goto(`/index.php/${context.path}/user/profile`);
		await managerPage.locator('#profileTabs a[name="roles"]').click();
		const rolesForm = managerPage.locator('form#rolesForm');
		await expect(rolesForm).toBeVisible({timeout: 15_000});
		await waitForJQueryIdle(managerPage);
		await expect(
			rolesForm.getByText(roleName, {exact: true}),
		).toBeVisible();

		// --- Toggle OFF through the same role form. --------------------
		await roles.goto(context.path);
		const rowId = await roles.resolveActionableRowId(roleName);
		const editForm = await roles.openEditForm(rowId);
		await expect(
			editForm.locator('input[name="permitSelfRegistration"]'),
		).toBeChecked();
		await roles.fillRoleForm(editForm, {
			options: {permitSelfRegistration: false},
		});
		await roles.saveForm(editForm);

		// --- OFF: registration hides the role. Only the default
		// Reviewer group remains self-registrable, so the prompt
		// collapses to the generic single-group opt-in — the bounding
		// positive for the absence assertion.
		await page.goto(`/index.php/${context.path}/user/register`);
		await expect(
			page.getByText(
				'Yes, I would like to be contacted with requests to review submissions to this journal.',
			),
		).toBeVisible({timeout: 15_000});
		await expect(page.getByText(roleName)).toHaveCount(0);

		// --- OFF: the profile Roles tab hides it too (default Reviewer
		// opt-in still renders — bounded negative).
		await managerPage.goto(`/index.php/${context.path}/user/profile`);
		await managerPage.locator('#profileTabs a[name="roles"]').click();
		await expect(rolesForm).toBeVisible({timeout: 15_000});
		await waitForJQueryIdle(managerPage);
		await expect(
			rolesForm.getByText('Reviewer', {exact: true}).first(),
		).toBeVisible();
		await expect(rolesForm.getByText(roleName, {exact: true})).toHaveCount(0);
	});

	// Row 5
	test('manager-level role without permitSettings reaches manager surfaces but not settings', {tag: ['@regression', '@slow']}, async ({pkpApi, pkpMail, browser, baseURL, asUser}) => {
		const tag = uniqueTag('rp5');
		const roleName = `Coordinator ${tag}`;
		const username = `coord-${tag}`;
		const password = 'C00rd!Pwd99'; // login form caps at maxlength=32
		const email = `${username}@mailinator.com`;

		// enableAnnouncements gives the throwaway a manager-area page
		// (management/settings/announcements) that is EXEMPT from
		// CanAccessSettingsPolicy — the reachable positive control.
		const {context} = await pkpApi.createJournal({
			tag,
			enableAnnouncements: true,
			users: [
				{username: 'dbarnes', roles: ['manager']},
				{
					username,
					password,
					email,
					givenName: 'Cora',
					// Distinct from the custom role's name — the access
					// page hosts BOTH the users table and the roles grid,
					// so a shared "Coordinator <tag>" string would make
					// any tr-by-text lookup ambiguous.
					familyName: `Crewson ${tag}`,
					roles: ['author'],
				},
			],
		});

		const managerCtx = await asUser('dbarnes');
		const managerPage = await managerCtx.newPage();

		// --- Custom manager-level role, permitSettings left OFF. -------
		const roles = new RolesSettingsPage(managerPage);
		await roles.goto(context.path);
		const createForm = await roles.openCreateForm();
		await roles.fillRoleForm(createForm, {
			permissionLevel: 'Journal Manager',
			name: roleName,
			abbrev: `CO${tag.slice(-4)}`,
		});
		// The permitSettings option renders for manager level and
		// defaults to unchecked — assert the default we rely on rather
		// than blind-trusting it.
		const permitSettings = createForm.locator(
			'input[name="permitSettings"]',
		);
		await expect(permitSettings).toBeVisible();
		await expect(permitSettings).not.toBeChecked();
		await roles.saveForm(createForm);
		await expect(roles.rows(roleName)).toHaveCount(1, {timeout: 15_000});

		// --- Grant via the only UI path: existing-user invite → accept.
		await managerPage.goto(
			`/index.php/${context.path}/management/settings/access`,
		);
		const userRow = managerPage.locator('tr', {hasText: `Crewson ${tag}`});
		await expect(userRow).toBeVisible({timeout: 15_000});
		await userRow.locator('button[aria-haspopup="menu"]').click();
		await managerPage
			.getByRole('menuitem', {name: 'Edit', exact: true})
			.click();

		await managerPage.waitForURL(/\/management\/settings\/user\/\d+(\?|#|$)/);
		await expect(
			managerPage.getByRole('heading', {
				name: /STEP 1 - Enter details and invite for roles/,
			}),
		).toBeVisible({timeout: 15_000});
		await managerPage
			.getByRole('button', {name: 'Add Another Role', exact: true})
			.click();
		await managerPage
			.locator('select[name="userGroupId"]')
			.selectOption({label: roleName});
		await managerPage.locator('input[name="dateStart"]').fill(localToday());
		await managerPage
			.locator('select[name="masthead"]')
			.last()
			.selectOption({label: 'Appear on the masthead'});
		await managerPage
			.getByRole('button', {name: 'Save And Continue', exact: true})
			.click();
		await expect(
			managerPage.getByRole('button', {
				name: 'Invite user to the role',
				exact: true,
			}),
		).toBeVisible({timeout: 15_000});
		await managerPage
			.getByRole('button', {name: 'Invite user to the role', exact: true})
			.click();
		const sentDialog = managerPage.getByRole('dialog', {
			name: 'Invitation Sent',
		});
		await expect(sentDialog).toBeVisible({timeout: 15_000});
		await expect(sentDialog).toContainText(email);

		// --- Accept. For an EXISTING user the receive controller logs
		// the invitee's session in (UserRoleAssignmentReceiveController
		// ::authorize) and the wizard collapses to the single review
		// step.
		const latest = await pkpMail.latestTo(email, {timeout: 15_000});
		const full = await pkpMail.fullMessage(latest.ID);
		const acceptUrl = extractAcceptUrl(full.HTML || '');

		const inviteeCtx = await browser.newContext({
			storageState: {cookies: [], origins: []},
			baseURL,
		});
		try {
			const inviteePage = await inviteeCtx.newPage();
			// Accept (existing-user single review step). The receive
			// controller logs the invitee's session in during the accept
			// page's API calls; under parallel load the session-register
			// and the finalize POST occasionally race, surfacing the
			// authorizationDenied error dialog. Reload + re-accept once
			// recovers it (a real invitee would re-open the same link).
			const successDialog = inviteePage.getByRole('dialog');
			for (let attempt = 0; ; attempt++) {
				await inviteePage.goto(acceptUrl);
				const acceptButton = inviteePage.getByRole('button', {
					name: /^Accept And Continue/i,
				});
				await expect(acceptButton).toBeVisible({timeout: 20_000});
				await acceptButton.click();
				await expect(successDialog).toBeVisible({timeout: 20_000});
				if (!/not authorized|authoriz/i.test(await successDialog.innerText())) {
					break;
				}
				if (attempt >= 2) {
					throw new Error(
						'accept finalize stayed unauthorized after retries',
					);
				}
			}
			await expect(successDialog).toContainText(/new role/i);

			// The receive controller's auto-login
			// (UserRoleAssignmentReceiveController::authorize →
			// Validation::registerUserSession) authenticates each
			// receive-API request server-side, but the rotated session
			// cookie does not survive into the browser context — the
			// next page navigation bounces 302 → /login (observed; same
			// family as the row-57 finding that finalize never logs the
			// invitee in). Drive the login form explicitly; the
			// credentials are the scenario-seeded ones.
			await inviteePage.goto(`/index.php/${context.path}/login`);
			await inviteePage.locator('input[name="username"]').fill(username);
			await inviteePage.locator('input[name="password"]').fill(password);
			await inviteePage
				.locator('form#login button[type="submit"]')
				.click();
			await inviteePage.waitForURL(
				(url) => !url.pathname.includes('/login'),
				{timeout: 20_000, waitUntil: 'commit'},
			);

			// REST sanity via the manager session: the throwaway now
			// holds the custom role.
			const usersRes = await managerPage.request.get(
				`/index.php/${context.path}/api/v1/users?searchPhrase=${encodeURIComponent(email)}`,
			);
			expect(usersRes.ok()).toBeTruthy();
			const usersBody = await usersRes.json();
			const invitee = (usersBody.items || []).find(
				(u) => u.email === email,
			);
			expect(invitee, `user row for ${email}`).toBeTruthy();
			const groupNames = (invitee.groups || []).map((g) =>
				typeof g.name === 'string'
					? g.name
					: g.name?.en || Object.values(g.name || {})[0],
			);
			expect(
				groupNames.some((n) => String(n).includes(roleName)),
				`custom role granted (groups: ${JSON.stringify(groupNames)})`,
			).toBeTruthy();

			// --- Gates, as the throwaway (session live from the accept).
			// Editorial dashboard: reachable (manager-level role).
			await inviteePage.goto(
				`/index.php/${context.path}/en/dashboard/editorial`,
			);
			await expect(inviteePage).toHaveURL(/dashboard\/editorial/);
			await expect(
				inviteePage.locator('.pkpSearch__input'),
			).toBeVisible({timeout: 20_000});

			// Settings nav absent; the manager-only Tools entry is the
			// in-nav positive control (same nav, same request).
			const inviteeNav = inviteePage.locator('nav#app-nav');
			await expect(
				inviteeNav.getByText('Tools', {exact: true}),
			).toBeVisible();
			await expect(
				inviteeNav.getByText('Settings', {exact: true}),
			).toHaveCount(0);

			// The announcements area is exempt from the settings gate —
			// a manager surface that stays reachable.
			await inviteePage.goto(
				`/index.php/${context.path}/management/settings/announcements`,
			);
			await expect(inviteePage).toHaveURL(/settings\/announcements/);
			await expect(
				inviteePage.getByRole('heading', {name: 'Announcements'}).first(),
			).toBeVisible({timeout: 15_000});

			// Every real settings area — INCLUDING Users & Roles
			// (settings/access), which ManagementHandler::authorize gates
			// like the rest — denies with the authorizationDenied
			// redirect.
			for (const area of SETTINGS_AREAS) {
				await inviteePage.goto(
					`/index.php/${context.path}/management/settings/${area}`,
				);
				await expect(
					inviteePage,
					`settings/${area} denied for permitSettings=false manager`,
				).toHaveURL(DENIED_URL);
			}

			// Control: dbarnes (default Journal manager group,
			// permitSettings=true) keeps the Settings nav on the same
			// journal.
			await managerPage.goto(
				`/index.php/${context.path}/en/dashboard/editorial`,
			);
			await expect(
				managerPage.locator('nav#app-nav').getByText('Settings', {
					exact: true,
				}),
			).toBeVisible({timeout: 20_000});
		} finally {
			await inviteeCtx.close();
		}
	});

	// Row 6 — read-only against publicknowledge (shared users, shared
	// journal; navigation only, no mutations).
	test('non-manager roles are denied at journal management settings URLs', {tag: '@regression'}, async ({asUser}) => {
		const actors = ['atester', 'jjanssen', 'mfritz']; // author, reviewer, assistant
		for (const username of actors) {
			const ctx = await asUser(username);
			const page = await ctx.newPage();
			for (const area of SETTINGS_AREAS) {
				await page.goto(
					`/index.php/publicknowledge/management/settings/${area}`,
				);
				// Logged-in + denied redirects to authorizationDenied;
				// a dead session would land on /login instead, so this
				// match doubles as the session-liveness control.
				await expect(
					page,
					`${username} denied at settings/${area}`,
				).toHaveURL(DENIED_URL);
			}
			// One body anchor per actor: the denial page actually
			// rendered (vs a blank 500).
			await expect(
				page.getByText(/access denied|does not have access/i).first(),
			).toBeVisible();
		}
	});

	// Row 7
	test('roles are journal-scoped: a journal-A manager is denied on journal B', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('rp7');
		const username = `xj-${tag}`;
		const password = 'Xj0urnal!Pw';

		const {context: journalA} = await pkpApi.createJournal({
			tag: `${tag}-a`,
			users: [
				{
					username,
					password,
					givenName: 'Xena',
					familyName: `CrossJournal ${tag}`,
					roles: ['manager'],
				},
			],
		});
		const {context: journalB} = await pkpApi.createJournal({
			tag: `${tag}-b`,
			users: [{username: 'dbarnes', roles: ['manager']}],
		});

		// Throwaway user → drive the login form directly (no cached
		// storage state for one-off users).
		await page.goto(`/index.php/${journalA.path}/login`);
		await page.locator('input[name="username"]').fill(username);
		await page.locator('input[name="password"]').fill(password);
		await page.locator('form#login button[type="submit"]').click();
		await page.waitForURL((url) => !url.pathname.includes('/login'), {
			timeout: 20_000,
			waitUntil: 'commit',
		});

		// --- Journal A: dashboard + settings reachable (manager). ------
		await page.goto(`/index.php/${journalA.path}/en/dashboard/editorial`);
		await expect(page).toHaveURL(/dashboard\/editorial/);
		await expect(page.locator('.pkpSearch__input')).toBeVisible({
			timeout: 20_000,
		});
		await page.goto(
			`/index.php/${journalA.path}/management/settings/access`,
		);
		await expect(page).toHaveURL(/management\/settings\/access/);
		await expect(
			page.getByRole('heading', {name: 'Users & Roles'}),
		).toBeVisible({timeout: 20_000});

		// --- Journal B: no roles there → dashboard and settings deny. --
		await page.goto(`/index.php/${journalB.path}/en/dashboard/editorial`);
		await expect(page, 'journal B dashboard denied').toHaveURL(DENIED_URL);
		await page.goto(
			`/index.php/${journalB.path}/management/settings/workflow`,
		);
		await expect(page, 'journal B settings denied').toHaveURL(DENIED_URL);

		// --- Journal A unaffected by the denials. ----------------------
		await page.goto(`/index.php/${journalA.path}/en/dashboard/editorial`);
		await expect(page).toHaveURL(/dashboard\/editorial/);
		await expect(page.locator('.pkpSearch__input')).toBeVisible({
			timeout: 20_000,
		});
	});
});
