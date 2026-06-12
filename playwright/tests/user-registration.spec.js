// @ts-check
const {test, expect} = require('../support/base-test.js');
const {getPassword} = require('../data/users.js');
const {LoginPage} = require('../pages/LoginPage.js');

/**
 * Public user registration — row #58 in docs/e2e-playwright-migration.md.
 *
 * Ports the Cypress `cy.register()` helper (lib/pkp/cypress/support/
 * commands.js:181) plus the post-registration "Make a New Submission"
 * handoff used by the canonical AmwandengaSubmission.cy.js's
 * `Registers as author and creates a submission` test (and ~20 other
 * `60-content/*Submission.cy.js` specs that bundle the same pattern).
 *
 * Spec runs anonymously (no storageState). The bootstrapped
 * publicknowledge journal is the registration context — the test only
 * INSERTs into the users table, so it doesn't disturb any other spec
 * that reads the user list (parallel-safe via a unique-tag username).
 *
 * Form note — `/user/register` is rendered by
 * `lib/pkp/templates/frontend/pages/userRegister.tpl` +
 * `frontend/components/registrationForm.tpl`. Despite the surrounding
 * Cypress helper using `id=` selectors, the template ships stable
 * `name=` attributes on every input which we anchor on instead.
 * Country is a plain `<select name="country">` whose options are keyed
 * by ISO-3166 alpha-2 code (see RegistrationForm::display:
 * `$countries[$country->getAlpha2()] = $country->getLocalName()`), so
 * we select by value rather than visible label.
 *
 * Post-submit flow — RegistrationHandler::register logs the user in
 * (no `email.require_validation` in the test config) and redirects
 * back to `/user/register`; that GET sees `Validation::isLoggedIn()`
 * and serves `frontend/pages/userRegisterComplete.tpl` with the
 * "Make a New Submission" link to `/{context}/submission`.
 */
