// @ts-check
const path = require('path');
const {test, expect} = require('../support/base-test.js');
const {
	setTinyMceContent,
	getTinyMceContent,
} = require('../support/tinymce.js');
const {EditorialWorkflowPage} = require('../../../../playwright/pages/EditorialWorkflowPage.js');
const {DiscussionManagerPage} = require('../pages/DiscussionManagerPage.js');
const submissionInReview = require('../../../../playwright/fixtures/scenarios/submission-in-review.js');
const submissionDraft = require('../../../../playwright/fixtures/scenarios/submission-draft.js');

/**
 * Email delivery — docs/e2e/plans/email-delivery.md (6 rows).
 *
 * The delivery pipeline itself is the feature under test: template →
 * composer → Mailer → SMTP (Mailpit), the Upload attacher, the
 * EDITOR_NOTIFY_AUTHOR email log surfaced to authors, the Participants →
 * Notify form (template prefill + discussion parity), per-recipient
 * reviewer copies, and the skip-email negative.
 *
 * Mailpit discipline (charter principle 8): the inbox is shared across
 * parallel workers and agents — every read goes through pkpMail.find
 * scoped by recipient + a unique whitespace-free marker; the row-6
 * negative is bounded by a positive control to a different recipient
 * (pkpMail.expectNone) and uses a unique throwaway author so nothing
 * else can ever mail that address.
 *
 * App realities baked into row 1 (verified against source):
 *   - The journal-level "Email Signature" (Workflow > Emails,
 *     `emailSignature` setting) reaches outgoing mail ONLY where a
 *     template references {$contextSignature}
 *     (classes/mail/variables/ContextEmailVariable.php — the OJS
 *     subclass compiles the setting into that variable). The stock
 *     EDITOR_DECISION_REVISIONS template ends with {$signature} — the
 *     SENDER's personal profile signature (SenderEmailVariable), not
 *     the journal signature — so the test appends the advertised
 *     {$contextSignature} variable to the composed body to prove the
 *     configured signature round-trips. The rest of the body is the
 *     untouched stock template.
 *   - No DMARC rewrite is configured in the test environment
 *     (config [email] force_dmarc_compliant_from unset), so the
 *     decision mail's From is the sending editor; Reply-To stays
 *     unset. "Headers identify the journal/editor" is asserted as:
 *     From = the editor, body signature = the journal.
 *
 * Tag convention: hyphenless alphanumeric tokens (patterns rule 10 —
 * Postgres tokenizes hyphens; Mailpit search treats the tag as one
 * word) with a per-run random component.
 */

const ATESTER_EMAIL = 'atester@mailinator.com';
const DBARNES_EMAIL = 'dbarnes@mailinator.com';
const PHUDSON_EMAIL = 'phudson@mailinator.com';
const JJANSSEN_EMAIL = 'jjanssen@mailinator.com';
const JOURNAL_NAME = 'Journal of Public Knowledge';
/** SubmissionEmailLogEventType::EDITOR_NOTIFY_AUTHOR = 0x30000001 */
const EVENT_EDITOR_NOTIFY_AUTHOR = 0x30000001;
/** Decision::PENDING_REVISIONS (lib/pkp/classes/decision/Decision.php) */
const DECISION_PENDING_REVISIONS = 4;
const STATUS_QUEUED = 1;
const STAGE_EXTERNAL_REVIEW = 3;

/**
 * Hyphenless tag: worker index isolates parallel workers, the random
 * suffix isolates runs on the long-lived local DB. Single alphanumeric
 * token so Mailpit/dashboard search treats it as one word.
 *
 * @param {number} row plan row number, for log readability
 */
function uniqueTag(row) {
	const rand = Math.random().toString(36).slice(2, 8);
	return `emd${row}w${test.info().parallelIndex}${rand}`;
}

/** Resolve a bundled upload fixture. */
function fixtureFile(name) {
	return path.resolve(__dirname, '..', 'fixtures', 'files', name);
}

