// @ts-check
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {test, expect} = require('../support/base-test.js');
const {UserProfilePage} = require('../pages/UserProfilePage.js');
const submissionDraft = require('../../../../playwright/fixtures/scenarios/submission-draft.js');
/**
 * API smoke — row #47 in docs/e2e-playwright-migration.md.
 *
 * Cypress sources:
 *   - lib/pkp/cypress/tests/integration/API.cy.js (shared): sets
 *     api_key_secret, tries anonymous /users (expects 401), creates &
 *     deletes a manager's API key via the profile → API Settings tab,
 *     then re-hits /users with the apiToken query param.
 *   - cypress/tests/integration/API.cy.js (OJS): same pattern for an
 *     author (ccorino), asserting /submissions returns exactly one
 *     item (the author's own).
 *
 * Both Cypress specs spend the bulk of their body driving the jQuery
 * profile form to create/delete an apiToken. The capability under
 * test per the roadmap is:
 *   - anonymous authenticated-only endpoints return 401
 *   - an authenticated user can hit the API and get JSON back
 *   - a CSRF token can be pulled from the page for authenticated
 *     writes
 *
 * Rows 1–4 drive this through session auth (dbarnes's baseline
 * storageState); since wave 1 the harness seeds `api_key_secret` into
 * config.test.inc.php (seed-test-config.js), so row 5 covers the
 * apiToken round-trip too — through a THROWAWAY user (never dbarnes:
 * the seeded users are read-only and an enabled key would persist for
 * the whole run). Row 6 covers the role-gate rejection arm.
 *
 * Six tests:
 *   1. CSRF token — authenticated page exposes
 *      `window.pkp.currentUser.csrfToken`. This is the canonical source
 *      for the X-Csrf-Token header every existing Playwright spec
 *      (public-comments, data-availability, doi-crossref) uses. Also
 *      verifies the sibling helper at `/index.php/index/api/v1/_csrf`
 *      is NOT a live endpoint — if it starts returning 200 we want to
 *      know, because `pkpApi.getCsrfToken()` in
 *      lib/pkp/playwright/support/api.js targets it speculatively.
 *   2. Anonymous /submissions — context-scoped submissions endpoint
 *      requires `has.user` middleware, so an anonymous request returns
 *      401 (or 403 if misrouted). Replaces the Cypress `cy.request`
 *      with `failOnStatusCode: false` pattern using Playwright's
 *      APIRequestContext.
 *   3. Authenticated /submissions — dbarnes (publicknowledge editor)
 *      sees a JSON list. dbarnes has no seeded submissions by default
 *      but the response still must be well-formed (items[] +
 *      pagination-like shape). We don't assert a specific item count
 *      because each spec seeds its own submissions and parallel
 *      workers may have left traces.
 *   4. Author-scoped /submissions — atester (the baseline non-editor
 *      author user) lists submissions and the response includes a
 *      seeded submission where atester is the submitter. Mirrors the
 *      OJS-side Cypress source's "author sees exactly one item"
 *      assertion, but with parallel-safe seeding (each worker seeds
 *      its own tagged submission) and a substring assertion on the
 *      title rather than item-count parity.
 *   5. API-key token round-trip — a scratch-journal throwaway user
 *      enables + generates a key via the profile API Key tab (one
 *      action: APIProfileForm::execute sets apiKeyEnabled AND apiKey
 *      together on "Create API Key"); a cookie-less APIRequestContext
 *      authenticates GET /submissions with ?apiToken=…; a
 *      tampered-signature token is rejected 400
 *      (SignatureInvalidException branch) and a validly-signed token
 *      over an unknown key is rejected 401 (the unauthorized branch) —
 *      both per DecodeApiTokenWithValidation.php:100-118.
 *   6. Role-gate rejection — atester (author-only) gets a JSON 401
 *      from the manager-gated /users endpoint while their session
 *      remains good for /submissions (positive control), and an
 *      anonymous request gets 401 from has.user. NOTE: HasRoles.php:70-73
 *      responds HTTP 401 (Response::HTTP_UNAUTHORIZED) for an
 *      authenticated-but-underprivileged user where HTTP semantics
 *      (and the locale key `api.403.unauthorized`!) suggest 403 — the
 *      assertion pins the actual behavior; see the app-changes ledger.
 *
 * Helper note: lib/pkp/playwright/support/api.js ships
 * `pkpApi.getCsrfToken()` pointing at `/index.php/index/api/v1/_csrf`
 * — there is no such route. Test 1 explicitly documents this and the
 * production pattern (read `window.pkp.currentUser.csrfToken`) that
 * every spec already uses. When the helper is revisited, it should
 * either be removed or rewired to navigate + evaluate the global.
 */
