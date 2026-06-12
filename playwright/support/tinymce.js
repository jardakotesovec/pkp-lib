// @ts-check

/**
 * Set the contents of a TinyMCE editor instance. Playwright has no
 * built-in equivalent — `page.fill` can't reach inside the editor's
 * iframe body, and `page.frameLocator(...).locator('body').fill(...)`
 * fights TinyMCE's own event machinery.
 *
 * Works by calling `tinymce.get(id).setContent(html)` directly on the
 * page, after waiting for the editor to finish initializing. Matches
 * the pattern the Cypress suite has used for years
 * (lib/pkp/cypress/support/commands.js:36-62).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} editorId  the control id, e.g. 'discussionForm-description-control'
 * @param {string} content   HTML to set (plain text is fine; TinyMCE wraps it)
 * @param {{timeout?: number}} [opts]
 */
exports.setTinyMceContent = async function setTinyMceContent(
	page,
	editorId,
	content,
	{timeout = 10_000} = {},
) {
	// Log which editors are mounted at the time we try to wait for ours
	// so a miss on editorId is actionable.
	try {
		await page.waitForFunction(
			(id) => Boolean(window.tinymce?.get(id)?.initialized),
			editorId,
			{timeout},
		);
	} catch (err) {
		// `tinymce.editors` was removed in TinyMCE 6 — enumerate live
		// editors via the no-arg `tinymce.get()` instead (OJS ships 7.x;
		// the old property made this diagnostic always report []).
		const editors = await page.evaluate(() => {
			const tiny = window.tinymce;
			const list =
				(typeof tiny?.get === 'function' ? tiny.get() : null) ?? [];
			return list.map((e) => ({
				id: e.id,
				initialized: e.initialized,
			}));
		});
		throw new Error(
			`setTinyMceContent: editor '${editorId}' never initialised. ` +
			`Mounted editors: ${JSON.stringify(editors)}`,
		);
	}

	await setContent(page, editorId, content);
};

/**
 * Read the contents of a TinyMCE editor instance. The mirror of
 * `setTinyMceContent` — used by specs that assert persisted values
 * after a reload (e.g. wizard autosave restore). Waits for the editor
 * to initialise, then returns `tinymce.get(id).getContent()` (HTML).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} editorId  the control id, e.g. 'titleAbstract-title-control-en'
 * @param {{timeout?: number}} [opts]
 * @returns {Promise<string>} the editor's HTML content
 */
exports.getTinyMceContent = async function getTinyMceContent(
	page,
	editorId,
	{timeout = 10_000} = {},
) {
	await page.waitForFunction(
		(id) => Boolean(window.tinymce?.get(id)?.initialized),
		editorId,
		{timeout},
	);
	return page.evaluate(
		(id) => window.tinymce.get(id).getContent(),
		editorId,
	);
};

async function setContent(page, editorId, content) {
	// Set content and trigger the full pipeline `tinymce-vue` listens on.
	// The Vue bridge maps TinyMCE's `Change` / `Input` events to the
	// `change` / `input` v-model events PKP's FieldRichTextarea binds
	// against, so firing both ensures parent components see the new
	// value (and e.g. enable their Save buttons). Using the `dispatch`
	// API (preferred over the legacy `fire` alias) avoids deprecation
	// warnings on TinyMCE 8+.
	await page.evaluate(
		({id, html}) => {
			const editor = window.tinymce.get(id);
			editor.setContent(html);
			editor.save(); // flushes content to the backing <textarea>
			const dispatch = editor.dispatch ?? editor.fire;
			dispatch.call(editor, 'Change');
			dispatch.call(editor, 'Input');
			dispatch.call(editor, 'KeyUp');
			const ta = document.getElementById(id);
			if (ta) {
				ta.dispatchEvent(new Event('input', {bubbles: true}));
				ta.dispatchEvent(new Event('change', {bubbles: true}));
			}
		},
		{id: editorId, html: content},
	);
}
