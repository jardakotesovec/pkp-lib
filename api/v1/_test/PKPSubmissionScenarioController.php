<?php

/**
 * @file api/v1/_test/PKPSubmissionScenarioController.php
 *
 * Copyright (c) 2026 Simon Fraser University
 * Copyright (c) 2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class PKPSubmissionScenarioController
 *
 * @ingroup api_v1_test
 *
 * @brief Handles POST /api/v1/_test/scenarios/submission — creates a
 *        single submission with any combination of participants,
 *        decisions, review rounds, and publications as declared in the
 *        spec.
 *
 * Gated by the TestModeGate middleware (APPLICATION_ENV === 'test' and
 * X-Test-Key header match). Dispatches a fixed pipeline of processors
 * inside a single DB::transaction so any processor failure rolls the
 * whole scenario back.
 */

namespace PKP\API\v1\_test;

use APP\core\Application;
use APP\facades\Repo;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Route;
use PKP\core\PKPBaseController;
use PKP\core\PKPRequest;
use PKP\security\Validation;
use PKP\testing\scenario\Processor\DecisionProcessor;
use PKP\testing\scenario\Processor\ParticipantProcessor;
use PKP\testing\scenario\Processor\PublicationsProcessor;
use PKP\testing\scenario\Processor\ReviewRoundProcessor;
use PKP\testing\scenario\Processor\SubmissionBuilderProcessor;
use PKP\testing\scenario\Processor\UserCommentProcessor;
use PKP\testing\scenario\ScenarioContext;

class PKPSubmissionScenarioController extends PKPBaseController
{
    public function getHandlerPath(): string
    {
        return '_test/scenarios';
    }

    public function getRouteGroupMiddleware(): array
    {
        return ['test.mode'];
    }

    public function getGroupRoutes(): void
    {
        Route::post('submission', $this->submission(...))
            ->name('test.scenarios.submission');
    }

    /**
     * TestModeGate is the only authorization we apply to this endpoint.
     */
    public function authorize(PKPRequest $request, array &$args, array $roleAssignments): bool
    {
        return true;
    }