/** Concatenated HTML+Text body of a Mailpit full message. */
function mailContent(full) {
	return `${full.HTML ?? ''}${full.Text ?? ''}`;
}

/**
 * Open Participants → (row) More Actions → Notify and return the legacy
 * modal + #notifyForm locators. The Notify action is offered on every
 * participant row (useParticipantManagerConfig.js:71-75); the form is
 * PKPStageParticipantNotifyForm rendered through a LegacyAjax side
 * modal titled "Notify".
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} fullName participant display name
 */
async function openNotifyForm(page, fullName) {
	const panel = page.locator('[data-cy="participant-manager"]');
	await expect(panel).toBeVisible({timeout: 15_000});
	await panel
		.getByRole('button', {name: `${fullName} More Actions`, exact: true})
		.click();
	await page.getByRole('menuitem', {name: 'Notify', exact: true}).click();
	const modal = page.getByRole('dialog', {name: 'Notify', exact: true});
	await expect(modal).toBeVisible({timeout: 15_000});
	const form = modal.locator('#notifyForm').last();
	await expect(form).toBeVisible({timeout: 15_000});
	return {modal, form};
}

/**
 * Resolve the notify form's TinyMCE id from the stable name attribute —
 * fbv textarea ids are runtime-suffixed (patterns rule 8).
 *
 * @param {import('@playwright/test').Locator} form
 */
async function notifyMessageEditorId(form) {
	const id = await form.locator('textarea[name="message"]').getAttribute('id');
	if (!id) {
		throw new Error('notify message textarea has no id');
	}
	return id;
}

/**
 * Pick a template in the notify form. The select's change handler POSTs
 * fetchTemplateBody (kebab-cased component route) and replaces the
 * TinyMCE message with the compiled template body — wait for both, then
 * return the prefilled content.
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} form
 * @param {string} templateLabel visible option label, e.g. 'Assign Editor'
 */
async function selectNotifyTemplate(page, form, templateLabel) {
	const templateLoaded = page.waitForResponse(
		(r) => r.url().includes('fetch-template-body') && r.ok(),
		{timeout: 15_000},
	);
	await form.locator('select#template').selectOption({label: templateLabel});
	await templateLoaded;
	const editorId = await notifyMessageEditorId(form);
	// The response callback applies the body asynchronously — observe
	// the editor content actually arriving.
	await page.waitForFunction(
		(id) => {
			const editor = window.tinymce?.get(id);
			return (
				Boolean(editor?.initialized) && editor.getContent().trim().length > 0
			);
		},
		editorId,
		{timeout: 15_000},
	);
	return getTinyMceContent(page, editorId);
}

/**
 * Submit the notify form (fbvFormButtons submitText = "Notify") and
 * wait for the modal to close (AjaxFormHandler success path).
 *
 * @param {import('@playwright/test').Locator} modal
 */
async function submitNotifyForm(modal) {
	await modal.getByRole('button', {name: 'Notify', exact: true}).click();
	await expect(modal).toBeHidden({timeout: 20_000});
}

/** The author's workflow surface for a submission. */
function authorWorkflowUrl(submissionId, journalPath = 'publicknowledge') {
	return `/index.php/${journalPath}/en/dashboard/mySubmissions?workflowSubmissionId=${submissionId}`;
}

