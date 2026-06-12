// @ts-check
const {test, expect} = require('../support/base-test.js');
const submissionPublished = require('../../../../playwright/fixtures/scenarios/submission-published.js');

const SCRATCH_ISSUE = {volume: 1, number: '1', year: 2026};

/**
 * Public comments — moderator UI surface
 * (docs/e2e/plans/public-comments.md rows 3–5).
 *
 * Rows 3–4 are structural: page mount (Comments heading + the four
 * tabs All / Approved / Hidden/Needs Approval / Reported) and tab
 * navigation (aria-selected flips, table re-queries per tab, empty
 * state with no comments).
 *
 * Row 5 exercises the moderation actions themselves against SEEDED
 * comments. Historical context: comments posted via REST after the
 * scratch journal's SPA session warmed hit a Vue reactivity race —
 * the `useFetchPaginated`-driven table sometimes stayed on "No Items"
 * even though the API returned the row. The adjudicated fix (plan's
 * Scenario-needs verdict, built in wave 1) is the submission
 * scenario's `userComments: [{user, text, approved?}]` passthrough
 * (lib/pkp/classes/testing/scenario/Processor/UserCommentProcessor.php),
 * which writes the same INSERT as UserCommentController::submit plus
 * the moderator-notification rows — so the comments exist BEFORE the
 * SPA mounts and the race never arms. Row 5 drives:
 *
 *   - a seeded unapproved comment lists under Hidden/Needs Approval;
 *   - Approve (detail side modal via the row's More Actions → View
 *     Comment) makes it render in `#public-comments` on the anonymous
 *     article page;
 *   - Hide removes a previously-approved comment from the public page
 *     and moves it from the Approved tab to Hidden/Needs Approval.
 *
 * Approve/Hide/Delete buttons live ONLY in the UserCommentDetailModal
 * (lib/ui-library/src/pages/userComments/UserCommentDetailModal.vue);
 * the table row's dropdown offers View Comment / Delete Comment
 * (useUserCommentsConfig.js getCommentItemActions). The store's
 * commentToggleApproval PUTs `comments/{id}/setApproval`, closes the
 * side modal on success, and the modal's onClose refetches the table.
 *
 * Report flows, delete-authorization rules, and version-gating remain
 * out of scope (plan's Round 2 bullets).
 */
