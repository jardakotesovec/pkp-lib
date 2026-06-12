// @ts-check
const {test, expect} = require('../support/base-test.js');
const {setTinyMceContent} = require('../support/tinymce.js');

/**
 * Public pages — docs/e2e/plans/public-pages.md (all 4 rows).
 *
 * Anonymous reader coverage of the about-section pages
 * (lib/pkp/pages/about/) and the settings surfaces that feed them:
 *
 *   1. (row 1) /about/contact on a scratch journal seeded with the
 *      journal scenario's `contact: {name, email}` passthrough —
 *      ContextBuilderProcessor mirrors it into supportName/supportEmail,
 *      so both the principal and the support contact blocks render the
 *      seeded values.
 *   2. (row 2) /about renders the "About the Journal" rich text saved
 *      via Settings → Journal → Masthead (FieldRichTextarea `about` on
 *      PKPMastheadForm).
 *   3. (row 3) /about/contact on bootstrap publicknowledge (read-only):
 *      the seeded principal contact (Ramiro Vaca + email) renders.
 *   4. (row 4) /about/privacy renders the statement configured via
 *      Website → Setup → Privacy; with NO statement the page is not
 *      served (404 from AboutSiteHandler::privacy). Plan-premise
 *      correction: new contexts are BORN with a default statement
 *      (lib/pkp/schemas/context.json privacyStatement defaultLocaleKey),
 *      so the 404 branch is exercised by clearing the field, not by
 *      reading a virgin journal.
 *
 * The contact email assertions need a real page (Smarty's
 * `{mailto encode='javascript'}` document.writes the link), which is
 * why rows 1/3 drive a browser context rather than request.get.
 */
