// @ts-check
const {test, expect} = require('../support/base-test.js');

/**
 * Institutions — docs/e2e/plans/institutions.md (rows 1–2).
 *
 * The feature under test is the Institutions list panel at
 * `management/settings/institutions` (PKPInstitutionsListPanel +
 * PKPInstitutionForm): add/edit round-trip with a multilingual name, IP
 * ranges and a ROR id (row 1), and delete-with-confirm (row 2).
 *
 * Reached by DIRECT URL on a scratch journal — the sidebar nav entry is
 * gated by paymentsEnabled / institution-stats settings, but the
 * ManagementHandler `institutions` op itself only requires the manager
 * role (the nav gating is exercised by distribution-settings row 4).
 *
 * Scratch journals are seeded with supportedLocales ['en','fr_CA'] so
 * the institution name field is genuinely multilingual (the secondary
 * locale input is exposed via the form's locale toggle, same driving as
 * publication-identifiers-license.spec.js).
 *
 * ROR notes:
 *   - The value must match the institution schema's regex
 *     (lib/pkp/schemas/institution.json: `https://ror.org/0[^ILOU]{6}\d{2}`);
 *     it is stored as a plain value — NO external lookup is part of this
 *     plan (round-2 note).
 *   - The form's ror field is a plain FieldText
 *     (PKPInstitutionForm.php:48), so no browser-side api.ror.org call
 *     should fire; the page.route stub below is hermetic insurance in
 *     case the field grows the ROR autosuggest (which queries
 *     api.ror.org from the browser — see contributors.spec.js), keeping
 *     the test independent of external egress either way.
 *
 * UI notes:
 *   - The add/edit form opens in a side modal (`[data-cy="active-modal"]`);
 *     fields: `input[name="name-en"]` / `input[name="name-fr_CA"]`
 *     (multilingual), `textarea[name="ipRanges"]`, `input[name="ror"]`.
 *   - Edit re-populates ipRanges by joining the stored array with CRLF
 *     (InstitutionsListPanel.vue:265); the textarea's API value
 *     normalizes newlines, so round-trip assertions match with a
 *     newline-tolerant regex.
 *   - Delete confirm is a dialog with Yes/No actions firing a jQuery
 *     POST + X-Http-Method-Override: DELETE (InstitutionsListPanel.vue:217).
 */

test.use({user: 'dbarnes'});

/** Two distinct schema-valid ROR ids (regex: https://ror.org/0[^ILOU]{6}\d{2}). */
const ROR_SFU = 'https://ror.org/03rmrcq20';
const ROR_SECOND = 'https://ror.org/00f54p054';