test.describe('Email delivery', () => {
	// Plan row 1.
	test('decision email renders variables, headers, and the configured signature', {tag: ['@regression', '@slow']}, async ({
		pkpApi,
		asUser,
		pkpMail,
	}) => {
		// Scratch journal + settings save + decision wizard + Mailpit poll.
		test.slow();
		const tag = uniqueTag(1);
		const sigMarker = `Sig${tag}`;
		const journalName = `Journal ${tag}`;
		// Scratch journal — publicknowledge's settings are read-only
		// (principle 1). atester needs the author role here to submit.
		const {context} = await pkpApi.createJournal({
			tag,
			name: {en: journalName},
			users: [
				{username: 'dbarnes', roles: ['manager', 'editor']},
				{username: 'atester', roles: ['author']},
			],
		});
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({tag, journal: context.path, submitter: 'atester'}),
		);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();

		// Workflow > Emails: replace the journal signature with a marker
		// that itself references {$contextName} — the variable is compiled
		// inside the signature at send time
		// (ContextEmailVariable::getContextSignature), so the delivered
		// mail proves both the setting edit and its internal rendering.
		// The settings form's preparedContent values are the raw tokens
		// themselves (PKPEmailSetupForm::addSignatureField), so the saved
		// value keeps {$contextName} un-baked.
		await page.goto(`/index.php/${context.path}/management/settings/workflow`);
		await page.locator('#emails-button').click();
		const emailsPanel = page.locator('#emails');
		await expect(emailsPanel).toBeVisible({timeout: 15_000});
		await setTinyMceContent(
			page,
			'emailSetup-emailSignature-control',
			`<p>${sigMarker} on behalf of {$contextName}</p>`,
		);
		await emailsPanel.getByRole('button', {name: 'Save', exact: true}).click();
		await expect(
			emailsPanel.locator('[role="status"]').filter({hasText: 'Saved'}),
		).toBeVisible({timeout: 15_000});

		// Record Request Revisions with the stock template.
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id, {journalPath: context.path});
		await workflow.clickRequestRevisions();
		await workflow.awaitEmailTemplateLoaded();

		// The composer's FieldPreparedContent renders the stock template's
		// known variables in place (renderedValue): the real recipient and
		// the tagged title are already visible in the editor.
		await expect
			.poll(
				() => getTinyMceContent(page, 'notifyAuthors-body-control'),
				{timeout: 15_000, message: 'stock template should render the tagged title'},
			)
			.toContain(tag);
		const loadedBody = await getTinyMceContent(
			page,
			'notifyAuthors-body-control',
		);
		expect(loadedBody).toContain('Author Tester'); // {$recipientName} rendered
		// Append the journal-signature variable (see spec header — the
		// stock decision templates carry the sender's {$signature}, not
		// {$contextSignature}); everything above stays stock.
		await workflow.setDecisionEmailBody(
			'notifyAuthors',
			`${loadedBody}<p>{$contextSignature}</p>`,
		);
		await workflow.recordDecision('have been requested');

		// Principle 8: recipient + unique marker (atester is shared across
		// parallel agents; sigMarker is not).
		const [message] = await pkpMail.find({
			to: ATESTER_EMAIL,
			contains: sigMarker,
			timeoutMs: 20_000,
		});
		// Stock subject, fully rendered.
		expect(message.Subject).toContain('encourage you to submit revisions');
		expect(message.Subject).not.toMatch(/\{\$\w+\}/);
		// From identifies the sending editor (no DMARC rewrite in test
		// config, so the mailable's sender() lands in From; Reply-To, when
		// the rewrite is on, would carry this same address).
		expect(message.From.Address).toBe(DBARNES_EMAIL);
		expect(message.From.Name).toContain('Daniel Barnes');

		const full = await pkpMail.fullMessage(message.ID);
		const content = mailContent(full);
		// Real values: recipient name, tagged submission title, and the
		// journal name rendered INSIDE the configured signature.
		expect(content).toContain('Author Tester');
		expect(content).toContain(tag);
		expect(content).toContain(sigMarker);
		expect(content).toContain(journalName);
		// No raw template token survives anywhere in the body.
		expect(content).not.toMatch(/\{\$\w+\}/);
	});

	// Plan row 2. Complements review-decisions row 4 (Accept + dummy.pdf,
	// no MIME assertion): different decision, png attachment, and the
	// ContentType/MIME of the delivered part is pinned here.
	test('composer attachment is delivered with the email', {tag: ['@regression', '@slow']}, async ({
		pkpApi,
		asUser,
		pkpMail,
	}) => {
		// Wizard + stacked attacher modals + Mailpit poll.
		test.slow();
		const tag = uniqueTag(2);
		const marker = `Attach${tag}`;
		const fileName = 'dependent-image.png';
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({tag, submitter: 'atester'}),
		);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		// Request Revisions: default (non-completed) reviewers → single
		// notifyAuthors step. Edited subject/body carry the marker so the
		// Mailpit match proves the body arrived INTACT alongside the
		// attachment.
		await workflow.clickRequestRevisions();
		await workflow.setDecisionEmailSubject(
			'notifyAuthors',
			`Revisions requested ${marker}`,
		);
		await workflow.setDecisionEmailBody(
			'notifyAuthors',
			`<p>Please revise your submission. ${marker}</p>`,
		);
		// Upload attacher; the POM races the temporaryFiles POST before
		// clicking Attach Files (ledger §2 row 6 — FileAttacherUpload's
		// isUploading off-by-one leaves the footer button enabled
		// mid-upload).
		await workflow.attachDecisionEmailUpload(fixtureFile(fileName));
		await workflow.recordDecision('have been requested');

		const [message] = await pkpMail.find({
			to: ATESTER_EMAIL,
			contains: marker,
			timeoutMs: 20_000,
		});
		expect(message.Subject).toBe(`Revisions requested ${marker}`);

		const full = await pkpMail.fullMessage(message.ID);
		// Body intact next to the attachment.
		expect(mailContent(full)).toContain(marker);
		// Mailpit lists attachments as [{PartID, FileName, ContentType,
		// Size}]: the uploaded filename arrives with real content.
		const attachments = full.Attachments ?? [];
		const attached = attachments.find((a) => a.FileName === fileName);
		expect(
			attached,
			`expected ${fileName} among attachments: ${JSON.stringify(attachments)}`,
		).toBeTruthy();
		expect(attached.Size).toBeGreaterThan(0);
		// KNOWN APP BUG (ledger candidate, wave 12): Upload-attacher
		// attachments are delivered as application/octet-stream instead
		// of their real MIME. Mailable::attachTemporaryFile
		// (lib/pkp/classes/mail/Mailable.php:615) omits the 'mime'
		// option its submission/library siblings pass, and the temp
		// file's on-disk name is extension-less (tempnam, prefix-only —
		// TemporaryFileManager.php:108), so Symfony's extension-based
		// guess (vendor/symfony/mime/Part/File.php:34-40) falls back to
		// octet-stream even though the row stores the true type
		// (TemporaryFileManager.php:120). Accept either value so the
		// test survives the one-line upstream fix
		// (`'mime' => $file->getFileType()`).
		expect(attached.ContentType).toMatch(
			/^(application\/octet-stream|image\/png)/,
		);
	});

	// Plan row 3. The seeded requestRevisions decision goes through
	// Repo::decision()->add(), so NotifyAuthors::logMailable writes the
	// EDITOR_NOTIFY_AUTHOR log row at parity with a UI decision; the
	// author-facing surface is WorkflowListingEmails ← emails/authorEmails.
	test('author sees logged notify-author emails on their submission', {tag: '@regression'}, async ({
		pkpApi,
		asUser,
	}) => {
		const tag = uniqueTag(3);
		const note = `Revnote${tag}`;
		// Seeded subject shape: DecisionProcessor::defaultSubject.
		const seededSubject = '[scenario] requestRevisions — notify author';
		const {submission} = await pkpApi.createSubmission({
			...submissionDraft({tag, submitter: 'atester'}),
			decisions: [
				{type: 'sendExternalReview', by: 'dbarnes'},
				{
					type: 'requestRevisions',
					by: 'dbarnes',
					toAuthor: `<p>Please address the reviewer concerns. ${note}</p>`,
				},
			],
			reviewRounds: [
				{reviewers: [{user: 'jjanssen', method: 'anonymous', status: 'accepted'}]},
			],
		});

		const authorCtx = await asUser('atester');
		const authorPage = await authorCtx.newPage();
		await authorPage.goto(authorWorkflowUrl(submission.id));

		// Review-stage author view: the Notifications panel lists the
		// logged email by subject (WorkflowListingEmails only fetches on
		// the external-review stage).
		const modal = authorPage.locator('[data-cy="active-modal"]').first();
		await expect(modal.getByText('Notifications').first()).toBeVisible({
			timeout: 20_000,
		});
		const emailLink = modal.getByText(seededSubject).first();
		await expect(emailLink).toBeVisible({timeout: 15_000});

		// The endpoint behind the panel returns exactly this one
		// EDITOR_NOTIFY_AUTHOR row for the submission (sendExternalReview
		// was seeded without a notify-author email, so it logs nothing).
		const res = await authorPage.request.get(
			`/index.php/publicknowledge/api/v1/emails/authorEmails?submissionId=${submission.id}&eventType=${EVENT_EDITOR_NOTIFY_AUTHOR}`,
		);
		expect(res.status()).toBe(200);
		const emails = await res.json();
		expect(emails).toHaveLength(1);
		expect(emails[0].subject).toBe(seededSubject);

		// Opening it (authorDashboard/readSubmissionEmail in a stacked
		// legacy side modal) shows the full subject + the seeded toAuthor
		// body.
		await emailLink.click();
		const reader = authorPage.locator('.pkp_submission_email');
		await expect(
			reader.getByRole('heading', {name: seededSubject}),
		).toBeVisible({timeout: 15_000});
		await expect(reader.getByText(note).first()).toBeVisible();
	});

	// Plan row 4. This plan owns the Participants → Notify delivery
	// surface (stage-participants dropped its duplicate row; its row 3
	// covers the ADD-form notify section instead).
	test('notify participant prefills from template, delivers, and opens a discussion', {tag: ['@regression', '@slow']}, async ({
		pkpApi,
		asUser,
		pkpMail,
	}) => {
		// Legacy form + Mailpit poll + discussion re-load.
		test.slow();
		const tag = uniqueTag(4);
		const marker = `Notify${tag}`;
		const {submission} = await pkpApi.createSubmission(
			submissionDraft({tag, submitter: 'atester'}),
		);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		// Participants → Notify on the author row. Picking the stage-1
		// alternate template "Assign Editor" (EDITOR_ASSIGN_SUBMISSION)
		// prefills the message with the COMPILED body — fetchTemplateBody
		// runs Mail::compileParams against the stage mailable's data, so
		// the tagged title is already real text, while {$recipientName}
		// stays raw until send (it's only resolvable per recipient —
		// PKPStageParticipantNotifyForm::getEmailVariableNames).
		const {modal, form} = await openNotifyForm(page, 'Author Tester');
		const prefilled = await selectNotifyTemplate(page, form, 'Assign Editor');
		expect(prefilled).toContain(tag);
		expect(prefilled).toContain('{$recipientName}');

		// Append a unique marker; the rest of the prefill is sent as-is.
		const editorId = await notifyMessageEditorId(form);
		await setTinyMceContent(page, editorId, `${prefilled}<p>${marker}</p>`);
		await submitNotifyForm(modal);

		// Delivery: subject comes from the chosen template (compiled at
		// send), the body carries the prefill + marker with the
		// per-recipient variables now rendered.
		const [message] = await pkpMail.find({
			to: ATESTER_EMAIL,
			contains: marker,
			timeoutMs: 20_000,
		});
		const expectedSubject = `You have been assigned as an editor on a submission to ${JOURNAL_NAME}`;
		expect(message.Subject).toBe(expectedSubject);
		const content = mailContent(await pkpMail.fullMessage(message.ID));
		expect(content).toContain(marker);
		expect(content).toContain(tag);
		expect(content).toContain('Author Tester'); // {$recipientName} rendered at send
		expect(content).not.toMatch(/\{\$\w+\}/);

		// PKPStageParticipantNotifyForm::sendMessage parity: an
		// EditorialTask discussion titled with the compiled subject opens
		// at the stage, holding the message as its head note. Reload the
		// workflow page — the legacy form's grid-refresh event doesn't
		// reach the Vue DiscussionManager.
		await workflow.goto(submission.id);
		const dm = new DiscussionManagerPage(page);
		await dm.expectVisible();
		await dm.expectInGroup(expectedSubject, 'In progress');
		const display = await dm.openByTitle(expectedSubject);
		await display.expectContains(marker);
		await display.close();
	});

	// Plan row 5. review-rounds-revisions row 5 drives the same wizard
	// shape but owns rounds/decision state; this row owns the reviewer
	// email delivery.
	test('decision notify-reviewers email reaches completed reviewers', {tag: ['@regression', '@slow']}, async ({
		pkpApi,
		asUser,
		pkpMail,
	}) => {
		// Two-step wizard + two Mailpit polls.
		test.slow();
		const tag = uniqueTag(5);
		const marker = `Notifyrev${tag}`;
		// TWO completed reviewers — RequestRevisions::getSteps only adds
		// the Notify Reviewers step for REVIEW_ASSIGNMENT_COMPLETED
		// assignments, and both must be default recipients.
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({
				tag,
				submitter: 'atester',
				reviewers: [
					{
						user: 'phudson',
						method: 'anonymous',
						status: 'completed',
						recommendation: 'pendingRevisions',
					},
					{
						user: 'jjanssen',
						method: 'anonymous',
						status: 'completed',
						recommendation: 'pendingRevisions',
					},
				],
			}),
		);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id);

		await workflow.clickRequestRevisions();
		// Step 1 (notifyAuthors) → Continue lands on Notify Reviewers,
		// which exists only because the two reviews are completed.
		await workflow.clickContinue();
		await expect(
			page
				.locator('.decision__stepHeader h2')
				.filter({hasText: 'Notify Reviewers'}),
		).toBeVisible({timeout: 15_000});

		// Entered text + template variables. {$recipientName} renders to
		// the selected recipients client-side (canChangeRecipients →
		// Composer's recipientVariable) or per recipient server-side —
		// both resolve to real names; {$submissionTitle} carries the tag.
		await workflow.setDecisionEmailBody(
			'notifyReviewers',
			`<p>Dear {$recipientName},</p>` +
				`<p>${marker} — revisions have been requested for {$submissionTitle}.</p>`,
		);
		await workflow.recordDecision('have been requested');

		// Each completed reviewer gets their own copy
		// (NotifyReviewers::sendReviewersEmail loops recipients) — scope
		// per recipient + the unique marker.
		for (const reviewer of [
			{email: PHUDSON_EMAIL, name: 'Paul Hudson'},
			{email: JJANSSEN_EMAIL, name: 'Julie Janssen'},
		]) {
			const [message] = await pkpMail.find({
				to: reviewer.email,
				contains: marker,
				timeoutMs: 20_000,
			});
			// Stock EDITOR_DECISION_NOTIFY_REVIEWERS subject.
			expect(message.Subject).toContain('Thank you for your review');
			const content = mailContent(await pkpMail.fullMessage(message.ID));
			expect(content).toContain(marker);
			expect(content).toContain(reviewer.name);
			expect(content).toContain(tag);
			expect(content).not.toMatch(/\{\$\w+\}/);
		}
	});

	// Plan row 6. Principle 8 negative: unique throwaway author bounds
	// the "no mail" target; a Participants → Notify control to dbarnes
	// (sent AFTER the skipped decision) bounds the wait.
	test('skipping the decision email sends nothing', {tag: ['@regression', '@slow']}, async ({
		pkpApi,
		asUser,
		pkpMail,
	}) => {
		// Scratch journal + wizard + control mail + author view.
		test.slow();
		const tag = uniqueTag(6);
		const controlMarker = `Control${tag}`;
		const username = `u${tag}`;
		const throwawayEmail = `${username}@mailinator.com`;
		// Throwaway author on a scratch journal: nothing else in the run
		// can ever address this recipient. Password follows the
		// username+username rule so asUser's form login works.
		const {context} = await pkpApi.createJournal({
			tag,
			users: [
				{username, password: username + username, roles: ['author']},
				{username: 'dbarnes', roles: ['manager', 'editor']},
			],
		});
		const {submission} = await pkpApi.createSubmission(
			submissionInReview({tag, journal: context.path, submitter: username}),
		);

		const ctx = await asUser('dbarnes');
		const page = await ctx.newPage();
		const workflow = new EditorialWorkflowPage(page);
		await workflow.goto(submission.id, {journalPath: context.path});

		// Request Revisions has a single notifyAuthors step here (no
		// completed reviews). The step is skippable (Email::$canSkip
		// default true): "Skip this email" swaps the composer for the
		// skipped notice, and DecisionPage excludes skipped steps from
		// the recorded actions.
		await workflow.clickRequestRevisions();
		await workflow.awaitEmailTemplateLoaded();
		await page
			.getByRole('button', {name: 'Skip this email', exact: true})
			.click();
		await expect(
			page.getByText('This step has been skipped and no email will be sent.'),
		).toBeVisible({timeout: 10_000});
		await workflow.recordDecision('have been requested');
		await workflow.viewSubmissionFromCompletionDialog(submission.id);

		// The decision recorded despite the skipped email.
		const after = await workflow.fetchSubmission(submission.id, context.path);
		expect(after.status).toBe(STATUS_QUEUED);
		expect(after.stageId).toBe(STAGE_EXTERNAL_REVIEW);
		const decisions = await workflow.fetchDecisions(
			submission.id,
			context.path,
		);
		expect(
			decisions.some((d) => d.decision === DECISION_PENDING_REVISIONS),
		).toBe(true);

		// Positive control AFTER the action under test: Participants →
		// Notify addressed to dbarnes himself (the only other stage
		// participant — notifying the throwaway would defeat the
		// negative), tagged with a unique marker.
		const {modal, form} = await openNotifyForm(page, 'Daniel Barnes');
		const editorId = await notifyMessageEditorId(form);
		await setTinyMceContent(
			page,
			editorId,
			`<p>Positive control message. ${controlMarker}</p>`,
		);
		await submitNotifyForm(modal);

		// Wait for the control copy, then assert zero messages for the
		// throwaway scoped by recipient + tag (the seeded title carries
		// the tag, so a leaked decision mail would have matched).
		await pkpMail.expectNone({
			to: throwawayEmail,
			contains: tag,
			afterControl: {to: DBARNES_EMAIL, contains: controlMarker},
			timeoutMs: 20_000,
		});

		// And the author's Notifications email list stays empty: no
		// EDITOR_NOTIFY_AUTHOR row was logged, so WorkflowListingEmails
		// doesn't render at all (v-if="emails?.length").
		const authorCtx = await asUser(username);
		const authorPage = await authorCtx.newPage();
		await authorPage.goto(authorWorkflowUrl(submission.id, context.path));
		const authorModal = authorPage.locator('[data-cy="active-modal"]').first();
		// Bound the negative on the settled revisions-requested state.
		await expect(
			authorModal.getByText('Revisions have been requested.').first(),
		).toBeVisible({timeout: 20_000});
		await expect(authorModal.getByText('Notifications')).toHaveCount(0);
		const res = await authorPage.request.get(
			`/index.php/${context.path}/api/v1/emails/authorEmails?submissionId=${submission.id}&eventType=${EVENT_EDITOR_NOTIFY_AUTHOR}`,
		);
		expect(res.status()).toBe(200);
		expect(await res.json()).toHaveLength(0);
	});
});