test.describe('Public comments — moderator UI', () => {
	test(
		'page mounts with Comments heading and four tabs',
		{tag: '@regression'},
		async ({pkpApi, asUser}) => {
			const tag = uniqueTag(test.info(), 'mount');
			const {context} = await pkpApi.createJournal({
				tag,
				enablePublicComments: true,
				users: [{username: 'dbarnes', roles: ['manager']}],
			});

			const ctx = await asUser('dbarnes');
			const page = await ctx.newPage();
			await page.goto(
				`/index.php/${context.path}/management/settings/userComments`,
			);

			// Heading is the localized 'manager.userComment.comments'
			// string ("Comments").
			await expect(
				page.getByRole('heading', {name: 'Comments', exact: true}),
			).toBeVisible({timeout: 15_000});

			// Four tabs render with the expected localized labels.
			// Tabs use role="tab" via lib/ui-library/.../Tabs.vue.
			for (const label of [
				'All',
				'Approved',
				'Hidden/Needs Approval',
				'Reported',
			]) {
				await expect(
					page.getByRole('tab', {name: label, exact: true}),
				).toBeVisible({timeout: 10_000});
			}

			// Default tab is "All" (per `activeTab = ref('all')` in
			// userCommentStore.js). With no seeded comments the
			// table emits its localized "No Items" empty state.
			await expect(
				page.getByText('No Items', {exact: true}).first(),
			).toBeVisible({timeout: 15_000});
		},
	);

	test(
		'manager can navigate between the four moderator tabs',
		{tag: '@regression'},
		async ({pkpApi, asUser}) => {
			const tag = uniqueTag(test.info(), 'tabs');
			const {context} = await pkpApi.createJournal({
				tag,
				enablePublicComments: true,
				users: [{username: 'dbarnes', roles: ['manager']}],
			});

			const ctx = await asUser('dbarnes');
			const page = await ctx.newPage();
			await page.goto(
				`/index.php/${context.path}/management/settings/userComments`,
			);
			await expect(
				page.getByRole('heading', {name: 'Comments', exact: true}),
			).toBeVisible({timeout: 15_000});

			// Click each non-default tab + assert it becomes the
			// active one. The tab-active selector is
			// `aria-selected="true"`. Tabs.vue uses the reka-ui
			// pattern where exactly one tab carries that attribute
			// at a time.
			for (const label of [
				'Approved',
				'Hidden/Needs Approval',
				'Reported',
				'All',
			]) {
				await page.getByRole('tab', {name: label, exact: true}).click();
				await expect(
					page.getByRole('tab', {name: label, exact: true}),
				).toHaveAttribute('aria-selected', 'true', {timeout: 10_000});
			}
		},
	);

	test(
		'moderator approves and hides seeded comments; anonymous article page reflects both',
		{tag: '@regression'},
		async ({pkpApi, asUser, browser, baseURL}) => {
			const tag = uniqueTag(test.info(), 'modact');
			const preApprovedText = `Seeded approved comment ${tag}`;
			const needsApprovalText = `Seeded unapproved comment ${tag}`;

			// Scratch journal with public comments on + a published issue
			// for the submission-published fixture to target (same shape
			// as public-comments.spec.js).
			const {context} = await pkpApi.createJournal({
				tag,
				enablePublicComments: true,
				users: [{username: 'dbarnes', roles: ['manager']}],
				issues: [{...SCRATCH_ISSUE, published: true}],
			});

			// Published article carrying both seeded comments: one
			// approved (renders publicly from the start) and one
			// unapproved (the moderation queue item). Seeding via
			// `userComments` writes rows BEFORE the moderation SPA ever
			// mounts — see the file doc-comment for why that matters.
			const spec = submissionPublished({
				tag,
				journal: context.path,
				issue: {...SCRATCH_ISSUE},
			});
			spec.userComments = [
				{user: 'phudson', text: `<p>${preApprovedText}</p>`, approved: true},
				{
					user: 'amccrae',
					text: `<p>${needsApprovalText}</p>`,
					approved: false,
				},
			];
			const {submission} = await pkpApi.createSubmission(spec);
			const articleUrl = `/index.php/${context.path}/article/view/${submission.id}`;

			const modCtx = await asUser('dbarnes');
			const modPage = await modCtx.newPage();
			// Anonymous reader with EXPLICIT empty storage state
			// (patterns.md parallel-load lesson 8).
			const anonCtx = await browser.newContext({
				baseURL,
				storageState: {cookies: [], origins: []},
			});
			try {
				const anonPage = await anonCtx.newPage();
				const commentsSection = anonPage.locator('#public-comments');

				// Baseline anonymous state: the seeded-approved comment
				// renders; the unapproved one must not leak.
				await anonPage.goto(articleUrl);
				await expect(commentsSection).toBeVisible({timeout: 10_000});
				await expect(
					commentsSection.getByText(preApprovedText, {exact: false}),
				).toBeVisible({timeout: 15_000});
				await expect(commentsSection).not.toContainText(needsApprovalText);

				// Moderation page: the unapproved comment sits under
				// Hidden/Needs Approval; the approved one does not.
				await modPage.goto(
					`/index.php/${context.path}/management/settings/userComments`,
				);
				await expect(
					modPage.getByRole('heading', {name: 'Comments', exact: true}),
				).toBeVisible({timeout: 15_000});
				await modPage
					.getByRole('tab', {name: 'Hidden/Needs Approval', exact: true})
					.click();
				const needsApprovalRow = modPage
					.getByRole('row')
					.filter({hasText: needsApprovalText});
				await expect(needsApprovalRow).toBeVisible({timeout: 15_000});
				await expect(
					modPage.getByRole('row').filter({hasText: preApprovedText}),
				).toHaveCount(0);

				// Approve via the detail side modal (More Actions → View
				// Comment → Approve Comment). The store PUTs setApproval,
				// closes the modal, and the onClose handler refetches the
				// table — wait on the PUT, then on the refetched state.
				await needsApprovalRow
					.getByRole('button', {name: 'More Actions'})
					.click();
				await modPage
					.getByRole('menuitem', {name: 'View Comment'})
					.click();
				const modal = modPage.locator('[data-cy="active-modal"]');
				// Anchor on inner modal text, not the wrapper (patterns.md
				// pitfall 5).
				await expect(
					modal.getByText('View comment details by'),
				).toBeVisible({timeout: 15_000});
				// useFetch tunnels PUT through POST + X-Http-Method-Override
				// (lib/ui-library useFetch.js:129-133) — match POST, not PUT.
				const approveResp = modPage.waitForResponse(
					(r) =>
						r.url().includes('/setApproval') &&
						r.request().method() === 'POST',
					{timeout: 20_000},
				);
				await modal
					.getByRole('button', {name: 'Approve Comment', exact: true})
					.click();
				const approveResponse = await approveResp;
				expect(
					approveResponse.ok(),
					`setApproval(true): ${approveResponse.status()}`,
				).toBeTruthy();
				await expect(modal).toHaveCount(0, {timeout: 15_000});
				// Approved comments leave the Hidden/Needs Approval table.
				await expect(
					modPage.getByRole('row').filter({hasText: needsApprovalText}),
				).toHaveCount(0, {timeout: 15_000});

				// Anonymous page now renders both comments.
				await anonPage.reload();
				await expect(commentsSection).toBeVisible({timeout: 10_000});
				await expect(
					commentsSection.getByText(needsApprovalText, {exact: false}),
				).toBeVisible({timeout: 15_000});
				await expect(
					commentsSection.getByText(preApprovedText, {exact: false}),
				).toBeVisible({timeout: 15_000});

				// Hide the originally-approved comment from the Approved
				// tab. Both comments are approved at this point, so the
				// tab lists both; Hide Comment is the enabled action for
				// an approved comment in the detail modal.
				await modPage
					.getByRole('tab', {name: 'Approved', exact: true})
					.click();
				const approvedRow = modPage
					.getByRole('row')
					.filter({hasText: preApprovedText});
				await expect(approvedRow).toBeVisible({timeout: 15_000});
				await approvedRow
					.getByRole('button', {name: 'More Actions'})
					.click();
				await modPage
					.getByRole('menuitem', {name: 'View Comment'})
					.click();
				await expect(
					modal.getByText('View comment details by'),
				).toBeVisible({timeout: 15_000});
				const hideResp = modPage.waitForResponse(
					(r) =>
						r.url().includes('/setApproval') &&
						r.request().method() === 'POST',
					{timeout: 20_000},
				);
				await modal
					.getByRole('button', {name: 'Hide Comment', exact: true})
					.click();
				const hideResponse = await hideResp;
				expect(
					hideResponse.ok(),
					`setApproval(false): ${hideResponse.status()}`,
				).toBeTruthy();
				await expect(modal).toHaveCount(0, {timeout: 15_000});

				// The hidden comment moved between tabs: gone from
				// Approved (which still lists the newly-approved one),
				// present under Hidden/Needs Approval.
				await expect(
					modPage.getByRole('row').filter({hasText: preApprovedText}),
				).toHaveCount(0, {timeout: 15_000});
				await expect(
					modPage.getByRole('row').filter({hasText: needsApprovalText}),
				).toBeVisible({timeout: 15_000});
				await modPage
					.getByRole('tab', {name: 'Hidden/Needs Approval', exact: true})
					.click();
				await expect(
					modPage.getByRole('row').filter({hasText: preApprovedText}),
				).toBeVisible({timeout: 15_000});

				// Anonymous page: the hidden comment is gone; the other
				// one stays visible as the positive control bounding the
				// negative assertion.
				await anonPage.reload();
				await expect(commentsSection).toBeVisible({timeout: 10_000});
				await expect(
					commentsSection.getByText(needsApprovalText, {exact: false}),
				).toBeVisible({timeout: 15_000});
				await expect(commentsSection).not.toContainText(preApprovedText);
			} finally {
				await anonCtx.close();
			}
		},
	);
});

/**
 * Build a tag scoped to this worker + test title so parallel workers
 * don't collide on the shared submissions list. Mirrors the helper
 * in lib/pkp/playwright/tests/public-comments.spec.js.
 *
 * @param {import('@playwright/test').TestInfo} info
 * @param {string} suffix
 */
function uniqueTag(info, suffix) {
	const slug = info.title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.slice(0, 12);
	const rand = Math.random().toString(36).slice(2, 6);
	return `ucm-w${info.parallelIndex}-${suffix}-${slug}-${rand}`;
}
