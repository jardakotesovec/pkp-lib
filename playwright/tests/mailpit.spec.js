// @ts-check
const {test, expect} = require('../support/base-test.js');
const submissionInReview = require('../../../../playwright/fixtures/scenarios/submission-in-review.js');

/**
 * Mailpit harness sanity — proves the fixture plumbing the rest of the
 * suite relies on:
 *
 *   1. clearAll() empties Mailpit's inbox.
 *   2. createSubmission() with a multi-decision review fixture emits a lot
 *      of internal mail during seeding — every Mail::send() inside the
 *      scenario controller is supposed to be intercepted by Mail::fake().
 *      None of it may reach Mailpit.
 *
 * If (2) fails, the assumption that scenario seeds are mail-silent is wrong
 * and downstream tests asserting on test-action mail will see seeded noise.
 *
 * The "real UI action produces SMTP traffic observable via pkpMail" proof
 * that used to live here (a password-reset request for dbarnes) was
 * absorbed into password-flows.spec.js row 1 (the full lost-password
 * round-trip on a throwaway user) — see docs/e2e/plans/password-flows.md.
 * The remaining tests here belong to the test-infrastructure plan.
 *
 * (2) was originally asserted as `messageCount() === 0` after a
 * clearAll(). That global count is only valid with zero parallel
 * neighbors — this file sits in the parallel project (its serial mode
 * below only orders its own tests), so any concurrent mail-sending test
 * (e.g. password-flows) lands a message between the clear and the count
 * and fails it. Reworked per principle 8: scope by the seed's unique tag
 * (every seeding mailable interpolates the tag-marked submission title)
 * across the fixture's full recipient cast, bounded by a positive
 * control message. The global-count form can return if/when the
 * test-infrastructure plan relocates this spec to tests/serial/.
 *
 * The spec runs serial because clearAll() is global — interleaving with
 * other mail-touching tests would race each other's inboxes.
 */

test.describe.configure({mode: 'serial'});

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

test('scenario seeding stays mail-faked — no tag-marked seed mail reaches Mailpit', async ({
	page,
	pkpApi,
	pkpMail,
}) => {
	// Worker-scoped tag keeps parallel runs isolated.
	const tag = `mailfake-w${test.info().parallelIndex}-${Math.random()
		.toString(36)
		.slice(2, 8)}`;

	// Throwaway control recipient on a scratch journal. Its password-reset
	// mail — real SMTP traffic triggered AFTER the seed below — bounds the
	// window in which any leaked seeding mail must already have arrived.
	const controlUser = `ctl${tag.replace(/[^a-z0-9]/gi, '')}`;
	const controlEmail = `${controlUser}@mailinator.com`;
	const {context} = await pkpApi.createJournal({
		tag,
		users: [
			{username: controlUser, password: `${controlUser}pw`, roles: ['author']},
		],
	});

	// submissionInReview drives sendExternalReview + adds two reviewers.
	// This path internally calls Mail::send() on multiple mailables
	// (submission acknowledgement, editor assignment, reviewer
	// invitations) — all addressed to the cast below, all interpolating
	// the tag-marked submission title. Every one of them must be
	// intercepted by Mail::fake() in PKPSubmissionScenarioController.
	await pkpApi.createSubmission(submissionInReview({tag}));

	// Positive control: a real UI action whose mail MUST reach Mailpit.
	await page.goto(`/index.php/${context.path}/login/lostPassword`);
	await page.locator('input[name="email"]').fill(controlEmail);
	await page.locator('button[type="submit"]').click();

	// No tag-marked mail to anyone the fixture's seeding mailables would
	// address (submitter, editor, both reviewers).
	for (const username of ['rvaca', 'dbarnes', 'phudson', 'jjanssen']) {
		await pkpMail.expectNone({
			to: `${username}@mailinator.com`,
			contains: tag,
			afterControl: {to: controlEmail, contains: controlUser},
			timeoutMs: 20_000,
		});
	}
});
