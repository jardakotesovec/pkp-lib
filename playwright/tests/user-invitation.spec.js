// @ts-check
const {test, expect} = require('../support/base-test.js');
/**
 * User invitations — full lifecycle (docs/e2e/plans/user-invitations.md
 * rows 1, 3, 4, 5; rows 2 and 6 live in user-role-assignment.spec.js).
 *
 * Row 1 ports the Cypress `createUserByInvitation` helper
 * (`lib/pkp/cypress/support/commands.js#1008`) — the full multi-actor
 * journey: manager → email → invitee → registration → role on context.
 * Rows 3–5 cover the rest of the invitation lifecycle: existing-user
 * accept, decline, and manager-side cancel. Per principle 4 the rows
 * whose behavior-under-test is NOT the manager wizard create their
 * invitation through the same REST pipeline the wizard drives
 * (invitations/add → populate → invite) instead of re-driving the
 * wizard UI; the wizard itself is covered by rows 1, 2 and 6.
 *
 * ## Step shapes (verified via classes/invitation/stepTypes/...)
 *
 * `SendInvitationStep::getSteps` (manager side):
 *   1. searchUser  — only when `!$invitation && !$user`. The Vue
 *      `UserInvitationSearchFormStep` searches `/api/v1/users` for an
 *      exact email/username/orcid match. When no match is found AND
 *      the search value is a valid email, it stashes the value as
 *      `inviteeEmail` on the wizard payload. The next-button label is
 *      "Search User"; `nextStep` runs the registered action which is
 *      idempotent for a new email — falls into the new-user branch.
 *   2. userDetails  — Enter Details: `inviteeEmail` (pre-filled),
 *      `givenName`, `familyName`, plus the role table
 *      (`UserInvitationUserGroupsTable`). The wizard pre-renders one
 *      empty `userGroupsToAdd` row (see store.js#239), so picking a
 *      role + start date + masthead does NOT require an extra click.
 *   3. userInvited — Email Composer. The auto-loaded
 *      UserRoleAssignmentInvitationNotify body is fine; the
 *      "Invite user to the role" button drives `invitations/{id}/invite`.
 *
 * `AcceptInvitationStep::getSteps` (invitee side, anonymous +
 * `OrcidManager::isEnabled` is false on a scratch journal so the ORCID
 * step is omitted). The steps depend on whether the invitation resolves
 * to an EXISTING user (`invitationModel->userId`, also set lazily from
 * a matching email via `changeInvitationUserIdUsingUserEmail`):
 *   - New user: userCreate (username + password + privacy consent) →
 *     userDetails (affiliation, names, country) → userCreateReview.
 *   - Existing user: userCreateReview ONLY — no account creation, no
 *     details form. On top of that,
 *     `UserRoleAssignmentReceiveController::authorize` AUTO-LOGS-IN the
 *     invitation's user when nobody is logged in
 *     (`Validation::registerUserSession`), so an anonymous click on the
 *     accept link lands in an authenticated review-and-accept step.
 *     Row 3 asserts exactly this branch.
 *
 * Surprise — the PKP `finalize` endpoint does NOT auto-log-in a NEWLY
 * CREATED user; clicking "View All Submissions" on the success dialog
 * redirects to `/{contextPath}/submissions` which bounces through
 * `/login` (row 1 drives a fresh login as the final fidelity check).
 * For an EXISTING user the auto-login from `receive` means the same
 * click lands straight on the dashboard (row 3 asserts no login
 * bounce).
 *
 * Surprise #2 — the OJS login form's password input ships with
 * `maxlength="32"` (lib/pkp/templates/frontend/components/loginForm.tpl),
 * but the AcceptInvitation wizard's password field has no such cap.
 * A long generated password (e.g. `username + username` per the
 * baseline `getPassword` rule, which produces 40+ chars for a tagged
 * username) writes a hash on accept that no later login can ever match
 * — Playwright's `.fill()` honours maxlength and silently truncates.
 * Use a short literal password (under 32 chars) here; the data/users.js
 * baseline rule does NOT apply to row 1's invitee.
 *
 * ## Email link extraction
 *
 *   The body's accept/decline anchors
 *   (locale `emails.userRoleAssignmentInvitationNotify.body`, verified
 *   at lib/pkp/locale/en/emails.po:604-623) use single-quoted hrefs AND
 *   a `class='btn btn-accept'` / `class='btn btn-decline'` attribute
 *   between href and `>` — neither variant `pkpMail.extractLink`
 *   covers (it requires double-quoted hrefs + contiguous link text).
 *   `extractInvitationUrl` below anchors on the `btn-accept` /
 *   `btn-decline` class signature instead, which is the stable
 *   invariant of the invitation template.
 *
 * ## Invitation lifecycle endpoints (verified live sources)
 *
 *   - Cancel: `PUT /api/v1/invitations/{id}/cancel` (manager session) —
 *     `UserRoleAssignmentCreateController::cancel` marks CANCELLED. The
 *     Invitations panel (`UserInvitationManager`) drives it via the
 *     row's "Cancel Invite" action + "Cancel Invitation" dialog.
 *   - Decline: the emailed `/{context}/invitation/decline?id=…&key=…`
 *     link renders a confirm page (templates/invitation/
 *     declineInvitation.tpl, h1 "Decline Invitation"); the POSTing
 *     "Confirm Decline Invitation" button hits `confirmDecline` which
 *     marks DECLINED and redirects to `/login`.
 *   - Any non-PENDING invitation: `Repo::invitation()->getByIdAndKey`
 *     scopes to `notHandled()` (status == PENDING), so a used/declined/
 *     cancelled accept link falls through to the "Invitation
 *     Unavailable" landing page
 *     (InvitationHandler::displayInvitationNotAvailablePage), NOT a
 *     role grant.
 *   - The Invitations panel heading is "Invitations (N)" where N is the
 *     `stillActive()` (pending + unexpired) count for the journal —
 *     scratch-journal-scoped, so the count assertions are
 *     parallel-safe.
 *
 * ## Locator pitfalls
 *
 *   - Headlessui menus + reka-ui dialogs: `getByRole('menuitem', ...)`
 *     / `getByRole('dialog')` at the page level (portaled to the
 *     document root).
 *   - Side-modal vs full-page: the manager-side invitation wizard
 *     mounts at /invitation/create/userRoleAssignment (full page).
 *   - The accept URL is a `/{contextPath}/invitation/accept?id=…&key=…`
 *     redirect that bounces through
 *     `/{contextPath}/invitation/userRoleAssignment/...` before
 *     mounting the AcceptInvitationPage Vue component. Don't race the
 *     URL — wait for the page mount via the first-step heading.
 *   - Privacy-consent renders as a FieldOptions checkbox; the input is
 *     `input[name="privacyStatement"][type="checkbox"]`. Use
 *     `.check()`, not `.click()` (the label wraps a link too).
 *   - The user-details form is multilingual; the wizard's primary
 *     locale on the scratch journal is `en`, so anchor on the `-en`
 *     suffixed inputs.
 *
 * ## Mail::fake boundary & Mailpit discipline
 *
 *   The manager-side POSTs go through the regular invitation API
 *   (`/api/v1/invitations/{id}/invite`), so the resulting mail flows to
 *   Mailpit. Mailpit is SHARED across parallel workers (charter
 *   principle 8): every read here uses `pkpMail.find({to, contains:
 *   tag})` — the recipient is per-test unique AND the body carries the
 *   tag via {$contextName}. Two discipline notes from refit:
 *   - An earlier revision called `pkpMail.clearAll()` as "cheap
 *     insurance" — that wipes sibling workers' mail mid-flight and is
 *     exactly what principle 8 forbids; removed.
 *   - `pkpMail.latestTo`/`inboxFor` are NOT recipient-scoped in
 *     practice: they query Mailpit's /api/v1/messages, which IGNORES
 *     the `query` parameter (verified against v1.29.7 — only
 *     /api/v1/search filters). Under parallel load `latestTo` returns
 *     the globally newest message; this spec once pulled a sibling
 *     worker's invitation email that way and declined a foreign
 *     invitation. Always `find`.
 */
