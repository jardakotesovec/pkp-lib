// @ts-check
const path = require('path');
const {test, expect} = require('../support/base-test.js');
const {UserProfilePage} = require('../pages/UserProfilePage.js');

/**
 * User profile — docs/e2e/plans/user-profile.md rows 1–6.
 *
 * Profile edits are USER mutations, and the 16 shared seeded users'
 * cached auth state (playwright/.auth/<user>.json) must survive across
 * parallel workers — so every test here creates its own scratch journal
 * AND its own throwaway user in one journal-scenario POST
 * (`users: [{username, password, roles}]`; the password makes
 * UserAssignmentProcessor CREATE the user instead of looking it up).
 * The throwaway logs in via the real login form, never via `asUser`
 * (which would write .auth cache files for single-use accounts) —
 * same convention as password-flows.spec.js's spec-local `login`.
 *
 * The profile page (/index.php/<ctx>/user/profile) is legacy-stack:
 * profile.tpl renders a jQuery-UI tabset (`#profileTabs`,
 * $.pkp.controllers.TabHandler) whose panels AJAX-load FBV forms from
 * tab.user.ProfileTabHandler. TabHandler pre-selects the tab named in
 * the URL hash at init (TabHandler.js:47-61), so navigation goes
 * through `#<anchor>` URLs. All driving/saving mechanics live in the
 * new UserProfilePage POM (lib/pkp/playwright/pages/UserProfilePage.js).
 *
 * Form-field selector ground truth (verified against the live tpls):
 *   - multilingual text inputs keep stable `name="field[en]"`
 *     (templates/form/textInput.tpl); ids are uniqid-suffixed → never
 *     select by id (patterns.md pitfall 8).
 *   - rich textareas (signature, mailingAddress, biography) are
 *     TinyMCE; values are written via setTinyMceContent and read back
 *     via getTinyMceContent (POM setRichField/getRichField).
 *   - self-registration checkboxes are `name="reviewerGroup[<id>]"`
 *     etc. (templates/user/userGroupSelfRegistration.tpl). The Roles
 *     tab ALSO renders hidden checkboxes for every OTHER
 *     registration-enabled journal on the site (publicknowledge plus
 *     every parallel worker's scratch journals) inside the collapsed
 *     `#userGroupExtraFormFields` extras — scope to `:visible` to hit
 *     only the current scratch journal's group.
 *
 * Row-specific notes:
 *   - Row 1 ("preferred name shows in the user nav"): the current
 *     backend top nav (<top-nav-actions>, lib/ui-library
 *     TopNavActions.vue) renders an InitialsAvatar + screen-reader
 *     username only — the full name is carried in
 *     `pkp.currentUser.fullName` (PKPTemplateManager.php:1667, which is
 *     User::getFullName() = preferred public name when set) and the
 *     avatar initials derive from given/family name
 *     (Identity::getDisplayInitials). The test asserts both of those
 *     nav-feeding surfaces; there is no visible full-name string in
 *     today's nav to assert on.
 *   - Row 2 ("changed email is accepted"): the plan note about
 *     `email.require_validation` is stale — ContactForm now routes ANY
 *     email change through a ChangeProfileEmailInvite
 *     (BaseProfileForm.php:66-86): the form flips to a pending state,
 *     a confirmation mail (template
 *     emails.changeProfileEmailInvitationNotify, accept link text
 *     "confirm") goes to the user's CURRENT address
 *     (Invitation::getMailableReceiver uses userId → current email),
 *     and GETting the accept URL finalizes the change and redirects to
 *     /user/profile#contact. The test walks that whole arc.
 *   - Row 6: APIProfileForm has ONE toggling action (API_KEY_NEW ↔
 *     API_KEY_DELETE) — there is no dedicated "regenerate" button, so
 *     regeneration = Delete + Create again, asserting the new JWT
 *     differs. The key is sha1(time()) so a same-second re-create
 *     would collide; the flow interleaves a reload between the two
 *     creates so >1s of wall clock always elapses. The Delete button
 *     guards with a NATIVE confirm() (apiProfileForm.tpl) — a 'dialog'
 *     handler accepts it (Playwright's default would dismiss → no-op).
 *
 * Parallel-safety: every mutation in this file lands on the per-test
 * throwaway user or its scratch journal; reviewing interests insert
 * unique-tagged rows into the site-wide controlled vocabulary
 * (additive, never read by other tests). Mailpit reads are scoped
 * recipient + unique marker (principle 8).
 */