    public function submission(Request $illuminateRequest): JsonResponse
    {
        $spec = $illuminateRequest->all();

        $schemaPath = __DIR__ . '/../../../classes/testing/scenario/schema/submission.json';
        $validationError = $this->validateAgainstSchema($spec, $schemaPath);
        if ($validationError !== null) {
            return response()->json(['error' => 'Invalid spec', 'details' => $validationError], Response::HTTP_BAD_REQUEST);
        }

        // `journal` is the historical (OJS-only) spelling of `context`.
        // Normalise once, here, so every processor downstream reads a
        // single key. Both spellings are then present on $spec, which
        // keeps app subclasses and their afterSubmissionCreated() hooks
        // working whichever one they were written against.
        $spec = $this->normaliseContextKey($spec);

        // Capture outbound mail for the whole request so decisions etc.
        // don't queue real messages. Other events (event log, notifications)
        // fire normally so tests can observe them.
        Mail::fake();

        // The scenario endpoint isn't routed through a context-bearing URL,
        // so OJS's Request->getContext() returns null. A number of Repo
        // side-effects (notifications, event log) dereference that context,
        // NPE'ing on us. Attach the spec's journal to the PKPRouter so those
        // internals see something sane. This is a workaround for an OJS
        // internal assumption, not a user-facing contract — tests still
        // think of the endpoint as context-agnostic.
        //
        // Stash + restore the prior `_context` so a residue can't leak to
        // a sibling request handled by the same PHP-CLI worker process
        // under workers=2 (mirrors the Registry::set/get save-restore
        // pattern in ContextBuilderProcessor).
        $contextPath = $spec['context'];
        $context = Application::getContextDAO()->getByPath($contextPath);
        if (!$context) {
            return response()->json(
                ['error' => "Context '{$contextPath}' not found. Bootstrap must seed it first."],
                Response::HTTP_BAD_REQUEST
            );
        }
        $router = Application::get()->getRequest()->getRouter();
        $previousRouterContext = $router->_context;
        $router->_context = $context;

        // Do NOT call Validation::registerUserSession here — Playwright's
        // `request` fixture shares cookies with the browser context, so
        // mutating the session from this endpoint regenerates the browser
        // user's OJSSID and drops their remember_web cookie. The net
        // effect is the browser ends up logged out mid-test. The Repo
        // side-effects we need only require a context ($request->getContext())
        // and an editor-by-id (passed in each decision spec), not a
        // "current user" from the session.

        $ctx = new ScenarioContext();
        $submissionBuilder = $this->newSubmissionBuilderProcessor();
        $participantProcessor = new ParticipantProcessor();
        $reviewRoundProcessor = $this->newReviewRoundProcessor();
        $decisionProcessor = $this->newDecisionProcessor($reviewRoundProcessor);
        $publicationsProcessor = new PublicationsProcessor();
        $userCommentProcessor = new UserCommentProcessor();

        // No DB::transaction wrapper — running each processor in its
        // own implicit transaction lets Postgres release row locks as
        // soon as each statement commits. Wrapping the whole scenario
        // in a single transaction caused parallel-worker calls to
        // serialize on the journals.seq UPDATE that fires inside
        // ContextDAO::resequence (and several other multi-row writes).
        // Trade-off — partial state on processor failure — is fine
        // because each test uses its own scratch submission and the
        // test DB is reset between runs.
        try {
            try {
                $submissionBuilder->run($spec, $ctx);
                if ($participantProcessor->appliesTo($spec)) {
                    $participantProcessor->run($spec, $ctx);
                }
                if ($decisionProcessor->appliesTo($spec)) {
                    $decisionProcessor->run($spec, $ctx);
                }
                if ($publicationsProcessor->appliesTo($spec)) {
                    $publicationsProcessor->run($spec, $ctx);
                }
                if ($userCommentProcessor->appliesTo($spec)) {
                    $userCommentProcessor->run($spec, $ctx);
                }
            } catch (\Throwable $e) {
                return response()->json([
                    'error' => 'Scenario build failed',
                    'message' => $e->getMessage(),
                    'class' => get_class($e),
                    'file' => $e->getFile() . ':' . $e->getLine(),
                ], Response::HTTP_INTERNAL_SERVER_ERROR);
            }

            return response()->json($ctx->submissionResponse($spec['tag'] ?? ''), Response::HTTP_OK);
        } finally {
            $router->_context = $previousRouterContext;
        }
    }

    /**
     * Accept either spelling of the owning-context key and republish both,
     * with `context` authoritative. Called after schema validation, which
     * already guarantees at least one of the two is present (the schema's
     * anyOf), so the null-coalescing chain cannot fall through.
     */
    private function normaliseContextKey(array $spec): array
    {
        $path = $spec['context'] ?? $spec['journal'];
        $spec['context'] = $path;
        $spec['journal'] = $path;
        return $spec;
    }

    /**
     * Factories for the processors whose behaviour is app-shaped. Apps
     * override to return their own subclass:
     *
     *  - submission builder — OJS/OPS put the submission in a `section`
     *    (publication.sectionId); OMP puts it in a `series`
     *    (publication.seriesId), a column OJS/OPS don't have.
     *  - decision processor — the decision vocabulary is app-keyed: OMP
     *    adds the whole internal-review family, OPS keeps only
     *    Decline/Revert.
     *  - review-round processor — apps may need a different reviewer
     *    default shape; kept a factory for symmetry with the above.
     */
    protected function newSubmissionBuilderProcessor(): SubmissionBuilderProcessor
    {
        return new SubmissionBuilderProcessor();
    }

    protected function newReviewRoundProcessor(): ReviewRoundProcessor
    {
        return new ReviewRoundProcessor();
    }

    protected function newDecisionProcessor(ReviewRoundProcessor $reviewRoundProcessor): DecisionProcessor
    {
        return new DecisionProcessor($reviewRoundProcessor);
    }

