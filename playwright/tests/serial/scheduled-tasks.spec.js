// @ts-check
const {execFile} = require('child_process');
const {promisify} = require('util');
const {test, expect} = require('../../support/base-test.js');
const submissionInReview = require('../../../../../playwright/fixtures/scenarios/submission-in-review.js');

const execFileAsync = promisify(execFile);

/**
 * Scheduled tasks — docs/e2e/plans/scheduled-tasks.md (rows 1–4).
 *
 * WHY SERIAL (charter principle 9, docs/e2e/PRINCIPLES.md): the
 * ReviewReminder task scans EVERY incomplete review assignment in the
 * database (Repo::reviewAssignment()->getCollector()
 * ->filterByIsIncomplete(true), no context/submission scoping —
 * lib/pkp/classes/task/ReviewReminder.php:47-52), and EditorialReminders
 * fans a digest job out to EVERY manager/sub-editor of EVERY enabled
 * context (lib/pkp/classes/task/EditorialReminders.php:38-53). Triggering
 * either from inside the parallel project would corrupt sibling tests:
 * a parallel worker's assignment sitting inside a reminder window would
 * get `dateReminded` stamped onto it AND its reviewer mailed; an
 * editorial digest addressed to a SHARED editor (dbarnes & co.)
 * interpolates the tag-marked titles of every outstanding submission,
 * which can break a sibling's `expectNone({to, contains: tag})`. These
 * rows therefore live exclusively in the serial project, which runs
 * with workers=1 AFTER the parallel suite has finished (config-factory
 * .js `serial` project).
 *
 * Trigger mechanism (plan Execution paragraph, verified): no test-only
 * HTTP endpoint exists and the built-in task runner is Off in the test
 * config, so each row shells out
 *   APPLICATION_ENV=test php lib/pkp/tools/scheduler.php test \
 *     --name="PKP\task\ReviewReminder"   (resp. EditorialReminders)
 * which runs the one named CallbackEvent synchronously (registered in
 * classes/scheduler/Scheduler.php). Reminder mailables are dispatched
 * as queued jobs; `php lib/pkp/tools/jobs.php run` drains the queue
 * deterministically before any Mailpit read. Both shell-outs inherit
 * process.env (dotenv-loaded by the Playwright config) so the DB env
 * vars reach PHP; APPLICATION_ENV=test is added explicitly.
 * Debug note: the schedule entries are registered withoutOverlapping —
 * if a triggered run is ever killed mid-task, the cache-backed mutex
 * can make subsequent `scheduler.php test` runs silently no-op until
 * it expires. The Mailpit assertions surface that as "no mail".
 *
 * Reminder-window date choice (rows 1–3): publicknowledge carries the
 * bootstrap-enriched thresholds (2 days before/after, response +
 * submit), so per the plan the submissions seed there and the in-window
 * deadline is `tomorrow 23:59:59` computed on the Node side. Tomorrow
 * end-of-day is the unique value that tolerates a ±1-day clock skew
 * between Node (local TZ) and PHP/Postgres (UTC here — the app-changes
 * §3 near-midnight hazard): server a day behind → diff 2.9 → floor 2
 * <= 2; server a day ahead → due is later the same server-day, still
 * in the future, diff 0. Assertions on the RENDERED date are skew-free
 * because the mail variable formats the stored string verbatim
 * (Y-m-d via config date_format_short, no TZ conversion —
 * lib/pkp/classes/mail/variables/ReviewAssignmentEmailVariable.php:84-95).
 *
 * Template fact (row 1): the REVIEW_RESPONSE_OVERDUE_AUTO default
 * template interpolates {$reviewDueDate} ("your review is due by …"),
 * NOT {$responseDueDate} — the response deadline drives the trigger
 * window only. Row 1 therefore seeds an explicit reviewDueDate and
 * asserts that rendering.
 *
 * Row 4 bell caveat: the planned "notification appears in the editor's
 * tasks bell" assertion is impossible against current app code — the
 * EditorialReminder job creates its notification at the default
 * NOTIFICATION_LEVEL_NORMAL (lib/pkp/jobs/email/EditorialReminder.php
 * :161-166), while both the bell's unread count
 * (lib/pkp/classes/notification/Notification.php:209-219) and the
 * tasks-grid loader
 * (lib/pkp/controllers/grid/notifications/TaskNotificationsGridHandler
 * .php:47) filter on NOTIFICATION_LEVEL_TASK, so the row can never
 * surface there (DB-verified: level=2 row created, bell count
 * unchanged). The row instead proves the notification row exists via
 * its only user-visible artifact: the per-notification unsubscribe
 * link the digest footer embeds (Unsubscribe trait requires the
 * created Notification). Reported as an app-bug candidate.
 *
 * Throwaway recipients: every row mints its own reviewer/editor through
 * the journal scenario's users[] (+password) — never the shared seeded
 * users, whose inboxes collect traffic from the rest of the suite
 * (plan Scenario-needs). All Mailpit reads are scoped recipient + tag.
 */