test.describe('User profile', () => {
	test(
		'identity tab edits persist and feed the user nav',
		{tag: '@regression'},
		async ({page, pkpApi}) => {
			const {user, profile} = await seedAndLogin(page, pkpApi, 'idnt');

			await profile.goto('identity');
			const form = profile.form('identity');

			// The username renders as static text (not an input) at the
			// top of the form — sanity-check we're editing the right user.
			await expect(form).toContainText(user.username);

			const preferredName = `Dr. Zadie ${user.username}`;
			await form.locator('input[name="givenName[en]"]').fill('Zadie');
			await form.locator('input[name="familyName[en]"]').fill('Profiletest');
			await form
				.locator('input[name="preferredPublicName[en]"]')
				.fill(preferredName);
			await profile.save('identity');

			// Survives reload.
			await profile.reload('identity');
			await expect(
				profile.form('identity').locator('input[name="givenName[en]"]'),
			).toHaveValue('Zadie');
			await expect(
				profile.form('identity').locator('input[name="familyName[en]"]'),
			).toHaveValue('Profiletest');
			await expect(
				profile
					.form('identity')
					.locator('input[name="preferredPublicName[en]"]'),
			).toHaveValue(preferredName);

			// User nav: the avatar initials now derive from the new
			// given/family name ("Z" + "P"), and pkp.currentUser.fullName
			// (the nav component's name source) is the preferred public
			// name. See file doc-comment for why there's no visible
			// full-name string to assert on directly.
			const userNav = page.locator('[data-cy="app-user-nav"]');
			await expect(userNav).toBeVisible();
			await expect(userNav).toContainText('ZP');
			const navFullName = await page.evaluate(
				() => window.pkp?.currentUser?.fullName,
			);
			expect(navFullName).toBe(preferredName);
		},
	);

	test(
		'contact tab edits persist; email change confirms via the emailed link',
		{tag: '@regression'},
		async ({page, pkpApi, pkpMail}) => {
			const {tag, user, profile} = await seedAndLogin(page, pkpApi, 'cont');

			await profile.goto('contact');
			const form = profile.form('contact');

			// Plain fields.
			await form.locator('input[name="phone"]').fill('604-555-0199');
			await form
				.locator('input[name="affiliation[en]"]')
				.fill('Public Knowledge Project');
			await form.locator('select[name="country"]').selectOption('CA');

			// Rich (TinyMCE) fields. signature is multilingual
			// (name="signature[en]"), mailingAddress is not.
			const signatureText = `Kind regards, ${tag}`;
			const mailingText = `123 Scenario Street ${tag}`;
			await profile.setRichField(
				'contact',
				'signature[en]',
				`<p>${signatureText}</p>`,
			);
			await profile.setRichField(
				'contact',
				'mailingAddress',
				`<p>${mailingText}</p>`,
			);

			// Email change — kicks off the pending-change invitation flow.
			const newEmail = `changed-${user.username}@mailinator.com`;
			await form.locator('input[name="email"]').fill(newEmail);

			await profile.save('contact');

			// The re-rendered form is in the pending state: old address
			// still active, pending notice names the new one.
			const pendingForm = profile.form('contact');
			await expect(pendingForm).toContainText(
				'You have requested a change of your email to',
			);
			await expect(pendingForm).toContainText(newEmail);
			await expect(pendingForm.locator('input[name="email"]')).toHaveValue(
				user.email,
			);

			// Confirmation email goes to the CURRENT address and contains
			// the new one (recipient + unique marker scoping; the new
			// address embeds the unique username).
			const [message] = await pkpMail.find({
				to: user.email,
				contains: newEmail,
				timeoutMs: 20_000,
			});
			const full = await pkpMail.fullMessage(message.ID);
			const acceptUrl = pkpMail.extractLink(full.HTML || '', 'confirm');

			// Accepting finalizes the change and redirects to
			// /user/profile#contact (ChangeProfileEmailInviteRedirect-
			// Controller::acceptHandle). This lands us on a FRESH page
			// load of the contact tab — which doubles as the
			// survives-reload check for every other field.
			await page.goto(acceptUrl);
			await expect(profile.heading).toBeVisible({timeout: 20_000});
			await expect(profile.form('contact')).toBeVisible({timeout: 15_000});

			const reloaded = profile.form('contact');
			await expect(reloaded.locator('input[name="email"]')).toHaveValue(
				newEmail,
			);
			await expect(reloaded.locator('input[name="phone"]')).toHaveValue(
				'604-555-0199',
			);
			await expect(
				reloaded.locator('input[name="affiliation[en]"]'),
			).toHaveValue('Public Knowledge Project');
			await expect(reloaded.locator('select[name="country"]')).toHaveValue(
				'CA',
			);
			expect(await profile.getRichField('contact', 'signature[en]')).toContain(
				signatureText,
			);
			expect(await profile.getRichField('contact', 'mailingAddress')).toContain(
				mailingText,
			);
		},
	);

	test(
		'roles tab: self-register as Reviewer and record reviewing interests',
		{tag: '@regression'},
		async ({page, pkpApi}) => {
			const {tag, profile} = await seedAndLogin(page, pkpApi, 'role');

			await profile.goto('roles');
			const form = profile.form('roles');

			// The scratch journal's own self-registration checkboxes are
			// the visible ones; every other journal's render inside the
			// collapsed "other contexts" extras (see file doc-comment).
			const authorBox = form
				.locator('input[name^="authorGroup"]:visible')
				.first();
			const reviewerBox = form
				.locator('input[name^="reviewerGroup"]:visible')
				.first();

			// Seeded author role arrives pre-checked; Reviewer not yet.
			await expect(authorBox).toBeChecked();
			await expect(reviewerBox).not.toBeChecked();
			await reviewerBox.check();

			// Reviewing interests — tag-it widget over the controlled
			// vocabulary (templates/form/interestsInput.tpl). Type + Enter
			// creates a tag (hidden input name="interests[]"); Escape
			// closes any autocomplete popup so it can't shadow Save.
			const interests = [`quantum metrology ${tag}`, `dark archiving ${tag}`];
			const interestInput = form.locator('#interests ul.tagit input[type="text"]');
			await expect(interestInput).toBeVisible({timeout: 15_000});
			for (const interest of interests) {
				await interestInput.click();
				await interestInput.pressSequentially(interest);
				await interestInput.press('Enter');
				await expect(
					form.locator('#interests li.tagit-choice', {hasText: interest}),
				).toBeVisible();
			}
			await interestInput.press('Escape');

			await profile.save('roles');

			// Survives reload: Reviewer role stays self-registered and
			// both vocabulary entries round-trip.
			await profile.reload('roles');
			const reloadedForm = profile.form('roles');
			await expect(
				reloadedForm.locator('input[name^="reviewerGroup"]:visible').first(),
			).toBeChecked();
			await expect(
				reloadedForm.locator('input[name^="authorGroup"]:visible').first(),
			).toBeChecked();
			for (const interest of interests) {
				await expect(
					reloadedForm.locator('#interests li.tagit-choice', {
						hasText: interest,
					}),
				).toBeVisible();
			}
		},
	);

	test(
		'public profile: bio and homepage URL round-trip; profile image renders after upload',
		{tag: '@regression'},
		async ({page, pkpApi}) => {
			const {tag, profile} = await seedAndLogin(page, pkpApi, 'publ');

			await profile.goto('publicProfile');
			const form = profile.form('publicProfile');

			const bioText = `Bio paragraph ${tag}`;
			const homepage = `https://example.com/${tag}`;
			await profile.setRichField(
				'publicProfile',
				'biography[en]',
				`<p>${bioText}</p>`,
			);
			await form.locator('input[name="userUrl"]').fill(homepage);

			// Save the text fields BEFORE uploading: the plupload widget
			// auto-starts on file selection (UploaderHandler FilesAdded →
			// start) and uploadProfileImage responds with a JSON redirect
			// (ProfileTabHandler.php:217) that reloads the whole page,
			// discarding unsaved form state.
			await profile.save('publicProfile');

			// Image upload. The native file input is plupload's hidden
			// html5-runtime input (patterns.md pitfall 12 —
			// setInputFiles directly; clicking the styled button opens a
			// real OS dialog). After the upload round-trips, the handler
			// follows the redirectRequested event to
			// /user/profile?uniq=...#publicProfile.
			await form
				.locator('input[type="file"]')
				.setInputFiles(
					path.join(__dirname, '..', 'fixtures', 'files', 'dependent-image.png'),
				);
			await page.waitForURL(/[?&]uniq=/, {
				timeout: 30_000,
				waitUntil: 'commit',
			});
			await expect(profile.form('publicProfile')).toBeVisible({
				timeout: 15_000,
			});

			// The form now renders the uploaded image
			// (publicProfileForm.tpl: <img src=".../profileImage-<id>.png?...">).
			const img = profile
				.form('publicProfile')
				.locator('img[src*="profileImage-"]');
			await expect(img).toBeVisible({timeout: 15_000});

			// Survives reload: bio + URL persisted, image still renders —
			// and actually loads (naturalWidth > 0 proves the public site
			// file serves, not just that an <img> tag exists).
			await profile.reload('publicProfile');
			const reloaded = profile.form('publicProfile');
			expect(
				await profile.getRichField('publicProfile', 'biography[en]'),
			).toContain(bioText);
			await expect(reloaded.locator('input[name="userUrl"]')).toHaveValue(
				homepage,
			);
			const reloadedImg = reloaded.locator('img[src*="profileImage-"]');
			await expect(reloadedImg).toBeVisible({timeout: 15_000});
			await expect
				.poll(
					() =>
						reloadedImg.evaluate(
							(el) => /** @type {HTMLImageElement} */ (el).naturalWidth,
						),
					{timeout: 10_000},
				)
				.toBeGreaterThan(0);
		},
	);

	test(
		'notification preferences persist',
		{tag: '@regression'},
		async ({page, pkpApi}) => {
			const {profile} = await seedAndLogin(page, pkpApi, 'noti');

			await profile.goto('notificationSettings');
			const form = profile.form('notificationSettings');

			// Checkbox names come from NotificationManager's settings map
			// (classes/notification/NotificationManager.php +
			// PKPNotificationManager::getNotificationSettingsMap); ids are
			// NOT uniqid-suffixed for checkboxes but name selectors stay
			// the convention. Default state: every "allow" box checked,
			// every "email" box unchecked.
			const allowAnnouncements = form.locator(
				'input[name="notificationNewAnnouncement"]',
			);
			const emailSubmissionSubmitted = form.locator(
				'input[name="emailNotificationSubmissionSubmitted"]',
			);
			const allowSubmissionSubmitted = form.locator(
				'input[name="notificationSubmissionSubmitted"]',
			);

			await expect(allowAnnouncements).toBeChecked();
			await expect(emailSubmissionSubmitted).not.toBeChecked();

			// Opt out of announcement notifications entirely; opt INTO
			// email for submission-submitted. Different settings pairs on
			// purpose: the form's enableDisablePairs JS disables a row's
			// email box when its allow box is unchecked, so toggling both
			// halves of one pair would self-conflict.
			await allowAnnouncements.uncheck();
			await emailSubmissionSubmitted.check();

			await profile.save('notificationSettings');

			// Survives reload (suppression behavior is the notifications
			// plan's job; this row is persistence only).
			await profile.reload('notificationSettings');
			const reloaded = profile.form('notificationSettings');
			await expect(
				reloaded.locator('input[name="notificationNewAnnouncement"]'),
			).not.toBeChecked();
			await expect(
				reloaded.locator('input[name="emailNotificationSubmissionSubmitted"]'),
			).toBeChecked();
			// Untouched control keeps its default.
			await expect(
				reloaded.locator('input[name="notificationSubmissionSubmitted"]'),
			).toBeChecked();
		},
	);

	test(
		'API key lifecycle: generate, regenerate to a different value, delete back to None',
		{tag: '@regression'},
		async ({page, pkpApi}) => {
			const {profile} = await seedAndLogin(page, pkpApi, 'apik');

			// The Delete action's native confirm() needs accepting —
			// Playwright's default dialog behavior is dismiss, which would
			// silently cancel the submit.
			page.on('dialog', (dialog) => dialog.accept());

			await profile.goto('apiSettings');
			const keyField = profile.apiKeyField();

			// Fresh user: no key, display reads the localized "None".
			await expect(keyField).toHaveValue('None');

			// Generate. The displayed value is a JWT over the stored
			// sha1 key (APIProfileForm::fetch).
			await profile.submitApiKeyAction('Create API Key');
			const firstKey = await profile.apiKeyField().inputValue();
			expect(firstKey).not.toBe('None');
			expect(firstKey).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);

			// Persists across reload before we regenerate — the reload
			// also guarantees >1s wall clock between the two generates
			// (the stored key is sha1(time()); see file doc-comment).
			await profile.reload('apiSettings');
			await expect(profile.apiKeyField()).toHaveValue(firstKey);

			// "Regenerate" = Delete + Create (single toggling action —
			// no dedicated regenerate button on this form).
			await profile.submitApiKeyAction('Delete');
			await expect(profile.apiKeyField()).toHaveValue('None');
			await profile.submitApiKeyAction('Create API Key');
			const secondKey = await profile.apiKeyField().inputValue();
			expect(secondKey).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
			expect(secondKey).not.toBe(firstKey);

			// Delete clears it back to "None", and stays cleared after a
			// reload.
			await profile.submitApiKeyAction('Delete');
			await expect(profile.apiKeyField()).toHaveValue('None');
			await profile.reload('apiSettings');
			await expect(profile.apiKeyField()).toHaveValue('None');
		},
	);
});

