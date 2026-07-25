#!/usr/bin/env node
// @ts-check

/**
 * Cross-platform launcher for one PHP dev server. Invoked by the
 * webServer array in lib/pkp/playwright/config-factory.js — one
 * `node start-php-server.js <port>` per Playwright worker.
 *
 * Replaces the historical shell command
 *   `sh seed-test-config.sh && mkdir -p temp/per-port-logs && exec php -S … >>file 2>&1`
 * which depended on a POSIX shell (Git Bash on Windows). Doing the
 * same work in Node lets Windows users run the Playwright suite
 * with a stock PHP install — no shell required.
 *
 * Responsibilities:
 *   1. Seed config.test.inc.php (idempotent — see ./seed-test-config.js).
 *   2. Ensure temp/per-port-logs exists.
 *   3. spawn `php -S 127.0.0.1:<port>` with stdout/stderr piped into
 *      temp/per-port-logs/<port>.log.
 *   4. Forward SIGINT / SIGTERM to PHP so Playwright's webServer
 *      teardown actually stops the dev server.
 *
 * Working directory: the caller (Playwright) sets cwd to appRoot,
 * so all relative paths below resolve from the OJS install root.
 */

const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');
const {seedTestConfig} = require('./seed-test-config.js');

// Load the app's .env.playwright into process.env so a standalone
// `npm run test:e2e:serve` produces a server with the SAME environment
// Playwright's webServer gives it. Under Playwright this is a no-op —
// config-factory.js has already called dotenv, and dotenv never
// overwrites variables that are already set.
//
// This matters most for TEST_API_KEY: PKP\middleware\TestModeGate 404s
// every /api/v1/_test/* route when the server process can't see it, so
// a hand-started server would silently have no scenario API.
try {
	require('dotenv').config({
		path: path.join(process.cwd(), '.env.playwright'),
	});
} catch {
	// dotenv is a devDependency; if it isn't installed, fall back to
	// whatever the caller exported. Nothing here is required for a
	// plain page-serving run.
}

const port = parseInt(process.argv[2] ?? '', 10);
if (!Number.isFinite(port) || port <= 0 || port > 65535) {
	console.error(`Usage: node start-php-server.js <port>`);
	process.exit(1);
}

seedTestConfig();

const logDir = path.resolve('temp', 'per-port-logs');
fs.mkdirSync(logDir, {recursive: true});
const logPath = path.join(logDir, `${port}.log`);
// 'a' = append, matches the historical `>>file 2>&1` redirect. Each
// PHP server writes to its own port-suffixed file; PHP's per-line
// `[timestamp]` prefix keeps interleaved log readable.
const logFd = fs.openSync(logPath, 'a');

const phpArgs = [
	'-d', 'log_errors=On',
	'-d', `error_log=${logPath}`,
	'-d', 'display_errors=Off',
	'-d', 'memory_limit=512M',
	'-S', `127.0.0.1:${port}`,
	'-t', '.',
];

const phpProc = spawn('php', phpArgs, {
	stdio: ['ignore', logFd, logFd],
	env: {
		...process.env,
		APPLICATION_ENV: 'test',
		// Offline resolution for remotely-hosted DTDs: the test config
		// firewalls all server-side egress (dead [proxy], which PKP also
		// wires into libxml's stream context), so filters that validate
		// against remote DTDs (PubMed export) resolve them from the
		// committed mirror via libxml2's XML-catalog support instead.
		XML_CATALOG_FILES: path.resolve(
			__dirname,
			'..',
			'fixtures',
			'dtd',
			'catalog.xml',
		),
	},
});

phpProc.on('error', (err) => {
	console.error(`Failed to spawn php for port ${port}: ${err.message}`);
	process.exit(1);
});

const forward = (signal) => {
	if (phpProc.pid && !phpProc.killed) {
		phpProc.kill(signal);
	}
};
process.on('SIGINT', () => forward('SIGINT'));
process.on('SIGTERM', () => forward('SIGTERM'));
process.on('SIGHUP', () => forward('SIGHUP'));

phpProc.on('exit', (code, signal) => {
	try {
		fs.closeSync(logFd);
	} catch {
		// best-effort
	}
	process.exit(code !== null ? code : 1);
});
