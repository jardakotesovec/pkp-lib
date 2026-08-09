<?php

/**
 * @file classes/submission/models/Submission.php
 *
 * Copyright (c) 2014-2026 Simon Fraser University
 * Copyright (c) 2000-2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class Submission
 *
 * @brief Eloquent read model for submissions, living alongside the
 *   DataObject-based \PKP\submission\PKPSubmission. Batched hydration
 *   through SettingsBuilder (one query for the main rows plus one for all
 *   settings, regardless of result size) replaces the per-submission
 *   settings query of EntityDAO::fromRow(), and the publications relation
 *   combined with relationship autoloading batches the per-submission
 *   publications fan-out: in a shared autoload context ONE publications
 *   query serves every submission in the collection, and the nested
 *   authors/galleys/files relations batch across all of those publications
 *   in turn.
 *
 *   Schema-less for the trait (submission.json carries no origin
 *   annotations); the settings and multilingual lists are derived at
 *   runtime from the schema service so app-level schema additions are
 *   included automatically. The submission schema declares no multilingual
 *   properties at the PKP level (nested multilingual flags inside
 *   reviewerSuggestions items are item-level, not top-level, so the schema
 *   service does not report them); the derivation below yields an empty
 *   list without hard-coding that assumption.
 *
 *   The app-level submission DAO adds no primary table columns (only
 *   schema properties), so a single PKP-level model serves the app.
 */

namespace PKP\submission\models;

use APP\facades\Repo;
use APP\publication\models\Publication as PublicationModel;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\LazyLoadingViolationException;
use Illuminate\Support\Arr;
use Illuminate\Support\LazyCollection;
use PKP\core\traits\DataObjectReadCompat;
use PKP\core\traits\ModelWithSettings;
use PKP\services\PKPSchemaService;
use PKP\submission\PKPSubmission;

class Submission extends Model
{
    use ModelWithSettings;
    use DataObjectReadCompat {
        DataObjectReadCompat::getLocalizedData insteadof ModelWithSettings;
    }

    /**
     * Schema properties that never appear as settings rows: composed or
     * attached at runtime by repositories, maps and API code (relations,
     * URLs, computed labels, workflow state). Everything else in the schema
     * that is not a primary table column is folded from the settings table
     * by the legacy EntityDAO::fromRow() and must be treated as a setting
     * here. Write-only creation-time props (sectionId, userGroupId) are NOT
     * listed: were a stray settings row ever to exist for them, the legacy
     * path would fold it (the schema carries the property), so the model
     * folds it too.
     */
    protected const NON_SETTING_PROPS = [
        '_href',
        'availableEditorialDecisions',
        'canCurrentUserChangeMetadata',
        'editorAssigned',
        'issueToBePublished',
        'metadataLocales',
        'participants',
        'publications',
        'recommendationsIn',
        'reviewAssignments',
        'reviewRounds',
        'reviewerSuggestions',
        'reviewersNotAssigned',
        'revisionsRequested',
        'revisionsSubmitted',
        'scheduledIn',
        'stages',
        'statusLabel',
        'urlAuthorWorkflow',
        'urlEditorialWorkflow',
        'urlPublished',
        'urlSubmissionWizard',
        'urlWorkflow',
    ];

    /** Batch size for hydrateMany(), bounding memory on huge id lists */
    protected const HYDRATE_CHUNK_SIZE = 500;

    protected $table = 'submissions';

    protected $primaryKey = 'submission_id';

    public $timestamps = false;

    protected $guarded = [
        'submissionId',
        'id',
    ];

    /** Settings list derived from the schema service, computed once */
    protected static ?array $settingsFromSchema = null;

    /** Multilingual settings derived from the schema service, computed once */
    protected static ?array $multilingualFromSchema = null;

    /** Map of schema property name => JSON-schema type, computed once */
    protected static ?array $schemaPropTypes = null;

