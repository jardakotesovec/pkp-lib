// @ts-check
const {test, expect} = require('../support/base-test.js');
const {EditorialWorkflowPage} = require('../../../../playwright/pages/EditorialWorkflowPage.js');
const {ContributorsPanel} = require('../pages/ContributorsPanel.js');
const submissionDraft = require('../../../../playwright/fixtures/scenarios/submission-draft.js');

/**
 * Contributors — docs/e2e/plans/contributors.md rows 2–6.
 *
 * Row 1 (basic add-contributor flow) is implemented in
 * publication-metadata-editing.spec.js (test 2) per the plan's Absorbs
 * split; this spec reuses its modal-driving approach via the
 * ContributorsPanel POM and covers the rest of the CRUD surface: edit,
 * delete, reorder + byline preview, primary-contact reassignment, and
 * the affiliations manual-entry round-trip.
 *
 * Seeding: every test creates its own stage-1 draft submission via the
 * submission scenario (submission-draft fixture; submitter defaults to
 * rvaca, whose seeded Author row — "Ramiro Vaca", rvaca@mailinator.com,
 * primary contact — is the pre-existing contributor the tests operate
 * on). Extra contributors are added through the UI: contributor CRUD is
 * the behavior under test, so no Processor support is wanted (plan's
 * scenario-needs note).
 *
 * Affiliations reality checks (row 6):
 *   - The affiliations field's autosuggest queries the external ROR API
 *     (https://api.ror.org) from the BROWSER once the input exceeds 3
 *     chars. The manual-entry path must not depend on that service
 *     (charter: all server egress is firewalled; browser egress is just
 *     as untrustworthy in CI), so the test stubs the ROR endpoint with
 *     an empty result set via page.route() and drives the
 *     custom-value option (Autosuggest allowCustom).
 *   - The contributor row's subtitle binding (`item.affiliation`,
 *     ContributorsListPanel.vue:61) is dead — the author payload only
 *     carries the `affiliations` array (lib/pkp/schemas/author.json),
 *     so affiliations never render under the contributor's name in the
 *     list. UI display is therefore asserted via the edit-form
 *     round-trip instead of the row subtitle. Reported as an app-bug
 *     candidate in the wave report.
 */

/** The seeded author row created from the submitter's user record. */
const SEEDED = {
	fullName: 'Ramiro Vaca',
	givenName: 'Ramiro',
	familyName: 'Vaca',
	email: 'rvaca@mailinator.com',
};

test.use({user: 'dbarnes'});

function uniqueTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

/** A whitespace-free token derived from the tag, safe inside names. */
function nameToken(tag) {
	return tag.replace(/[^a-z0-9]/gi, '');
}

/**
 * Fetch the submission's current publication JSON via the REST API
 * (same shape as publication-metadata-editing.spec.js — the publication
 * payload is the source of truth for authors/primaryContactId).
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} submissionId
 */
async function fetchCurrentPublication(page, submissionId) {
	const subRes = await page.request.get(
		`/index.php/publicknowledge/api/v1/submissions/${submissionId}`,
	);
	if (!subRes.ok()) {
		throw new Error(
			`GET submission ${submissionId} failed: ${subRes.status()} ${await subRes.text()}`,
		);
	}
	const sub = await subRes.json();
	const pubRes = await page.request.get(
		`/index.php/publicknowledge/api/v1/submissions/${submissionId}/publications/${sub.currentPublicationId}`,
	);
	if (!pubRes.ok()) {
		throw new Error(
			`GET publication ${sub.currentPublicationId} failed: ${pubRes.status()} ${await pubRes.text()}`,
		);
	}
	return pubRes.json();
}

/** Seed a draft submission and land on its Contributors panel. */
async function gotoContributors(page, pkpApi, tag) {
	const {submission} = await pkpApi.createSubmission(submissionDraft({tag}));
	const workflow = new EditorialWorkflowPage(page);
	await workflow.goto(submission.id);
	const panel = new ContributorsPanel(page);
	await panel.openPanel();
	return {submission, panel};
}