const APP_ROOT = process.cwd();

const TASK_REVIEW_REMINDER = 'PKP\\task\\ReviewReminder';
const TASK_EDITORIAL_REMINDERS = 'PKP\\task\\EditorialReminders';

/**
 * Run one named scheduled task synchronously via the scheduler CLI.
 * Throws if the CLI exits non-zero or doesn't report the task DONE.
 *
 * @param {string} taskName  fully-qualified registered event name
 */
async function runScheduledTask(taskName) {
	const {stdout, stderr} = await execFileAsync(
		'php',
		['lib/pkp/tools/scheduler.php', 'test', `--name=${taskName}`],
		{
			cwd: APP_ROOT,
			maxBuffer: 10 * 1024 * 1024,
			timeout: 120_000,
			env: {...process.env, APPLICATION_ENV: 'test'},
		},
	);
	if (!/DONE/.test(stdout)) {
		throw new Error(
			`scheduler.php test --name=${taskName} did not report DONE.\n` +
				`stdout: ${stdout}\nstderr: ${stderr}`,
		);
	}
	return stdout;
}

/**
 * Drain the default job queue: the reminder tasks dispatch their
 * mailables as queued jobs; this runs them all before Mailpit reads.
 * (The end-of-request job runner may legitimately have drained some or
 * all of them already — an empty queue is success, not an error.)
 */
async function drainJobs() {
	const {stdout} = await execFileAsync('php', ['lib/pkp/tools/jobs.php', 'run'], {
		cwd: APP_ROOT,
		maxBuffer: 10 * 1024 * 1024,
		timeout: 180_000,
		env: {...process.env, APPLICATION_ENV: 'test'},
	});
	return stdout;
}

/** prefix-w{workerIndex}-{random} — per-run random component. */
function uniqueTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

/** Short, globally-unique throwaway username (users persist on the DB). */
function uniqueUsername(prefix) {
	return `${prefix}${Math.random().toString(36).slice(2, 10)}`;
}

/** 'YYYY-MM-DD 23:59:59' for Node-local today + n days. */
function endOfDayPlusDays(n) {
	const d = new Date(Date.now() + n * 24 * 60 * 60 * 1000);
	return `${isoDate(d)} 23:59:59`;
}