    /**
     * App-specific additions to the scenario spec schema. The schema sets
     * additionalProperties:false, so app-only spec keys (e.g. OJS's
     * metrics) must be declared here to pass validation. Return a map of
     * property name => JSON-schema definition as plain PHP arrays, e.g.
     * ['metrics' => ['type' => 'object', 'properties' => [...]]].
     * Merged into the schema's properties before validation; default none.
     */
    protected function schemaOverlayProperties(): array
    {
        return [];
    }

    /**
     * App-specific additions to a *nested* definition in the schema's
     * `$defs` block — the mechanism the publishing-container and
     * representation overlays use, since those keys live on
     * `$defs/publication`, not at the spec root.
     *
     * Return [ '<def name>' => [ '<property>' => <JSON-schema array> ] ];
     * each property is merged into `$defs.<def name>.properties`, which
     * also exempts it from that definition's additionalProperties:false.
     * Overlay definitions may `$ref` the shared building blocks that stay
     * in the schema file (`#/$defs/issue`, `#/$defs/galley`,
     * `#/$defs/mediaFile`).
     *
     * Example (OJS): ['publication' => ['issue' => ['$ref' => '#/$defs/issue']]]
     */
    protected function schemaOverlayDefProperties(): array
    {
        return [];
    }

    /**
     * Spec keys the app makes mandatory on top of the shared `required`
     * list. Exists because a key can be app-only AND non-optional: OJS
     * requires `section` on every submission, but `section` is not a
     * cross-app concept and so cannot sit in the shared schema.
     *
     * @return string[]
     */
    protected function schemaRequiredOverlay(): array
    {
        return [];
    }

    /**
     * Validate the spec against schema/submission.json (with the app's
     * schemaOverlayProperties() merged in). Returns a human-readable
     * error string naming the offending key(s)/path(s), or null when
     * the spec is valid.
     *
     * Mirrors PKPContextScenarioController::validateAgainstSchema — the
     * two scenario controllers share no base/trait below PKPBaseController
     * (which is production code, not a place for test-only helpers), so
     * the logic is duplicated inline. Keep both copies in sync.
     *
     * @throws \RuntimeException when the validator dependency is missing —
     *   this endpoint only exists in test mode, where silently skipping
     *   validation would let malformed specs seed misleading state.
     */
    private function validateAgainstSchema(array $spec, string $schemaPath): ?string
    {
        if (!is_readable($schemaPath)) {
            return "Schema file not found: {$schemaPath}";
        }

        if (!class_exists(\Opis\JsonSchema\Validator::class)) {
            throw new \RuntimeException(
                'opis/json-schema is not installed but is required to validate scenario specs in test mode. '
                . 'Run `composer install` in lib/pkp (it is declared in require-dev).'
            );
        }

        $schema = json_decode(file_get_contents($schemaPath));
        if (!is_object($schema)) {
            return "Schema file is not valid JSON: {$schemaPath}";
        }
        foreach ($this->schemaOverlayProperties() as $property => $definition) {
            // Adding the property to `properties` also exempts it from the
            // additionalProperties:false check (draft-07 semantics).
            $schema->properties->{$property} = json_decode(json_encode($definition));
        }
        foreach ($this->schemaRequiredOverlay() as $property) {
            if (!in_array($property, $schema->required ?? [], true)) {
                $schema->required[] = $property;
            }
        }
        foreach ($this->schemaOverlayDefProperties() as $defName => $properties) {
            if (!isset($schema->{'$defs'}->{$defName})) {
                return "Schema has no \$defs/{$defName} to overlay properties onto";
            }
            foreach ($properties as $property => $definition) {
                $schema->{'$defs'}->{$defName}->properties->{$property}
                    = json_decode(json_encode($definition));
            }
        }

        $validator = new \Opis\JsonSchema\Validator();
        $result = $validator->validate(json_decode(json_encode($spec)), $schema);
        if ($result->isValid()) {
            return null;
        }

        $error = $result->error();
        if (!$error) {
            return 'Validation failed';
        }
        $messages = [];
        foreach ((new \Opis\JsonSchema\Errors\ErrorFormatter())->format($error) as $path => $pathMessages) {
            foreach ((array) $pathMessages as $message) {
                $messages[] = "{$path}: {$message}";
            }
        }
        return implode('; ', $messages) ?: 'Validation failed';
    }
}