test.describe('Public user registration', () => {
	test(
		'anonymous visitor registers via /user/register, lands on the dashboard, and can start a new submission',
		async ({browser, baseURL}) => {
			const ctx = await browser.newContext({
				baseURL,
			});
			try {
				const page = await ctx.newPage();

				// Unique-tag username keeps parallel workers + reruns
				// from colliding on the users table's UNIQUE(username)
				// constraint. 32-char max per the form's input cap.
				const suffix = Math.random().toString(36).slice(2, 8);
				const username = `reg-w${test.info().parallelIndex}-${suffix}`;
				const password = getPassword(username);
				const email = `${username}@mailinator.com`;

				await page.goto('/index.php/publicknowledge/user/register');
				await expect(
					page.getByRole('heading', {name: 'Register'}),
				).toBeVisible();

				// Identity fieldset.
				await page.locator('input[name="givenName"]').fill('Reg');
				await page.locator('input[name="familyName"]').fill('Tester');
				await page
					.locator('input[name="affiliation"]')
					.fill('Public Knowledge Project');
				// Country picker: native <select> keyed by alpha-2.
				await page.locator('select[name="country"]').selectOption('CA');

				// Login fieldset.
				await page.locator('input[name="email"]').fill(email);
				await page.locator('input[name="username"]').fill(username);
				await page.locator('input[name="password"]').fill(password);
				await page.locator('input[name="password2"]').fill(password);

				// Privacy consent — required when the journal carries a
				// privacyStatement (the bootstrapped publicknowledge does;
				// see config/registry/contextSettings.xml). The Cypress
				// helper unconditionally clicks this.
				await page.locator('input[name="privacyConsent"]').check();

				// Submit. The handler logs the user in and redirects to
				// /user/register, which then serves the success page.
				// Wait for the URL to settle on /user/register and the
				// "Make a New Submission" link to render before
				// proceeding (the redirect chain involves a fresh GET).
				await Promise.all([
					page.waitForURL(/\/user\/register(\/|\?|$)/),
					page.locator('form#register button[type="submit"]').click(),
				]);

				// The post-registration landing page.
				await expect(
					page.getByRole('heading', {
						name: 'Registration complete',
					}),
				).toBeVisible();

				// Click "Make a New Submission" — the post-registration CTA
				// rendered by templates/frontend/pages/userRegisterComplete.tpl
				// (`<li class="new_submission"><a>...</a></li>`).
				await page
					.getByRole('link', {name: 'Make a New Submission'})
					.click();

				// Wizard's Start step. `getByRole('heading', {name: 'Make
				// a Submission'})` is the same anchor used by
				// wizard-section-rules.spec.js. Wait for the StartSubmission
				// Vue form to mount via its TinyMCE iframe (the Title
				// control). 15s mirrors the precedent in row #12.
				await expect(
					page.getByRole('heading', {name: 'Make a Submission'}),
				).toBeVisible();
				await expect(
					page.locator('#startSubmission-title-control_ifr'),
				).toBeAttached({timeout: 15_000});

				// Section dropdown — bootstrap journal seeds two sections
				// (Articles + Reviews), so StartSubmission renders a
				// FieldOptions radio. Anchor on the Section legend +
				// Articles option label, same pattern as
				// wizard-section-rules.spec.js.
				const sectionField = page.locator('.pkpFormField--options', {
					has: page.locator('legend', {hasText: 'Section'}),
				});
				await expect(sectionField).toBeVisible();
				await expect(
					sectionField.locator('label', {hasText: 'Articles'}),
				).toBeVisible();
			} finally {
				await ctx.close();
			}
		},
	);

	test(
		'registration with reviewer opt-in records the reviewer role and interests',
		{tag: '@regression'},
		async ({page}) => {
			// Row 2 — docs/e2e/plans/registration-login.md. The default
			// Reviewer group ships permitSelfRegistration="true"
			// (registry/userGroups.xml), so the publicknowledge register
			// form renders the opt-in checkbox + interests field
			// (templates/frontend/pages/userRegister.tpl, #reviewerOptinGroup).
			// No test.use({user}) in this file → `page` is anonymous.
			const suffix = Math.random().toString(36).slice(2, 8);
			const username = `reg2-w${test.info().parallelIndex}-${suffix}`;
			const password = getPassword(username);
			// Interests land in a SITE-level controlled vocab shared by
			// every worker — unique, whitespace-free values keep this
			// INSERT-only and collision-free. Comma is the separator
			// Repo::userInterest()->setInterestsForUser explodes on.
			const interests = [`Iva${suffix}`, `Ivb${suffix}`];

			await page.goto('/index.php/publicknowledge/user/register');
			await expect(
				page.getByRole('heading', {name: 'Register'}),
			).toBeVisible();

			await page.locator('input[name="givenName"]').fill('Reg');
			await page.locator('input[name="familyName"]').fill('Reviewer');
			await page
				.locator('input[name="affiliation"]')
				.fill('Public Knowledge Project');
			await page.locator('select[name="country"]').selectOption('CA');
			await page
				.locator('input[name="email"]')
				.fill(`${username}@mailinator.com`);
			await page.locator('input[name="username"]').fill(username);
			await page.locator('input[name="password"]').fill(password);
			await page.locator('input[name="password2"]').fill(password);

			// Reviewer opt-in: publicknowledge has exactly one
			// self-registerable reviewer group, so the single-group locale
			// key renders ("Yes, I would like to be contacted with
			// requests to review submissions to this journal.").
			const optIn = page.locator(
				'#reviewerOptinGroup input[type="checkbox"]',
			);
			await optIn.check();
			await page
				.locator('input[name="interests"]')
				.fill(interests.join(','));

			await page.locator('input[name="privacyConsent"]').check();

			await Promise.all([
				page.waitForURL(/\/user\/register(\/|\?|$)/),
				page.locator('form#register button[type="submit"]').click(),
			]);
			await expect(
				page.getByRole('heading', {name: 'Registration complete'}),
			).toBeVisible();

			// The profile's Roles tab is the canonical readback surface:
			// it re-renders the self-registration groups with the user's
			// memberships checked, plus the interests vocabulary. Legacy
			// jQuery tabs (templates/user/profile.tpl #profileTabs) load
			// the panel via AJAX on click.
			await page.goto('/index.php/publicknowledge/user/profile');
			await page.locator('#profileTabs a[name="roles"]').click();

			const rolesForm = page.locator('#rolesForm');
			// Scope to the CURRENT journal's self-registration section.
			// On a long-lived test DB the Roles tab also lists every
			// scratch journal under "Register with other journals"
			// (#userGroupExtraFormFields), each with its own "Reviewer"
			// checkbox — an unscoped lookup is a strict-mode violation.
			// userGroups.tpl renders the current-context section as the
			// FIRST .section inside the #userGroups form area; there is no
			// text label to anchor on (formSection.tpl's translate=false
			// branch reads the misspelled $FBV_Label and renders nothing).
			const selfRegSection = rolesForm
				.locator('#userGroups > .section')
				.first();
			await expect(
				selfRegSection.getByRole('checkbox', {
					name: 'Reviewer',
					exact: true,
				}),
			).toBeChecked();
			// Interests render as a tag-it list (form/interestsInput.tpl).
			// Assert on text content — robust both before and after the
			// tagit JS transforms the seeded <li> items into pills.
			const interestsList = rolesForm.locator('ul.interests');
			for (const interest of interests) {
				await expect(interestsList).toContainText(interest);
			}
		},
	);

	test(
		'registration validation rejects duplicates and incomplete input',
		{tag: '@regression'},
		async ({page}) => {
			// Row 3 — docs/e2e/plans/registration-login.md. Duplicate
			// checks are READ-ONLY against the seeded baseline user
			// `atester` (username + email), so this never mutates shared
			// state. RegistrationForm wires the failures asserted here:
			//   username  → user.register.form.usernameExists
			//   email     → user.register.form.emailExists
			//   password  → user.register.form.passwordsDoNotMatch
			//   consent   → user.profile.form.privacyConsentRequired
			const suffix = Math.random().toString(36).slice(2, 8);
			const unique = `reg3-w${test.info().parallelIndex}-${suffix}`;
			const goodPassword = `pw-${suffix}-ok`;

			await page.goto('/index.php/publicknowledge/user/register');
			await expect(
				page.getByRole('heading', {name: 'Register'}),
			).toBeVisible();

			// 1) Missing required fields: the form's native `required`
			// attributes block the submit client-side — no POST happens,
			// no server-rendered errors, the page stays put.
			await page.locator('form#register button[type="submit"]').click();
			await expect(page).toHaveURL(/\/user\/register/);
			await expect(page.locator('input#givenName')).toHaveJSProperty(
				'validity.valueMissing',
				true,
			);
			await expect(page.locator('input#username')).toHaveJSProperty(
				'validity.valueMissing',
				true,
			);
			await expect(page.locator('#formErrors')).toHaveCount(0);

			// 2) Duplicate username + duplicate email + password mismatch
			// + missing privacy consent — all pass native validation, all
			// fail server-side in one POST. The re-rendered form lists
			// each field error and retains the entered values.
			await page.locator('input[name="givenName"]').fill('Dup');
			await page.locator('input[name="familyName"]').fill('Tester');
			await page.locator('input[name="affiliation"]').fill('PKP');
			await page.locator('select[name="country"]').selectOption('CA');
			await page
				.locator('input[name="email"]')
				.fill('atester@mailinator.com');
			await page.locator('input[name="username"]').fill('atester');
			await page.locator('input[name="password"]').fill(`${goodPassword}a`);
			await page.locator('input[name="password2"]').fill(`${goodPassword}b`);
			// privacyConsent deliberately left unchecked.
			await page.locator('form#register button[type="submit"]').click();

			const formErrors = page.locator('#formErrors');
			await expect(formErrors).toBeVisible();
			await expect(formErrors).toContainText(
				'The selected username is already in use by another user.',
			);
			await expect(formErrors).toContainText(
				'The selected email address is already in use by another user.',
			);
			await expect(formErrors).toContainText('The passwords do not match.');
			await expect(formErrors).toContainText(
				'You must agree to the terms of the privacy statement.',
			);
			// Entered values are retained (passwords are not — the
			// template never echoes them back).
			await expect(page.locator('input#username')).toHaveValue('atester');
			await expect(page.locator('input#email')).toHaveValue(
				'atester@mailinator.com',
			);
			await expect(page.locator('input#givenName')).toHaveValue('Dup');
			await expect(page.locator('select#country')).toHaveValue('CA');

			// 3) Fix everything EXCEPT consent: unique credentials,
			// matching passwords. The only remaining error is the privacy
			// consent — and the account must still not be created.
			await page.locator('input[name="username"]').fill(unique);
			await page
				.locator('input[name="email"]')
				.fill(`${unique}@mailinator.com`);
			await page.locator('input[name="password"]').fill(goodPassword);
			await page.locator('input[name="password2"]').fill(goodPassword);
			await page.locator('form#register button[type="submit"]').click();

			await expect(formErrors).toBeVisible();
			await expect(formErrors.locator('li')).toHaveCount(1);
			await expect(formErrors).toContainText(
				'You must agree to the terms of the privacy statement.',
			);

			// 4) Black-box proof no account was created: the rejected
			// credentials cannot log in.
			const login = new LoginPage(page);
			await login.login(unique, goodPassword, 'publicknowledge');
			await expect(login.error).toContainText(
				'Invalid username/email or password',
			);
		},
	);
});
