<?php

/**
 * @file classes/testing/scenario/Processor/PublicationsProcessor.php
 *
 * Copyright (c) 2026 Simon Fraser University
 * Copyright (c) 2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class PublicationsProcessor
 *
 * @brief Fills in metadata + attributes + optional publish on each
 *        publication in the spec's `publications` array.
 *
 * Index 0 targets the bare publication already created by
 * SubmissionBuilderProcessor. Index > 0 creates a chained new version
 * via Repo::publication()->version(), which copies authors/citations
 * and derives versionMajor/versionMinor from the versionIsMinor flag
 * — exactly what the UI's publish form does when a user creates a
 * new version.
 */

namespace PKP\testing\scenario\Processor;

use APP\core\Application;
use APP\facades\Repo;
use APP\publication\enums\VersionStage;
use PKP\security\Role;
use PKP\stageAssignment\StageAssignment;
use PKP\submissionFile\SubmissionFile;
use PKP\testing\scenario\GenreLookup;
use PKP\testing\scenario\ScenarioContext;
use PKP\testing\scenario\ScenarioProcessor;

class PublicationsProcessor implements ScenarioProcessor
{
    /**
     * Content metadata fields the spec accepts under publications[].metadata.
     *
     * datePublished mirrors the editor capability in the publish flow:
     * OJS's IssueEntryForm exposes the field
     * (classes/components/forms/publication/IssueEntryForm.php:124-128)
     * and it lands via the same Repo::publication()->edit() call. When set
     * before publish, OJS's setStatusOnPublish keeps the predefined value
     * instead of stamping today (classes/publication/Repository.php:219-226).
     */
    private const METADATA_FIELDS = [
        'title', 'subtitle', 'prefix', 'abstract', 'plainLanguageSummary',
        'keywords', 'subjects', 'disciplines', 'supportingAgencies',
        'coverage', 'type', 'source', 'rights', 'fundingStatement',
        'dataAvailability', 'copyrightHolder', 'copyrightYear',
        'licenseUrl', 'pages', 'urlPath', 'datePublished',
    ];

    /** Directory of bundled fixture files for galley uploads, relative to the OJS root. */
    private const FIXTURE_FILES_DIR = 'lib/pkp/playwright/fixtures/files';

    /** Fixture used when a galleys[] entry names no file. Same PDF the wizard seed attaches. */
    private const DEFAULT_GALLEY_FIXTURE = 'default-article.pdf';

    /** Publication-level attribute fields the spec accepts directly on a publications[] entry. */
    private const ATTRIBUTE_FIELDS = ['jatsPublicVisibility'];

    public function appliesTo(array $spec): bool
    {
        return !empty($spec['publications']);
    }

    public function run(array $spec, ScenarioContext $ctx): array
    {
        $tag = $spec['tag'];
        $publications = $spec['publications'];
        $previousPublicationId = $ctx->firstPublicationId();

        foreach ($publications as $i => $pubSpec) {
            if ($i === 0) {
                $publicationId = $previousPublicationId;
            } else {
                $previous = Repo::publication()->get($previousPublicationId);
                $versionStage = isset($pubSpec['versionStage'])
                    ? VersionStage::from($pubSpec['versionStage'])
                    : null;
                $publicationId = Repo::publication()->version(
                    $previous,
                    $versionStage,
                    (bool)($pubSpec['versionIsMinor'] ?? true)
                );
                $previousPublicationId = $publicationId;
            }

            $this->applyMetadataAndAttributes($publicationId, $pubSpec, $tag);

            // Galleys are created in the production stage before the editor
            // hits Publish, so seed them ahead of the publish() call — DOI
            // minting and the publish event then see them like production.
            $galleyFragments = [];
            if (!empty($pubSpec['galleys'])) {
                $galleyFragments = $this->seedGalleys($publicationId, $pubSpec['galleys'], $ctx);
            }

            if (!empty($pubSpec['published'])) {
                $this->publish($publicationId, $pubSpec, $ctx);
            }

            $publication = Repo::publication()->get($publicationId);
            $ctx->recordPublication([
                'id' => (int)$publication->getId(),
                'versionStage' => $publication->getData('versionStage'),
                'versionMajor' => $publication->getData('versionMajor'),
                'versionMinor' => $publication->getData('versionMinor'),
                'status' => $publication->getData('status'),
                'issueId' => $publication->getData('issueId'),
                'datePublished' => $publication->getData('datePublished'),
                'galleys' => $galleyFragments,
            ]);
        }

        return [];
    }

