// @ts-check
const {test, expect} = require('../support/base-test.js');
const {waitForJQueryIdle} = require('../support/jquery.js');
const {setTinyMceContent} = require('../support/tinymce.js');
/**
 * Navigation menus — docs/e2e/plans/navigation-menus.md (all 4 rows).
 *
 * Ports lib/pkp/cypress/tests/integration/NavigationMenus.cy.js.
 *
 * The Navigation Menu Editor surface mixes two modal pipelines on the
 * same Setup → Navigation tab:
 *
 *   - The OUTER navigation-menus grid (`#navigationMenuGridContainer`)
 *     is the legacy `pkp_controllers_linkAction` jQuery grid whose
 *     "Add Menu" / row Edit / row Remove link actions now open the
 *     modern Vue `NavigationMenuManagerFormModal` (a `SideModalBody`
 *     side-modal — `[data-cy="active-modal"]`). The form inside is a
 *     PkpForm with `name="title"` + `name="areaName"` plus an embedded
 *     two-panel drag-and-drop NavigationMenuEditor
 *     (`[data-cy="navigation-menu-editor"]` with `[data-cy="assigned-panel"]`
 *     / `[data-cy="unassigned-panel"]`).
 *
 *   - The INNER navigation-menu-items grid
 *     (`#navigationMenuItemsGridContainer`) is rendered alongside the
 *     menus grid on the same tab and remains pure legacy: jQuery-UI
 *     AjaxModal opens `form#navigationMenuItemsForm` with fbv
 *     `name="title[en]"` / `name="path"` / `select[name="menuItemType"]`
 *     and per-row Edit / Remove link actions hidden behind the
 *     `a.show_extras` toggle (same row #8 sections / row #7 issues
 *     pattern).
 *
 * Each test seeds an E0 scratch journal so the bootstrapped
 * publicknowledge journal's navigation menus stay untouched.
 * `PKPContextService::add()` runs `NavigationMenuDAO::installSettings(
 * 'registry/navigationMenus.xml')` during context creation, so a
 * scratch journal already has a default Primary Navigation Menu
 * assigned to the `primary` area — the area-conflict assertion keys
 * off that default.
 */

function uniqueTag() {
	const workerIndex = test.info().parallelIndex;
	const suffix = Math.random().toString(36).slice(2, 8);
	return `nav-w${workerIndex}-${suffix}`;
}

/**
 * Visit the Navigation tab of the Website settings page. The tab is a
 * Vue `<tab id="navigationMenus">` inside the website tabset; clicking
 * the tab fires the `navigationMenuGridContainer` `load_url_in_div`
 * fetch.
 */
async function openNavigationTab(page, journalPath) {
	await page.goto(`/index.php/${journalPath}/management/settings/website`);
	await page.locator('#setup-button').click();
	await page.getByRole('tab', {name: 'Navigation'}).click();
	// Wait for both grids to mount — Add Menu link action on the menus
	// grid, Add Item link action on the items grid.
	await expect(
		page.locator('a.pkp_linkaction_addNavigationMenu'),
	).toBeVisible({timeout: 15_000});
	// The items grid renders many `a.pkp_controllers_linkAction` anchors
	// (one Add Item plus per-row Edit / Remove for each default item),
	// so `.toBeVisible()` would trip strict-mode. Existence on the
	// add-item anchor is enough to confirm the grid has hydrated.
	await expect(
		page.locator(
			'#navigationMenuItemsGridContainer a.pkp_linkaction_addNavigationMenuItem',
		),
	).toBeVisible({timeout: 15_000});
	// The link anchors render via AJAX before jQuery binds their click
	// handlers; under workers=5 a click on `a.pkp_linkaction_addNavigationMenu`
	// can land on the DOM element before the handler is bound, leaving
	// the side modal unopened. Wait for jQuery to settle so the handler
	// is in place.
	await waitForJQueryIdle(page);
}