test.describe('Public pages', () => {
	test(
		'contact page renders scenario-seeded principal and support contact on a scratch journal',
		async ({pkpApi, browser, baseURL}) => {
			const tag = scratchTag('ppc');
			const contactName = `Contact Person ${tag}`;
			const contactEmail = `contact-${tag}@example.com`;
			const {context} = await pkpApi.createJournal({
				tag,
				name: {en: `Public pages contact ${tag}`},
				contact: {name: contactName, email: contactEmail},
			});

			const anon = await anonContext(browser, baseURL);
			try {
				const page = await anon.newPage();
				const resp = await page.goto(
					`/index.php/${context.path}/about/contact`,
				);
				expect(resp?.status()).toBe(200);
				await expect(page.locator('h1').first()).toContainText(
					/Contact/i,
				);

				// Principal contact block (frontend/pages/contact.tpl
				// `.contact.primary`): seeded name + mailto link whose
				// visible text is the address.
				const primary = page.locator('.contact.primary');
				await expect(primary.locator('h2')).toContainText(
					/Principal Contact/i,
				);
				await expect(primary.locator('.name')).toContainText(
					contactName,
				);
				await expect(
					primary.getByRole('link', {name: contactEmail}),
				).toBeVisible();

				// Support contact block mirrors the same values —
				// ContextBuilderProcessor copies contact.name/email into
				// supportName/supportEmail (ContextBuilderProcessor.php:70-73).
				const support = page.locator('.contact.support');
				await expect(support.locator('h2')).toContainText(
					/Support Contact/i,
				);
				await expect(support.locator('.name')).toContainText(
					contactName,
				);
				await expect(
					support.getByRole('link', {name: contactEmail}),
				).toBeVisible();
			} finally {
				await anon.close();
			}
		},
	);

	test(
		'about-the-journal page displays the About text configured on the masthead form',
		async ({pkpApi, asUser, browser, baseURL}) => {
			// The masthead form requires name + acronym + country; the
			// scenario seeds name and country but acronym must come from
			// the spec or the PUT fails validation.
			const tag = scratchTag('ppa');
			const {context} = await pkpApi.createJournal({
				tag,
				name: {en: `Public pages about ${tag}`},
				acronym: {en: 'PPA8'},
				users: [{username: 'dbarnes', roles: ['manager']}],
			});

			const ctx = await asUser('dbarnes');
			const page = await ctx.newPage();
			await page.goto(
				`/index.php/${context.path}/management/settings/context`,
			);

			// Masthead is the first (default-active) tab on the journal
			// settings page; its pkp-form renders inside the #masthead
			// tab panel.
			const mastheadForm = page.locator('#masthead form').first();
			await expect(mastheadForm).toBeVisible({timeout: 15_000});

			const aboutText = `All about this journal ${tag}`;
			await setTinyMceContent(
				page,
				'masthead-about-control-en',
				`<p>${aboutText}</p>`,
				{timeout: 15_000},
			);
			await Promise.all([
				page.waitForResponse(
					(res) =>
						/\/api\/v1\/contexts\/\d+/.test(res.url()) &&
						res.ok() &&
						['POST', 'PUT'].includes(res.request().method()),
					{timeout: 15_000},
				),
				mastheadForm
					.getByRole('button', {name: 'Save', exact: true})
					.click(),
			]);

			// --- Anonymous /about renders the heading and the saved text
			// (frontend/pages/about.tpl prints getLocalizedData('about')).
			const anon = await anonContext(browser, baseURL);
			try {
				const reader = await anon.newPage();
				const resp = await reader.goto(
					`/index.php/${context.path}/about`,
				);
				expect(resp?.status()).toBe(200);
				await expect(reader.locator('h1').first()).toContainText(
					/About the Journal/i,
				);
				await expect(reader.locator('.page_about')).toContainText(
					aboutText,
				);
			} finally {
				await anon.close();
			}
		},
	);

	test(
		'contact page shows the bootstrap journal contact details',
		async ({browser, baseURL}) => {
			// Row 3 — bootstrap publicknowledge, read-only. Complements
			// row 1: same handler/template, but reading the long-lived
			// shared journal (contact seeded in
			// playwright/fixtures/bootstrap.js) instead of a scratch one.
			const anon = await anonContext(browser, baseURL);
			try {
				const page = await anon.newPage();
				const resp = await page.goto(
					'/index.php/publicknowledge/about/contact',
				);
				expect(resp?.status()).toBe(200);
				await expect(page.locator('h1').first()).toContainText(
					/Contact/i,
				);

				const primary = page.locator('.contact.primary');
				await expect(primary.locator('.name')).toContainText(
					'Ramiro Vaca',
				);
				await expect(
					primary.getByRole('link', {name: 'rvaca@mailinator.com'}),
				).toBeVisible();
			} finally {
				await anon.close();
			}
		},
	);

	test(
		'privacy statement page renders the configured statement and 404s when none is set',
		async ({pkpApi, asUser, browser, baseURL}) => {
			const tag = scratchTag('ppp');
			const {context} = await pkpApi.createJournal({
				tag,
				name: {en: `Public pages privacy ${tag}`},
				users: [{username: 'dbarnes', roles: ['manager']}],
			});

			// --- Configure a custom statement on Website → Setup →
			// Privacy (PKPPrivacyForm, FieldRichTextarea privacyStatement).
			const ctx = await asUser('dbarnes');
			const page = await ctx.newPage();
			await page.goto(
				`/index.php/${context.path}/management/settings/website`,
			);
			await page.locator('#setup-button').click();
			await page.locator('#privacy-button').click();
			const privacyForm = page.locator('#privacy form').first();
			await expect(privacyForm).toBeVisible({timeout: 15_000});

			const statement = `We only collect what we must ${tag}`;
			await setTinyMceContent(
				page,
				'privacy-privacyStatement-control-en',
				`<p>${statement}</p>`,
				{timeout: 15_000},
			);
			await Promise.all([
				page.waitForResponse(
					(res) =>
						/\/api\/v1\/contexts\/\d+/.test(res.url()) &&
						res.ok() &&
						['POST', 'PUT'].includes(res.request().method()),
					{timeout: 15_000},
				),
				privacyForm
					.getByRole('button', {name: 'Save', exact: true})
					.click(),
			]);

			// --- Anonymous page renders the saved statement.
			const anon = await anonContext(browser, baseURL);
			try {
				const reader = await anon.newPage();
				const resp = await reader.goto(
					`/index.php/${context.path}/about/privacy`,
				);
				expect(resp?.status()).toBe(200);
				await expect(reader.locator('h1').first()).toContainText(
					/Privacy Statement/i,
				);
				await expect(
					reader.locator('.page_privacy'),
				).toContainText(statement);
			} finally {
				await anon.close();
			}

			// --- Clear the statement: with no statement the page is not
			// served (AboutSiteHandler::privacy throws
			// NotFoundHttpException → 404). New contexts ship a DEFAULT
			// statement (context.json defaultLocaleKey), so clearing is
			// how the unset state is reached.
			await setTinyMceContent(
				page,
				'privacy-privacyStatement-control-en',
				'',
				{timeout: 15_000},
			);
			await Promise.all([
				page.waitForResponse(
					(res) =>
						/\/api\/v1\/contexts\/\d+/.test(res.url()) &&
						res.ok() &&
						['POST', 'PUT'].includes(res.request().method()),
					{timeout: 15_000},
				),
				privacyForm
					.getByRole('button', {name: 'Save', exact: true})
					.click(),
			]);

			const anon404 = await anonContext(browser, baseURL);
			try {
				const reader = await anon404.newPage();
				const resp = await reader.goto(
					`/index.php/${context.path}/about/privacy`,
				);
				expect(resp?.status()).toBe(404);
			} finally {
				await anon404.close();
			}
		},
	);
});

/**
 * Short worker-scoped tag with a random suffix for scratch-journal
 * tests. The journal scenario derives the journal path as
 * `j-<alnum(tag)>` (PKPContextScenarioController.php:83-86) and
 * journals.path is varchar(32), so tags stay short; the random suffix
 * keeps re-runs against a long-lived DB from colliding on the path.
 * Mirrors announcements.spec.js.
 *
 * @param {string} prefix
 */
function scratchTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

/**
 * Fresh anonymous browser context. The explicit empty storageState
 * guards against inheriting a logged-in session if this file ever
 * gains a `test.use({user})` (patterns.md rule 8).
 *
 * @param {import('@playwright/test').Browser} browser
 * @param {string} [baseURL]
 */
async function anonContext(browser, baseURL) {
	return browser.newContext({
		baseURL,
		storageState: {cookies: [], origins: []},
	});
}
