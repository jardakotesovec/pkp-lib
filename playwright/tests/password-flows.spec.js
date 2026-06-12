// @ts-check
const {test, expect} = require('../support/base-test.js');

/**
 * Password flows — docs/e2e/plans/password-flows.md (5 rows).
 *
 * Absorbs (rework): the password-reset request test formerly in
 * lib/pkp/playwright/tests/mailpit.spec.js — row 1 extends it from
 * "request → mail arrives" to the full reset round-trip. The remaining
 * mailpit.spec.js tests (clearAll harness, Mail::fake leak check) stay
 * there for the test-infrastructure plan.
 *
 * Throwaway-user discipline (charter principles 1 & 7): every row
 * mutates a password, so every row seeds its OWN user(s) via the
 * journal scenario's `users[]` (which creates users when `password` is
 * supplied) on its own scratch journal. The 16 shared seeded users are
 * never touched — their cached storage states in playwright/.auth/
 * would be invalidated by a password change and break sibling tests.
 * For the same reason `asUser` is never used here (it caches auth
 * state keyed by username with the derived password); login forms are
 * driven directly.
 *
 * Mailpit discipline (principle 8): the inbox is shared across
 * parallel workers and sibling runs. Every read is scoped by the
 * throwaway's unique address (`pkpMail.find({to, contains})`); the one
 * negative assertion (row 2) is bounded by a positive control message
 * via `pkpMail.expectNone`. `clearAll()` is never called.
 *
 * Flow facts verified against the live app (LoginHandler.php,
 * ResetPasswordForm.php, LoginChangePasswordForm.php,
 * ChangePasswordForm.php, ProfileTabHandler.php):
 *   - POST login/requestResetPassword always renders the same generic
 *     "confirmation sent" message page, known or unknown email (no
 *     account enumeration).
 *   - The PASSWORD_RESET_CONFIRM mail body carries the reset URL as a
 *     RAW url string ("Reset my password: http://..."), NOT an <a>
 *     anchor — pkpMail.extractLink cannot be used; see extractResetUrl
 *     below. The hash rides in `?confirm=<hmac>%3A<expiryEpoch>`.
 *   - login/resetPassword/<username>?confirm=<bad> renders the
 *     frontend error page ("expired or is not valid") with a back link
 *     to lostPassword; an UNKNOWN username 302s straight to
 *     lostPassword.
 *   - A mustChangePassword login is logged out server-side and 302'd
 *     to login/changePassword/<username>; savePassword re-logs-in and
 *     302s home (the role dashboard).
 *   - The profile Password tab is a legacy AjaxFormHandler form;
 *     validation failures re-render the form (fields cleared) and
 *     surface the error through the in-place notification
 *     (#changePasswordFormNotification, class notifyFormError).
 *   - FormValidatorPassword reports only the FIRST failing rule
 *     (required → confirmed → min), so mismatch+short reports the
 *     mismatch; a matching-but-short pair reports the length rule.
 */

/** Locale strings asserted verbatim (lib/pkp/locale/en/user.po). */
const MSG = {
	confirmationSent:
		'A confirmation has been sent to your email address if a matching account was found.',
	passwordUpdated:
		'Password has been updated successfully. Please login with updated password.',
	invalidHash:
		'Sorry, the link you clicked on has expired or is not valid. Please try resetting your password again.',
	loginError: 'Invalid username/email or password. Please try again.',
	oldPasswordInvalid: 'The current password you entered was incorrect.',
	// site minPasswordLength is the installer default (6) — see
	// PKPInstall::MIN_PASSWORD_LENGTH; the scratch journal inherits the
	// site-level setting.
	lengthRestriction: 'The password must be at least 6 characters.',
	passwordsDoNotMatch: 'The passwords do not match.',
};

function uniqueTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

/**
 * Throwaway user derived from the tag: unique username + unique
 * mailinator address (the processor would default the email the same
 * way; spelled out so mail assertions are obviously recipient-scoped).
 */