    /**
     * Merge metadata (with the tag appended to every title locale) plus
     * UI-settable attributes onto the target publication via one edit() call.
     */
    private function applyMetadataAndAttributes(int $publicationId, array $pubSpec, string $tag): void
    {
        $metadata = $pubSpec['metadata'] ?? [];
        $editParams = [];

        foreach (self::METADATA_FIELDS as $field) {
            if (array_key_exists($field, $metadata)) {
                $editParams[$field] = $metadata[$field];
            }
        }

        // Append [tag] to every locale of the title for parallel isolation.
        if (isset($editParams['title']) && is_array($editParams['title'])) {
            foreach ($editParams['title'] as $locale => $value) {
                $editParams['title'][$locale] = trim((string)$value) . " [{$tag}]";
            }
        }

        // Set versionStage here on the index-0 publication too (where
        // version() wasn't called to do it). For index > 0 it's redundant
        // but harmless — Repo::publication()->version already set it.
        if (isset($pubSpec['versionStage'])) {
            $editParams['versionStage'] = $pubSpec['versionStage'];
        }

        foreach (self::ATTRIBUTE_FIELDS as $field) {
            if (array_key_exists($field, $pubSpec)) {
                $editParams[$field] = $pubSpec[$field];
            }
        }

        if (empty($editParams)) {
            return;
        }

        $publication = Repo::publication()->get($publicationId);
        Repo::publication()->edit($publication, $editParams);
    }

    /**
     * Seed galleys on the target publication, mirroring the galley grid's
     * two-step flow:
     *
     *  1. ArticleGalleyForm::execute() creates the galley row via
     *     Repo::galley()->add(Repo::galley()->newDataObject([...])) with
     *     publicationId / label / locale / urlPath / urlRemote
     *     (controllers/grid/articleGalleys/form/ArticleGalleyForm.php:171-193).
     *  2. The galley file-upload wizard attaches a SubmissionFile at the
     *     PROOF stage with assocType = ASSOC_TYPE_REPRESENTATION and
     *     assocId = galleyId, field-for-field as
     *     SubmissionFilesUploadForm::execute() (lines 183-238). OJS's
     *     submissionFile Repository::add() then wires
     *     galley.submissionFileId automatically
     *     (classes/submissionFile/Repository.php:40-58).
     *
     * Remote galleys (urlRemote) carry no file, exactly as the form allows.
     */
    private function seedGalleys(int $publicationId, array $galleySpecs, ScenarioContext $ctx): array
    {
        $submission = Repo::submission()->get($ctx->submissionId());
        $contextId = $ctx->submissionContextId();
        $fragments = [];

        foreach ($galleySpecs as $galleySpec) {
            if (!empty($galleySpec['file']) && !empty($galleySpec['urlRemote'])) {
                throw new \InvalidArgumentException(
                    "galleys[] entry '{$galleySpec['label']}' sets both `file` and `urlRemote` — a galley is either a file galley or a remote galley, never both."
                );
            }

            $locale = $galleySpec['locale'] ?? $submission->getData('locale');
            $isRemote = !empty($galleySpec['urlRemote']);

            // Step 1 — the galley row (ArticleGalleyForm::execute data shape).
            $galleyId = Repo::galley()->add(Repo::galley()->newDataObject([
                'publicationId' => $publicationId,
                'label' => $galleySpec['label'],
                'locale' => $locale,
                'urlPath' => null,
                'urlRemote' => $isRemote ? $galleySpec['urlRemote'] : null,
            ]));

            // Step 2 — the PROOF-stage file, unless this is a remote galley.
            $submissionFileId = null;
            if (!$isRemote) {
                $submissionFileId = $this->attachGalleyFile(
                    $galleyId,
                    $galleySpec['file'] ?? self::DEFAULT_GALLEY_FIXTURE,
                    $submission,
                    $contextId
                );
            }

            $fragments[] = [
                'id' => $galleyId,
                'label' => $galleySpec['label'],
                'locale' => $locale,
                'submissionFileId' => $submissionFileId,
                'urlRemote' => $isRemote ? $galleySpec['urlRemote'] : null,
            ];
        }

        return $fragments;
    }