test.describe('User invitations — lifecycle', () => {
	test(
		'manager invites a new user; the invitee accepts via the email link, completes registration, and lands in the assigned role',
		{tag: '@regression'},
		async ({pkpApi, pkpMail, browser, baseURL, asUser}) => {
			const tag = uniqueTag('r57');
			const inviteeEmail = `invitee-${tag}@mailinator.com`;
			const inviteeUsername = `invitee-${tag}`;
			// The OJS login form's password input ships `maxlength=32`
			// (lib/pkp/templates/frontend/components/loginForm.tpl); the
			// AcceptInvitation wizard's password field has no such cap,
			// so a `getPassword(username)` derivative ("username + username"
			// per data/users.js#getPassword) writes a 40+ char hash on
			// accept that no subsequent login can ever match — the form
			// silently truncates to 32 chars. Use a short literal that
			// fits both forms; "Inv1tee!Pwd" exceeds the minimum-length
			// rule (6 by default) and stays under any maxlength.
			const inviteePassword = 'Inv1tee!Pwd';
			const inviteeGivenName = 'Invited';
			const inviteeFamilyName = `User-${tag}`;

			const {context} = await pkpApi.createJournal({
				tag,
				users: [{username: 'dbarnes', roles: ['manager']}],
			});

			const managerCtx = await asUser('dbarnes');
			let inviteeCtx;
			try {
				const managerPage = await managerCtx.newPage();
				await managerPage.goto(
					`/index.php/${context.path}/management/settings/access`,
				);
				await expect(
					managerPage.getByRole('heading', {name: 'Users & Roles'}),
				).toBeVisible();

				// Drive "Invite to a role". Per InvitationHandler / the
				// access page's button, this navigates to the invitation
				// wizard at /invitation/userRoleAssignment.
				await managerPage
					.getByRole('button', {name: 'Invite to a role', exact: true})
					.click();

				// Step 1 — Search User. Wait for the search input + its
				// surrounding step heading to mount.
				await expect(
					managerPage.getByRole('heading', {
						name: /STEP 1 - Search User/i,
					}),
				).toBeVisible({timeout: 15_000});

				// The FieldText control name is `search` on the wizard's
				// payload. Native input has `name="search"`; we anchor on
				// it directly.
				await managerPage.locator('input[name="search"]').fill(inviteeEmail);

				// "Search User" advance — the registered action runs the
				// user query, finds none, and sets `inviteeEmail` on the
				// wizard payload before letting the wizard advance.
				await managerPage
					.getByRole('button', {name: 'Search User', exact: true})
					.click();

				// Step 2 — Enter Details. Email is pre-filled from the
				// search step; given/family names + role table need
				// driving.
				await expect(
					managerPage.getByRole('heading', {
						name: /STEP 2 - Enter details and invite for roles/i,
					}),
				).toBeVisible({timeout: 15_000});

				// givenName / familyName are multilingual <FieldText>
				// inputs whose `<input>` `name` is `givenName-en` etc.
				// The form is mounted with the wizard's primary locale
				// (en on the scratch journal).
				await managerPage
					.locator('input[name="givenName-en"]')
					.fill(inviteeGivenName);
				await managerPage
					.locator('input[name="familyName-en"]')
					.fill(inviteeFamilyName);

				// Role table — one empty row pre-rendered. Pick Reviewer
				// (the row's plan choice; reviewer roles auto-show on
				// masthead and don't surface the masthead select).
				await managerPage
					.locator('select[name="userGroupId"]')
					.selectOption({label: 'Reviewer'});

				const today = todayIso();
				await managerPage.locator('input[name="dateStart"]').fill(today);

				// Reviewer is one of `reviewerUserGroupIds`, so masthead
				// renders as a static "Visible on Journal Masthead" span
				// (no select); skip the masthead pick.

				// Step 2 → Step 3 (email composer).
				await managerPage
					.getByRole('button', {name: 'Save And Continue', exact: true})
					.click();

				// Step 3 — Email Composer. The mailable's body is auto-
				// loaded; "Invite user to the role" submits the
				// invitation and dispatches the email.
				await expect(
					managerPage.getByRole('button', {
						name: 'Invite user to the role',
						exact: true,
					}),
				).toBeVisible({timeout: 15_000});
				await managerPage
					.getByRole('button', {
						name: 'Invite user to the role',
						exact: true,
					})
					.click();

				// "Invitation Sent" reka-ui PkpDialog confirms the
				// dispatch on the manager side.
				const sentDialog = managerPage.getByRole('dialog', {
					name: 'Invitation Sent',
				});
				await expect(sentDialog).toBeVisible({timeout: 15_000});
				await expect(sentDialog).toContainText(inviteeEmail);

				// ----- Email side -----
				// Scoped read (principle 8): recipient + the unique tag,
				// which appears in the body via {$contextName} ("Scratch
				// context <tag>"). NEVER latestTo/inboxFor here — those
				// hit Mailpit's /api/v1/messages which IGNORES the query
				// param (verified against v1.29.7), so under parallel
				// load they return ANOTHER test's newest email; this
				// spec once extracted a sibling worker's accept link and
				// declined a foreign invitation that way.
				const [latest] = await pkpMail.find({
					to: inviteeEmail,
					contains: tag,
					timeoutMs: 15_000,
				});
				const full = await pkpMail.fullMessage(latest.ID);
				const acceptUrl = extractInvitationUrl(full.HTML || '', 'accept');
				expect(acceptUrl, 'Accept Invitation link from email').toBeTruthy();

				// ----- Invitee side -----
				inviteeCtx = await browser.newContext({
					baseURL,
					storageState: {cookies: [], origins: []},
				});
				const inviteePage = await inviteeCtx.newPage();
				await inviteePage.goto(acceptUrl);

				// AcceptInvitation step 1 — userCreate (username +
				// password + privacy). Wait for the receiveInvitation
				// fetch to settle by anchoring on the email display
				// block — `store.email` is null until the fetch returns,
				// and the FieldText controls only mount once the wizard
				// store transitions through openStep, so a stale fill
				// can race the receive.
				await expect(
					inviteePage.getByText(inviteeEmail, {exact: true}).first(),
				).toBeVisible({timeout: 20_000});

				await inviteePage
					.locator('input[name="username"]')
					.fill(inviteeUsername);
				await inviteePage
					.locator('input[name="password"]')
					.fill(inviteePassword);

				// Privacy consent — FieldOptions checkbox + the post-fill
				// `toBeChecked` assertion forces the v-model emit to
				// land before "Save and continue", otherwise the wizard's
				// updateInvitationPayload() local privacy gate rejects
				// the step transition.
				const privacyCheckbox = inviteePage.locator(
					'input[name="privacyStatement"][type="checkbox"]',
				);
				await privacyCheckbox.check();
				await expect(privacyCheckbox).toBeChecked();

				// Step 1 → Step 2 (userDetails).
				await inviteePage
					.getByRole('button', {name: 'Save and continue', exact: true})
					.click();

				// AcceptInvitation step 2 — userDetails. The form fields
				// `givenName` / `familyName` are pre-filled from the
				// manager step. `affiliation` and `userCountry` are NOT
				// pre-filled — the manager-side wizard never collects
				// them.
				//
				// The form's input name pattern matches the same Field
				// definitions used by `UserDetailsForm`, with
				// `affiliation-en` for the multilingual text and
				// `userCountry` as a non-multilingual <select>.
				await expect(
					inviteePage.locator('input[name="affiliation-en"]'),
				).toBeVisible({timeout: 15_000});
				await inviteePage
					.locator('input[name="affiliation-en"]')
					.fill('Public Knowledge Project');
				await inviteePage
					.locator('select[name="userCountry"]')
					.selectOption('CA');

				// Step 2 → Step 3 (review). Same "Save and continue".
				await inviteePage
					.getByRole('button', {name: 'Save and continue', exact: true})
					.click();

				// AcceptInvitation step 3 — review + finalize.
				await expect(
					inviteePage.getByRole('heading', {
						name: /Review & create account/i,
					}),
				).toBeVisible({timeout: 15_000});

				// Review step's next button — `acceptInvitation
				// .detailsReview.nextButtonLabel` resolves via the
				// OJS-specific override at `locale/en/invitation.po:10`
				// to "Accept And Continue to OJS" (OMP/OPS would
				// override the same key with "...OMP" / "...OPS").
				// Anchor on the leading invariant prefix so this spec
				// stays application-agnostic.
				await inviteePage
					.getByRole('button', {name: /^Accept And Continue/i})
					.click();

				// Success modal — the post-finalize dialog confirms the
				// invitation was accepted. The modal title pulls from
				// `acceptInvitation.modal.title` ("You've been assigned a
				// new role in OJS" via the OJS-specific override at
				// locale/en/invitation.po:19).
				const successDialog = inviteePage.getByRole('dialog');
				await expect(successDialog).toBeVisible({timeout: 20_000});
				await expect(successDialog).toContainText(/new role/i);
				// Close the dialog. The "View All Submissions" callback
				// redirects to `/{contextPath}/submissions` — but the
				// PKP `finalize` endpoint does NOT auto-log-in the new
				// user (the OJS-side journey requires a manual login,
				// confirmed by the redirect bouncing through `/login`).
				// The fidelity step below logs in explicitly with the
				// freshly-created credentials, which is the canonical
				// "user lands in the assigned role" assertion.
				await successDialog
					.getByRole('button', {name: 'View All Submissions', exact: true})
					.click();

				// ----- REST verification (via the manager's session) -----
				// Confirm the new user exists with the assigned role on
				// the scratch journal.
				const newUser = await findUserByEmail(
					managerPage,
					context.path,
					inviteeEmail,
				);
				expect(newUser, `new user row for ${inviteeEmail}`).toBeTruthy();
				expect(newUser.userName).toBe(inviteeUsername);

				// Role-assignment shape: the user's `groups` array on
				// the journal-scoped users endpoint contains the user-
				// group rows for the journal context. Reviewer is in
				// the list.
				const groupNames = groupNamesOf(newUser);
				expect(
					groupNames.some((name) => /reviewer/i.test(String(name))),
					`new user has Reviewer role (groups: ${JSON.stringify(groupNames)})`,
				).toBeTruthy();

				// ----- Fidelity: log in as the new user -----
				// Drive the standard login form to confirm the
				// credentials the AcceptInvitation wizard wrote work
				// end-to-end. The dashboard URL pattern matches both
				// editorial (manager/editor) and mySubmissions (author/
				// reviewer-only) landings — Reviewer typically gets the
				// reviewer dashboard, but the bootstrap may route via
				// mySubmissions on first login. Anchor on either.
				await inviteePage.goto(`/index.php/${context.path}/login`);
				await inviteePage
					.locator('input[name="username"]')
					.fill(inviteeUsername);
				await inviteePage
					.locator('input[name="password"]')
					.fill(inviteePassword);
				await inviteePage
					.locator('form#login button[type="submit"]')
					.click();
				await inviteePage.waitForURL(
					/\/dashboard\/(editorial|mySubmissions|reviewAssignments)/,
					{timeout: 20_000},
				);
			} finally {
				if (inviteeCtx) {
					await inviteeCtx.close();
				}
			}
		},
	);

	test(
		'an existing journal user accepts a role invitation without re-registering',
		{tag: '@regression'},
		async ({pkpApi, pkpMail, browser, baseURL, asUser}) => {
			const tag = uniqueTag('r3');
			const suffix = tag.split('-').pop();
			const invitee = {
				username: `uiv3${suffix}`,
				password: `uiv3${suffix}uiv3${suffix}`,
				givenName: 'Ines',
				familyName: `Existing${suffix}`,
				email: `uiv3${suffix}@mailinator.com`,
			};

			const {context} = await pkpApi.createJournal({
				tag,
				users: [
					{username: 'dbarnes', roles: ['manager']},
					// Throwaway EXISTING journal user — already a reviewer,
					// invited to the additional Author role below.
					{...invitee, roles: ['reviewer']},
				],
			});

			const managerCtx = await asUser('dbarnes');
			const managerPage = await managerCtx.newPage();
			// Load an authenticated backend page so window.pkp.currentUser
			// (and its csrfToken) exists for the REST setup calls.
			await managerPage.goto(
				`/index.php/${context.path}/management/settings/access`,
			);
			await expect(
				managerPage.getByRole('heading', {name: 'Users & Roles'}),
			).toBeVisible();

			// Setup (principle 4): create the invitation through the same
			// REST pipeline the Edit-user wizard drives (add → populate →
			// invite). The wizard UI itself is rows 1/2/6 territory.
			const targetUser = await findUserByEmail(
				managerPage,
				context.path,
				invitee.email,
			);
			expect(targetUser, 'throwaway invitee resolved').toBeTruthy();
			const authorGroupId = await getUserGroupIdByName(
				managerPage,
				context.path,
				'Author',
			);
			await createRoleInvitation(managerPage, context.path, {
				userId: targetUser.id,
				userGroupsToAdd: [
					{userGroupId: authorGroupId, dateStart: todayIso(), masthead: false},
				],
			});

			// The pending invitation shows on the Invitations panel.
			await managerPage.goto(
				`/index.php/${context.path}/management/settings/access`,
			);
			await expect(
				managerPage.getByRole('heading', {name: /^Invitations \(1\)$/}),
			).toBeVisible({timeout: 15_000});

			// ----- Email side -----
			// Scoped read (principle 8): recipient + tag (in the body via
			// {$contextName}). See row 1's note on why latestTo is unsafe.
			const [latest] = await pkpMail.find({
				to: invitee.email,
				contains: tag,
				timeoutMs: 15_000,
			});
			const full = await pkpMail.fullMessage(latest.ID);
			const acceptUrl = extractInvitationUrl(full.HTML || '', 'accept');

			// ----- Invitee side (anonymous context) -----
			const inviteeCtx = await browser.newContext({
				baseURL,
				storageState: {cookies: [], origins: []},
			});
			try {
				const inviteePage = await inviteeCtx.newPage();
				await inviteePage.goto(acceptUrl);

				// Existing-account branch: AcceptInvitationStep::getSteps
				// returns ONLY the review step when the invitation has a
				// userId, so the wizard mounts directly on
				// "Review & create account" — no userCreate, no
				// userDetails.
				await expect(
					inviteePage.getByRole('heading', {
						name: /Review & create account/i,
					}),
				).toBeVisible({timeout: 20_000});
				await expect(
					inviteePage.locator('input[name="username"]'),
					'no account-creation form for an existing user',
				).toHaveCount(0);
				await expect(
					inviteePage.locator('input[name="password"]'),
				).toHaveCount(0);

				// The review's Roles table lists the invited role.
				const rolesTable = inviteePage.getByRole('table', {name: 'Roles'});
				await expect(rolesTable).toContainText('Author');

				// Finalize. Server-side, every receive/refine/finalize API
				// call auto-authenticates as the invitation's user when
				// nobody is logged in
				// (UserRoleAssignmentReceiveController::authorize →
				// Validation::registerUserSession — re-run per request),
				// which is what lets an anonymous browser complete the
				// wizard for an existing account. That session does NOT
				// reliably persist to the browser, so the success
				// dialog's "View All Submissions" may land on /login —
				// matching the row's contract: the existing user LOGS IN
				// (with their unchanged credentials), they never
				// re-register. Tolerate both landings and finish with an
				// explicit login when bounced.
				await inviteePage
					.getByRole('button', {name: /^Accept And Continue/i})
					.click();
				const successDialog = inviteePage.getByRole('dialog');
				await expect(successDialog).toBeVisible({timeout: 20_000});
				await expect(successDialog).toContainText(/new role/i);
				await successDialog
					.getByRole('button', {name: 'View All Submissions', exact: true})
					.click();
				await inviteePage.waitForURL(/\/(login|dashboard)\b/, {
					timeout: 20_000,
				});
				if (/\/login\b/.test(inviteePage.url())) {
					// The EXISTING credentials still work — nothing was
					// re-registered by the accept flow.
					await inviteePage
						.locator('input[name="username"]')
						.fill(invitee.username);
					await inviteePage
						.locator('input[name="password"]')
						.fill(invitee.password);
					await inviteePage
						.locator('form#login button[type="submit"]')
						.click();
				}
				await inviteePage.waitForURL(
					/\/dashboard\/(editorial|mySubmissions|reviewAssignments)/,
					{timeout: 20_000},
				);
				const currentUser = await inviteePage.evaluate(
					() => window.pkp?.currentUser,
				);
				expect(
					currentUser?.username,
					'the EXISTING account is active — no re-registration happened',
				).toBe(invitee.username);
			} finally {
				await inviteeCtx.close();
			}

			// ----- Manager side: role active, pending cleared -----
			const after = await findUserByEmail(
				managerPage,
				context.path,
				invitee.email,
			);
			const groupNames = groupNamesOf(after);
			expect(
				groupNames.some((name) => /author/i.test(String(name))),
				`Author role active after accept (groups: ${JSON.stringify(groupNames)})`,
			).toBeTruthy();
			expect(
				groupNames.some((name) => /reviewer/i.test(String(name))),
				'pre-existing Reviewer role untouched',
			).toBeTruthy();

			await managerPage.goto(
				`/index.php/${context.path}/management/settings/access`,
			);
			await expect(
				managerPage.getByRole('heading', {name: /^Invitations \(0\)$/}),
			).toBeVisible({timeout: 15_000});
		},
	);

	test(
		'an invitee declines an invitation via the emailed decline link',
		{tag: '@regression'},
		async ({pkpApi, pkpMail, browser, baseURL, asUser}) => {
			const tag = uniqueTag('r4');
			const suffix = tag.split('-').pop();
			const inviteeEmail = `uiv4${suffix}@mailinator.com`;

			const {context} = await pkpApi.createJournal({
				tag,
				users: [{username: 'dbarnes', roles: ['manager']}],
			});

			const managerCtx = await asUser('dbarnes');
			const managerPage = await managerCtx.newPage();
			await managerPage.goto(
				`/index.php/${context.path}/management/settings/access`,
			);
			await expect(
				managerPage.getByRole('heading', {name: 'Users & Roles'}),
			).toBeVisible();

			// Setup: new-email invitation to the Author role via REST.
			const authorGroupId = await getUserGroupIdByName(
				managerPage,
				context.path,
				'Author',
			);
			await createRoleInvitation(managerPage, context.path, {
				inviteeEmail,
				givenName: 'Devin',
				familyName: `Decliner${suffix}`,
				userGroupsToAdd: [
					{userGroupId: authorGroupId, dateStart: todayIso(), masthead: false},
				],
			});

			await managerPage.goto(
				`/index.php/${context.path}/management/settings/access`,
			);
			await expect(
				managerPage.getByRole('heading', {name: /^Invitations \(1\)$/}),
			).toBeVisible({timeout: 15_000});

			// ----- Email side: both lifecycle links from one message -----
			// Scoped read (principle 8) — see row 1's note on latestTo.
			const [latest] = await pkpMail.find({
				to: inviteeEmail,
				contains: tag,
				timeoutMs: 15_000,
			});
			const full = await pkpMail.fullMessage(latest.ID);
			const html = full.HTML || '';
			const declineUrl = extractInvitationUrl(html, 'decline');
			const acceptUrl = extractInvitationUrl(html, 'accept');

			// ----- Invitee declines (anonymous) -----
			const inviteeCtx = await browser.newContext({
				baseURL,
				storageState: {cookies: [], origins: []},
			});
			try {
				const inviteePage = await inviteeCtx.newPage();
				await inviteePage.goto(declineUrl);

				// Decline is a 2-step confirm (GET renders the page, the
				// POST actually declines — pkp/pkp-lib#11690): h1
				// "Decline Invitation" + "Confirm Decline Invitation"
				// submit.
				await expect(
					inviteePage.getByRole('heading', {name: 'Decline Invitation'}),
				).toBeVisible({timeout: 15_000});
				await inviteePage
					.getByRole('button', {name: 'Confirm Decline Invitation'})
					.click();

				// confirmDecline marks the invitation DECLINED and
				// redirects to the journal login page.
				await inviteePage.waitForURL(/\/login/, {timeout: 20_000});

				// The invitation is no longer actionable: the accept link
				// resolves to the "Invitation Unavailable" landing page
				// (getByIdAndKey scopes to PENDING), not the wizard.
				await inviteePage.goto(acceptUrl);
				await expect(
					inviteePage.getByRole('heading', {name: 'Invitation Unavailable'}),
				).toBeVisible({timeout: 15_000});
			} finally {
				await inviteeCtx.close();
			}

			// ----- Manager side -----
			// The panel no longer counts the invitation as pending.
			await managerPage.goto(
				`/index.php/${context.path}/management/settings/access`,
			);
			await expect(
				managerPage.getByRole('heading', {name: /^Invitations \(0\)$/}),
			).toBeVisible({timeout: 15_000});
			// No role was granted — the Users list is unchanged (the
			// invitee never registered, so no user row exists at all).
			const declinedUser = await findUserByEmail(
				managerPage,
				context.path,
				inviteeEmail,
			);
			expect(declinedUser, 'no user created for declined invitee').toBeNull();
		},
	);

	test(
		'a manager cancels a pending invitation and the emailed accept link stops working',
		{tag: '@regression'},
		async ({pkpApi, pkpMail, browser, baseURL, asUser}) => {
			const tag = uniqueTag('r5');
			const suffix = tag.split('-').pop();
			const inviteeEmail = `uiv5${suffix}@mailinator.com`;

			const {context} = await pkpApi.createJournal({
				tag,
				users: [{username: 'dbarnes', roles: ['manager']}],
			});

			const managerCtx = await asUser('dbarnes');
			const managerPage = await managerCtx.newPage();
			await managerPage.goto(
				`/index.php/${context.path}/management/settings/access`,
			);
			await expect(
				managerPage.getByRole('heading', {name: 'Users & Roles'}),
			).toBeVisible();

			// Setup: new-email invitation via REST.
			const authorGroupId = await getUserGroupIdByName(
				managerPage,
				context.path,
				'Author',
			);
			await createRoleInvitation(managerPage, context.path, {
				inviteeEmail,
				givenName: 'Cara',
				familyName: `Cancelled${suffix}`,
				userGroupsToAdd: [
					{userGroupId: authorGroupId, dateStart: todayIso(), masthead: false},
				],
			});

			// Grab the accept URL BEFORE cancelling — the point of the
			// test is that this very link goes dead afterwards. Scoped
			// read (principle 8) — see row 1's note on latestTo.
			const [latest] = await pkpMail.find({
				to: inviteeEmail,
				contains: tag,
				timeoutMs: 15_000,
			});
			const full = await pkpMail.fullMessage(latest.ID);
			const acceptUrl = extractInvitationUrl(full.HTML || '', 'accept');

			// ----- Manager cancels from the Invitations panel -----
			await managerPage.goto(
				`/index.php/${context.path}/management/settings/access`,
			);
			await expect(
				managerPage.getByRole('heading', {name: /^Invitations \(1\)$/}),
			).toBeVisible({timeout: 15_000});

			const inviteRow = managerPage.locator('tr', {hasText: inviteeEmail});
			await expect(inviteRow).toBeVisible();
			// The row's DropdownActions trigger is a headlessui menu
			// button; anchor on the aria-haspopup attribute (its
			// accessible name is a translation that may be unresolved on
			// scratch journals — same caveat as the Users table).
			await inviteRow.locator('button[aria-haspopup="menu"]').click();
			// Menu items portal to the document root — page scope.
			await managerPage
				.getByRole('menuitem', {name: 'Cancel Invite', exact: true})
				.click();

			// reka-ui confirm dialog: title "Cancel Invitation", body
			// echoes the invitee details, warnable primary action with
			// the same "Cancel Invitation" label.
			const cancelDialog = managerPage.getByRole('dialog', {
				name: 'Cancel Invitation',
			});
			await expect(cancelDialog).toBeVisible({timeout: 15_000});
			await expect(cancelDialog).toContainText(inviteeEmail);
			await cancelDialog
				.getByRole('button', {name: 'Cancel Invitation', exact: true})
				.click();

			// The store refetches after the PUT /cancel: row gone, count
			// back to zero.
			await expect(
				managerPage.getByRole('heading', {name: /^Invitations \(0\)$/}),
			).toBeVisible({timeout: 15_000});
			await expect(managerPage.locator('tr', {hasText: inviteeEmail})).toHaveCount(
				0,
			);

			// ----- The emailed accept link now errors -----
			const inviteeCtx = await browser.newContext({
				baseURL,
				storageState: {cookies: [], origins: []},
			});
			try {
				const inviteePage = await inviteeCtx.newPage();
				await inviteePage.goto(acceptUrl);
				await expect(
					inviteePage.getByRole('heading', {name: 'Invitation Unavailable'}),
				).toBeVisible({timeout: 15_000});
			} finally {
				await inviteeCtx.close();
			}

			// No role granted / no account minted for the invitee.
			const cancelledUser = await findUserByEmail(
				managerPage,
				context.path,
				inviteeEmail,
			);
			expect(cancelledUser, 'no user created for cancelled invitee').toBeNull();
		},
	);
});

function uniqueTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

function todayIso() {
	return new Date().toISOString().split('T')[0];
}

/**
 * Pull the `<a class='btn btn-accept|btn-decline' href='...'>` URL out
 * of the userRoleAssignmentInvitationNotify HTML body. The shared
 * `pkpMail.extractLink` helper requires double-quoted hrefs and
 * contiguous link text, neither of which the email template ships;
 * keep this local rather than hand-tuning the shared helper for one
 * caller.
 *
 * @param {string} html
 * @param {'accept'|'decline'} kind
 */
function extractInvitationUrl(html, kind) {
	const re = new RegExp(
		`<a[^>]+href=['"]([^'"]+)['"][^>]*class=['"][^'"]*btn-${kind}[^'"]*['"][^>]*>`,
		'i',
	);
	const match = html.match(re);
	if (!match) {
		throw new Error(`${kind} link not found in mail body`);
	}
	return match[1];
}

/**
 * Resolve a journal user via the context-scoped users endpoint, using
 * the authenticated browser context's request (session + cookies ride
 * along). Returns null when no user with that exact email is enrolled.
 */
async function findUserByEmail(page, contextPath, email) {
	const res = await page.request.get(
		`/index.php/${contextPath}/api/v1/users?searchPhrase=${encodeURIComponent(
			email,
		)}&status=all`,
	);
	if (!res.ok()) {
		throw new Error(`GET users: ${res.status()} — ${await res.text()}`);
	}
	const body = await res.json();
	return (body.items ?? []).find((u) => u.email === email) ?? null;
}