function throwawayUser(tag, n = 1) {
	const username = `u${n}${tag.replace(/[^a-z0-9]/gi, '')}`;
	return {
		username,
		email: `${username}@mailinator.com`,
		password: `orig-${tag}-pw`,
	};
}

/**
 * Scratch journal + throwaway users in one seed. `users` entries carry
 * `password` so the UserAssignmentProcessor CREATES them (it only
 * looks up existing users when no password is given).
 */
async function seedJournal(pkpApi, tag, users) {
	const {context} = await pkpApi.createJournal({
		tag,
		name: {en: `Password flows ${tag}`},
		users,
	});
	return context;
}

/**
 * Drive the journal-level login form. Asserting what happened next
 * (dashboard vs error) is the caller's job — both outcomes are under
 * test in this spec.
 */
async function login(page, contextPath, username, password) {
	await page.goto(`/index.php/${contextPath}/login`);
	await page.locator('input#username').fill(username);
	await page.locator('input#password').fill(password);
	await page.locator('form#login button').click();
}

async function expectLoggedInToDashboard(page) {
	await page.waitForURL(/\/dashboard\//, {
		timeout: 20_000,
		waitUntil: 'commit',
	});
}

async function expectLoginRejected(page) {
	await expect(page.locator('.pkp_form_error')).toContainText(
		MSG.loginError,
	);
}

/**
 * Submit the lost-password form and land on the generic confirmation
 * page. Returns the confirmation description text so callers can
 * compare known-vs-unknown responses verbatim (anti-enumeration).
 */
async function requestPasswordReset(page, contextPath, email) {
	await page.goto(`/index.php/${contextPath}/login/lostPassword`);
	const form = page.locator('form#lostPasswordForm');
	await form.locator('input[name="email"]').fill(email);
	await form.locator('button[type="submit"]').click();
	const description = page.locator('.page_message .description');
	await expect(description).toContainText(MSG.confirmationSent);
	return (await description.innerText()).trim();
}

/**
 * Pull the reset URL out of the PASSWORD_RESET_CONFIRM body. The
 * default template interpolates {$passwordResetUrl} as a bare URL (no
 * anchor tag), so pkpMail.extractLink does not apply — match the URL
 * itself and decode any &amp; (none today: single query param; kept
 * for parity with the review-rounds extractLink pattern should the
 * template grow params).
 */
function extractResetUrl(fullMessage) {
	const body = fullMessage.HTML || fullMessage.Text || '';
	const match = body.match(
		/https?:\/\/[^\s<>"]+\/login\/resetPassword\/[^\s<>"]+/,
	);
	if (!match) {
		throw new Error('Reset URL not found in mail body');
	}
	return match[0].replace(/&amp;/g, '&');
}

/** Fetch the newest reset mail for a recipient and return its reset URL. */
async function resetUrlFromMail(pkpMail, user) {
	const messages = await pkpMail.find({
		to: user.email,
		contains: user.username, // unique tag-derived marker in the URL path
		timeoutMs: 20_000,
	});
	const full = await pkpMail.fullMessage(messages[0].ID);
	return extractResetUrl(full);
}

/**
 * Fresh, explicitly-anonymous page for "log in again from scratch"
 * assertions (patterns.md rule 8: pass an explicit empty storageState;
 * manual contexts don't inherit the worker baseURL either).
 */
async function freshAnonymousPage(browser, baseURL) {
	const context = await browser.newContext({
		baseURL,
		storageState: {cookies: [], origins: []},
	});
	return context.newPage();
}