/**
 * One journal-scenario POST: scratch journal + throwaway user (created
 * because the spec carries `password`), then a real login-form login in
 * that journal's context. Returns the ready-to-use UserProfilePage.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} pkpApi
 * @param {string} suffix
 */
async function seedAndLogin(page, pkpApi, suffix) {
	const tag = uniqueTag(suffix);
	const username = `u${tag.replace(/[^a-z0-9]/gi, '')}`;
	const user = {
		username,
		// Short literal password: the login form's input caps at
		// maxlength=32 (precedent: user-invitation.spec.js).
		password: `pw-${tag}`,
		email: `${username}@mailinator.com`,
		givenName: 'Throwaway',
		familyName: `Profile-${suffix}`,
	};
	const {context} = await pkpApi.createJournal({
		tag,
		name: {en: `User profile ${tag}`},
		users: [{...user, roles: ['author']}],
	});

	// Journal-scoped login form (same selectors LoginPage wraps; driven
	// inline since the redirect wait differs from the POM's contract —
	// precedent: password-flows.spec.js).
	await page.goto(`/index.php/${context.path}/login`);
	await page.locator('input#username').fill(user.username);
	await page.locator('input#password').fill(user.password);
	await page.locator('form#login button').click();
	await page.waitForURL((url) => !url.pathname.includes('/login'), {
		timeout: 20_000,
		waitUntil: 'commit',
	});

	return {
		tag,
		user,
		context,
		profile: new UserProfilePage(page, context.path),
	};
}

/**
 * Worker- and run-scoped unique tag (journals.urlPath is varchar(32) —
 * keep it short; whitespace-free per patterns.md tag conventions).
 *
 * @param {string} suffix
 */
function uniqueTag(suffix) {
	const rand = Math.random().toString(36).slice(2, 8);
	return `up-w${test.info().parallelIndex}-${suffix}-${rand}`;
}
