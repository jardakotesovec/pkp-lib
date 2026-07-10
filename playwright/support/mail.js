// @ts-check

/**
 * Wraps Mailpit's HTTP API for tests that assert on emails sent during
 * normal app requests. Scenario-seeding emails are discarded by the
 * scenario controllers' Mail::fake(); only test-action mail (decisions
 * submitted via UI, password resets, invitations, etc.) reaches Mailpit.
 *
 * Tests opt in by destructuring `pkpMail` from the test fixture.
 * Mailpit is SHARED across parallel workers (charter principle 8,
 * docs/e2e/PRINCIPLES.md) — always scope reads by recipient + the
 * test's unique tag. `find` / `expectNone` are the canonical helpers:
 *
 *   test('something', async ({page, pkpMail}) => {
 *     // ...UI action that sends mail tagged with the scenario tag...
 *     const [message] = await pkpMail.find({
 *       to: 'editor.diana@mailinator.com',
 *       contains: tag,
 *     });
 *     expect(message.Subject).toContain('Password Reset');
 *   });
 *
 * Mailpit's API conventions (verified live against v1.29.7):
 *  - GET    /api/v1/messages?query=<search>  → {messages: [{ID, From, To, Subject, Created, Snippet}, ...]}
 *  - GET    /api/v1/search?query=<search>    → same shape (canonical search endpoint)
 *  - DELETE /api/v1/messages                 → 200 on success
 *  - GET    /api/v1/message/:id              → full message body (HTML/Text/Headers)
 * Search-query syntax uses prefixes like `to:`, `from:`, `subject:`;
 * bare (optionally quoted) terms match across subject + body content.
 */