/**
 * Locator scoped to the active NavigationMenuManagerFormModal side-modal.
 * Filter by the `navigation-menu-editor` panel which only exists in
 * this specific modal — robust against any other side-modal stacking.
 */
function menuFormModal(page) {
	return page
		.locator('[data-cy="active-modal"]')
		.filter({has: page.locator('[data-cy="navigation-menu-editor"]')});
}

/**
 * Open the Add Menu side-modal and wait for the Vue editor to mount.
 *
 * The "Add Menu" link action is rendered as
 * `<a class="pkp_controllers_linkAction pkp_linkaction_addNavigationMenu">`
 * by the legacy grid handler — `getByRole('button', {name: 'Add Menu'})`
 * does NOT match (it's an anchor, not a button).
 *
 * Click-retry rationale: after a menu save the legacy grid refreshes
 * itself (dataChanged → fetch-grid → full HTML replace), and a click
 * issued in that window can land on the about-to-be-detached anchor —
 * focus registers, but the (re)bound handler never runs and no modal
 * opens (observed once under workers=2). jQuery-idle narrows the
 * window; the retry closes it.
 */
async function openAddMenuModal(page) {
	const modal = menuFormModal(page);
	await waitForJQueryIdle(page);
	for (let attempt = 0; ; attempt++) {
		await page.locator('a.pkp_linkaction_addNavigationMenu').click();
		try {
			await expect(modal).toHaveCount(1, {timeout: 7_000});
			break;
		} catch (err) {
			if (attempt >= 2) {
				throw err;
			}
			// A slow-but-successful open may land just past the expect
			// window — never re-click into the overlay in that case.
			if ((await modal.count()) > 0) {
				break;
			}
			await waitForJQueryIdle(page);
		}
	}
	await expect(modal.locator('[data-cy="assigned-panel"]')).toBeVisible();
	await expect(modal.locator('[data-cy="unassigned-panel"]')).toBeVisible();
	return modal;
}

/**
 * Open the row's Edit side-modal by clicking the row's title link
 * (the legacy grid renders the title column as a clickable LinkAction
 * that opens the same NavigationMenuManagerFormModal as the Edit row
 * action).
 */
async function openEditMenuModalByTitle(page, title) {
	const modal = menuFormModal(page);
	// Same refresh-race guard as openAddMenuModal.
	await waitForJQueryIdle(page);
	for (let attempt = 0; ; attempt++) {
		await page
			.locator('#navigationMenuGridContainer')
			.getByText(title, {exact: true})
			.first()
			.click();
		try {
			await expect(modal).toHaveCount(1, {timeout: 7_000});
			break;
		} catch (err) {
			if (attempt >= 2) {
				throw err;
			}
			if ((await modal.count()) > 0) {
				break;
			}
			await waitForJQueryIdle(page);
		}
	}
	await expect(modal.locator('[data-cy="assigned-panel"]')).toBeVisible();
	return modal;
}

/**
 * Cancel a side-modal that has unsaved changes. The PkpForm's Cancel
 * button calls `closeModal`, which goes through `useFormChanged`'s
 * `confirmClose` and opens the [data-cy="dialog"] Yes/No prompt.
 */
async function cancelWithUnsavedChanges(page, modal) {
	await modal.getByRole('button', {name: 'Cancel'}).click();
	const dialog = page.locator('[data-cy="dialog"]');
	await expect(dialog).toBeVisible({timeout: 10_000});
	await dialog.getByRole('button', {name: 'Yes'}).click();
	await expect(modal).toHaveCount(0, {timeout: 10_000});
}