    protected function casts(): array
    {
        return [
            'submission_id' => 'integer',
            'context_id' => 'integer',
            'current_publication_id' => 'integer',
            'date_last_activity' => 'string',
            'date_submitted' => 'string',
            'last_modified' => 'string',
            'locale' => 'string',
            'stage_id' => 'integer',
            'status' => 'integer',
            'submission_progress' => 'string',
        ];
    }

    public function getSettingsTable(): string
    {
        return 'submission_settings';
    }

    public static function getSchemaName(): ?string
    {
        return null;
    }

    /**
     * Settings are every schema property that is not a primary table column
     * of the submission DAO and not composed/attached at runtime. Derived
     * at runtime so app-level schema additions are included automatically.
     */
    public function getSettings(): array
    {
        if (static::$settingsFromSchema === null) {
            $schema = app()->get('schema')->get(PKPSchemaService::SCHEMA_SUBMISSION);
            static::$settingsFromSchema = array_values(array_diff(
                array_keys(get_object_vars($schema->properties)),
                array_keys(Repo::submission()->dao->primaryTableColumns),
                self::NON_SETTING_PROPS
            ));
        }
        return static::$settingsFromSchema;
    }

    public function getMultilingualProps(): array
    {
        if (static::$multilingualFromSchema === null) {
            static::$multilingualFromSchema = array_values(array_intersect(
                app()->get('schema')->getMultilingualProps(PKPSchemaService::SCHEMA_SUBMISSION),
                $this->getSettings()
            ));
        }
        return static::$multilingualFromSchema;
    }

    /**
     * Publications of this submission, in the exact order of the legacy
     * publication collector's orderByVersion() — the ordering SQL lives in
     * the Publication model's scopeOrderByVersion() and is reused here via
     * the dynamic scope call, not duplicated. Eager/autoloaded loading
     * preserves the per-parent relative order because Eloquent distributes
     * the globally-ordered result rows to their parents in sequence.
     */
    public function publications(): HasMany
    {
        // chaperone() hydrates the inverse submission() relation on the
        // loaded publications, so the compat surface's submission-locale
        // reads (Publication::compatLocale()/getDefaultLocale()) cost no
        // parent refetch. No extra queries; purely additive for the bridge.
        return $this->hasMany(PublicationModel::class, 'submission_id', 'submission_id')
            ->orderByVersion()
            ->chaperone('submission');
    }