test.describe('Contributors', () => {
	// Row 2
	test('editor edits the submitter’s seeded contributor; new family name and email persist', {tag: '@smoke'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('contrib2');
		const {submission, panel} = await gotoContributors(page, pkpApi, tag);

		const newFamilyName = `Vacaedited${nameToken(tag)}`;
		const newEmail = `contrib2-${tag}@mailinator.com`.toLowerCase();
		const newFullName = `${SEEDED.givenName} ${newFamilyName}`;

		// The submitter's seeded author row is the only contributor.
		await expect(panel.row(SEEDED.fullName)).toBeVisible({timeout: 15_000});

		// Edit opens prefilled: name, email match the rvaca user record the
		// scenario's newAuthorFromUser copied.
		const modal = await panel.openEditModal(SEEDED.fullName);
		await expect(modal.locator('input[name="givenName-en"]')).toHaveValue(
			SEEDED.givenName,
		);
		await expect(modal.locator('input[name="familyName-en"]')).toHaveValue(
			SEEDED.familyName,
		);
		await expect(modal.locator('input[name="email"]')).toHaveValue(
			SEEDED.email,
		);

		await modal.locator('input[name="familyName-en"]').fill(newFamilyName);
		await modal.locator('input[name="email"]').fill(newEmail);
		await panel.saveForm(modal);

		// The list refreshes with the new display name.
		await expect(panel.row(newFullName)).toBeVisible({timeout: 15_000});

		// Survives a full reload…
		await page.reload();
		await panel.openPanel();
		await expect(panel.row(newFullName)).toBeVisible({timeout: 15_000});

		// …and the publication's authors payload carries both changes.
		const pub = await fetchCurrentPublication(page, submission.id);
		const match = (pub.authors || []).find(
			(a) => (a.email || '').toLowerCase() === newEmail,
		);
		expect(match, `author with email ${newEmail} should exist`).toBeTruthy();
		expect(match.familyName?.en).toBe(newFamilyName);
		expect(match.givenName?.en).toBe(SEEDED.givenName);
	});

	// Row 3
	test('editor deletes a contributor; the remaining contributor is untouched', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('contrib3');
		const {submission, panel} = await gotoContributors(page, pkpApi, tag);

		const added = {
			givenName: `Del${nameToken(tag)}`,
			familyName: 'Deletee',
			email: `contrib3-${tag}@mailinator.com`.toLowerCase(),
		};
		const addedFullName = `${added.givenName} ${added.familyName}`;
		await panel.addContributor(added);

		// Delete with confirmation; the row disappears.
		await panel.deleteContributor(addedFullName);
		await expect(panel.row(addedFullName)).toHaveCount(0);
		await expect(panel.row(SEEDED.fullName)).toBeVisible();

		// Publication authors no longer include the deleted email; the
		// seeded contributor survives untouched and keeps primary contact.
		const pub = await fetchCurrentPublication(page, submission.id);
		const authors = pub.authors || [];
		expect(
			authors.some((a) => (a.email || '').toLowerCase() === added.email),
		).toBe(false);
		expect(authors).toHaveLength(1);
		const seeded = authors.find(
			(a) => (a.email || '').toLowerCase() === SEEDED.email,
		);
		expect(seeded, 'seeded contributor should survive').toBeTruthy();
		expect(seeded.familyName?.en).toBe(SEEDED.familyName);
		expect(pub.primaryContactId).toBe(seeded.id);
	});

	// Row 4
	test('editor reorders contributors; saved order shows in the byline preview and survives reload', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('contrib4');
		const {submission, panel} = await gotoContributors(page, pkpApi, tag);

		const added = {
			givenName: `Zelda${nameToken(tag)}`,
			familyName: 'Reorder',
			email: `contrib4-${tag}@mailinator.com`.toLowerCase(),
		};
		const addedFullName = `${added.givenName} ${added.familyName}`;
		await panel.addContributor(added);

		// Baseline order: the seeded submitter first, the new contributor
		// appended last.
		await expect(panel.rowTitles().first()).toContainText(SEEDED.fullName);
		await expect(panel.rowTitles().last()).toContainText(addedFullName);

		// Order mode: move the new contributor up one, then Save Order.
		await panel.startOrdering();
		await panel.moveUp(addedFullName);
		await panel.saveOrder();
		await expect(panel.rowTitles().first()).toContainText(addedFullName);

		// The Preview modal's author strings reflect the new byline order:
		// the added contributor's unique given name precedes the seeded
		// submitter in the "Full" display string.
		const preview = await panel.openPreview();
		const fullRow = preview
			.getByRole('row')
			.filter({has: page.getByRole('cell', {name: 'Full', exact: true})});
		const fullText = (await fullRow.textContent()) || '';
		expect(fullText).toContain(added.givenName);
		expect(fullText).toContain(SEEDED.givenName);
		expect(fullText.indexOf(added.givenName)).toBeLessThan(
			fullText.indexOf(SEEDED.givenName),
		);
		await panel.closeStackedModal(preview);

		// The order survives a full reload, and the authors payload carries
		// the persisted seq values.
		await page.reload();
		await panel.openPanel();
		await expect(panel.rowTitles().first()).toContainText(addedFullName, {
			timeout: 15_000,
		});
		const pub = await fetchCurrentPublication(page, submission.id);
		const authors = pub.authors || [];
		const addedAuthor = authors.find(
			(a) => (a.email || '').toLowerCase() === added.email,
		);
		const seededAuthor = authors.find(
			(a) => (a.email || '').toLowerCase() === SEEDED.email,
		);
		expect(addedAuthor, 'added author should exist').toBeTruthy();
		expect(seededAuthor, 'seeded author should exist').toBeTruthy();
		expect(addedAuthor.seq).toBeLessThan(seededAuthor.seq);
	});

	// Row 5
	test('editor reassigns the primary contact; the badge moves and the publication updates', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('contrib5');
		const {submission, panel} = await gotoContributors(page, pkpApi, tag);

		const added = {
			givenName: `Pri${nameToken(tag)}`,
			familyName: 'Contactee',
			email: `contrib5-${tag}@mailinator.com`.toLowerCase(),
		};
		const addedFullName = `${added.givenName} ${added.familyName}`;
		await panel.addContributor(added);

		// Default state: the submitter's seeded row carries the badge; the
		// new contributor offers "Set Primary Contact".
		await expect(panel.primaryContactBadge(SEEDED.fullName)).toBeVisible({
			timeout: 15_000,
		});
		await expect(panel.setPrimaryContactButton(addedFullName)).toBeVisible();

		// Reassign: the badge moves, the old primary gets the button back.
		await panel.setPrimaryContact(addedFullName);
		await expect(panel.primaryContactBadge(addedFullName)).toBeVisible({
			timeout: 15_000,
		});
		await expect(panel.primaryContactBadge(SEEDED.fullName)).toHaveCount(0);
		await expect(panel.setPrimaryContactButton(SEEDED.fullName)).toBeVisible();

		// Persisted: publication.primaryContactId now points at the added
		// contributor's author row.
		const pub = await fetchCurrentPublication(page, submission.id);
		const addedAuthor = (pub.authors || []).find(
			(a) => (a.email || '').toLowerCase() === added.email,
		);
		expect(addedAuthor, 'added author should exist').toBeTruthy();
		expect(pub.primaryContactId).toBe(addedAuthor.id);
	});

	// Row 6
	test('contributor affiliations round-trip via manual entry', {tag: '@regression'}, async ({page, pkpApi}) => {
		const tag = uniqueTag('contrib6');

		// Hermetic ROR stub: typing >3 chars in the affiliations
		// autosuggest fires a browser-side query against api.ror.org. An
		// empty 200 keeps the field on the happy path (no error dialog)
		// without depending on external egress; the manual path under test
		// is the allowCustom option, which renders regardless.
		await page.route('https://api.ror.org/**', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({number_of_results: 0, time_taken: 0, items: []}),
			}),
		);

		const {submission, panel} = await gotoContributors(page, pkpApi, tag);
		const institution = `Institute of Testing ${nameToken(tag)}`;

		const modal = await panel.openEditModal(SEEDED.fullName);
		const affField = modal.locator('.pkpFormField--affiliations');
		await expect(affField).toBeVisible({timeout: 10_000});

		// Manual entry: type the institution, pick the custom (free-text)
		// option, then Add inserts it into the affiliations table.
		await affField.locator('input.pkpAutosuggest__input').fill(institution);
		await affField.getByRole('option', {name: institution}).click();
		await affField.getByRole('button', {name: 'Add', exact: true}).click();
		await expect(
			affField.getByRole('cell').filter({hasText: institution}).first(),
		).toBeVisible({timeout: 10_000});

		await panel.saveForm(modal);

		// Persisted on the publication author: the affiliations array
		// carries the manually entered institution under the primary locale.
		const pub = await fetchCurrentPublication(page, submission.id);
		const author = (pub.authors || []).find(
			(a) => (a.email || '').toLowerCase() === SEEDED.email,
		);
		expect(author, 'seeded author should exist').toBeTruthy();
		const affiliationNames = (author.affiliations || []).map(
			(a) => a.name?.en,
		);
		expect(affiliationNames).toContain(institution);

		// UI round-trip: after a full reload the edit form lists the saved
		// affiliation. (The list row's affiliation subtitle is a dead
		// binding — see the spec header — so the form is the UI surface
		// that proves persistence.)
		await page.reload();
		await panel.openPanel();
		const reopened = await panel.openEditModal(SEEDED.fullName);
		await expect(
			reopened
				.locator('.pkpFormField--affiliations')
				.getByRole('cell')
				.filter({hasText: institution})
				.first(),
		).toBeVisible({timeout: 10_000});
	});
});
