<?php

/**
 * @file api/v1/_test/PKPContextScenarioController.php
 *
 * Copyright (c) 2026 Simon Fraser University
 * Copyright (c) 2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class PKPContextScenarioController
 *
 * @ingroup api_v1_test
 *
 * @brief Handles POST requests that build a scratch context (journal/press/
 *        server) for per-test scenarios. Concrete subclass registers the
 *        app-specific route — OJS's JournalScenarioController registers
 *        `journal`, OMP's would register `press`, OPS's `server`.
 *
 * Tests that mutate context-level configuration (sections, email templates,
 * plugin settings, reviewer recommendations, task templates, …) create
 * their own scratch context via this endpoint so the bootstrapped
 * publicknowledge journal stays read-only for the rest of the suite.
 *
 * Gated by the TestModeGate middleware (APPLICATION_ENV === 'test' and
 * X-Test-Key header match). Each processor runs in its own implicit
 * transaction so per-statement row locks release immediately — see the
 * comment in context() for why we don't wrap the whole scenario in a
 * single DB::transaction.
 */

namespace PKP\API\v1\_test;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Mail;
use PKP\core\PKPBaseController;
use PKP\core\PKPRequest;
use PKP\testing\bootstrap\Processor\CategoryProcessor;
use PKP\testing\bootstrap\Processor\SectionProcessor;
use PKP\testing\scenario\Processor\ContextBuilderProcessor;
use PKP\testing\scenario\Processor\ReviewFormProcessor;
use PKP\testing\scenario\Processor\UserAssignmentProcessor;
use PKP\testing\scenario\ScenarioContext;

abstract class PKPContextScenarioController extends PKPBaseController
{
    public function getHandlerPath(): string
    {
        return '_test/scenarios';
    }

    public function getRouteGroupMiddleware(): array
    {
        return ['test.mode'];
    }

    /**
     * TestModeGate is the only authorization we apply to this endpoint.
     */
    public function authorize(PKPRequest $request, array &$args, array $roleAssignments): bool
    {
        return true;
    }

    /**
     * Shared handler that builds the scratch context. Subclasses register
     * the app-specific route (journal / press / server) that points here.
     */
    public function context(Request $illuminateRequest): JsonResponse
    {
        $spec = $illuminateRequest->all();

        $schemaPath = __DIR__ . '/../../../classes/testing/scenario/schema/context.json';
        $validationError = $this->validateAgainstSchema($spec, $schemaPath);
        if ($validationError !== null) {
            return response()->json(['error' => 'Invalid spec', 'details' => $validationError], Response::HTTP_BAD_REQUEST);
        }

        // Tag-derived path keeps parallel worker runs from colliding and
        // avoids accidental reuse of the publicknowledge path. Sanitised
        // to satisfy OJS's urlPath constraints (alnum, no spaces).
        if (empty($spec['path'])) {
            $spec['path'] = 'j-' . preg_replace('/[^a-z0-9]/i', '', strtolower($spec['tag']));
        }

        // Capture outbound mail so context creation (welcome emails, etc.)
        // doesn't queue real messages.
        Mail::fake();

        $ctx = new ScenarioContext();
        $contextBuilder = new ContextBuilderProcessor();
        $userAssignment = new UserAssignmentProcessor();
        $sectionProcessor = new SectionProcessor();
        $categoryProcessor = new CategoryProcessor();
        $reviewFormProcessor = new ReviewFormProcessor();
        $reviewFormsResult = null;

        // No DB::transaction wrapper — running each processor in its
        // own implicit transaction lets Postgres release row locks (in
        // particular ContextDAO::resequence's per-row UPDATE on the
        // journals table) as soon as each statement commits, instead
        // of holding them until the end of a wide outer transaction.
        // Under workers=5+ this prevents the queueing that pushed
        // /scenarios/journal POSTs past the 10s API timeout. The
        // trade-off — partial state on processor failure — is fine
        // because each test uses its own scratch journal and the test
        // DB is reset between runs.
        try {
            $contextBuilder->run($spec, $ctx);
            $contextId = $ctx->journalId($spec['path']);

            $editorsToAssign = [];
            if (!empty($spec['sections'])) {
                $sectionResult = $sectionProcessor->run(
                    $contextId,
                    $spec['sections'],
                    $spec['path']
                );
                $editorsToAssign = $sectionResult['editorsToAssign'] ?? [];
            }

            if (!empty($spec['reviewForms'])) {
                $reviewFormsResult = $reviewFormProcessor->run(
                    $contextId,
                    $spec['reviewForms'],
                    $spec['primaryLocale'] ?? 'en'
                );
            }

            if ($userAssignment->appliesTo($spec)) {
                $userAssignment->run($spec, $ctx);
            }

            if (!empty($editorsToAssign)) {
                $sectionProcessor->assignSectionEditors(
                    $contextId,
                    $editorsToAssign,
                    $ctx
                );
            }

            if (!empty($spec['categories'])) {
                $categoryProcessor->run($contextId, $spec['categories']);
            }

            $this->afterContextCreated($spec, $contextId);
        } catch (\Throwable $e) {
            return response()->json([
                'error' => 'Scenario build failed',
                'message' => $e->getMessage(),
                'class' => get_class($e),
                'file' => $e->getFile() . ':' . $e->getLine(),
            ], Response::HTTP_INTERNAL_SERVER_ERROR);
        }

        $response = $ctx->contextScenarioResponse($spec);
        if ($reviewFormsResult !== null) {
            // Review form + element IDs so tests can select a seeded form
            // when assigning reviewers without scraping the settings grid.
            $response['reviewForms'] = $reviewFormsResult;
        }
        return response()->json($response, Response::HTTP_OK);
    }

    /**
     * App-specific post-create hook. Default no-op; subclasses (e.g.
     * OJS's JournalScenarioController) override to seed additional
     * concepts that don't exist cross-app (issues for OJS).
     *
     * Runs inside the same DB transaction as ContextBuilderProcessor so
     * any failure rolls the whole scenario back.
     */
    protected function afterContextCreated(array $spec, int $contextId): void
    {
        // no-op by default
    }

    /**
     * App-specific additions to the scenario spec schema. The schema sets
     * additionalProperties:false, so app-only spec keys (e.g. OJS's
     * subscriptions[]) must be declared here to pass validation. Return a
     * map of property name => JSON-schema definition as plain PHP arrays,
     * e.g. ['subscriptions' => ['type' => 'array', 'items' => [...]]].
     * Merged into the schema's properties before validation; default none.
     */
    protected function schemaOverlayProperties(): array
    {
        return [];
    }

    /**
     * Validate the spec against schema/context.json (with the app's
     * schemaOverlayProperties() merged in). Returns a human-readable
     * error string naming the offending key(s)/path(s), or null when
     * the spec is valid.
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