    /**
     * Bridge to the DataObject representation used by templates, hooks and
     * the rest of the application. Reproduces everything the legacy
     * hydration path produces: EntityDAO::fromRow() conversions plus the
     * app-level \APP\submission\DAO::fromRow() publications wiring — a
     * remembered LazyCollection, keyed by publication id, in
     * orderByVersion() order, each bridged via
     * PublicationModel::toDataObject($submissionLocale, $submissionContextId).
     *
     * Publications sourcing mirrors the Galley file-preload guard: when the
     * publications relation is already loaded, or a relationship-autoload
     * callback is registered (the hydrateMany() path — accessing the
     * relation then batch-loads publications for every submission in the
     * autoload context at once, and the loaded models join the same context
     * so their own authors/galleys/files relations batch across all of
     * them), the relation is used. Otherwise the per-submission fetch runs
     * inside the LazyCollection exactly as \APP\submission\DAO::fromRow()
     * wires it, deferred to first iteration. The try/catch covers lazy-
     * loading prevention modes where relation access would throw instead
     * of load.
     */
    public function toDataObject(): \APP\submission\Submission
    {
        $attributes = $this->getAttributes();
        $propTypes = static::schemaPropTypes();

        $submission = Repo::submission()->newDataObject();

        // Primary table columns, converted by JSON-schema type exactly as
        // EntityDAO::fromRow() does (nullable: null stays null)
        $data = [];
        foreach (Repo::submission()->dao->primaryTableColumns as $propName => $column) {
            if (!array_key_exists($column, $attributes)) {
                continue;
            }
            $value = $attributes[$column];
            $data[$propName] = $value === null
                ? null
                : self::convertFromDb($value, $propTypes[$propName] ?? 'string');
        }
        $submission->setAllData($data);

        // Settings, converted by JSON-schema type
        foreach ($this->getSettings() as $name) {
            $type = $propTypes[$name] ?? 'string';
            if (in_array($name, $this->getMultilingualProps())) {
                // Match DataObject::setData() semantics: null locale values
                // are dropped, and a prop with no remaining locales is absent
                $localized = [];
                foreach ((array) ($attributes[$name] ?? []) as $locale => $raw) {
                    $value = self::convertFromDb($raw, $type);
                    if ($value !== null) {
                        $localized[$locale] = $value;
                    }
                }
                if ($localized !== []) {
                    $submission->setData($name, $localized);
                }
            } elseif (array_key_exists($name, $attributes)) {
                $submission->setData($name, self::convertFromDb($attributes[$name], $type));
            }
        }

        // Publications, matching \APP\submission\DAO::fromRow(): remembered
        // LazyCollection, publication_id keys, orderByVersion() order. The
        // source resolution runs on first iteration, like the wiring's
        // deferred query.
        $submissionId = $this->submissionId;
        $submissionLocale = $attributes['locale'] ?? null;
        $submissionContextId = isset($attributes['context_id']) ? (int) $attributes['context_id'] : null;
        $submission->setData(
            'publications',
            LazyCollection::make(function () use ($submissionId, $submissionLocale, $submissionContextId) {
                $models = null;
                if ($this->relationLoaded('publications')) {
                    $models = $this->getRelation('publications');
                } elseif ($this->hasRelationAutoloadCallback()) {
                    try {
                        $models = $this->publications;
                    } catch (LazyLoadingViolationException) {
                        $models = null;
                    }
                }
                // Not in an autoload context: per-submission fetch identical
                // to the current \APP\submission\DAO::fromRow() wiring
                $models ??= PublicationModel::withSubmissionIds([$submissionId])
                    ->orderByVersion()
                    ->get()
                    ->withRelationshipAutoloading();
                foreach ($models as $model) {
                    yield $model->publicationId => $model->toDataObject($submissionLocale, $submissionContextId);
                }
            })->remember()
        );

        return $submission;
    }

    /**
     * Batched hydration of many submissions into DataObjects.
     *
     * One submissions fetch (rows + settings via SettingsBuilder) per chunk
     * of at most HYDRATE_CHUNK_SIZE ids, each chunk's collection put into a
     * shared relationship-autoload context. All relation batching flows
     * from that shared context: the first bridged submission that iterates
     * its publications triggers ONE publications query (rows + settings)
     * for every submission in the chunk, the loaded publication models join
     * the same context so ONE authors and ONE galleys query serve all their
     * publications, and the galleys' file relation batches the same way.
     *
     * @param array $submissionIds submission ids in the desired order
     *
     * @return array<int,\APP\submission\Submission> DataObjects keyed by
     *   submission id, in input order (first occurrence wins for
     *   duplicates); ids not found in the database are skipped
     */
    public static function hydrateMany(array $submissionIds): array
    {
        $ids = array_values(array_unique(array_map(intval(...), $submissionIds)));

        $modelsById = [];
        foreach (array_chunk($ids, self::HYDRATE_CHUNK_SIZE) as $chunk) {
            $models = static::withSubmissionIds($chunk)
                ->get()
                ->withRelationshipAutoloading();
            foreach ($models as $model) {
                $modelsById[$model->submissionId] = $model;
            }
        }

        $submissions = [];
        foreach ($ids as $id) {
            if (isset($modelsById[$id])) {
                $submissions[$id] = $modelsById[$id]->toDataObject();
            }
        }
        return $submissions;
    }

    //
    // EXPERIMENTAL DataObject read-compat surface (see DataObjectReadCompat)
    //

