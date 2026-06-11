// @ts-check

/**
 * Cold-boot seed for config.test.inc.php. Replaces the historical
 * lib/pkp/playwright/seed-test-config.sh — same behaviour, written in
 * Node so Windows users don't need a POSIX shell (Git Bash) to run
 * the Playwright suite.
 *
 * Behaviour (mirrors the .sh exactly):
 *   1. Idempotent: returns early if config.test.inc.php already exists.
 *      (Corollary: after adding a new substitution below, delete the
 *      existing config.test.inc.php once so it gets re-seeded.)
 *   2. Copy config.TEMPLATE.inc.php → config.test.inc.php.
 *   3. Apply line-anchored substitutions: 4 to point [email] at Mailpit
 *      (127.0.0.1:1025) so the pkpMail fixture sees test-action mail,
 *      plus 1 setting api_key_secret to a fixed test-only value — the
 *      template ships it empty, and without it API-key Bearer tokens
 *      can't be signed/verified.
 *   4. Verify each substitution actually landed; abort loudly if any
 *      didn't (config.TEMPLATE.inc.php drifted) so the failure is
 *      "webServer didn't start" instead of "Mailpit asserts time out
 *      10 minutes later".
 *
 * Concurrency: the Playwright webServer array spawns one PHP server
 * per worker. Each invokes start-php-server.js, which calls this
 * function. The fast-path existsSync check short-circuits in the
 * common case (file already exists). When it doesn't, the actual
 * write uses the `wx` open flag — atomic create-or-fail (O_EXCL on
 * POSIX). If two processes both pass the existsSync gate
 * simultaneously, the loser gets EEXIST when its write hits the
 * filesystem; we catch that and treat it the same as the
 * already-exists case (no error, file content is deterministic
 * because both processes derive it from the same template + same
 * substitutions).
 */

const fs = require('fs');

const TARGET = 'config.test.inc.php';
const TEMPLATE = 'config.TEMPLATE.inc.php';

const SUBSTITUTIONS = [
	{from: /^default = sendmail$/m, to: 'default = smtp'},
	{from: /^; smtp = On$/m, to: 'smtp = On'},
	{from: /^; smtp_server = mail\.example\.com$/m, to: 'smtp_server = 127.0.0.1'},
	{from: /^; smtp_port = 25$/m, to: 'smtp_port = 1025'},
	// Test-only signing secret for API-key Bearer tokens. NOT a secret —
	// it only ever signs keys for the disposable Playwright database.
	{
		from: /^api_key_secret = ""$/m,
		to: 'api_key_secret = "playwright-api-key-secret-not-a-secret"',
	},
];

const REQUIRED_PATTERNS_AFTER = [
	/^default = smtp$/m,
	/^smtp = On$/m,
	/^smtp_server = 127\.0\.0\.1$/m,
	/^smtp_port = 1025$/m,
	/^api_key_secret = "playwright-api-key-secret-not-a-secret"$/m,
];

function seedTestConfig() {
	if (fs.existsSync(TARGET)) {
		return;
	}

	let content = fs.readFileSync(TEMPLATE, 'utf8');
	for (const {from, to} of SUBSTITUTIONS) {
		content = content.replace(from, to);
	}

	for (const pattern of REQUIRED_PATTERNS_AFTER) {
		if (!pattern.test(content)) {
			console.error(
				`ERROR: ${TARGET} seed failed — pattern ${pattern} not found.`,
			);
			console.error(
				`${TEMPLATE} may have drifted; update`
				+ ' lib/pkp/playwright/scripts/seed-test-config.js.',
			);
			process.exit(1);
		}
	}

	// `wx` flag = open(O_WRONLY|O_CREAT|O_EXCL) — fail if the file
	// already exists. If we lose the race against a concurrent
	// invocation, EEXIST means the other process beat us; the file
	// content is deterministic so we treat that as success.
	try {
		fs.writeFileSync(TARGET, content, {flag: 'wx'});
	} catch (err) {
		if (err && err.code === 'EEXIST') {
			return;
		}
		throw err;
	}
}

module.exports = {seedTestConfig};

if (require.main === module) {
	seedTestConfig();
}
