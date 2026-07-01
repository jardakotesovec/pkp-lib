// @ts-check
const {test, expect} = require('../support/base-test.js');
const {DiscussionManagerPage} = require('../pages/DiscussionManagerPage.js');
const {TasksGridModal} = require('../pages/TasksGridModal.js');
const {UserProfilePage} = require('../pages/UserProfilePage.js');
const {EditorialWorkflowPage} = require('../../../../playwright/pages/EditorialWorkflowPage.js');
const submissionDraft = require('../../../../playwright/fixtures/scenarios/submission-draft.js');

/**
 * Notifications — docs/e2e/plans/notifications.md (4 rows).
 *
 * The feature under test is the per-user notification machinery around
 * NOTIFICATION_TYPE_NEW_QUERY (the "new discussion" task notification):
 *  - the Tasks inbox (TaskNotificationsGridHandler) opened from the
 *    top-nav bell, including unread state, the link back to the
 *    submission, and the Mark Read / Mark New / Delete grid actions;
 *  - the per-(user, context) email-blocking subscription settings, both
 *    via the profile Notifications tab
 *    (PKPNotificationSettingsForm: the `emailNotificationNewQuery`
 *    checkbox is labelled "Do not send me an email…" — CHECKED means
 *    blocked, written to blocked_emailed_notification) and via the
 *    tokenized unsubscribe link the discussion mail footer carries
 *    (mail/traits/Discussion.php → emails.footer.unsubscribe.discussion
 *    → pages/notification/NotificationHandler::unsubscribe →
 *    PKPNotificationsUnsubscribeForm, whose pre-checked boxes are ALSO
 *    block-list entries).
 *
 * The notification-producing action is always a discussion created by
 * dbarnes through the Discussion Manager UI:
 * EditorialTaskController::addTask → notifyParticipants
 * (api/v1/submissions/tasks/EditorialTaskController.php:1014) creates a
 * LEVEL_TASK NEW_QUERY notification per participant, then emails each
 * one UNLESS NEW_QUERY is in their blocked_emailed_notification list
 * (:1071-1078) — the in-app row is created either way, which is exactly
 * what rows 3 and 4 pin down.
 *
 * Throwaway-user discipline (plan "Scenario needs"): EVERY row creates
 * its own scratch journal + throwaway recipient users via the journal
 * scenario's `users[]` (entries carrying `password` are created, not
 * looked up). Shared seeded users accumulate task notifications and
 * mail from parallel tests, so no row ever asserts against them — and
 * no row ever asserts bell badge counts (shared-surface, racy).
 * Rows 3–4 additionally NEED the scratch journal for correctness:
 * blocked-notification settings are stored per (user, context), so the
 * toggles never touch publicknowledge. Throwaways log in via the real
 * login form in explicitly-empty-state contexts (patterns.md rule 8),
 * never via asUser (no .auth cache files for single-use accounts).
 *
 * Mailpit discipline (principle 8): every read is
 * `pkpMail.find({to, contains})` scoped to a throwaway recipient + the
 * test's unique tag; both negative assertions are bounded by a positive
 * control message to a second throwaway via `pkpMail.expectNone`. The
 * unsubscribe link is an HTML anchor in the discussion footer
 * (`<a href="{$unsubscribeUrl}">unsubscribe</a>`), so
 * pkpMail.extractLink applies — unlike password-flows' raw-URL reset
 * mail — with &amp; decoded before navigation.
 *
 * Absorbs: none.
 */

test.use({user: 'dbarnes'});

/** Worker- and run-scoped unique tag (whitespace-free, ≤32 incl. prefix). */
function uniqueTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

/**
 * Throwaway user derived from the tag: unique username + unique
 * mailinator address so every Mailpit read is recipient-scoped.
 * Given/family names are what the Add-discussion participant
 * checkboxes and the NEW_QUERY message render.
 *
 * @param {string} tag
 * @param {number} n
 * @param {string} familyName
 */
function throwawayUser(tag, n, familyName) {
	const username = `u${n}${tag.replace(/[^a-z0-9]/gi, '')}`;
	return {
		username,
		email: `${username}@mailinator.com`,
		// Login form input caps at maxlength=32 — keep it short.
		password: `pw-${tag}`,
		givenName: 'Notif',
		familyName,
		fullName: `Notif ${familyName}`,
	};
}

/** users[] entry for the journal scenario (password ⇒ CREATE the user). */
function userSpec(user, roles) {
	return {
		username: user.username,
		email: user.email,
		password: user.password,
		givenName: user.givenName,
		familyName: user.familyName,
		roles,
	};
}

