// @ts-check

/**
 * Shared baseline users — single source of truth for Playwright test
 * credentials. Role-keyed roster (maintainer decision 2026-07-10): usernames
 * take the `role.firstname` form, display names read "Firstname Role"
 * (givenName = firstname, familyName = role in CamelCase) so UI screenshots
 * say the role, and emails match usernames. One account per permission
 * archetype; all first names are unique across the roster.
 *
 * Passwords derive from the username (see getPassword):
 *   admin          → 'admin'
 *   everyone else  → username + username
 *                    (e.g. editor.diana → editor.dianaeditor.diana)
 *
 * Consumed by:
 *   - bootstrap.setup.js — POSTs the users list (with passwords) inside
 *                          the baseline journal spec to
 *                          /api/v1/_test/scenarios/journal
 *   - support/auth.js    — iterates roles to save storageState files
 *   - feature specs      — rarely; prefer storageState over explicit login
 */

/**
 * Username-derived password rule. Kept as a tiny exported helper so both
 * the Playwright client and any shared tooling derive passwords the same way.
 *
 * @param {string} username
 * @returns {string}
 */
exports.getPassword = function getPassword(username) {
	if (!username) {
		throw new Error('getPassword: username is required');
	}
	return username === 'admin' ? 'admin' : username + username;
};

/**
 * @typedef {Object} BaselineUser
 * @property {string} username
 * @property {string} givenName
 * @property {string} familyName
 * @property {string} email
 * @property {string} country           ISO-3166 alpha-2
 * @property {string} affiliation
 * @property {string=} journal          urlPath of the journal the roles apply to
 * @property {string[]=} roles          role-string keys understood by UserProcessor
 * @property {boolean=} siteAdmin
 * @property {boolean=} mustChangePassword
 */

/**
 * Ordered baseline. Admin is created by the installer; listed here for
 * reference only. Within a role, the FIRST user is the default pick (the
 * `users` helper map below keys on that).
 *
 * @type {BaselineUser[]}
 */