// Row 1
test('lost-password round trip: request, email link, new password, login', {tag: ['@smoke']}, async ({page, pkpApi, pkpMail}) => {
	const tag = uniqueTag('pw1');
	const user = throwawayUser(tag);
	const context = await seedJournal(pkpApi, tag, [
		{username: user.username, email: user.email, password: user.password, roles: ['author']},
	]);

	// Request from the public lost-password form → generic confirmation.
	await requestPasswordReset(page, context.path, user.email);
	await expect(
		page.getByRole('heading', {name: 'Reset Password'}),
	).toBeVisible();

	// Reset mail lands in Mailpit, scoped to the throwaway recipient.
	const messages = await pkpMail.find({
		to: user.email,
		contains: user.username,
		timeoutMs: 20_000,
	});
	expect(messages[0].Subject).toBe('Password Reset Confirmation');
	const full = await pkpMail.fullMessage(messages[0].ID);
	const resetUrl = extractResetUrl(full);

	// The link opens the new-password form (hash validated server-side).
	await page.goto(resetUrl);
	const resetForm = page.locator('form#updateResetPassword');
	await expect(resetForm).toBeVisible();
	const newPassword = `new-${tag}-pw`;
	await resetForm.locator('input[name="password"]').fill(newPassword);
	await resetForm.locator('input[name="password2"]').fill(newPassword);
	await resetForm.locator('button[type="submit"]').click();
	await expect(page.locator('.page_message .description')).toContainText(
		MSG.passwordUpdated,
	);

	// Old password rejected; new password logs in.
	await login(page, context.path, user.username, user.password);
	await expectLoginRejected(page);
	await login(page, context.path, user.username, newPassword);
	await expectLoggedInToDashboard(page);
});

// Row 2
test('lost-password edge cases: unknown email and invalid hash', {tag: ['@regression']}, async ({page, pkpApi, pkpMail}) => {
	const tag = uniqueTag('pw2');
	const control = throwawayUser(tag);
	const unknownEmail = `nobody-${tag.replace(/[^a-z0-9]/gi, '')}@mailinator.com`;
	const context = await seedJournal(pkpApi, tag, [
		{username: control.username, email: control.email, password: control.password, roles: ['author']},
	]);

	// Unknown email → byte-identical generic confirmation (no account
	// enumeration), compared against the known-account response below.
	const unknownResponse = await requestPasswordReset(
		page,
		context.path,
		unknownEmail,
	);

	// Positive control AFTER the unknown request: the control user's
	// mail bounds the negative wait (principle 8).
	const knownResponse = await requestPasswordReset(
		page,
		context.path,
		control.email,
	);
	expect(unknownResponse).toBe(knownResponse);

	await pkpMail.expectNone({
		to: unknownEmail,
		afterControl: {to: control.email, contains: control.username},
		timeoutMs: 20_000,
	});

	// Tampered hash: the control's REAL link with the hmac zeroed out.
	const resetUrl = await resetUrlFromMail(pkpMail, control);
	const tamperedUrl = resetUrl.replace(
		/confirm=[0-9a-f]+/,
		`confirm=${'0'.repeat(64)}`,
	);
	await page.goto(tamperedUrl);
	await expect(page.locator('.page_error .description')).toContainText(
		MSG.invalidHash,
	);
	// The error page routes the user back to the lost-password form.
	await expect(page.locator('.cmp_back_link a')).toHaveAttribute(
		'href',
		/\/login\/lostPassword/,
	);

	// Expired hash: real hmac, expiry timestamp in the past.
	const expiredUrl = resetUrl.replace(
		/%3A\d+$/i,
		`%3A${Math.floor(Date.now() / 1000) - 3600}`,
	);
	await page.goto(expiredUrl);
	await expect(page.locator('.page_error .description')).toContainText(
		MSG.invalidHash,
	);

	// Unknown username in the reset link → straight redirect back to
	// lostPassword (no probe-able difference between bad user and bad
	// hash beyond this, and neither leaks account existence).
	await page.goto(
		`/index.php/${context.path}/login/resetPassword/nosuchuser${tag.replace(/[^a-z0-9]/gi, '')}?confirm=${'0'.repeat(64)}%3A99`,
	);
	await page.waitForURL(/\/login\/lostPassword/, {
		timeout: 20_000,
		waitUntil: 'commit',
	});

	// The control user's password never changed throughout.
	await login(page, context.path, control.username, control.password);
	await expectLoggedInToDashboard(page);
});