/**
 * One scratch journal + draft submission with throwaway recipients.
 * dbarnes is enrolled ('editor' resolves to the manager-level Journal
 * editor group — users.md caution — which is fine here: he only drives
 * the Discussion Manager) and stage-assigned so he can open the
 * workflow and appears pre-checked as the discussion creator. Every
 * extra throwaway is enrolled + stage-assigned as author so the Add
 * form lists them as assignable participants.
 *
 * @param {object} pkpApi
 * @param {string} tag
 * @param {{submitter: object, extraParticipants?: object[]}} opts
 */
async function seedScratchScenario(pkpApi, tag, {submitter, extraParticipants = []}) {
	const {context} = await pkpApi.createJournal({
		tag,
		name: {en: `Notifications ${tag}`},
		users: [
			{username: 'dbarnes', roles: ['editor']},
			userSpec(submitter, ['author']),
			...extraParticipants.map((u) => userSpec(u, ['author'])),
		],
	});

	const submissionTitle = `Submission ${tag}`;
	const {submission} = await pkpApi.createSubmission({
		...submissionDraft({
			tag,
			submitter: submitter.username,
			participants: [
				{user: 'dbarnes', role: 'editor'},
				...extraParticipants.map((u) => ({user: u.username, role: 'author'})),
			],
		}),
		journal: context.path,
		publications: [
			{
				versionStage: 'AO',
				metadata: {
					title: {en: submissionTitle},
					abstract: {en: `<p>Notifications scenario ${tag}.</p>`},
				},
				published: false,
			},
		],
	});

	return {context, submission, submissionTitle};
}

/**
 * dbarnes (the default page user) creates a discussion through the
 * Discussion Manager on the submission's workflow page. The title
 * carries the marker, so it rides into the email subject, the email
 * body, and the in-app NEW_QUERY message (submission.query.new).
 *
 * @param {import('@playwright/test').Page} page
 * @param {{contextPath: string, submissionId: number, title: string, body: string, participantNames: string[]}} opts
 */
async function createDiscussion(page, {contextPath, submissionId, title, body, participantNames}) {
	const workflow = new EditorialWorkflowPage(page);
	await workflow.goto(submissionId, {journalPath: contextPath});
	const dm = new DiscussionManagerPage(page);
	await dm.expectVisible();
	const form = await dm.openAdd();
	await form.fillTitle(title);
	for (const name of participantNames) {
		await form.checkParticipant(name);
	}
	await form.fillDescription(`<p>${body}</p>`);
	await form.save();
	await expect(dm.row(title)).toBeVisible();
}

/**
 * Fresh, explicitly-anonymous context (patterns.md rule 8 — a plain
 * newContext() would inherit dbarnes' storageState) + a real
 * login-form login in the scratch journal. Callers close the context.
 *
 * @param {import('@playwright/test').Browser} browser
 * @param {string|undefined} baseURL
 * @param {string} contextPath
 * @param {{username: string, password: string}} user
 */
async function loginFreshContext(browser, baseURL, contextPath, user) {
	const ctx = await browser.newContext({
		baseURL,
		storageState: {cookies: [], origins: []},
	});
	const page = await ctx.newPage();
	await page.goto(`/index.php/${contextPath}/login`);
	await page.locator('input#username').fill(user.username);
	await page.locator('input#password').fill(user.password);
	await page.locator('form#login button').click();
	await page.waitForURL((url) => !url.pathname.includes('/login'), {
		timeout: 20_000,
		waitUntil: 'commit',
	});
	return page;
}