test.describe('API smoke', () => {
	test(
		'authenticated page exposes a CSRF token via window.pkp.currentUser',
		{tag: '@regression'},
		async ({asUser}) => {
			const ctx = await asUser('dbarnes');
			const page = await ctx.newPage();
			// The profile page renders for every authenticated user
			// regardless of context-scoped role. It carries the
			// standard PKP template shell, which injects
			// window.pkp.currentUser with csrfToken + id + roles
			// (see PKPTemplateManager::getJavaScriptData).
			await page.goto('/index.php/index/user/profile');
			await expect(page).not.toHaveURL(/\/login/);

			const currentUser = await page.evaluate(
				() => window.pkp?.currentUser,
			);
			expect(currentUser, 'pkp.currentUser injected').toBeTruthy();
			expect(currentUser.username).toBe('dbarnes');
			// CSRF token format: a 32-char hex string (Laravel's
			// random_bytes/Str::random on the session). Allow any
			// non-empty string — the shape guarantee is "present &
			// usable as X-Csrf-Token", not a specific length.
			expect(
				currentUser.csrfToken,
				'csrfToken is a non-empty string',
			).toMatch(/^[A-Za-z0-9]{16,}$/);

			// Negative: the speculative REST endpoint
			// lib/pkp/playwright/support/api.js targets
			// (`pkpApi.getCsrfToken` → /index/api/v1/_csrf) does
			// NOT exist. If the route is ever added (or removed),
			// this probe catches the drift. Today it 404s.
			const probe = await page.request.get(
				'/index.php/index/api/v1/_csrf',
			);
			expect(
				[404, 401, 403],
				`Unexpected /api/v1/_csrf status ${probe.status()} ` +
					'— if this endpoint starts returning 200, revisit ' +
					'lib/pkp/playwright/support/api.js `getCsrfToken`.',
			).toContain(probe.status());
		
		},
	);

	test(
		'anonymous request to /submissions is rejected',
		{tag: '@regression'},
		async ({request}) => {
			// APIRequestContext without storageState — no session cookie.
			// The /submissions endpoint uses has.user middleware which
			// responds 401 for anonymous callers. Accept 401 or 403
			// depending on the middleware chain; the shape the test
			// cares about is "not 200".
			const resp = await request.get(
				'/index.php/publicknowledge/api/v1/submissions',
			);
			expect(resp.status(), 'anonymous submissions must be rejected').toBe(
				401,
			);
			// Response body is JSON with an error message (not an HTML
			// login page).
			const body = await resp.json();
			expect(body).toHaveProperty('error');
		},
	);

	test(
		'authenticated user lists submissions',
		{tag: '@regression'},
		async ({asUser}) => {
			const ctx = await asUser('dbarnes');
			const page = await ctx.newPage();
			// Warm the session by navigating to a context page first
			// — ensures the session cookies are present on the
			// following in-page fetch.
			await page.goto('/index.php/publicknowledge/dashboard/editorial');
			await expect(page).not.toHaveURL(/\/login/);

			// In-page fetch so cookies ride along. PKP's API context
			// route + session cookie auth path is the same
			// middleware flow every authenticated UI click
			// exercises; asserting the endpoint returns a
			// well-formed response body is the "API is reachable"
			// smoke.
			const result = await page.evaluate(async () => {
				const r = await fetch(
					'/index.php/publicknowledge/api/v1/submissions',
					{headers: {Accept: 'application/json'}},
				);
				const j = await r.json();
				return {status: r.status, body: j};
			});
			expect(result.status).toBe(200);
			// The listing endpoint returns {items, itemsMax, ...}.
			// Items may be empty for dbarnes depending on what other
			// tests have seeded — we only assert the shape.
			expect(result.body).toHaveProperty('items');
			expect(Array.isArray(result.body.items)).toBe(true);
			expect(result.body).toHaveProperty('itemsMax');
			expect(typeof result.body.itemsMax).toBe('number');

		},
	);

	test(
		'authenticated author lists their own submissions',
		{tag: '@regression'},
		async ({pkpApi, asUser}) => {
			const tag = `apsmoke-w${test.info().parallelIndex}-${Math.random().toString(36).slice(2, 8)}`;
			const titleEn = `Author smoke ${tag}`;

			// Seed a draft submission with atester (baseline author)
			// as the submitter. submissionDraft's auto-author seeding
			// makes atester both the author of record + a Stage 1
			// participant, so /api/v1/submissions surfaces it for
			// her authenticated session.
			const spec = submissionDraft({tag, submitter: 'atester'});
			spec.publications = spec.publications || [{}];
			spec.publications[0].metadata = {
				...(spec.publications[0].metadata || {}),
				title: {en: titleEn},
			};
			const {submission} = await pkpApi.createSubmission(spec);

			const ctx = await asUser('atester');
			const page = await ctx.newPage();
			await page.goto(
				'/index.php/publicknowledge/dashboard/mySubmissions',
			);
			await expect(page).not.toHaveURL(/\/login/);

			// In-page fetch so the session cookies ride along. Scope by
			// searchPhrase using ONLY the unique tag token: the phrase is
			// space-tokenized and OR-matched (LIKE) against titles, so any
			// common word would match other runs' accumulated submissions,
			// while drafts carry no dateSubmitted (parity with real drafts)
			// and sort last — the seeded row is not guaranteed onto page 1
			// of a loosely-scoped listing.
			const result = await page.evaluate(async (phrase) => {
				const r = await fetch(
					'/index.php/publicknowledge/api/v1/submissions?searchPhrase=' +
						encodeURIComponent(phrase),
					{headers: {Accept: 'application/json'}},
				);
				const j = await r.json();
				return {status: r.status, body: j};
			}, tag);
			expect(result.status).toBe(200);
			expect(Array.isArray(result.body.items)).toBe(true);

			// The seeded submission must surface in atester's listing.
			// Anchor on the submission id rather than title position to
			// avoid race-with-other-tests false matches.
			const ids = result.body.items.map((s) => s.id);
			expect(
				ids.includes(submission.id),
				`atester should see submission id=${submission.id} in /submissions?searchPhrase=${titleEn}; got ids=${JSON.stringify(ids)}`,
			).toBeTruthy();
		},
	);

	test(
		'API-key token authenticates a cookie-less request; bad tokens are rejected',
		{tag: '@regression'},
		async ({pkpApi, asUser, request}) => {
			// Throwaway user in a scratch journal — NEVER a seeded user:
			// the baseline 17 are read-only shared state and an enabled
			// API key would persist for the rest of the run. Password is
			// set to the suite's username-twice derivation so `asUser`
			// (which derives via getPassword) can drive the login.
			const suffix = `w${test.info().parallelIndex}${Math.random().toString(36).slice(2, 8)}`;
			const tag = `apikey-${suffix}`;
			const username = `uapikey${suffix}`;
			const {context} = await pkpApi.createJournal({
				tag,
				name: {en: `API key smoke ${tag}`},
				users: [
					{
						username,
						password: username + username,
						email: `${username}@mailinator.com`,
						givenName: 'Throwaway',
						familyName: `ApiKey ${suffix}`,
						roles: ['author'],
					},
				],
			});

			// Enable + generate the key through the profile UI. One
			// button does both: APIProfileForm::execute() sets
			// apiKeyEnabled=1 AND apiKey=sha1(time()) on the
			// API_KEY_NEW action — there is no separate enable toggle
			// on current main. The displayed value is the JWT signed
			// with config's api_key_secret (seeded since wave 1).
			const ctx = await asUser(username);
			const page = await ctx.newPage();
			const profile = new UserProfilePage(page, context.path);
			await profile.goto('apiSettings');
			await expect(profile.apiKeyField()).toHaveValue('None');
			await profile.submitApiKeyAction('Create API Key');
			const apiToken = await profile.apiKeyField().inputValue();
			expect(apiToken, 'profile shows a JWT after Create API Key').toMatch(
				/^[\w-]+\.[\w-]+\.[\w-]+$/,
			);

			// The `request` fixture carries no cookies in this file (no
			// test.use({user})), so the ONLY credential below is the
			// apiToken query param (DecodeApiTokenWithValidation reads
			// it — see getApiToken, middleware line 155-163).
			const submissionsUrl = `/index.php/${context.path}/api/v1/submissions`;

			// Control: same cookie-less context without a token is 401 —
			// proves the token is what authenticates the next call.
			const anon = await request.get(submissionsUrl);
			expect(anon.status(), 'tokenless request rejected').toBe(401);

			const ok = await request.get(
				`${submissionsUrl}?apiToken=${encodeURIComponent(apiToken)}`,
			);
			expect(ok.status(), 'apiToken-authenticated request succeeds').toBe(
				200,
			);
			const body = await ok.json();
			expect(body).toHaveProperty('items');
			expect(Array.isArray(body.items)).toBe(true);
			expect(body).toHaveProperty('itemsMax');

			// Tampered token: flip a character in the middle of the
			// signature segment. firebase/php-jwt raises
			// SignatureInvalidException, which the middleware maps to
			// HTTP 400 + api.400.invalidApiToken
			// (DecodeApiTokenWithValidation.php:108-112). The plan row
			// presumed 401 — 400 is the actual contract.
			const tampered = tamperJwtSignature(apiToken);
			const bad = await request.get(
				`${submissionsUrl}?apiToken=${encodeURIComponent(tampered)}`,
			);
			expect(bad.status(), 'tampered-signature token rejected').toBe(400);
			expect(await bad.json()).toHaveProperty('error');

			// Forged token: validly signed with the known test secret
			// but over an api key no user owns — exercises the 401
			// unauthorized branch (middleware line 100-105: user lookup
			// by key fails). This is the closest realizable shape of the
			// plan row's "tampered token returns 401".
			const forged = signHs256(
				['0'.repeat(40)], // sha1-shaped key that belongs to nobody
				readTestApiKeySecret(),
			);
			const unknown = await request.get(
				`${submissionsUrl}?apiToken=${encodeURIComponent(forged)}`,
			);
			expect(
				unknown.status(),
				'validly-signed token over an unknown key rejected',
			).toBe(401);
			expect(await unknown.json()).toHaveProperty('error');
		},
	);

	test(
		'role-gated endpoint rejects insufficient roles',
		{tag: '@regression'},
		async ({asUser, request}) => {
			// atester is the only seeded author-without-editor-roles —
			// the meaningful subject for a role-gate rejection.
			const ctx = await asUser('atester');
			const page = await ctx.newPage();
			await page.goto('/index.php/publicknowledge/dashboard/mySubmissions');
			await expect(page).not.toHaveURL(/\/login/);

			// In-page fetches so the session cookies ride along. /users
			// is gated to admin/manager/sub-editor
			// (PKPUserController::getRouteGroupMiddleware); /submissions
			// allows authors and acts as the positive control proving
			// the session itself is live — i.e. the rejection below is
			// the ROLE gate, not an expired login.
			const probes = await page.evaluate(async () => {
				const get = async (url) => {
					const r = await fetch(url, {
						headers: {Accept: 'application/json'},
					});
					let body = null;
					try {
						body = await r.json();
					} catch {
						// keep null — content-type assertion below will fail loudly
					}
					return {status: r.status, body};
				};
				return {
					users: await get('/index.php/publicknowledge/api/v1/users'),
					submissions: await get(
						'/index.php/publicknowledge/api/v1/submissions',
					),
				};
			});

			expect(
				probes.submissions.status,
				'positive control: author session lists submissions',
			).toBe(200);

			// HasRoles.php:70-73 responds Response::HTTP_UNAUTHORIZED
			// (401) — not the semantically-expected 403 — for an
			// authenticated user lacking the required roles. The locale
			// key is even named `api.403.unauthorized`. Pin the actual
			// behavior; flagged in the app-changes ledger.
			expect(
				probes.users.status,
				'author-only session rejected from /users',
			).toBe(401);
			expect(probes.users.body).toHaveProperty('error');

			// Anonymous arm: no session at all is turned away by
			// has.user (HasUser.php:38-40) with the same JSON error
			// shape.
			const anon = await request.get(
				'/index.php/publicknowledge/api/v1/users',
			);
			expect(anon.status(), 'anonymous request rejected').toBe(401);
			expect(await anon.json()).toHaveProperty('error');
		},
	);
});