    /**
     * Copy a bundled fixture into the submission's files-dir tree and create
     * the matching PROOF-stage SubmissionFile attached to the galley. Field
     * set mirrors SubmissionFilesUploadForm::execute() (lines 214-235) for a
     * fresh upload into the galley grid: fileStage = SUBMISSION_FILE_PROOF,
     * assocType = ASSOC_TYPE_REPRESENTATION, assocId = the galley, name
     * keyed by the submission locale, genre = Article Text. The uploader is
     * attributed to the admin user since the Processor runs out-of-session
     * (same convention as ReviewRoundProcessor's event-log rows).
     */
    private function attachGalleyFile(
        int $galleyId,
        string $fixtureName,
        \APP\submission\Submission $submission,
        int $contextId
    ): int {
        $fixturePath = $this->resolveGalleyFixturePath($fixtureName);
        $genre = GenreLookup::genreForKey($contextId, 'ARTICLE');
        $admin = Repo::user()->getByUsername('admin', true);

        $submissionDir = Repo::submissionFile()->getSubmissionDir($contextId, $submission->getId());
        $extension = pathinfo($fixtureName, PATHINFO_EXTENSION);
        $fileId = app()->get('file')->add(
            $fixturePath,
            $submissionDir . '/' . uniqid() . ($extension !== '' ? '.' . $extension : '')
        );

        $submissionFile = Repo::submissionFile()->dao->newDataObject();
        $submissionFile->setData('fileId', $fileId);
        $submissionFile->setData('fileStage', SubmissionFile::SUBMISSION_FILE_PROOF);
        $submissionFile->setData('name', basename($fixtureName), $submission->getData('locale'));
        $submissionFile->setData('submissionId', $submission->getId());
        $submissionFile->setData('uploaderUserId', $admin?->getId());
        $submissionFile->setData('assocType', Application::ASSOC_TYPE_REPRESENTATION);
        $submissionFile->setData('assocId', $galleyId);
        $submissionFile->setData('genreId', (int)$genre->getId());

        // Repo::submissionFile()->add() also writes the two upload event-log
        // rows and sets galley.submissionFileId (APP\submissionFile\Repository).
        return Repo::submissionFile()->add($submissionFile);
    }

    /**
     * Locate a bundled fixture file for a galley. Same root-resolution
     * pattern as SubmissionBuilderProcessor::resolveFixturePath(). The
     * name is reduced to its basename so specs can't traverse outside
     * the fixtures directory.
     */
    private function resolveGalleyFixturePath(string $fixtureName): string
    {
        $base = defined('INDEX_FILE_LOCATION')
            ? dirname(INDEX_FILE_LOCATION)
            : dirname(__DIR__, 6);

        $path = $base . '/' . self::FIXTURE_FILES_DIR . '/' . basename($fixtureName);
        if (!is_readable($path)) {
            throw new \RuntimeException(
                "Galley fixture '{$fixtureName}' not readable at {$path}. "
                . 'Add the file to ' . self::FIXTURE_FILES_DIR . ' or reference an existing fixture.'
            );
        }
        return $path;
    }

