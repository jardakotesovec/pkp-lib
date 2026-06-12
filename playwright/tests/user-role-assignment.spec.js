// @ts-check
const {test, expect} = require('../support/base-test.js');
/**
 * Manager-side invitation wizard on Users & Roles —
 * docs/e2e/plans/user-invitations.md rows 2 and 6 (rows 1 and 3–5 live
 * in user-invitation.spec.js).
 *
 * Mirrors the inbound side of the Cypress `inviteUser` helper
 * (`lib/pkp/cypress/support/commands.js#967`) for an EXISTING journal
 * user, distinct from the new-email invite branch.
 *
 * ## Surprise — there is no non-invite path in OJS today
 *
 * Probing the live UI confirmed the plan's "scope-drop" branch:
 *
 *   1. The Users & Roles page exposes ONE entry point for adding a
 *      role — the invitation wizard. Both "Invite to a role" (Users
 *      tab top-right) and the per-row "Edit" action route through
 *      `app(Invitation::class)->createNew('userRoleAssignment')`.
 *   2. The wizard's user-search step (`UserInvitationSearchFormStep`)
 *      hits `/api/v1/users?searchPhrase=…`, which filters by
 *      `contextId` server-side. So a user not yet in the scratch
 *      journal is invisible to the wizard's search and falls into the
 *      "new user" branch; a user already enrolled resolves to the
 *      existing-user branch (row 6 asserts that resolution).
 *   3. The "Edit user" action on a journal user opens the SAME wizard
 *      with the search step skipped (see `SendInvitationStep::getSteps`
 *      — `if (!$invitation && !$user) { ... }`). The remaining two
 *      steps are Enter Details + Email Composer; submitting the email
 *      only WRITES a pending invitation row + dispatches the email,
 *      it does not assign the role directly. The user must accept
 *      via the email link before `user_user_groups` is mutated
 *      (user-invitation.spec.js row 3 covers that side).
 *
 * ## Seed shape (refit per the plan's principle-7 note)
 *
 *   The original migration spec seeded **phudson** — one of the 16
 *   shared baseline users — and left a pending invitation on his
 *   account across runs. Refit: each test seeds its own THROWAWAY
 *   `users[]` user (password supplied → created on the fly by
 *   UserAssignmentProcessor) so no shared user accumulates state.
 *
 *   E0 scratch journal:
 *     - dbarnes   → manager (scratch journal admin)
 *     - throwaway → reviewer (already has a role, so visible in the
 *                   Users grid AND resolvable by the wizard's search)
 *
 * ## Locator notes
 *
 *   - The user-row "More Actions" trigger is a headlessui menu button
 *     with `aria-haspopup="menu"`. Its accessible name is the
 *     `userAccess.management.options` translation, but on a scratch
 *     journal that translation key falls back to `##…##`-wrapped raw
 *     in some locales' compile state — anchor on the row + the
 *     `aria-haspopup="menu"` attribute instead, which is stable.
 *   - The dropdown's menuitems render via headlessui portal at the
 *     document root; scope `getByRole('menuitem', {name: 'Edit'})` to
 *     the page (not the row).
 *   - The wizard's role select is a native `<select name="userGroupId">`.
 *     The `availableUserGroups` computed in `UserInvitationUserGroupsTable`
 *     filters out roles the user already holds (active, no dateEnd),
 *     so "Reviewer" is absent for the throwaway — row 6 asserts the
 *     exclusion directly on the option list.
 *   - User-group IDs are scratch-journal-specific, so anchor on the
 *     visible role label (the option's text), not its value.
 *   - "Save And Continue" advances from Details → Email; submission
 *     button on the email step is "Invite user to the role".
 *   - The success dialog has `role="dialog"` with the
 *     `userInvitation.modal.title` heading "Invitation Sent".
 *   - The search step's found/not-found message
 *     (`userInvitation.search.userFound`) is set by the step action but
 *     cleared again by `updateInvitation()` before the next step
 *     renders (UserInvitationPageStore#282) — it is NOT a reliable
 *     assertion target. Row 6 asserts the resolution by its effects:
 *     the details step renders the existing user's identity display
 *     (no editable new-user form) and the current-roles table.
 *
 * ## Drop list (vs the plan)
 *
 *   - The "user not yet in any scratch-journal role" requirement was
 *     dropped — see the surprise note above.
 *   - The "log in as the assignee and verify role-gated pages" arm
 *     was dropped — that requires driving the email-link accept flow
 *     (user-invitation.spec.js rows 1/3 territory).
 */