exports.baselineUsers = [
	{
		username: 'admin',
		givenName: 'Admin',
		familyName: 'User',
		email: 'admin@example.com',
		country: 'US',
		affiliation: 'Public Knowledge Project',
		siteAdmin: true,
	},
	{
		username: 'manager.maya',
		givenName: 'Maya',
		familyName: 'Manager',
		email: 'manager.maya@mailinator.com',
		country: 'MX',
		affiliation: 'Universidad Nacional Autónoma de México',
		journal: 'publicknowledge',
		roles: ['manager'],
	},
	{
		// Senior editor of publicknowledge — also a section editor of BOTH
		// sections (see the bootstrap's sectionEditors arrays).
		username: 'editor.diana',
		givenName: 'Diana',
		familyName: 'Editor',
		email: 'editor.diana@mailinator.com',
		country: 'AU',
		affiliation: 'University of Melbourne',
		journal: 'publicknowledge',
		roles: ['editor'],
	},
	{
		// Section editor for Articles (ART). Default pick for "a section editor".
		username: 'sectioneditor.ana',
		givenName: 'Ana',
		familyName: 'SectionEditor',
		email: 'sectioneditor.ana@mailinator.com',
		country: 'US',
		affiliation: 'University of Chicago',
		journal: 'publicknowledge',
		roles: ['sectionEditor'],
	},
	{
		// Section editor for Reviews (REV).
		username: 'sectioneditor.ravi',
		givenName: 'Ravi',
		familyName: 'SectionEditor',
		email: 'sectioneditor.ravi@mailinator.com',
		country: 'JP',
		affiliation: 'Kyoto University',
		journal: 'publicknowledge',
		roles: ['sectionEditor'],
	},
	{
		// Another Articles section editor. Roster note: the designated account
		// for recommend-only assignments — the recommendOnly flag itself is
		// per-assignment, not a property of this account.
		username: 'sectioneditor.omar',
		givenName: 'Omar',
		familyName: 'SectionEditor',
		email: 'sectioneditor.omar@mailinator.com',
		country: 'CA',
		affiliation: 'University of Toronto',
		journal: 'publicknowledge',
		roles: ['sectionEditor'],
	},
	{
		username: 'reviewer.julia',
		givenName: 'Julia',
		familyName: 'Reviewer',
		email: 'reviewer.julia@mailinator.com',
		country: 'NL',
		affiliation: 'Utrecht University',
		journal: 'publicknowledge',
		roles: ['reviewer'],
	},
	{
		username: 'reviewer.paul',
		givenName: 'Paul',
		familyName: 'Reviewer',
		email: 'reviewer.paul@mailinator.com',
		country: 'CA',
		affiliation: 'McGill University',
		journal: 'publicknowledge',
		roles: ['reviewer'],
	},
	{
		username: 'reviewer.amara',
		givenName: 'Amara',
		familyName: 'Reviewer',
		email: 'reviewer.amara@mailinator.com',
		country: 'CA',
		affiliation: 'University of Manitoba',
		journal: 'publicknowledge',
		roles: ['reviewer'],
	},
	{
		username: 'reviewer.adam',
		givenName: 'Adam',
		familyName: 'Reviewer',
		email: 'reviewer.adam@mailinator.com',
		country: 'US',
		affiliation: 'State University of New York',
		journal: 'publicknowledge',
		roles: ['reviewer'],
	},
	{
		username: 'copyeditor.carla',
		givenName: 'Carla',
		familyName: 'Copyeditor',
		email: 'copyeditor.carla@mailinator.com',
		country: 'BE',
		affiliation: 'Ghent University',
		journal: 'publicknowledge',
		roles: ['copyeditor'],
	},
	{
		username: 'copyeditor.sam',
		givenName: 'Sam',
		familyName: 'Copyeditor',
		email: 'copyeditor.sam@mailinator.com',
		country: 'CL',
		affiliation: 'Universidad de Chile',
		journal: 'publicknowledge',
		roles: ['copyeditor'],
	},
	{
		username: 'layouteditor.leo',
		givenName: 'Leo',
		familyName: 'LayoutEditor',
		email: 'layouteditor.leo@mailinator.com',
		country: 'US',
		affiliation: 'Duke University',
		journal: 'publicknowledge',
		roles: ['layoutEditor'],
	},
	{
		username: 'proofreader.pia',
		givenName: 'Pia',
		familyName: 'Proofreader',
		email: 'proofreader.pia@mailinator.com',
		country: 'ZA',
		affiliation: 'University of Cape Town',
		journal: 'publicknowledge',
		roles: ['proofreader'],
	},
	{
		// Non-privileged author — exists so specs that need to exercise the
		// author-side permission gate (Repo::submission()->canEditPublication
		// for an AUTHOR-only stage assignment) have a functional login. Every
		// other seeded publicknowledge user bypasses the gate via a manager/
		// editor role (NOT_CHANGE_METADATA_EDIT_PERMISSION_ROLES).
		// author.alex is author-only, password derives normally via
		// getPassword, and is explicitly NOT mustChangePassword — login must
		// land on the dashboard, not the password-change form.
		username: 'author.alex',
		givenName: 'Alex',
		familyName: 'Author',
		email: 'author.alex@mailinator.com',
		country: 'CA',
		affiliation: 'Simon Fraser University',
		journal: 'publicknowledge',
		roles: ['author'],
		mustChangePassword: false,
	},
	{
		// Second author — for co-author and foreign-submission cases (e.g.
		// asserting one author cannot see or touch another author's
		// submission).
		username: 'author.bea',
		givenName: 'Bea',
		familyName: 'Author',
		email: 'author.bea@mailinator.com',
		country: 'IE',
		affiliation: 'University College Dublin',
		journal: 'publicknowledge',
		roles: ['author'],
	},
	{
		// Assistant enrolled in the Funding coordinator group — the one
		// default assistant group WITH review-stage access (stages 1,3 in
		// registry/userGroups.xml; 'funding' is the UserGroupLookup role key).
		// Use for "an assistant can reach the review stage" scenarios.
		username: 'assistant.rita',
		givenName: 'Rita',
		familyName: 'Assistant',
		email: 'assistant.rita@mailinator.com',
		country: 'DE',
		affiliation: 'Freie Universität Berlin',
		journal: 'publicknowledge',
		roles: ['funding'],
	},
	{
		// Registered reader — no roles beyond reader. Use for reader-facing
		// gates (subscription walls, comment forms, "registered user but no
		// editorial access" checks).
		username: 'reader.rosa',
		givenName: 'Rosa',
		familyName: 'Reader',
		email: 'reader.rosa@mailinator.com',
		country: 'ES',
		affiliation: 'Universitat de Barcelona',
		journal: 'publicknowledge',
		roles: ['reader'],
	},
];

/**
 * Convenience map keyed by role string → first baseline user with that role.
 * Useful for tests that want "some editor" without caring which one.
 */
exports.users = exports.baselineUsers.reduce((acc, user) => {
	if (user.siteAdmin && !acc.admin) {
		acc.admin = user;
	}
	for (const role of user.roles ?? []) {
		if (!acc[role]) {
			acc[role] = user;
		}
	}
	return acc;
}, /** @type {Record<string, BaselineUser>} */ ({}));