// Row 3
test('forced password change on first login', {tag: ['@regression']}, async ({page, pkpApi, browser, baseURL}) => {
	const tag = uniqueTag('pw3');
	const user = throwawayUser(tag);
	const context = await seedJournal(pkpApi, tag, [
		{
			username: user.username,
			email: user.email,
			password: user.password,
			roles: ['author'],
			mustChangePassword: true,
		},
	]);

	// Login redirects to the forced-change form (and logs the session
	// back out server-side until the password actually changes).
	await login(page, context.path, user.username, user.password);
	await page.waitForURL(/\/login\/changePassword\//, {
		timeout: 20_000,
		waitUntil: 'commit',
	});
	const changeForm = page.locator('form#loginChangePassword');
	await expect(changeForm).toBeVisible();

	// Dashboard unreachable until the password is changed.
	await page.goto(`/index.php/${context.path}/dashboard/mySubmissions`);
	await expect(page).toHaveURL(/\/login\b/);
	await expect(page.locator('form#login')).toBeVisible();

	// Complete the forced change; the username field arrives pre-filled.
	await page.goto(
		`/index.php/${context.path}/login/changePassword/${user.username}`,
	);
	await expect(changeForm.locator('input[name="username"]')).toHaveValue(
		user.username,
	);
	const newPassword = `new-${tag}-pw`;
	await changeForm.locator('input[name="oldPassword"]').fill(user.password);
	await changeForm.locator('input[name="password"]').fill(newPassword);
	await changeForm.locator('input[name="password2"]').fill(newPassword);
	await changeForm.locator('button[type="submit"]').click();

	// savePassword logs the user in and sends them home (the dashboard).
	await expectLoggedInToDashboard(page);

	// Fresh anonymous session: old password rejected, new one works
	// with no forced-change detour.
	const fresh = await freshAnonymousPage(browser, baseURL);
	await login(fresh, context.path, user.username, user.password);
	await expectLoginRejected(fresh);
	await login(fresh, context.path, user.username, newPassword);
	await expectLoggedInToDashboard(fresh);
	await fresh.context().close();
});

// Row 4
test('change password from the profile Password tab', {tag: ['@regression']}, async ({page, pkpApi, browser, baseURL}) => {
	const tag = uniqueTag('pw4');
	const user = throwawayUser(tag);
	const context = await seedJournal(pkpApi, tag, [
		{username: user.username, email: user.email, password: user.password, roles: ['author']},
	]);

	await login(page, context.path, user.username, user.password);
	await expectLoggedInToDashboard(page);

	// Profile → Password tab (legacy jQuery tabs, AJAX-loaded form).
	await page.goto(`/index.php/${context.path}/user/profile`);
	await page.locator('#profileTabs a[name="changePassword"]').click();
	const form = page.locator('form#changePasswordForm');
	await expect(form).toBeVisible();

	// Wrong current password → rejected; the error surfaces through the
	// form's in-place notification (the AjaxFormHandler re-render
	// clears the fields). The throwaway user is unique to this test, so
	// the notification fetch can't be drained by a parallel worker.
	const newPassword = `new-${tag}-pw`;
	await form.locator('input[name="oldPassword"]').fill(`wrong-${tag}`);
	await form.locator('input[name="password"]').fill(newPassword);
	await form.locator('input[name="password2"]').fill(newPassword);
	await form.locator('button.submitFormButton').click();
	await expect(
		page.locator('#changePasswordFormNotification'),
	).toContainText(MSG.oldPasswordInvalid);

	// Correct current password → save succeeds (empty-content JSON is
	// the canonical success signal; toasts race under parallel load).
	await form.locator('input[name="oldPassword"]').fill(user.password);
	await form.locator('input[name="password"]').fill(newPassword);
	await form.locator('input[name="password2"]').fill(newPassword);
	const saveResponse = page.waitForResponse(
		(r) => r.url().includes('save-password') && r.status() === 200,
	);
	await form.locator('button.submitFormButton').click();
	const saveJson = await (await saveResponse).json();
	expect(saveJson.status).toBe(true);
	expect(saveJson.content).toBe('');

	// Fresh session: only the new password logs in.
	const fresh = await freshAnonymousPage(browser, baseURL);
	await login(fresh, context.path, user.username, user.password);
	await expectLoginRejected(fresh);
	await login(fresh, context.path, user.username, newPassword);
	await expectLoggedInToDashboard(fresh);
	await fresh.context().close();
});