/**
 * Drag a NavigationMenuEditor item from the unassigned panel onto the
 * TOP EDGE of the assigned panel's first root item via raw mouse
 * events, inserting it at root position 0. The editor's DnD is
 * @atlaskit/pragmatic-drag-and-drop (native HTML5 drag events) —
 * Playwright Chromium synthesizes those from mouse down/move/up, but
 * needs ≥2 moves after mousedown for the dragover stream to reach the
 * target (same constraint as the jQuery-UI sortable pattern in OJS's
 * IssuePage#dragRowAbove).
 *
 * Targeting notes (both alternatives failed live):
 *   - The first root item's top strip resolves `reorder-above` in the
 *     tree-item hitbox → root index 0. Slight overshoot lands in the
 *     index-0 DropZone whose explicit payload is ALSO {parentId: null,
 *     index: 0} — either way the item ends up at root level.
 *   - Dropping in the panel's free bottom area is NOT root-safe: on
 *     the drag path the trailing child-level DropZone expands a
 *     DropGhostPreview under the cursor (DropZone.vue showGhost drops
 *     the h-0 wrapper) and swallows the drop, nesting the item into
 *     the last root item's CSS-hidden submenu.
 *   - The first item is only a safe target AFTER scrolling the editor
 *     to the top of the side modal's scroll area; otherwise the modal
 *     auto-scroll leaves it clipped under the sticky modal header and
 *     the drop coordinates hit the header instead.
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} modal the NavigationMenuManagerFormModal locator
 * @param {import('@playwright/test').Locator} source item to move ([data-menu-item-title] node)
 */
async function dragMenuItemToAssignedRoot(page, modal, source) {
	const editor = modal.locator('[data-cy="navigation-menu-editor"]');
	await editor.evaluate((el) => el.scrollIntoView({block: 'start'}));
	const target = modal
		.locator('[data-cy="panel-content-assigned"] [data-menu-item-title]')
		.first();
	await expect(target).toBeVisible();
	await source.hover(); // auto-waits for visibility + stability
	const sourceBox = await source.boundingBox();
	const targetBox = await target.boundingBox();
	if (!sourceBox || !targetBox) {
		throw new Error('dragMenuItemToAssignedRoot: item has no bounding box');
	}
	const startX = sourceBox.x + sourceBox.width / 2;
	const startY = sourceBox.y + sourceBox.height / 2;
	await page.mouse.move(startX, startY);
	await page.mouse.down();
	// First small move fires dragstart…
	await page.mouse.move(startX, startY - 5);
	// …then walk to just inside the target's top edge so the hitbox
	// resolves `reorder-above` rather than `make-child`.
	await page.mouse.move(
		targetBox.x + targetBox.width / 2,
		targetBox.y + 3,
		{steps: 15},
	);
	await page.mouse.up();
}

/**
 * Expand a row's hidden controls by clicking its `a.show_extras` glyph,
 * then click the action whose label matches `actionText` inside the
 * sibling `tr.row_controls`. Mirrors the row #8 sections /
 * subscription-config helpers.
 */
async function clickRowAction(page, gridSelector, rowText, actionText) {
	const row = page
		.locator(`${gridSelector} tr.gridRow`, {hasText: rowText})
		.first();
	// Each row has its own settings glyph; if it's already expanded
	// (class flipped to `hide_extras` after a previous click in the
	// same render), skip the toggle.
	const showExtras = row.locator('a.show_extras');
	if ((await showExtras.count()) > 0) {
		await showExtras.click();
	}
	// row_controls is the sibling tr — the grid renders it adjacent to
	// the gridRow with a matching `${rowId}-control-row` id. Walk up to
	// the tbody and pick the visible row_controls under the same
	// container.
	await page
		.locator(`${gridSelector} tr.row_controls:visible`)
		.getByText(actionText, {exact: true})
		.first()
		.click();
}