    /**
     * Resolve optional issue → issueId, then Repo::publication()->publish.
     */
    private function publish(int $publicationId, array $pubSpec, ScenarioContext $ctx): void
    {
        if (isset($pubSpec['issue'])) {
            $issueId = $this->resolveIssueId($pubSpec['issue'], $ctx->submissionContextId());
            $publication = Repo::publication()->get($publicationId);
            Repo::publication()->edit($publication, ['issueId' => $issueId]);
        }

        $publication = Repo::publication()->get($publicationId);
        // Use the default (null) submissionStatus arg so submission.status
        // gets updated to reflect the just-published publication. The UI
        // controller (PKPSubmissionController::publishPublication) passes
        // `false` here, but that's because production reaches publish()
        // after a chain of decisions that already advanced the
        // submission's status. The Processor consolidates create →
        // publish in one pass; without the auto-update the submission
        // would be left at STATUS_QUEUED while the publication is
        // PUBLISHED, and UI surfaces that read submission.status (e.g.
        // the change-language affordance) wouldn't recognise the
        // submission as published.
        Repo::publication()->publish($publication);

        // After publish, production iterates stage_assignments and clears
        // canChangeMetadata on every AUTHOR role assignment — authors
        // lose metadata-edit after publish. Mirror that here so
        // scenario-seeded published submissions reflect the same
        // permission state.
        $submissionId = Repo::publication()->get($publicationId)->getData('submissionId');
        $authorAssignments = StageAssignment::withSubmissionIds([$submissionId])
            ->withRoleIds([Role::ROLE_ID_AUTHOR])
            ->get();
        foreach ($authorAssignments as $stageAssignment) {
            $stageAssignment->canChangeMetadata = 0;
            $stageAssignment->save();
        }
    }

    /**
     * Accepts three forms:
     *   - { volume, number, year } — key lookup into Phase 1 bootstrap issues
     *   - 'latest'  — most recently published issue in this journal
     *   - 'current' — the journal's current (unpublished) issue
     */
    private function resolveIssueId(array|string $issueSpec, int $contextId): int
    {
        if (is_string($issueSpec)) {
            return match ($issueSpec) {
                'latest' => $this->resolveLatestPublishedIssue($contextId),
                'current' => $this->resolveCurrentIssue($contextId),
                default => throw new \InvalidArgumentException("Unknown issue shorthand '{$issueSpec}'; use 'latest' or 'current'"),
            };
        }

        $collector = Repo::issue()->getCollector()->filterByContextIds([$contextId]);
        if (isset($issueSpec['volume'])) {
            $collector = $collector->filterByVolumes([(int)$issueSpec['volume']]);
        }
        if (isset($issueSpec['number'])) {
            $collector = $collector->filterByNumbers([(string)$issueSpec['number']]);
        }
        if (isset($issueSpec['year'])) {
            $collector = $collector->filterByYears([(int)$issueSpec['year']]);
        }
        $matches = $collector->getMany();
        if ($matches->isEmpty()) {
            throw new \RuntimeException(
                "No issue found in context {$contextId} matching " . json_encode($issueSpec)
                . ". Seed the needed issue in the bootstrap spec."
            );
        }
        if ($matches->count() > 1) {
            throw new \RuntimeException(
                "Issue spec is ambiguous — " . $matches->count() . " matches. Add more identifying fields."
            );
        }
        return (int)$matches->first()->getId();
    }

    private function resolveLatestPublishedIssue(int $contextId): int
    {
        $issues = Repo::issue()->getCollector()
            ->filterByContextIds([$contextId])
            ->filterByPublished(true)
            ->orderBy(Repo::issue()->getCollector()::ORDERBY_PUBLISHED, Repo::issue()->getCollector()::ORDER_DIR_DESC)
            ->getMany();
        if ($issues->isEmpty()) {
            throw new \RuntimeException(
                "publications[].issue = 'latest' but context {$contextId} has no published issues. "
                . "Seed one in the bootstrap spec."
            );
        }
        return (int)$issues->first()->getId();
    }

    private function resolveCurrentIssue(int $contextId): int
    {
        $current = Repo::issue()->getCurrent($contextId);
        if (!$current) {
            throw new \RuntimeException(
                "publications[].issue = 'current' but context {$contextId} has no current issue."
            );
        }
        return (int)$current->getId();
    }
}
