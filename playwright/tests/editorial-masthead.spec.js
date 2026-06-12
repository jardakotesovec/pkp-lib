// @ts-check
const {test, expect} = require('../support/base-test.js');

/**
 * Editorial masthead — docs/e2e/plans/editorial-masthead.md.
 *
 * Row 1 ports cypress/tests/integration/EditorialMasthead.cy.js: the
 * reader-only page renders for anonymous visitors (bootstrapped
 * publicknowledge, read-only — no scratch journal needed).
 *
 * Row 2 covers what actually drives the page's content
 * (AboutContextHandler::editorialMasthead +
 * templates/frontend/pages/editorialMasthead.tpl):
 *   - role sections render only for user groups with the `masthead`
 *     flag (registry/userGroups.xml: Journal editor, Section editor,
 *     Editorial Board Member… — and reviewer roles are explicitly
 *     EXCLUDED from the sections, they get the separate previous-year
 *     Peer Reviewers block instead);
 *   - within a section, a user appears only when their assignment row
 *     carries the per-user opt-in (`user_user_groups.masthead = 1`),
 *     rendered with the assignment's start YEAR (`date_start` →
 *     common.fromUntil "{$from} –").
 *
 * UI-FALLBACK rationale (adjudicated in the plan): the scenario
 * endpoint's UserAssignmentProcessor calls
 * `assignUserToGroup(..., masthead: null)`, so NO seeded assignment
 * ever appears on the masthead. The only production write-path for the
 * opt-in is the invitation round-trip: the manager's wizard records
 * the masthead choice on `userGroupsToAdd`, and the invitee's accept
 * (`UserRoleAssignmentReceiveController::finalize`) is what calls
 * `assignUserToGroup(..., masthead: true)` — also clearing the
 * editorial-masthead cache. Row 2 therefore reaches the opted-in state
 * via the invitation accept round-trip in-test: REST invite (the same
 * pipeline the wizard drives — principle 4 keeps the manager UI out of
 * a row whose behavior-under-test is the masthead page) + UI accept
 * (the part that performs the gated write).
 *
 * The accept-side details (existing-user invitations collapse to the
 * single review step + the receive endpoint auto-logs the invitee in)
 * are documented in user-invitation.spec.js row 3.
 */