    /**
     * @copydoc DataObjectReadCompat::dataObjectCompatPseudoProps()
     */
    protected function dataObjectCompatPseudoProps(): array
    {
        return [
            'publications' => 'compatPublications',
        ];
    }

    /**
     * @copydoc DataObjectReadCompat::dataObjectCompatConvert()
     *
     * JSON-schema typed conversion identical to what toDataObject() applies,
     * so compat reads carry the same values the bridged DataObject would.
     */
    protected function dataObjectCompatConvert(string $key, mixed $value): mixed
    {
        if ($value === null) {
            return null;
        }
        $type = static::schemaPropTypes()[$key] ?? 'string';
        if (in_array($key, $this->getMultilingualProps())) {
            // Match DataObject::setData() semantics: null locale values are
            // dropped, and a prop with no remaining locales is absent
            $localized = [];
            foreach ((array) $value as $locale => $raw) {
                $converted = self::convertFromDb($raw, $type);
                if ($converted !== null) {
                    $localized[$locale] = $converted;
                }
            }
            return $localized === [] ? null : $localized;
        }
        return self::convertFromDb($value, $type);
    }

    /**
     * Live publication models, orderByVersion() order (legacy: remembered
     * LazyCollection of Publication DataObjects keyed by publication id)
     */
    protected function compatPublications(): mixed
    {
        return $this->publications;
    }

    /**
     * @copydoc \PKP\submission\PKPSubmission::getDefaultLocale()
     */
    public function getDefaultLocale(): ?string
    {
        return $this->getData('locale');
    }

    /**
     * @copydoc \PKP\submission\PKPSubmission::getBestId()
     */
    public function getBestId()
    {
        return strlen($urlPath = (string) $this->getCurrentPublication()?->getData('urlPath')) ? $urlPath : $this->getId();
    }

    /**
     * @copydoc \PKP\submission\PKPSubmission::getCurrentPublication()
     *
     * @return PublicationModel|null
     */
    public function getCurrentPublication()
    {
        $publicationId = $this->getData('currentPublicationId');
        $publications = $this->getData('publications');
        if (!$publicationId || empty($publications)) {
            return null;
        }
        foreach ($publications as $publication) {
            if ($publication->getId() === $publicationId) {
                return $publication;
            }
        }
    }

    /**
     * @copydoc \PKP\submission\PKPSubmission::getPublishedPublications()
     *
     * @return PublicationModel[]
     */
    public function getPublishedPublications()
    {
        $publications = $this->getData('publications') ?? collect();
        if ($publications->isEmpty()) {
            return [];
        }
        return $publications->filter(function ($publication) {
            return $publication->getData('status') === PKPSubmission::STATUS_PUBLISHED;
        })->all();
    }

    /**
     * Scope a query to submissions of the given id/s
     */
    public function scopeWithSubmissionIds(Builder $query, int|array $submissionIds): Builder
    {
        return $query->whereIn('submission_id', Arr::wrap($submissionIds));
    }

    /**
     * Map of schema property name => JSON-schema type, for the legacy-
     * equivalent value conversions in toDataObject()
     */
    protected static function schemaPropTypes(): array
    {
        if (static::$schemaPropTypes === null) {
            $schema = app()->get('schema')->get(PKPSchemaService::SCHEMA_SUBMISSION);
            $types = [];
            foreach (get_object_vars($schema->properties) as $propName => $propSchema) {
                $types[$propName] = $propSchema->type ?? 'string';
            }
            static::$schemaPropTypes = $types;
        }
        return static::$schemaPropTypes;
    }

    /**
     * Convert a raw database value by JSON-schema type, mirroring
     * \PKP\db\DAO::convertFromDB() as used by EntityDAO::fromRow()
     */
    protected static function convertFromDb(mixed $value, string $type): mixed
    {
        return match ($type) {
            'bool', 'boolean' => (bool) $value,
            'int', 'integer' => (int) $value,
            'float', 'number' => (float) $value,
            'object', 'array' => $value === null ? null : json_decode($value, true),
            default => $value,
        };
    }
}