// Row 5
test('password validation rules on the reset and profile forms', {tag: ['@regression']}, async ({page, pkpApi, pkpMail, browser, baseURL}) => {
	const tag = uniqueTag('pw5');
	const user = throwawayUser(tag);
	const context = await seedJournal(pkpApi, tag, [
		{username: user.username, email: user.email, password: user.password, roles: ['author']},
	]);

	// --- Reset form (reached through a real reset link; done BEFORE
	// any login on this account — logging in changes dateLastLogin,
	// which invalidates previously-issued reset hashes). ---
	await requestPasswordReset(page, context.path, user.email);
	const resetUrl = await resetUrlFromMail(pkpMail, user);

	await page.goto(resetUrl);
	const resetForm = page.locator('form#updateResetPassword');
	await expect(resetForm).toBeVisible();

	// Below site minPasswordLength (matching pair → the length rule is
	// what fails). Server-side validation re-renders with #formErrors.
	await resetForm.locator('input[name="password"]').fill('abc');
	await resetForm.locator('input[name="password2"]').fill('abc');
	await resetForm.locator('button[type="submit"]').click();
	await expect(page.locator('#formErrors')).toContainText(
		MSG.lengthRestriction,
	);

	// New/confirm mismatch (both long enough → the confirm rule fails).
	// The re-rendered form keeps the hidden username/hash fields.
	await resetForm.locator('input[name="password"]').fill(`mm-a-${tag}`);
	await resetForm.locator('input[name="password2"]').fill(`mm-b-${tag}`);
	await resetForm.locator('button[type="submit"]').click();
	await expect(page.locator('#formErrors')).toContainText(
		MSG.passwordsDoNotMatch,
	);

	// Password unchanged after the failed attempts: original still works.
	await login(page, context.path, user.username, user.password);
	await expectLoggedInToDashboard(page);

	// --- Profile Password form (same rules, ajax rendering: errors
	// arrive through the in-place notification). ---
	await page.goto(`/index.php/${context.path}/user/profile`);
	await page.locator('#profileTabs a[name="changePassword"]').click();
	const form = page.locator('form#changePasswordForm');
	await expect(form).toBeVisible();

	await form.locator('input[name="oldPassword"]').fill(user.password);
	await form.locator('input[name="password"]').fill('abc');
	await form.locator('input[name="password2"]').fill('abc');
	await form.locator('button.submitFormButton').click();
	await expect(
		page.locator('#changePasswordFormNotification'),
	).toContainText(MSG.lengthRestriction);

	// Fields come back cleared after the ajax re-render — refill.
	await form.locator('input[name="oldPassword"]').fill(user.password);
	await form.locator('input[name="password"]').fill(`mm-a-${tag}`);
	await form.locator('input[name="password2"]').fill(`mm-b-${tag}`);
	await form.locator('button.submitFormButton').click();
	await expect(
		page.locator('#changePasswordFormNotification'),
	).toContainText(MSG.passwordsDoNotMatch);

	// Password unchanged after the profile failures too.
	const fresh = await freshAnonymousPage(browser, baseURL);
	await login(fresh, context.path, user.username, user.password);
	await expectLoggedInToDashboard(fresh);
	await fresh.context().close();
});