test.describe('Users & Roles — assign user to a role', () => {
	test(
		'manager assigns an existing journal user to an additional role and sees a pending invitation',
		{tag: '@regression'},
		async ({pkpApi, asUser}) => {
			const tag = uniqueTag('r60');
			const suffix = tag.split('-').pop();
			// Throwaway invitee — created by the scenario endpoint
			// (password present → create branch), so no shared seeded
			// user carries a pending invitation across runs.
			const throwaway = {
				username: `ura2${suffix}`,
				password: `ura2${suffix}ura2${suffix}`,
				givenName: 'Ursula',
				familyName: `Assignee${suffix}`,
				email: `ura2${suffix}@mailinator.com`,
			};
			const fullName = `${throwaway.givenName} ${throwaway.familyName}`;
			const {context} = await pkpApi.createJournal({
				tag,
				users: [
					{username: 'dbarnes', roles: ['manager']},
					// Seeded as reviewer so the Users grid surfaces the
					// row — we drive the editUser flow which sidesteps
					// the search step entirely.
					{...throwaway, roles: ['reviewer']},
				],
			});

			const ctx = await asUser('dbarnes');
			const page = await ctx.newPage();
			await page.goto(
				`/index.php/${context.path}/management/settings/access`,
			);

			// Wait for the Users-and-Roles page to land; the user
			// access table renders the seeded users via /api/v1/users.
			await expect(
				page.getByRole('heading', {name: 'Users & Roles'}),
			).toBeVisible();

			// Confirm the throwaway is in the user access table at
			// baseline — the row contains the full name + "Reviewer".
			const userRow = page.locator('tr', {hasText: fullName});
			await expect(userRow).toBeVisible();
			await expect(userRow).toContainText('Reviewer');

			// Open the row's More Actions menu. The button carries
			// `aria-haspopup="menu"` reliably; the accessible name
			// uses an unresolved translation key on scratch journals
			// in some compile states, so anchor by attribute.
			await userRow.locator('button[aria-haspopup="menu"]').click();

			// The menu portal renders at the document root, hence the
			// page-scoped getByRole. "Edit" routes to the editUser
			// wizard (no Search step).
			await page
				.getByRole('menuitem', {name: 'Edit', exact: true})
				.click();

			// editUser → /management/settings/user/{id}; the wizard
			// renders directly into Step 1 ("Enter details"), with
			// the user's email/given/family pre-rendered as
			// read-only display blocks. The page-level h1 is empty
			// in editUser mode (UserRoleAssignmentInviteUIController
			// sets `pageTitle = ''` when `$user` is set), so anchor
			// on the step heading "STEP 1 - Enter details and
			// invite for roles" (h2) which Vue renders once the
			// page mounts.
			await page.waitForURL(/\/management\/settings\/user\/\d+(\?|#|$)/);
			await expect(
				page.getByRole('heading', {
					name: /STEP 1 - Enter details and invite for roles/,
				}),
			).toBeVisible();
			// The role table renders the user's existing roles +
			// the start-date / masthead controls. Anchor on the
			// Journal Masthead columnheader before driving the form.
			await expect(
				page.getByRole('columnheader', {name: 'Journal Masthead'}),
			).toBeVisible();

			// Add Another Role appends an empty row to the
			// userGroupsToAdd state with role/date/masthead controls.
			await page
				.getByRole('button', {name: 'Add Another Role', exact: true})
				.click();

			// Pick the new role by visible label (the user_group_id
			// option values are scratch-journal-specific).
			// `availableUserGroups` filters out roles the user
			// already holds, so "Reviewer" is excluded — Author is
			// the canonical pick for an existing-reviewer test.
			const newRoleSelect = page.locator('select[name="userGroupId"]');
			await newRoleSelect.selectOption({label: 'Author'});

			// Start date — the wizard uses HTML5 date input;
			// today's ISO date keeps things deterministic.
			const today = new Date().toISOString().split('T')[0];
			await page.locator('input[name="dateStart"]').fill(today);

			// Masthead — "Author" is not a reviewer role, so the
			// FieldSelect renders with show/hide options. Pick
			// "Appear on the masthead".
			await page
				.locator('select[name="masthead"]')
				.last()
				.selectOption({label: 'Appear on the masthead'});

			// Step 1 → Step 2 (email composer). The page's
			// `updateInvitation` POST creates the invitation row
			// (status=PENDING) and lets us pull the id later.
			await page
				.getByRole('button', {name: 'Save And Continue', exact: true})
				.click();

			// Email step. The mailable's body is auto-loaded from
			// the seeded UserRoleAssignmentInvitationNotify
			// template, so we don't need to set anything in
			// TinyMCE — submit drives `invitations/{id}/invite`
			// which dispatches the email.
			await expect(
				page.getByRole('button', {
					name: 'Invite user to the role',
					exact: true,
				}),
			).toBeVisible();
			await page
				.getByRole('button', {name: 'Invite user to the role', exact: true})
				.click();

			// Success dialog — reka-ui PkpDialog with the
			// userInvitation.modal.title heading.
			const sentDialog = page.getByRole('dialog', {name: 'Invitation Sent'});
			await expect(sentDialog).toBeVisible({timeout: 15_000});
			await expect(sentDialog).toContainText(throwaway.email);

			// REST sanity — the journal-scoped invitations
			// endpoint should now list one PENDING userRoleAssignment
			// invitation for the throwaway. We piggy-back dbarnes's
			// authenticated browser context for the GET so we
			// inherit the session cookie + CSRF surface.
			const apiRes = await page.request.get(
				`/index.php/${context.path}/api/v1/invitations/userRoleAssignment`,
			);
			expect(apiRes.ok()).toBeTruthy();
			const body = await apiRes.json();
			expect(Array.isArray(body.items)).toBeTruthy();
			const pendingInvite = body.items.find(
				(i) => i.existingUser?.email === throwaway.email,
			);
			expect(
				pendingInvite,
				`pending invitation row for ${throwaway.email}`,
			).toBeTruthy();
			expect(pendingInvite.status).toBe('PENDING');

			// And one of the userGroupsToAdd entries is the
			// "Author" role we just picked — the resource serializes
			// userGroupName per locale.
			const userGroupNames = (pendingInvite.userGroupsToAdd || []).map(
				(g) => g.userGroupName,
			);
			expect(
				userGroupNames.some((name) => /author/i.test(String(name))),
				`userGroupsToAdd contains Author (got ${JSON.stringify(userGroupNames)})`,
			).toBeTruthy();

			// User-side: the Users tab's Invitations panel mirrors
			// the same pending row. Re-navigating to the access
			// page (the dialog has a "View All Users" CTA but
			// asserting on the URL is more robust than racing the
			// dialog click) and checking the Invitations table
			// header count flips from 0 to 1.
			await page.goto(
				`/index.php/${context.path}/management/settings/access`,
			);
			await expect(
				page.getByRole('heading', {name: /^Invitations \(1\)$/}),
			).toBeVisible({timeout: 15_000});
		},
	);

	test(
		'wizard search resolves an existing journal user and excludes roles already held',
		{tag: '@regression'},
		async ({pkpApi, asUser}) => {
			const tag = uniqueTag('r6');
			const suffix = tag.split('-').pop();
			// Throwaway user already enrolled in the scratch journal —
			// the wizard's context-scoped search must resolve them
			// into the existing-user branch.
			const existing = {
				username: `ura6${suffix}`,
				password: `ura6${suffix}ura6${suffix}`,
				givenName: 'Selma',
				familyName: `Search${suffix}`,
				email: `ura6${suffix}@mailinator.com`,
			};
			const {context} = await pkpApi.createJournal({
				tag,
				users: [
					{username: 'dbarnes', roles: ['manager']},
					{...existing, roles: ['reviewer']},
				],
			});

			const ctx = await asUser('dbarnes');
			const page = await ctx.newPage();
			await page.goto(
				`/index.php/${context.path}/management/settings/access`,
			);
			await expect(
				page.getByRole('heading', {name: 'Users & Roles'}),
			).toBeVisible();

			// Fresh wizard (search step included — unlike editUser).
			await page
				.getByRole('button', {name: 'Invite to a role', exact: true})
				.click();
			await expect(
				page.getByRole('heading', {name: /STEP 1 - Search User/i}),
			).toBeVisible({timeout: 15_000});

			// Step-1 search by the email of a user already in the
			// journal. The step action resolves the account (exact
			// email match against the context-scoped /users search)
			// and stashes userId + identity + currentUserGroups on
			// the wizard payload before the wizard advances.
			await page.locator('input[name="search"]').fill(existing.email);
			await page
				.getByRole('button', {name: 'Search User', exact: true})
				.click();

			await expect(
				page.getByRole('heading', {
					name: /STEP 2 - Enter details and invite for roles/i,
				}),
			).toBeVisible({timeout: 15_000});

			// Existing-user branch: identity renders as read-only
			// display blocks (AcceptInvitationFormDisplayItemBasic) —
			// the editable new-user PkpForm must NOT mount.
			await expect(
				page.getByText(existing.email, {exact: true}).first(),
			).toBeVisible();
			await expect(
				page.getByText(existing.givenName, {exact: true}).first(),
			).toBeVisible();
			await expect(
				page.getByText(existing.familyName, {exact: true}).first(),
			).toBeVisible();
			await expect(
				page.locator('input[name="givenName-en"]'),
				'no editable name form for a resolved existing user',
			).toHaveCount(0);

			// Current roles table: the held "Reviewer" role shows as a
			// current-user-group row (name + start date + masthead
			// column).
			await expect(
				page.getByRole('columnheader', {name: 'Journal Masthead'}),
			).toBeVisible();
			await expect(
				page.locator('tr', {hasText: 'Reviewer'}).first(),
			).toBeVisible();

			// The role select excludes roles already held:
			// `availableUserGroups` filters out active assignments, so
			// "Reviewer" is not offered while other defaults (Author,
			// Section editor, …) are.
			const optionLabels = (
				await page.locator('select[name="userGroupId"] option').allTextContents()
			).map((s) => s.trim());
			expect(optionLabels).toContain('Author');
			expect(optionLabels).toContain('Section editor');
			expect(
				optionLabels.includes('Reviewer'),
				`role select must exclude the held Reviewer role (got ${JSON.stringify(optionLabels)})`,
			).toBeFalsy();
		},
	);
});

function uniqueTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}