test.describe('Editorial masthead', () => {
	test(
		'masthead page renders for anonymous readers',
		{tag: '@smoke'},
		async ({page}) => {
			const res = await page.goto(
				'/index.php/publicknowledge/en/about/editorialMasthead',
			);
			expect(res?.status()).toBe(200);
			expect(page.url()).toContain('/about/editorialMasthead');
			const h1 = page.locator('h1').first();
			await expect(h1).toBeVisible();
			await expect(h1).not.toHaveText('');
		},
	);

	test(
		'masthead reflects role flags and per-user opt-ins',
		{tag: '@regression'},
		async ({pkpApi, pkpMail, browser, baseURL, asUser}) => {
			const tag = uniqueTag('em2');
			const suffix = tag.split('-').pop();
			// Opt-in target: enrolled as Author (a masthead-flag-OFF
			// group — doubles as the "flag off renders no section"
			// fixture) and invited to Section editor (flag ON) with the
			// manager's "Appear on the masthead" choice.
			const optIn = {
				username: `emi${suffix}`,
				password: `emi${suffix}emi${suffix}`,
				givenName: 'Mona',
				familyName: `Opted${suffix}`,
				email: `emi${suffix}@mailinator.com`,
			};
			// Same-role control: seeded straight into Section editor by
			// the scenario endpoint, i.e. masthead = null — must NOT
			// appear even though the section itself renders.
			const noOptIn = {
				username: `emn${suffix}`,
				password: `emn${suffix}emn${suffix}`,
				givenName: 'Nora',
				familyName: `Hidden${suffix}`,
				email: `emn${suffix}@mailinator.com`,
			};
			const {context} = await pkpApi.createJournal({
				tag,
				users: [
					{username: 'dbarnes', roles: ['manager']},
					{...optIn, roles: ['author']},
					{...noOptIn, roles: ['sectionEditor']},
				],
			});

			// ----- Manager setup: invitation with the masthead opt-in -----
			const managerCtx = await asUser('dbarnes');
			const managerPage = await managerCtx.newPage();
			await managerPage.goto(
				`/index.php/${context.path}/management/settings/access`,
			);
			await expect(
				managerPage.getByRole('heading', {name: 'Users & Roles'}),
			).toBeVisible();

			const target = await findUserByEmail(
				managerPage,
				context.path,
				optIn.email,
			);
			expect(target, 'opt-in target enrolled').toBeTruthy();
			const sectionEditorGroupId = await getUserGroupIdByName(
				managerPage,
				context.path,
				'Section editor',
			);
			await createRoleInvitation(managerPage, context.path, {
				userId: target.id,
				userGroupsToAdd: [
					{
						userGroupId: sectionEditorGroupId,
						dateStart: new Date().toISOString().split('T')[0],
						masthead: true,
					},
				],
			});

			// ----- Invitee accept round-trip (the gated write) -----
			// Scoped mail read (principle 8): recipient + tag (in the body
			// via {$contextName}). NEVER latestTo/inboxFor — Mailpit's
			// /api/v1/messages endpoint ignores its query param (verified
			// v1.29.7), so they return the globally newest message and a
			// parallel sibling's accept link under load.
			const [latest] = await pkpMail.find({
				to: optIn.email,
				contains: tag,
				timeoutMs: 15_000,
			});
			const full = await pkpMail.fullMessage(latest.ID);
			const acceptUrl = extractAcceptUrl(full.HTML || '');

			const inviteeCtx = await browser.newContext({
				baseURL,
				storageState: {cookies: [], origins: []},
			});
			try {
				const inviteePage = await inviteeCtx.newPage();
				await inviteePage.goto(acceptUrl);
				// Existing-user invitation → single review step (the
				// receive endpoint auto-logs the invitee in).
				await expect(
					inviteePage.getByRole('heading', {
						name: /Review & create account/i,
					}),
				).toBeVisible({timeout: 20_000});
				// The review's Roles table reflects the manager's
				// masthead opt-in for the invited role.
				const rolesTable = inviteePage.getByRole('table', {name: 'Roles'});
				await expect(rolesTable).toContainText('Section editor');
				await expect(rolesTable).toContainText('Appear on the masthead');
				await inviteePage
					.getByRole('button', {name: /^Accept And Continue/i})
					.click();
				const successDialog = inviteePage.getByRole('dialog');
				await expect(successDialog).toBeVisible({timeout: 20_000});
				await expect(successDialog).toContainText(/new role/i);
			} finally {
				await inviteeCtx.close();
			}

			// ----- Anonymous reader: one render, three invariants -----
			const anonCtx = await browser.newContext({
				baseURL,
				storageState: {cookies: [], origins: []},
			});
			try {
				const anonPage = await anonCtx.newPage();
				const res = await anonPage.goto(
					`/index.php/${context.path}/en/about/editorialMasthead`,
				);
				expect(res?.status()).toBe(200);

				// 1. The opted-in user appears under their role section
				//    (h2 = the group's localized name) with the start
				//    year from the accepted assignment.
				await expect(
					anonPage.getByRole('heading', {name: 'Section editor', exact: true}),
				).toBeVisible();
				const optInItem = anonPage.locator('.user_listing li', {
					hasText: `${optIn.givenName} ${optIn.familyName}`,
				});
				await expect(optInItem).toBeVisible();
				await expect(optInItem.locator('.date_start')).toContainText(
					String(new Date().getFullYear()),
				);

				// 2. A same-role user without the opt-in is absent (the
				//    scenario-seeded assignment carries masthead = null).
				await expect(
					anonPage.getByText(`${noOptIn.givenName} ${noOptIn.familyName}`),
				).toHaveCount(0);

				// 3. A masthead-flag-off role renders no section at all,
				//    even with an assigned user (the opt-in target holds
				//    Author). Cover both singular and plural spellings so
				//    a template/name drift can't silently pass.
				await expect(
					anonPage.getByRole('heading', {name: 'Author', exact: true}),
				).toHaveCount(0);
				await expect(
					anonPage.getByRole('heading', {name: 'Authors', exact: true}),
				).toHaveCount(0);
			} finally {
				await anonCtx.close();
			}
		},
	);
});

function uniqueTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

/**
 * Spec-local copies of the invitation REST setup helpers (the
 * authoritative commentary lives in user-invitation.spec.js — spec
 * files cannot share code without re-registering each other's tests,
 * and POM ownership rules keep these out of the shared pages/).
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
	// Default mailable template → emailComposer, as the UI composer
	// step does. Without it the invitation email goes out with an
	// EMPTY body (no accept link): UserRoleAssignmentInvite::
	// getMailable() only assigns $emailBody inside
	// `if (isset($emailComposerValues))` — see the APP BUG note in
	// user-invitation.spec.js#createRoleInvitation.
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