test.describe('Notifications', () => {
	// Row 1
	test('new discussion lands in the participant\'s tasks inbox', {tag: '@smoke'}, async ({page, pkpApi, browser, baseURL}) => {
		const tag = uniqueTag('ntf1');
		const submitter = throwawayUser(tag, 1, 'Submitter');
		const {context, submission, submissionTitle} = await seedScratchScenario(
			pkpApi,
			tag,
			{submitter},
		);

		const title = `Discussion ${tag}`;
		await createDiscussion(page, {
			contextPath: context.path,
			submissionId: submission.id,
			title,
			body: `Inbox body ${tag}`,
			participantNames: [submitter.fullName],
		});

		// The submitter signs in through the login form and opens the
		// tasks inbox from the top-nav bell.
		const authorPage = await loginFreshContext(
			browser,
			baseURL,
			context.path,
			submitter,
		);
		const tasks = new TasksGridModal(authorPage);
		await tasks.open();

		// The tagged NEW_QUERY notification is listed UNREAD: the message
		// names the creator and the discussion title
		// (submission.query.new), the details line carries the submission
		// title. Presence/read-state only — never the bell badge count.
		await expect(tasks.task(tag)).toBeVisible({timeout: 15_000});
		await tasks.expectUnread(tag);
		await expect(tasks.task(tag)).toContainText('started a discussion');
		await expect(tasks.task(tag)).toContainText(title);
		await expect(
			tasks.task(tag).locator('.details .submission'),
		).toContainText(submissionTitle);

		// "Linking to the submission": the row's details LinkAction marks
		// it read and redirects to the submitter's workflow surface for
		// this submission (QueryNotificationManager::getNotificationUrl →
		// getWorkflowUrlByUserRoles).
		await tasks.openTask(tag);
		await authorPage.waitForURL(
			new RegExp(`workflowSubmissionId=${submission.id}(?!\\d)`),
			{timeout: 20_000, waitUntil: 'commit'},
		);

		await authorPage.context().close();
	});

	// Row 2
	test('mark read / mark new / delete in the tasks grid', {tag: '@regression'}, async ({page, pkpApi, browser, baseURL}) => {
		const tag = uniqueTag('ntf2');
		const submitter = throwawayUser(tag, 1, 'Submitter');
		const {context, submission} = await seedScratchScenario(pkpApi, tag, {
			submitter,
		});

		const title = `Discussion ${tag}`;
		await createDiscussion(page, {
			contextPath: context.path,
			submissionId: submission.id,
			title,
			body: `Grid actions body ${tag}`,
			participantNames: [submitter.fullName],
		});

		const authorPage = await loginFreshContext(
			browser,
			baseURL,
			context.path,
			submitter,
		);
		const tasks = new TasksGridModal(authorPage);
		await tasks.open();
		await expect(tasks.task(tag)).toBeVisible({timeout: 15_000});
		await tasks.expectUnread(tag);

		// Mark Read clears the row's unread state. Selection has to be
		// re-applied before every action — the grid refresh that follows
		// each POST drops it (see TasksGridModal doc-comment).
		await tasks.selectTask(tag);
		await tasks.markRead();
		await tasks.expectRead(tag);

		// Mark New restores it.
		await tasks.selectTask(tag);
		await tasks.markNew();
		await tasks.expectUnread(tag);

		// Delete removes the row from the grid.
		await tasks.selectTask(tag);
		await tasks.deleteSelected();
		await expect(tasks.task(tag)).toHaveCount(0);

		await authorPage.context().close();
	});

	// Row 3
	test('blocking email for new-discussion notifications stops mail but keeps in-app', {tag: '@regression'}, async ({page, pkpApi, pkpMail, browser, baseURL}) => {
		const tag = uniqueTag('ntf3');
		const blocked = throwawayUser(tag, 1, 'Blocked');
		const control = throwawayUser(tag, 2, 'Control');
		const {context, submission} = await seedScratchScenario(pkpApi, tag, {
			submitter: blocked,
			extraParticipants: [control],
		});

		// The blocked user opts out of NEW_QUERY emails on their profile
		// Notifications tab in the SCRATCH journal context (the setting
		// is stored per user+context). Checkbox semantics: the email
		// column is "Do not send me an email for these types of
		// notifications" — checking it writes the type into
		// blocked_emailed_notification (PKPNotificationSettingsForm::
		// execute). The in-app "allow" box stays checked.
		const blockedPage = await loginFreshContext(
			browser,
			baseURL,
			context.path,
			blocked,
		);
		const profile = new UserProfilePage(blockedPage, context.path);
		await profile.goto('notificationSettings');
		const form = profile.form('notificationSettings');
		await expect(
			form.locator('input[name="notificationNewQuery"]'),
		).toBeChecked();
		await form.locator('input[name="emailNotificationNewQuery"]').check();
		await profile.save('notificationSettings');

		// dbarnes starts a discussion with both throwaways as
		// participants — one addTask → notifyParticipants pass over both.
		const title = `Discussion ${tag}`;
		await createDiscussion(page, {
			contextPath: context.path,
			submissionId: submission.id,
			title,
			body: `Blocked-email body ${tag}`,
			participantNames: [blocked.fullName, control.fullName],
		});

		// The control participant's copy arrives (positive control that
		// bounds the negative wait — both sends happen synchronously in
		// the same request); the blocked recipient gets none.
		const [controlMessage] = await pkpMail.find({
			to: control.email,
			contains: tag,
			timeoutMs: 20_000,
		});
		expect(controlMessage.Subject).toBe(title);
		await pkpMail.expectNone({
			to: blocked.email,
			contains: tag,
			afterControl: {to: control.email, contains: tag},
			timeoutMs: 20_000,
		});

		// The in-app notification STILL appears in the blocked user's
		// tasks inbox — only the email leg is suppressed
		// (EditorialTaskController::notifyParticipants creates the
		// notification before the blocked-email check).
		const tasks = new TasksGridModal(blockedPage);
		await tasks.open();
		await expect(tasks.task(tag)).toBeVisible({timeout: 15_000});
		await tasks.expectUnread(tag);

		await blockedPage.context().close();
	});

	// Row 4
	test('unsubscribe link from a notification email blocks future sends', {tag: '@regression'}, async ({page, pkpApi, pkpMail, browser, baseURL}) => {
		const tag = uniqueTag('ntf4');
		const target = throwawayUser(tag, 1, 'Target');
		const control = throwawayUser(tag, 2, 'Control');
		const {context, submission} = await seedScratchScenario(pkpApi, tag, {
			submitter: target,
			extraParticipants: [control],
		});

		// Discussion 1 → the target's notification email. Markers are
		// per-discussion (tag + d1/d2) so the row-4 negative assertion
		// can't match this first, legitimately-delivered message.
		const title1 = `Discussion ${tag}d1`;
		await createDiscussion(page, {
			contextPath: context.path,
			submissionId: submission.id,
			title: title1,
			body: `First body ${tag}d1`,
			participantNames: [target.fullName],
		});

		// The discussion mail footer (emails.footer.unsubscribe.discussion)
		// carries the tokenized unsubscribe link as an HTML anchor.
		const [message1] = await pkpMail.find({
			to: target.email,
			contains: `${tag}d1`,
			timeoutMs: 20_000,
		});
		const full1 = await pkpMail.fullMessage(message1.ID);
		const unsubscribeUrl = pkpMail
			.extractLink(full1.HTML || '', 'unsubscribe')
			.replace(/&amp;/g, '&');
		expect(unsubscribeUrl).toContain('/notification/unsubscribe');
		expect(unsubscribeUrl).toContain('validate=');
		expect(unsubscribeUrl).toMatch(/id=\d+/);

		// Following it renders the confirm form (frontend page, token
		// validated server-side; every email-type checkbox arrives
		// pre-checked = "unsubscribe from these"), and submitting lands
		// on the success result page.
		const targetPage = await loginFreshContext(
			browser,
			baseURL,
			context.path,
			target,
		);
		await targetPage.goto(unsubscribeUrl);
		const unsubscribeForm = targetPage.locator(
			'form#unsubscribeNotificationForm',
		);
		await expect(unsubscribeForm).toBeVisible({timeout: 15_000});
		await expect(
			targetPage.getByText(
				'Select the emails that you no longer wish to receive',
			),
		).toBeVisible();
		await expect(targetPage.getByText(target.email).first()).toBeVisible();
		await expect(
			unsubscribeForm.locator('input[name="emailNotificationNewQuery"]'),
		).toBeChecked();
		await unsubscribeForm
			.getByRole('button', {name: 'Unsubscribe'})
			.click();
		await expect(
			targetPage.getByRole('heading', {name: 'You have been unsubscribed'}),
		).toBeVisible({timeout: 15_000});
		await expect(
			targetPage.getByText('has been successfully unsubscribed'),
		).toBeVisible();

		// Discussion 2 notifies both participants: the control's copy
		// arrives (positive control), the unsubscribed target's does not.
		const title2 = `Discussion ${tag}d2`;
		await createDiscussion(page, {
			contextPath: context.path,
			submissionId: submission.id,
			title: title2,
			body: `Second body ${tag}d2`,
			participantNames: [target.fullName, control.fullName],
		});
		const [controlMessage] = await pkpMail.find({
			to: control.email,
			contains: `${tag}d2`,
			timeoutMs: 20_000,
		});
		expect(controlMessage.Subject).toBe(title2);
		await pkpMail.expectNone({
			to: target.email,
			contains: `${tag}d2`,
			afterControl: {to: control.email, contains: `${tag}d2`},
			timeoutMs: 20_000,
		});

		// In-app unaffected: the second discussion's notification is in
		// the target's tasks inbox (unsubscribe only blocks the email leg).
		await targetPage.goto(`/index.php/${context.path}/dashboard/mySubmissions`);
		const tasks = new TasksGridModal(targetPage);
		await tasks.open();
		await expect(tasks.task(`${tag}d2`)).toBeVisible({timeout: 15_000});
		await tasks.expectUnread(`${tag}d2`);

		await targetPage.context().close();
	});
});