exports.createMailClient = function ({mailpitUrl, request}) {
	const base = mailpitUrl ?? process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';

	/**
	 * Single-shot Mailpit search; returns the (possibly empty) message
	 * list, newest first. Internal building block for `find` /
	 * `expectNone`.
	 *
	 * @param {string} query  Mailpit search-syntax query
	 * @returns {Promise<Array<object>>}
	 */
	async function searchOnce(query) {
		const res = await request.get(
			`${base}/api/v1/search?query=${encodeURIComponent(query)}`,
		);
		if (!res.ok()) {
			throw new Error(
				`Mailpit search failed: ${res.status()} ${await res.text()}`,
			);
		}
		const body = await res.json();
		return body.messages ?? [];
	}

	return {
		/**
		 * Delete every message in Mailpit's inbox.
		 *
		 * **Permitted ONLY in the dedicated serial test-infrastructure
		 * spec** (charter principle 8, docs/e2e/PRINCIPLES.md) — never in
		 * parallel specs.
		 *
		 * **Race warning** — Mailpit is shared across parallel workers.
		 * Calling `clearAll()` while another worker is mid-flow can wipe
		 * mail it just sent. Use `find()` / `expectNone()` (scoped by
		 * recipient + unique tag) or `deleteForRecipient(email)` instead.
		 */
		async clearAll() {
			const res = await request.delete(`${base}/api/v1/messages`);
			if (!res.ok()) {
				throw new Error(
					`Mailpit clearAll failed: ${res.status()} ${await res.text()}`,
				);
			}
		},

		/**
		 * Delete every message addressed to `email` (matches To, Cc, and
		 * Bcc — same semantics Mailpit's `to:` search uses). Safe under
		 * parallel-worker load: workers operating on disjoint recipients
		 * don't race.
		 */
		async deleteForRecipient(email) {
			const res = await request.delete(
				`${base}/api/v1/search?query=${encodeURIComponent('to:' + email)}`,
			);
			if (!res.ok()) {
				throw new Error(
					`Mailpit deleteForRecipient failed: ${res.status()} ${await res.text()}`,
				);
			}
		},

		/**
		 * Poll Mailpit until at least one message addressed to `email`
		 * appears, then return the message list (Mailpit returns newest
		 * first). Throws if no message arrives within `timeout` ms.
		 *
		 * Each entry has Mailpit's PascalCase shape: {ID, From, To,
		 * Subject, Created, Snippet, ...}. Use `fullMessage(id)` for the
		 * complete body.
		 */
		async inboxFor(email, {timeout = 10_000, poll = 250} = {}) {
			const deadline = Date.now() + timeout;
			let lastStatus = null;
			let lastBodyPreview = null;
			while (Date.now() < deadline) {
				// /api/v1/search is the only endpoint that FILTERS by the
				// query — /api/v1/messages?query=… silently ignores it and
				// returns the global newest-first list (verified live,
				// Mailpit 1.29.7). The unscoped form once handed a parallel
				// agent ANOTHER agent's invitation mail, whose decline link
				// it then followed (wave 9).
				const res = await request.get(
					`${base}/api/v1/search?query=${encodeURIComponent('to:' + email)}`,
				);
				if (!res.ok()) {
					throw new Error(
						`Mailpit query failed: ${res.status()} ${await res.text()}`,
					);
				}
				const body = await res.json();
				lastStatus = `total=${body.messages_count ?? body.total ?? 0}`;
				// Capture a body slice so an unexpected response shape
				// (Mailpit version drift; field rename) is recognisable
				// from the timeout error rather than masquerading as
				// "0 messages".
				lastBodyPreview = JSON.stringify(body).slice(0, 200);
				if (body.messages && body.messages.length > 0) {
					return body.messages;
				}
				await new Promise((r) => setTimeout(r, poll));
			}
			throw new Error(
				`No mail for ${email} within ${timeout}ms ` +
					`(last poll: ${lastStatus}; body: ${lastBodyPreview})`,
			);
		},

		/**
		 * Convenience: return the most recent message addressed to `email`,
		 * or throw if none arrives within the timeout.
		 */
		async latestTo(email, opts) {
			const messages = await this.inboxFor(email, opts);
			return messages[0];
		},

		/**
		 * Scoped positive query — the canonical principle-8 read. Polls
		 * Mailpit's search API until at least one message addressed to
		 * `to` whose content (subject + body) contains the `contains`
		 * marker (the test's unique tag) appears, then returns the
		 * matching messages, newest first. Safe under parallel-worker
		 * load: scoping by recipient + unique marker means other
		 * workers' mail never matches.
		 *
		 * @param {object} opts
		 * @param {string} opts.to        recipient (matches To/Cc/Bcc)
		 * @param {string} opts.contains  unique content marker, e.g. the scenario tag
		 * @param {string=} opts.subject  optional additional subject filter
		 * @param {number=} opts.timeoutMs  give-up deadline (default 10s)
		 * @param {number=} opts.poll       poll interval ms (default 250)
		 * @returns {Promise<Array<object>>} matching messages in Mailpit's
		 *   PascalCase shape: {ID, From, To, Subject, Created, Snippet, ...}.
		 *   Use `fullMessage(id)` for the complete body.
		 */
		async find({to, contains, subject, timeoutMs = 10_000, poll = 250}) {
			if (!to || !contains) {
				throw new Error(
					'pkpMail.find requires both `to` and `contains` — unscoped ' +
						'queries race against parallel workers (principle 8).',
				);
			}
			const query = buildScopedQuery({to, contains, subject});
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const messages = await searchOnce(query);
				if (messages.length > 0) {
					return messages;
				}
				await new Promise((r) => setTimeout(r, poll));
			}
			// Distinguish "no mail at all for this recipient" from "mail
			// arrived but the marker didn't match" in the failure message.
			const forRecipient = await searchOnce(buildScopedQuery({to}));
			throw new Error(
				`No mail matching ${JSON.stringify(query)} within ${timeoutMs}ms ` +
					`(${forRecipient.length} message(s) total for ${to})`,
			);
		},

		/**
		 * Scoped negative assertion — principle 8's required shape for
		 * "no email sent". First waits for a positive control message
		 * (`afterControl`) that the test triggered AFTER the action that
		 * must not send mail; its arrival bounds the wait (mail delivery
		 * is ordered enough that once the later control is in Mailpit,
		 * the earlier negative target would be too). Then asserts zero
		 * messages match the negative target and throws otherwise.
		 *
		 * @param {object} opts
		 * @param {string} opts.to        recipient the mail must NOT have gone to
		 * @param {string=} opts.contains optional content marker narrowing the negative target
		 * @param {{to: string, contains: string}} opts.afterControl
		 *   positive control message to wait for before asserting
		 * @param {number=} opts.timeoutMs  deadline for the control message (default 10s)
		 * @returns {Promise<void>}
		 */
		async expectNone({to, contains, afterControl, timeoutMs = 10_000}) {
			if (!to) {
				throw new Error('pkpMail.expectNone requires `to`.');
			}
			if (!afterControl?.to || !afterControl?.contains) {
				throw new Error(
					'pkpMail.expectNone requires afterControl {to, contains} — a ' +
						'negative assertion without a positive control message is ' +
						'an unbounded wait (principle 8).',
				);
			}
			await this.find({
				to: afterControl.to,
				contains: afterControl.contains,
				timeoutMs,
			});
			const query = buildScopedQuery({to, contains});
			const matches = await searchOnce(query);
			if (matches.length > 0) {
				const subjects = matches.map((m) => m.Subject).join('; ');
				throw new Error(
					`Expected no mail matching ${JSON.stringify(query)} but found ` +
						`${matches.length}: ${subjects}`,
				);
			}
		},

		/**
		 * Total number of messages currently in Mailpit (any recipient,
		 * any subject). Useful for leak-detection assertions — e.g.
		 * confirming `Mail::fake()` in scenario controllers really
		 * suppresses every seeding email.
		 */
		async messageCount() {
			const res = await request.get(`${base}/api/v1/messages`);
			if (!res.ok()) {
				throw new Error(
					`Mailpit count query failed: ${res.status()} ${await res.text()}`,
				);
			}
			const body = await res.json();
			return body.messages_count ?? body.total ?? 0;
		},

		/**
		 * Fetch the full body of a single message by Mailpit ID. Returned
		 * shape includes HTML, Text, Headers — mirror Mailpit's API.
		 */
		async fullMessage(id) {
			const res = await request.get(`${base}/api/v1/message/${id}`);
			if (!res.ok()) {
				throw new Error(
					`Mailpit fetch ${id} failed: ${res.status()} ${await res.text()}`,
				);
			}
			return res.json();
		},

		/**
		 * Pull the first <a href="..."> matching `linkText` out of an HTML
		 * body. Used for click-the-link flows (password reset, invitation
		 * accept, etc.).
		 */
		extractLink(html, linkText) {
			const re = new RegExp(
				`<a[^>]+href="([^"]+)"[^>]*>[^<]*${escapeRegex(linkText)}[^<]*</a>`,
				'i',
			);
			const match = html.match(re);
			if (!match) {
				throw new Error(`Link "${linkText}" not found in mail body`);
			}
			return match[1];
		},
	};
};

function escapeRegex(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a Mailpit search query scoped by recipient, with optional
 * subject filter and free-text content marker. All terms AND together
 * in Mailpit's search syntax.
 *
 * @param {{to: string, contains?: string, subject?: string}} opts
 * @returns {string}
 */
function buildScopedQuery({to, contains, subject}) {
	const parts = [`to:${quoteSearchTerm(to)}`];
	if (subject) {
		parts.push(`subject:${quoteSearchTerm(subject)}`);
	}
	if (contains) {
		parts.push(quoteSearchTerm(contains));
	}
	return parts.join(' ');
}

/**
 * Quote a Mailpit search term when it contains whitespace so it
 * matches as a phrase. Mailpit's syntax has no quote-escaping, so
 * embedded double quotes are stripped (they can't appear in the
 * tags/addresses tests use anyway).
 *
 * @param {string} term
 * @returns {string}
 */
function quoteSearchTerm(term) {
	const cleaned = String(term).replace(/"/g, '');
	return /\s/.test(cleaned) ? `"${cleaned}"` : cleaned;
}