/** Localized group names from a users-endpoint row. */
function groupNamesOf(user) {
	return (user?.groups || []).map((g) =>
		typeof g.name === 'string' ? g.name : g.name?.en || Object.values(g.name || {})[0],
	);
}

/**
 * Resolve a user group id by its localized name on the scratch journal
 * (GET /api/v1/userGroups → UserGroupResource: {id, roleId, name}).
 */
async function getUserGroupIdByName(page, contextPath, name) {
	const res = await page.request.get(
		`/index.php/${contextPath}/api/v1/userGroups`,
	);
	if (!res.ok()) {
		throw new Error(`GET userGroups: ${res.status()} — ${await res.text()}`);
	}
	const body = await res.json();
	const group = (body.items ?? []).find((g) => g.name === name);
	if (!group) {
		throw new Error(
			`user group "${name}" not found (got ${JSON.stringify(
				(body.items ?? []).map((g) => g.name),
			)})`,
		);
	}
	return group.id;
}

/**
 * Create + send a userRoleAssignment invitation through the regular
 * REST pipeline the wizard drives: POST add → PUT populate → PUT
 * invite. Used as SETUP by rows whose behavior-under-test is the
 * invitee/panel side, not the wizard (principle 4). `page` must be an
 * authenticated manager page that has rendered a backend view (the
 * CSRF token is read from window.pkp.currentUser).
 *
 * APP BUG worked around here:
 * `UserRoleAssignmentInvite::getMailable()` (lib/pkp/classes/
 * invitation/invitations/userRoleAssignment/UserRoleAssignmentInvite.php
 * :110-124) only assigns `$emailBody` INSIDE
 * `if (isset($emailComposerValues))` — when the payload carries no
 * `emailComposer`, `->body($emailBody)` reads an undefined variable
 * and the invitation email goes out with an EMPTY body (just the
 * mailable's <style> block — no accept/decline links). The computed
 * `$templateBody` fallback exists but is never used. The UI never
 * hits this because UserInvitationEmailComposerStep.vue#70-75 always
 * writes `emailComposer: {subject, body}` on mount; this helper
 * mirrors that by loading the default USER_ROLE_ASSIGNMENT_INVITATION
 * template and sending it along with populate. Variables like
 * {$acceptUrl}/{$declineUrl} are mailable substitutions resolved at
 * send time, so the raw template body is the correct payload.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} contextPath
 * @param {{userId?: number, inviteeEmail?: string, givenName?: string,
 *   familyName?: string,
 *   userGroupsToAdd: Array<{userGroupId: number, dateStart: string, masthead: boolean}>
 * }} opts
 * @returns {Promise<number>} invitationId
 */