/** 'YYYY-MM-DD' (also exactly how the email renders dates: Y-m-d). */
function isoDate(d) {
	const pad = (x) => String(x).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The Y-m-d string the mail will render for a seeded 'date time' value. */
function renderedDate(seededDate) {
	return seededDate.split(' ')[0];
}

/**
 * Request a password reset for a throwaway user — the canonical
 * positive-control mail that bounds negative/count assertions
 * (principle 8). Real SMTP traffic, sent strictly AFTER the action
 * under test.
 */
async function sendControlMail(page, contextPath, email) {
	await page.goto(`/index.php/${contextPath}/login/lostPassword`);
	const form = page.locator('form#lostPasswordForm');
	await form.locator('input[name="email"]').fill(email);
	await form.locator('button[type="submit"]').click();
	await expect(page.locator('.page_message .description')).toContainText(
		/confirmation has been sent/i,
	);
}

test.describe('Scheduled tasks (serial)', () => {
	test(
		'review response reminder is sent to a non-responding reviewer',
		{tag: '@regression'},
		async ({pkpApi, pkpMail}) => {
			// Row 1.
			test.setTimeout(120_000);
			const tag = uniqueTag('schedrr1');
			const reviewer = uniqueUsername('rr1');
			const reviewerEmail = `${reviewer}@mailinator.com`;
			const responseDueDate = endOfDayPlusDays(1); // inside the 2-day before-response window
			const reviewDueDate = endOfDayPlusDays(14); // what the template renders; outside every window

			// Scratch journal exists solely to mint the throwaway reviewer
			// (users[] + password); the submission seeds on publicknowledge,
			// which carries the reminder thresholds (plan Scenario-needs).
			await pkpApi.createJournal({
				tag,
				users: [{username: reviewer, password: `${reviewer}pw`, roles: ['reviewer']}],
			});
			const {submission} = await pkpApi.createSubmission(
				submissionInReview({
					tag,
					reviewers: [
						{
							user: reviewer,
							method: 'anonymous',
							status: 'invited',
							responseDueDate,
							reviewDueDate,
						},
					],
				}),
			);

			await runScheduledTask(TASK_REVIEW_REMINDER);
			await drainJobs();

			// ReviewResponseRemindAuto lands with the throwaway reviewer,
			// scoped recipient + tag (the seeded title carries "[tag]").
			const messages = await pkpMail.find({
				to: reviewerEmail,
				contains: tag,
				timeoutMs: 20_000,
			});
			expect(messages).toHaveLength(1);
			expect(messages[0].Subject).toBe('Will you be able to review this for us?');

			const full = await pkpMail.fullMessage(messages[0].ID);
			// Names the tagged submission…
			expect(full.HTML).toContain(`[${tag}]`);
			// …with the seeded review due date rendered (Y-m-d, verbatim —
			// see header on why this assertion is skew-free)…
			expect(full.HTML).toContain(
				`your review is due by ${renderedDate(reviewDueDate)}`,
			);
			// …and the reviewer's one-click review URL for this submission.
			expect(full.HTML).toContain(
				`reviewer/submission?submissionId=${submission.id}"`,
			);
		},
	);

	test(
		'review submit reminder is sent to a confirmed reviewer',
		{tag: '@regression'},
		async ({pkpApi, pkpMail}) => {
			// Row 2.
			test.setTimeout(120_000);
			const tag = uniqueTag('schedrr2');
			const reviewer = uniqueUsername('rr2');
			const reviewerEmail = `${reviewer}@mailinator.com`;
			const reviewDueDate = endOfDayPlusDays(1); // inside the 2-day before-submit window

			await pkpApi.createJournal({
				tag,
				users: [{username: reviewer, password: `${reviewer}pw`, roles: ['reviewer']}],
			});
			const {submission} = await pkpApi.createSubmission(
				submissionInReview({
					tag,
					reviewers: [
						{
							user: reviewer,
							method: 'anonymous',
							status: 'accepted', // dateConfirmed set → submit-reminder branch
							reviewDueDate,
						},
					],
				}),
			);

			await runScheduledTask(TASK_REVIEW_REMINDER);
			await drainJobs();

			const messages = await pkpMail.find({
				to: reviewerEmail,
				contains: tag,
				timeoutMs: 20_000,
			});
			expect(messages).toHaveLength(1);
			expect(messages[0].Subject).toBe(
				'A reminder to please complete your review',
			);

			const full = await pkpMail.fullMessage(messages[0].ID);
			expect(full.HTML).toContain(`[${tag}]`);
			// ReviewRemindAuto renders the review (submit) deadline.
			expect(full.HTML).toContain(
				`expecting to have this review by ${renderedDate(reviewDueDate)}`,
			);
			expect(full.HTML).toContain(
				`reviewer/submission?submissionId=${submission.id}"`,
			);
		},
	);

	test(
		're-running the task does not duplicate a reminder',
		{tag: '@regression'},
		async ({page, pkpApi, pkpMail}) => {
			// Row 3 — same seed shape as row 1; the duplicate-suppression
			// mechanism under test is the `dateReminded` stamp the first
			// job run writes (lib/pkp/jobs/email/ReviewReminder.php:94-97).
			test.setTimeout(120_000);
			const tag = uniqueTag('schedrr3');
			const reviewer = uniqueUsername('rr3');
			const reviewerEmail = `${reviewer}@mailinator.com`;
			// Control recipient: separate throwaway so the bounding mail
			// can never collide with the reminder count (and carries no tag).
			const control = uniqueUsername('ctl3');
			const controlEmail = `${control}@mailinator.com`;

			const {context} = await pkpApi.createJournal({
				tag,
				users: [
					{username: reviewer, password: `${reviewer}pw`, roles: ['reviewer']},
					{username: control, password: `${control}pw`, roles: ['author']},
				],
			});
			await pkpApi.createSubmission(
				submissionInReview({
					tag,
					reviewers: [
						{
							user: reviewer,
							method: 'anonymous',
							status: 'invited',
							responseDueDate: endOfDayPlusDays(1),
						},
					],
				}),
			);

			// First run sends the reminder — the row's own positive control
			// that the seed sits inside the window.
			await runScheduledTask(TASK_REVIEW_REMINDER);
			await drainJobs();
			const firstRun = await pkpMail.find({
				to: reviewerEmail,
				contains: tag,
				timeoutMs: 20_000,
			});
			expect(firstRun).toHaveLength(1);

			// Second run: dateReminded is now set and the response deadline
			// is still in the future → no branch matches, nothing dispatched.
			await runScheduledTask(TASK_REVIEW_REMINDER);
			await drainJobs();

			// Bound the "no second mail" wait with a control message sent
			// strictly AFTER the second run (principle 8): once the later
			// control is in Mailpit, an earlier duplicate would be too.
			await sendControlMail(page, context.path, controlEmail);
			await pkpMail.find({
				to: controlEmail,
				contains: control,
				timeoutMs: 20_000,
			});

			const afterSecondRun = await pkpMail.find({
				to: reviewerEmail,
				contains: tag,
				timeoutMs: 5_000,
			});
			expect(afterSecondRun).toHaveLength(1);
		},
	);

	test(
		'editorial reminder digest reaches the assigned editor',
		{tag: '@regression'},
		async ({pkpApi, pkpMail}) => {
			// Row 4 — scratch journal keeps the digest to exactly our
			// submission. EditorialReminders fans jobs out to every
			// editor/manager of every context, so the drain budget is
			// generous (its digests to other journals' editors are noise
			// this row never reads — see the serial rationale up top).
			test.setTimeout(180_000);
			const tag = uniqueTag('scheded4');
			const editor = uniqueUsername('ed4');
			const editorEmail = `${editor}@mailinator.com`;
			const author = uniqueUsername('au4');

			const {context} = await pkpApi.createJournal({
				tag,
				users: [
					{username: editor, password: `${editor}pw`, roles: ['editor']},
					{username: author, password: `${author}pw`, roles: ['author']},
				],
			});
			// Queued stage-1 submission assigned to the throwaway editor:
			// "A new submission is waiting to be sent for review" outstanding
			// state (EditorialReminder.php:94-97).
			const {submission} = await pkpApi.createSubmission({
				tag,
				journal: context.path,
				submitter: author,
				section: 'ART',
				locale: 'en',
				submitted: true,
				participants: [{user: editor, role: 'editor'}],
				publications: [
					{
						versionStage: 'AO',
						metadata: {
							title: {en: 'Editorial digest target'},
							abstract: {en: '<p>Waiting for an initial decision.</p>'},
						},
						published: false,
					},
				],
			});

			await runScheduledTask(TASK_EDITORIAL_REMINDERS);
			await drainJobs();

			const messages = await pkpMail.find({
				to: editorEmail,
				contains: tag,
				timeoutMs: 20_000,
			});
			expect(messages).toHaveLength(1);
			// Subject interpolates the scratch journal's name, which embeds
			// the tag ("Scratch context <tag>").
			expect(messages[0].Subject).toBe(
				`Outstanding editorial tasks for Scratch context ${tag}`,
			);

			const full = await pkpMail.fullMessage(messages[0].ID);
			// The digest is scoped to exactly our submission…
			expect(full.HTML).toContain('assigned to 1 submissions');
			// …listed as waiting initial review, with the tagged title
			// linked to its workflow page.
			expect(full.HTML).toContain(
				'A new submission is waiting to be sent for review or declined.',
			);
			expect(full.HTML).toContain(`[${tag}]`);
			expect(full.HTML).toContain(`workflowSubmissionId=${submission.id}`);
			// The per-notification unsubscribe link proves the
			// EDITORIAL_REMINDER notification row was created — the bell
			// assertion the plan wanted is unreachable (level NORMAL vs the
			// bell's TASK filter; see header).
			expect(full.HTML).toContain('notification/unsubscribe');
		},
	);
});