function uniqueTag(prefix) {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${prefix}-w${workerIndex}-${suffix}`;
}

/** The institutions side modal (top-most active side modal). */
function activeModal(page) {
	return page.locator('[data-cy="active-modal"]').first();
}

/** The list row carrying the given institution name. */
function institutionRow(page, name) {
	return page.locator('.institutionsListPanel .listPanel__item', {
		hasText: name,
	});
}

/**
 * Seed a scratch journal and open its Institutions settings page.
 *
 * @returns {Promise<{path: string, id: number}>}
 */
async function gotoInstitutions(page, pkpApi, tag) {
	const {context} = await pkpApi.createJournal({
		tag,
		supportedLocales: ['en', 'fr_CA'],
		users: [{username: 'dbarnes', roles: ['manager']}],
	});

	// Hermetic stub for any browser-side ROR lookup (see header).
	await page.route('https://api.ror.org/**', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({number_of_results: 0, time_taken: 0, items: []}),
		}),
	);

	await page.goto(
		`/index.php/${context.path}/management/settings/institutions`,
	);
	await expect(
		page.getByRole('button', {name: 'Add Institution'}),
	).toBeVisible({timeout: 15_000});
	return {path: context.path, id: context.id};
}

/**
 * Submit the open institution form and wait for the write to land.
 * Adds POST `/api/v1/institutions`; edits PUT `/api/v1/institutions/{id}`
 * (tunneled as POST + X-Http-Method-Override by useFetch) — accept both
 * verbs and both URL shapes.
 *
 * @param {import('@playwright/test').Page} page
 */
async function saveInstitutionForm(page) {
	await Promise.all([
		page.waitForResponse(
			(res) =>
				/\/api\/v1\/institutions(\/\d+)?$/.test(res.url()) &&
				['POST', 'PUT'].includes(res.request().method()) &&
				res.ok(),
			{timeout: 20_000},
		),
		activeModal(page)
			.getByRole('button', {name: 'Save', exact: true})
			.click(),
	]);
	// formSuccess closes the modal and refreshes the list.
	await expect(activeModal(page)).toHaveCount(0, {timeout: 15_000});
}

/**
 * Add an institution through the UI.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} values
 * @param {string} values.nameEn
 * @param {string} [values.nameFr]
 * @param {string} [values.ipRanges]
 * @param {string} [values.ror]
 */
async function addInstitution(page, {nameEn, nameFr, ipRanges, ror}) {
	await page.getByRole('button', {name: 'Add Institution'}).click();
	const modal = activeModal(page);
	const nameInput = modal.locator('input[name="name-en"]');
	await expect(nameInput).toBeVisible({timeout: 15_000});
	await nameInput.fill(nameEn);
	if (nameFr) {
		await modal
			.locator('.pkpFormLocales button')
			.filter({hasText: 'French'})
			.click();
		await modal.locator('input[name="name-fr_CA"]').fill(nameFr);
	}
	if (ipRanges) {
		await modal.locator('textarea[name="ipRanges"]').fill(ipRanges);
	}
	if (ror) {
		await modal.locator('input[name="ror"]').fill(ror);
	}
	await saveInstitutionForm(page);
	await expect(institutionRow(page, nameEn)).toBeVisible({timeout: 15_000});
}

test.describe('Institutions', () => {
	// Row 1
	test('manager creates and edits an institution; values round-trip', {tag: '@smoke'}, async ({page, pkpApi}) => {
		// Scratch-journal bootstrap + two modal round-trips + reloads.
		test.slow();
		const tag = uniqueTag('inst1');
		await gotoInstitutions(page, pkpApi, tag);

		const nameEn = `Institute of Testing ${tag}`;
		const nameFr = `Institut d'essais ${tag}`;
		const ipRangeA = '142.58.103.1 - 142.58.103.4';
		const ipRangeB = '10.1.*.*';

		await addInstitution(page, {
			nameEn,
			nameFr,
			ipRanges: `${ipRangeA}\n${ipRangeB}`,
			ror: ROR_SFU,
		});

		// Reopen: every value round-trips (the edit modal re-populates
		// from the stored institution).
		await institutionRow(page, nameEn)
			.getByRole('button', {name: 'Edit'})
			.click();
		let modal = activeModal(page);
		await expect(modal.locator('input[name="name-en"]')).toHaveValue(nameEn, {
			timeout: 15_000,
		});
		await modal
			.locator('.pkpFormLocales button')
			.filter({hasText: 'French'})
			.click();
		await expect(modal.locator('input[name="name-fr_CA"]')).toHaveValue(
			nameFr,
		);
		// Stored ranges come back joined with CRLF; match newline-tolerantly.
		await expect(modal.locator('textarea[name="ipRanges"]')).toHaveValue(
			new RegExp(
				`${ipRangeA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\r\\n]+${ipRangeB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
			),
		);
		await expect(modal.locator('input[name="ror"]')).toHaveValue(ROR_SFU);

		// Edit the name and an IP range, save.
		const nameEdited = `${nameEn} (edited)`;
		const ipRangeEdited = '192.168.0.0/24';
		await modal.locator('input[name="name-en"]').fill(nameEdited);
		await modal
			.locator('textarea[name="ipRanges"]')
			.fill(`${ipRangeA}\n${ipRangeEdited}`);
		await saveInstitutionForm(page);
		await expect(institutionRow(page, nameEdited)).toBeVisible({
			timeout: 15_000,
		});

		// Persists across a full reload; the edited values re-populate.
		await page.reload();
		await expect(institutionRow(page, nameEdited)).toBeVisible({
			timeout: 15_000,
		});
		await institutionRow(page, nameEdited)
			.getByRole('button', {name: 'Edit'})
			.click();
		modal = activeModal(page);
		await expect(modal.locator('input[name="name-en"]')).toHaveValue(
			nameEdited,
			{timeout: 15_000},
		);
		await expect(modal.locator('textarea[name="ipRanges"]')).toHaveValue(
			new RegExp(ipRangeEdited.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
		);
		await expect(modal.locator('input[name="ror"]')).toHaveValue(ROR_SFU);
	});

	// Row 2
	test('manager deletes an institution; the other one is untouched', {tag: '@regression'}, async ({page, pkpApi}) => {
		test.slow();
		const tag = uniqueTag('inst2');
		await gotoInstitutions(page, pkpApi, tag);

		const keepName = `Keep Institute ${tag}`;
		const dropName = `Drop Institute ${tag}`;
		await addInstitution(page, {
			nameEn: keepName,
			ipRanges: '142.58.103.1',
			ror: ROR_SECOND,
		});
		await addInstitution(page, {nameEn: dropName, ipRanges: '10.0.0.1'});

		// Delete the second one; confirm dialog fires the DELETE
		// (POST + X-Http-Method-Override) before the row is dropped
		// client-side.
		await institutionRow(page, dropName)
			.getByRole('button', {name: 'Delete'})
			.click();
		const dialog = page.getByRole('dialog', {name: 'Delete Institution'});
		await expect(
			dialog.getByText(
				'Are you sure you want to continue and delete this institution?',
			),
		).toBeVisible({timeout: 15_000});
		await Promise.all([
			page.waitForResponse(
				(res) =>
					/\/api\/v1\/institutions\/\d+$/.test(res.url()) &&
					res.request().method() === 'POST' &&
					res.ok(),
				{timeout: 20_000},
			),
			dialog.getByRole('button', {name: 'Yes', exact: true}).click(),
		]);
		await expect(institutionRow(page, dropName)).toHaveCount(0, {
			timeout: 15_000,
		});
		await expect(institutionRow(page, keepName)).toBeVisible();

		// Stays gone after a reload; the first institution is untouched.
		await page.reload();
		await expect(institutionRow(page, keepName)).toBeVisible({
			timeout: 15_000,
		});
		await expect(institutionRow(page, dropName)).toHaveCount(0);

		// The survivor's values are intact (untouched by the delete).
		await institutionRow(page, keepName)
			.getByRole('button', {name: 'Edit'})
			.click();
		const modal = activeModal(page);
		await expect(modal.locator('input[name="name-en"]')).toHaveValue(
			keepName,
			{timeout: 15_000},
		);
		await expect(modal.locator('input[name="ror"]')).toHaveValue(ROR_SECOND);
	});
});