/**
 * Flip one character in the middle of a JWT's signature segment so the
 * HMAC no longer verifies. Middle, not last: base64url's final char
 * only contributes 2-4 bits, so flipping it can decode to identical
 * signature bytes and sail through verification.
 *
 * @param {string} jwt
 * @returns {string}
 */
function tamperJwtSignature(jwt) {
	const parts = jwt.split('.');
	const sig = parts[2];
	const i = Math.floor(sig.length / 2);
	const flipped = sig[i] === 'A' ? 'B' : 'A';
	parts[2] = sig.slice(0, i) + flipped + sig.slice(i + 1);
	return parts.join('.');
}

/**
 * Minimal HS256 JWT signer (header.payload.signature, base64url) — just
 * enough to forge a validly-signed token without pulling in a JWT
 * dependency. Mirrors what APIProfileForm::fetch produces via
 * firebase/php-jwt's JWT::encode([$apiKey], $secret, 'HS256').
 *
 * @param {unknown} payload JSON-serializable payload
 * @param {string} secret
 * @returns {string}
 */
function signHs256(payload, secret) {
	const b64url = (/** @type {Buffer|string} */ input) =>
		Buffer.from(input)
			.toString('base64')
			.replace(/=+$/, '')
			.replace(/\+/g, '-')
			.replace(/\//g, '_');
	const header = b64url(JSON.stringify({typ: 'JWT', alg: 'HS256'}));
	const body = b64url(JSON.stringify(payload));
	const signature = crypto
		.createHmac('sha256', secret)
		.update(`${header}.${body}`)
		.digest('base64')
		.replace(/=+$/, '')
		.replace(/\+/g, '-')
		.replace(/\//g, '_');
	return `${header}.${body}.${signature}`;
}

/**
 * Read the api_key_secret the harness seeded into config.test.inc.php
 * (lib/pkp/playwright/scripts/seed-test-config.js) — reading it from
 * disk keeps the forged-token arm in lockstep with whatever the server
 * actually verifies against.
 *
 * @returns {string}
 */
function readTestApiKeySecret() {
	const configPath = path.resolve(
		__dirname,
		'..',
		'..',
		'..',
		'..',
		'config.test.inc.php',
	);
	const config = fs.readFileSync(configPath, 'utf8');
	const match = config.match(/^api_key_secret = "([^"]+)"$/m);
	if (!match) {
		throw new Error(
			`api_key_secret not found in ${configPath} — the wave-1 ` +
				'seed-test-config substitution is missing; API-key tokens ' +
				'cannot be signed/verified.',
		);
	}
	return match[1];
}