test.describe('Navigation menus', () => {
	test(
		'manager creates a menu, edits its title, validates duplicate + area-conflict, and deletes it',
		{tag: '@regression'},
		async ({pkpApi, asUser}) => {
			const tag = uniqueTag();
			const {context} = await pkpApi.createJournal({
				tag,
				name: {en: `Nav Menu Scratch ${tag}`},
				users: [{username: 'dbarnes', roles: ['manager']}],
			});
			const ctx = await asUser('dbarnes');
			const page = await ctx.newPage();
			await openNavigationTab(page, context.path);

			const menuName = `Test Nav Menu ${tag}`;
			const updatedMenuName = `${menuName} Updated`;

			// --- 1. Create ---
			let modal = await openAddMenuModal(page);

			// New-menu invariants: assigned panel is empty, unassigned
			// panel has a healthy starter set including Register / Login.
			await expect(
				modal.locator('[data-cy="assigned-panel"] [data-menu-item-title]'),
			).toHaveCount(0);
			const unassignedItems = modal.locator(
				'[data-cy="unassigned-panel"] [data-menu-item-title]',
			);
			expect(await unassignedItems.count()).toBeGreaterThan(4);
			await expect(
				modal.locator('[data-cy="unassigned-panel"]').getByText('Register'),
			).toBeVisible();
			await expect(
				modal.locator('[data-cy="unassigned-panel"]').getByText('Login'),
			).toBeVisible();

			await modal.locator('input[name="title"]').fill(menuName);
			await modal.getByRole('button', {name: 'Save'}).click();
			await expect(modal).toHaveCount(0, {timeout: 15_000});

			// New row appears in the menus grid.
			await expect(
				page
					.locator('#navigationMenuGridContainer tr.gridRow', {
						hasText: menuName,
					})
					.first(),
			).toBeVisible({timeout: 15_000});

			// --- 2. Edit title (clicking the row title opens the same
			// NavigationMenuManagerFormModal in edit mode) ---
			modal = await openEditMenuModalByTitle(page, menuName);
			const titleInput = modal.locator('input[name="title"]');
			await expect(titleInput).toHaveValue(menuName);
			await titleInput.fill(updatedMenuName);
			await modal.getByRole('button', {name: 'Save'}).click();
			await expect(modal).toHaveCount(0, {timeout: 15_000});

			await expect(
				page
					.locator('#navigationMenuGridContainer tr.gridRow', {
						hasText: updatedMenuName,
					})
					.first(),
			).toBeVisible({timeout: 15_000});

			// --- 3. Duplicate-title validation ---
			modal = await openAddMenuModal(page);
			await modal.locator('input[name="title"]').fill(updatedMenuName);
			await modal.getByRole('button', {name: 'Save'}).click();
			// Modal stays open; the inline error message is "This title
			// already exists for another navigation menu." (per
			// PKPNavigationMenuController + manager.po). The Cypress
			// source greps the prefix "This title already exists" — keep
			// the same anchor here so a future copy edit on the period
			// or sentence tail doesn't break the test. PkpForm renders
			// the message twice — once inline next to the field, once
			// in the form-level error footer ("Go to Title: …"); use
			// `.first()` so strict mode is happy.
			await expect(
				modal
					.getByText('This title already exists', {exact: false})
					.first(),
			).toBeVisible({timeout: 10_000});
			await cancelWithUnsavedChanges(page, modal);

			// --- 4. Area-conflict validation ---
			// Default Primary Navigation Menu (installed by
			// NavigationMenuDAO::installSettings) already occupies the
			// `primary` area. Selecting it on a new menu trips
			// PKPNavigationMenuController#304-310's getByArea check.
			modal = await openAddMenuModal(page);
			await modal.locator('input[name="title"]').fill(`${menuName} 2`);
			await modal.locator('select[name="areaName"]').selectOption('primary');
			await modal.getByRole('button', {name: 'Save'}).click();
			await expect(
				modal
					.getByText(
						'A navigation menu is already assigned to this area',
						{exact: false},
					)
					.first(),
			).toBeVisible({timeout: 10_000});
			await cancelWithUnsavedChanges(page, modal);

			// --- 5. Delete ---
			await clickRowAction(
				page,
				'#navigationMenuGridContainer',
				updatedMenuName,
				'Remove',
			);
			// RemoteActionConfirmationModal opens a jQuery-UI dialog
			// with an OK button.
			await page.getByRole('button', {name: 'OK'}).click();
			await expect(
				page.locator('#navigationMenuGridContainer', {
					hasText: updatedMenuName,
				}),
			).toHaveCount(0, {timeout: 15_000});
		
		},
	);

	test(
		'manager creates, edits, and deletes a custom navigation menu item',
		{tag: '@regression'},
		async ({pkpApi, asUser}) => {
			const tag = uniqueTag();
			const {context} = await pkpApi.createJournal({
				tag,
				name: {en: `Nav Item Scratch ${tag}`},
				users: [{username: 'dbarnes', roles: ['manager']}],
			});
			const ctx = await asUser('dbarnes');
			const page = await ctx.newPage();
			await openNavigationTab(page, context.path);

			const itemTitle = `Test Custom Item ${tag}`;
			const itemPath = `test-custom-item-${tag}`;
			const updatedTitle = `${itemTitle} Updated`;

			// The items grid sits on the same tab. Its "Add Item" link
			// action opens a jQuery-UI AjaxModal hosting
			// `form#navigationMenuItemsForm` (legacy fbv). Scope by the
			// stable add-item class so we don't accidentally hit a
			// per-row Edit / Remove anchor (the grid renders dozens
			// from the default Primary Navigation Menu install).
			await page
				.locator(
					'#navigationMenuItemsGridContainer a.pkp_linkaction_addNavigationMenuItem',
				)
				.click();

			const itemForm = page.locator('form#navigationMenuItemsForm');
			await expect(itemForm).toBeVisible({timeout: 10_000});

			// Switch the menuItemType to NMI_TYPE_CUSTOM, which reveals
			// the customNMIType.tpl section (path + content fields).
			await itemForm
				.locator('select[name="menuItemType"]')
				.selectOption('NMI_TYPE_CUSTOM');
			await itemForm.locator('input[name="title[en]"]').fill(itemTitle);
			await itemForm.locator('input[name="path"]').fill(itemPath);
			await itemForm.getByRole('button', {name: 'Save'}).click();
			await expect(itemForm).toHaveCount(0, {timeout: 15_000});

			// Verify the new item lands in the items grid.
			await expect(
				page
					.locator('#navigationMenuItemsGridContainer tr.gridRow', {
						hasText: itemTitle,
					})
					.first(),
			).toBeVisible({timeout: 15_000});

			// --- Edit ---
			await clickRowAction(
				page,
				'#navigationMenuItemsGridContainer',
				itemTitle,
				'Edit',
			);
			const editForm = page.locator('form#navigationMenuItemsForm');
			await expect(editForm).toBeVisible({timeout: 10_000});
			await editForm.locator('input[name="title[en]"]').fill(updatedTitle);
			await editForm.getByRole('button', {name: 'Save'}).click();
			await expect(editForm).toHaveCount(0, {timeout: 15_000});

			await expect(
				page
					.locator('#navigationMenuItemsGridContainer tr.gridRow', {
						hasText: updatedTitle,
					})
					.first(),
			).toBeVisible({timeout: 15_000});

			// --- Delete ---
			await clickRowAction(
				page,
				'#navigationMenuItemsGridContainer',
				updatedTitle,
				'Remove',
			);
			await page.getByRole('button', {name: 'OK'}).click();
			await expect(
				page.locator('#navigationMenuItemsGridContainer', {
					hasText: updatedTitle,
				}),
			).toHaveCount(0, {timeout: 15_000});

		},
	);

	test(
		'custom item assigned to the primary menu renders on the front end',
		{tag: '@regression'},
		async ({pkpApi, asUser, browser, baseURL}) => {
			// Plan row 3. A custom item WITH content is created through the
			// legacy item form, assigned into the default Primary
			// Navigation Menu via the Vue NavigationMenuEditor (DnD is the
			// editor's only move mechanism — no button/keyboard fallback
			// exists, see dragMenuItemAbove), and must then render in the
			// anonymous primary nav, linking to its
			// navigationMenuItemViewContent page.
			const tag = uniqueTag();
			const {context} = await pkpApi.createJournal({
				tag,
				name: {en: `Nav Front Scratch ${tag}`},
				users: [{username: 'dbarnes', roles: ['manager']}],
			});
			const ctx = await asUser('dbarnes');
			const page = await ctx.newPage();
			await openNavigationTab(page, context.path);

			const itemTitle = `Custom Page ${tag}`;
			const itemPath = `custom-${tag}`;
			const contentMarker = `Custom page content for ${tag}`;

			// --- 1. Create the custom item with content ---
			await page
				.locator(
					'#navigationMenuItemsGridContainer a.pkp_linkaction_addNavigationMenuItem',
				)
				.click();
			const itemForm = page.locator('form#navigationMenuItemsForm');
			await expect(itemForm).toBeVisible({timeout: 10_000});
			await itemForm
				.locator('select[name="menuItemType"]')
				.selectOption('NMI_TYPE_CUSTOM');
			await itemForm.locator('input[name="title[en]"]').fill(itemTitle);
			await itemForm.locator('input[name="path"]').fill(itemPath);
			// The content field is a legacy fbv rich textarea whose id is
			// runtime-suffixed ($FBV_uniqId, patterns.md pitfall 8) —
			// resolve the generated id off the stable name attribute.
			const contentId = await itemForm
				.locator('textarea[name="content[en]"]')
				.getAttribute('id');
			await setTinyMceContent(
				page,
				String(contentId),
				`<p>${contentMarker}</p>`,
			);
			await itemForm.getByRole('button', {name: 'Save'}).click();
			await expect(itemForm).toHaveCount(0, {timeout: 15_000});
			await expect(
				page
					.locator('#navigationMenuItemsGridContainer tr.gridRow', {
						hasText: itemTitle,
					})
					.first(),
			).toBeVisible({timeout: 15_000});

			// --- 2. Assign it into the default Primary Navigation Menu ---
			const modal = await openEditMenuModalByTitle(
				page,
				'Primary Navigation Menu',
			);
			const source = modal.locator(
				`[data-cy="panel-content-unassigned"] [data-menu-item-title="${itemTitle}"]`,
			);
			await expect(source).toBeVisible({timeout: 15_000});
			await dragMenuItemToAssignedRoot(page, modal, source);

			// The move is state-only until saved; the item must now sit in
			// the assigned panel at ROOT level (direct child of the panel
			// content — a nested placement would render it inside another
			// item's CSS-hidden front-end dropdown) and be gone from
			// unassigned.
			const assignedCopy = modal.locator(
				`[data-cy="panel-content-assigned"] > [data-cy^="menu-item-"] > [data-menu-item-title="${itemTitle}"]`,
			);
			await expect(assignedCopy).toBeVisible({timeout: 10_000});
			await expect(source).toHaveCount(0);

			// Save → PUT /api/v1/navigationMenus/{menuId} (tunneled as
			// POST + X-Http-Method-Override by useFetch).
			const saved = page.waitForResponse(
				(res) =>
					/\/api\/v1\/navigationMenus\/\d+/.test(res.url()) &&
					res.ok() &&
					['POST', 'PUT'].includes(res.request().method()),
				{timeout: 15_000},
			);
			await modal.getByRole('button', {name: 'Save'}).click();
			await saved;
			await expect(modal).toHaveCount(0, {timeout: 15_000});

			// --- 3. Anonymous front end renders the new entry ---
			const anon = await browser.newContext({
				baseURL,
				storageState: {cookies: [], origins: []},
			});
			try {
				const reader = await anon.newPage();
				const resp = await reader.goto(`/index.php/${context.path}/`);
				expect(resp?.status()).toBe(200);

				const nav = reader.locator('#navigationPrimary');
				await expect(nav).toBeVisible();
				const link = nav.getByRole('link', {name: itemTitle, exact: true});
				await expect(link).toBeVisible();

				// Clicking opens the custom content page
				// (NavigationMenuItemHandler::view →
				// navigationMenuItemViewContent.tpl).
				await link.click();
				await reader.waitForURL(new RegExp(itemPath), {
					waitUntil: 'commit',
				});
				await expect(reader.locator('h1.page_title')).toHaveText(
					itemTitle,
				);
				await expect(reader.locator('.page')).toContainText(contentMarker);
			} finally {
				await anon.close();
			}
		},
	);

	test(
		'default user-menu items display conditionally by auth state',
		{tag: '@regression'},
		async ({pkpApi, browser, baseURL}) => {
			// Plan row 4. New contexts install the default User Navigation
			// Menu (registry/navigationMenus.xml, `user` area): Register +
			// Login for anonymous visitors; a username dropdown (with
			// Logout) once authenticated — PKPNavigationMenuService::
			// getDisplayStatus flips the two sets server-side. A throwaway
			// user (created via the scenario's users[] password branch)
			// logs in through the real front-end login form so the seeded
			// baseline users' cached auth states stay untouched.
			const tag = uniqueTag();
			const username = `navu${tag.replace(/[^a-z0-9]/g, '')}`;
			const password = 'navUserPass1';
			const {context} = await pkpApi.createJournal({
				tag,
				name: {en: `Nav User Scratch ${tag}`},
				users: [{username, password, roles: ['reader']}],
			});

			const anon = await browser.newContext({
				baseURL,
				storageState: {cookies: [], origins: []},
			});
			try {
				const reader = await anon.newPage();
				const resp = await reader.goto(`/index.php/${context.path}/`);
				expect(resp?.status()).toBe(200);

				// --- Anonymous: Register + Login show, no user dropdown ---
				const userNav = reader.locator('#navigationUserWrapper');
				await expect(userNav).toBeVisible();
				const registerLink = userNav.getByRole('link', {
					name: 'Register',
					exact: true,
				});
				const loginLink = userNav.getByRole('link', {
					name: 'Login',
					exact: true,
				});
				await expect(registerLink).toBeVisible();
				await expect(loginLink).toBeVisible();
				expect(await registerLink.getAttribute('href')).toContain(
					'/user/register',
				);
				expect(await loginLink.getAttribute('href')).toContain('/login');
				await expect(
					userNav.locator('a[href*="/login/signOut"]'),
				).toHaveCount(0);

				// --- Log in through the front-end form (same selectors as
				// LoginPage: stable ids on userLogin.tpl) ---
				await loginLink.click();
				await reader.waitForURL(/\/login/, {waitUntil: 'commit'});
				await reader.locator('input#username').fill(username);
				await reader.locator('input#password').fill(password);
				await reader.locator('form#login button').click();
				await reader.waitForURL(
					(url) => !url.pathname.includes('/login'),
					{timeout: 15_000, waitUntil: 'commit'},
				);

				// --- Authenticated: username dropdown with Logout; the
				// Login/Register items are filtered out server-side ---
				await reader.goto(`/index.php/${context.path}/`);
				const userNavIn = reader.locator('#navigationUserWrapper');
				await expect(userNavIn).toBeVisible();
				// The dropdown parent renders {$loggedInUsername}.
				await expect(userNavIn.getByText(username).first()).toBeVisible();
				// The Logout child sits in the CSS-hidden dropdown submenu —
				// invisible to the accessibility tree until hover, so assert
				// presence via a CSS href locator (same pattern as the About
				// submenu in journal-homepage.spec.js).
				await expect(
					userNavIn.locator('a[href*="/login/signOut"]'),
				).toHaveCount(1);
				await expect(
					userNavIn.getByRole('link', {name: 'Register', exact: true}),
				).toHaveCount(0);
				await expect(
					userNavIn.getByRole('link', {name: 'Login', exact: true}),
				).toHaveCount(0);
			} finally {
				await anon.close();
			}
		},
	);
});
