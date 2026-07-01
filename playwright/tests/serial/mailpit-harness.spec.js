// @ts-check
const {test, expect} = require('../../support/base-test.js');
const submissionInReview = require('../../../../../playwright/fixtures/scenarios/submission-in-review.js');

/**
 * Mailpit harness sanity — docs/e2e/plans/test-infrastructure.md row 7.
 *
 * Proves the fixture plumbing the rest of the suite relies on:
 *
 *   1. clearAll() empties Mailpit's inbox.
 *   2. Scenario seeding is mail-silent: a mail-heavy seed (scratch
 *      journal + multi-decision in-review submission, which fires
 *      submission acknowledgement, editor assignment and reviewer
 *      invitation mailables) leaves Mailpit at ZERO messages, because
 *      every Mail::send() inside the scenario controllers is
 *      intercepted by Mail::fake(). If this fails, downstream tests
 *      asserting on test-action mail would see seeded noise.
 *
 * WHY SERIAL (charter principles 8–9, docs/e2e/PRINCIPLES.md): both
 * tests call pkpMail.clearAll(), which wipes the GLOBAL shared inbox,
 * and test 2 asserts the GLOBAL message count. This spec is the ONLY
 * place clearAll() is permitted, and both moves are legitimate only
 * with zero parallel neighbors — which the serial project guarantees
 * (workers=1, runs after the parallel suite; config-factory.js).
 *
 * History: this spec previously lived in the parallel project
 * (lib/pkp/playwright/tests/mailpit.spec.js), where the global-count
 * leak check could never be stably green — wave 8 reworked it
 * tag-scoped + control-bounded as a stopgap (app-changes.md §3). Moved
 * here per the test-infrastructure plan, the stronger global-count
 * form below is restored. The "real UI action produces SMTP traffic"
 * proof that also once lived here (a password-reset request) was
 * absorbed into password-flows.spec.js row 1; a positive-control
 * password-reset remains below only to BOUND the leak check's window.
 */

test('clearAll empties Mailpit when there is nothing to clear', async ({pkpMail}) => {
	await pkpMail.clearAll();
	// Re-querying for a non-existent recipient should time out fast — use
	// inboxFor with a tiny budget to confirm "empty" rather than waiting
	// for the default 10s.
	await expect(
		pkpMail.inboxFor('nobody-' + Date.now() + '@mailinator.com', {
			timeout: 500,
			poll: 100,
		}),
	).rejects.toThrow(/No mail/);
});

test('scenario seeding stays mail-faked — Mailpit stays at zero after a mail-heavy seed', async ({
	page,
	pkpApi,
	pkpMail,
}) => {
	const tag = `mailfake-w${test.info().parallelIndex}-${Math.random()
		.toString(36)
		.slice(2, 8)}`;

	// Throwaway control recipient on a scratch journal. Its password-reset
	// mail — real SMTP traffic triggered AFTER the seeds below — bounds the
	// window in which any leaked seeding mail must already have arrived.
	const controlUser = `ctl${tag.replace(/[^a-z0-9]/gi, '')}`;
	const controlEmail = `${controlUser}@mailinator.com`;

	// Start from a clean inbox, then run BOTH scenario seeds. The journal
	// seed runs under the same Mail::fake() contract as the submission
	// seed, so the count assertions cover it too.
	await pkpMail.clearAll();
	const {context} = await pkpApi.createJournal({
		tag,
		users: [
			{username: controlUser, password: `${controlUser}pw`, roles: ['author']},
		],
	});
	// submissionInReview drives sendExternalReview + adds two reviewers —
	// the mail-heaviest seed shape in the fixture set.
	await pkpApi.createSubmission(submissionInReview({tag}));

	// The restored global-count form (legitimate here: no parallel
	// neighbors): scenario seeding must leave Mailpit untouched. Seeding
	// requests are synchronous, so any leak has been SMTP-delivered by
	// now bar ingest latency — which the control below closes.
	expect(await pkpMail.messageCount()).toBe(0);

	// Positive control: a real UI action whose mail MUST reach Mailpit,
	// triggered after the seeds. Once it has arrived, any earlier leaked
	// seed mail would have arrived too — so the inbox holding EXACTLY the
	// control message proves nothing trailed in.
	await page.goto(`/index.php/${context.path}/login/lostPassword`);
	const form = page.locator('form#lostPasswordForm');
	await form.locator('input[name="email"]').fill(controlEmail);
	await form.locator('button[type="submit"]').click();
	await pkpMail.find({
		to: controlEmail,
		contains: controlUser,
		timeoutMs: 20_000,
	});
	expect(await pkpMail.messageCount()).toBe(1);
});