async function createRoleInvitation(
	page,
	contextPath,
	{userId, inviteeEmail, givenName, familyName, userGroupsToAdd},
) {
	const csrfToken = await page.evaluate(
		() => window.pkp?.currentUser?.csrfToken,
	);
	if (!csrfToken) {
		throw new Error(
			'No CSRF token — navigate the page to an authenticated backend view first',
		);
	}
	const headers = {
		'X-Csrf-Token': csrfToken,
		'Content-Type': 'application/json',
	};
	const api = `/index.php/${contextPath}/api/v1/invitations`;

	const addRes = await page.request.post(`${api}/add/userRoleAssignment`, {
		headers,
		data: {invitationData: userId ? {userId} : {inviteeEmail}},
	});
	if (!addRes.ok()) {
		throw new Error(
			`POST invitations/add: ${addRes.status()} — ${await addRes.text()}`,
		);
	}
	const {invitationId} = await addRes.json();

	const invitationData = {userGroupsToAdd};
	if (givenName) {
		invitationData.givenName = {en: givenName};
	}
	if (familyName) {
		invitationData.familyName = {en: familyName};
	}
	// Default mailable template → emailComposer, as the composer step
	// does (see the APP BUG note above; without it the email body is
	// empty and carries no accept/decline links).
	const tplRes = await page.request.get(
		`/index.php/${contextPath}/api/v1/emailTemplates/USER_ROLE_ASSIGNMENT_INVITATION`,
	);
	if (!tplRes.ok()) {
		throw new Error(
			`GET emailTemplates: ${tplRes.status()} — ${await tplRes.text()}`,
		);
	}
	const tpl = await tplRes.json();
	invitationData.emailComposer = {
		subject: localizedValue(tpl.subject),
		body: localizedValue(tpl.body),
	};
	const popRes = await page.request.put(`${api}/${invitationId}/populate`, {
		headers,
		data: {invitationData},
	});
	if (!popRes.ok()) {
		throw new Error(
			`PUT invitations/${invitationId}/populate: ${popRes.status()} — ${await popRes.text()}`,
		);
	}

	const invRes = await page.request.put(`${api}/${invitationId}/invite`, {
		headers,
		data: {},
	});
	if (!invRes.ok()) {
		throw new Error(
			`PUT invitations/${invitationId}/invite: ${invRes.status()} — ${await invRes.text()}`,
		);
	}
	return invitationId;
}

/** Pull the en (or first) value out of a localized REST field. */
function localizedValue(value) {
	if (typeof value === 'string') {
		return value;
	}
	return value?.en ?? Object.values(value || {})[0] ?? '';
}
