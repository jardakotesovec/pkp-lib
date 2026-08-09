<?php

/**
 * @file classes/publication/models/Publication.php
 *
 * Copyright (c) 2014-2026 Simon Fraser University
 * Copyright (c) 2000-2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class Publication
 *
 * @brief Eloquent read model for publications, living alongside the
 *   DataObject-based \PKP\publication\PKPPublication. Batched hydration
 *   through SettingsBuilder (one query for the main rows plus one for all
 *   settings) replaces the per-publication settings query of
 *   EntityDAO::fromRow(), and the authors/galleys relations combined with
 *   relationship autoloading batch the per-publication collector fan-out.
 *
 *   Schema-less for the trait (publication.json carries no origin
 *   annotations); the settings and multilingual lists are derived at runtime
 *   from the schema service so app-level schema additions are included
 *   automatically.
 */

namespace PKP\publication\models;

use APP\core\Application;
use APP\facades\Repo;
use APP\publication\enums\VersionStage;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\LazyLoadingViolationException;
use Illuminate\Support\Arr;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\LazyCollection;
use PKP\author\models\Author;
use PKP\citation\models\Citation as CitationModel;
use PKP\controlledVocab\ControlledVocab;
use PKP\controlledVocab\ControlledVocabEntry;
use PKP\core\traits\ModelWithSettings;
use PKP\dataCitation\DataCitation;
use PKP\doi\models\Doi as DoiModel;
use PKP\funder\Funder;
use PKP\galley\models\Galley;
use PKP\publication\PublicationCategory;
use PKP\services\PKPSchemaService;

class Publication extends Model
{
    use ModelWithSettings;

    /**
     * Schema properties that never appear as settings rows: composed or
     * attached by the DAOs/repositories at hydration time (relations,
     * controlled vocabulary, computed strings) or read from the submission
     * row (locale). Everything else in the schema that is not a primary
     * table column is folded from the settings table by the legacy
     * EntityDAO::fromRow() and must be treated as a setting here.
     */
    protected const NON_SETTING_PROPS = [
        '_href',
        'authors',
        'authorsString',
        'authorsStringIncludeInBrowse',
        'authorsStringShort',
        'categoryIds',
        'citations',
        'citationsRaw',
        'dataCitations',
        'doiObject',
        'fullTitle',
        'funders',
        'galleys',
        'locale',
        'reviewDoiItems',
        'urlPublished',
        'versionString',
    ];

    protected $table = 'publications';

    protected $primaryKey = 'publication_id';

    public $timestamps = false;

    protected $guarded = [
        'publicationId',
        'id',
    ];

    /** Settings list derived from the schema service, computed once */
    protected static ?array $settingsFromSchema = null;

    /** Multilingual settings derived from the schema service, computed once */
    protected static ?array $multilingualFromSchema = null;

    /** Map of schema property name => JSON-schema type, computed once */
    protected static ?array $schemaPropTypes = null;

    /**
     * Per-run cache of contexts by id for the unassigned-version string in
     * toDataObject(): at most one context fetch per distinct context instead
     * of one submission + one context fetch per publication.
     */
    protected static array $contextsById = [];

    protected function casts(): array
    {
        return [
            'publication_id' => 'integer',
            'date_published' => 'string',
            'last_modified' => 'string',
            'primary_contact_id' => 'integer',
            // publication.json declares seq as integer even though the
            // column is double precision; match the legacy conversion
            'seq' => 'integer',
            'submission_id' => 'integer',
            'url_path' => 'string',
            'doi_id' => 'integer',
            'version_stage' => 'string',
            'version_minor' => 'integer',
            'version_major' => 'integer',
            'update_type' => 'string',
            // plain cast column, not an Eloquent-managed timestamp
            'created_at' => 'string',
            'source_publication_id' => 'integer',
        ];
    }

    public function getSettingsTable(): string
    {
        return 'publication_settings';
    }

    public static function getSchemaName(): ?string
    {
        return null;
    }

    /**
     * Settings are every schema property that is not a primary table column
     * of the app-level publication DAO and not composed/attached at
     * hydration time. Derived at runtime so app-level schema additions are
     * included automatically.
     */
    public function getSettings(): array
    {
        if (static::$settingsFromSchema === null) {
            $schema = app()->get('schema')->get(PKPSchemaService::SCHEMA_PUBLICATION);
            static::$settingsFromSchema = array_values(array_diff(
                array_keys(get_object_vars($schema->properties)),
                array_keys(Repo::publication()->dao->primaryTableColumns),
                self::NON_SETTING_PROPS
            ));
        }
        return static::$settingsFromSchema;
    }

    public function getMultilingualProps(): array
    {
        if (static::$multilingualFromSchema === null) {
            static::$multilingualFromSchema = array_values(array_intersect(
                app()->get('schema')->getMultilingualProps(PKPSchemaService::SCHEMA_PUBLICATION),
                $this->getSettings()
            ));
        }
        return static::$multilingualFromSchema;
    }

    /**
     * Contributors of this publication, in display order
     */
    public function authors(): HasMany
    {
        // Legacy's ORDER BY seq has no explicit tiebreak but yields id order
        // for equal-seq contributors; make that deterministic here
        return $this->hasMany(Author::class, 'publication_id', 'publication_id')
            ->orderBy('seq')
            ->orderBy('author_id');
    }

    /**
     * Galleys of this publication, in display order
     */
    public function galleys(): HasMany
    {
        return $this->hasMany(Galley::class, 'publication_id', 'publication_id')->orderBy('seq');
    }

    /**
     * The publication's DOI
     */
    public function doi(): BelongsTo
    {
        return $this->belongsTo(DoiModel::class, 'doi_id', 'doi_id');
    }

    /**
     * Citations of this publication, in the seq-asc order of the legacy
     * citation collector. Legacy has no explicit tiebreak (the corpus has
     * no equal-seq citations); make it deterministic here with the id.
     */
    public function citations(): HasMany
    {
        return $this->hasMany(CitationModel::class, 'publication_id', 'publication_id')
            ->orderBy('seq')
            ->orderBy('citation_id');
    }

    /**
     * Category assignments of this publication. The legacy pluck runs with
     * no ORDER BY; make the relation deterministic with the id.
     */
    public function categories(): HasMany
    {
        return $this->hasMany(PublicationCategory::class, 'publication_id', 'publication_id')
            ->orderBy('publication_category_id');
    }

    /**
     * The publication's controlled vocabularies (keywords, subjects,
     * disciplines, supporting agencies). The entries come through the
     * nested controlledVocabEntries relation, which relationship
     * autoloading batches across every vocab of every publication in the
     * autoload context. Like the legacy getBySymbolic() query, the entries
     * relation carries no ORDER BY: the legacy per-vocab entry order is
     * planner-driven (heap order, which on the corpus is NOT id order),
     * and an unordered scan reproduces it per vocab id.
     */
    public function controlledVocabs(): HasMany
    {
        return $this->hasMany(ControlledVocab::class, 'assoc_id', 'publication_id')
            ->where('assoc_type', Application::ASSOC_TYPE_PUBLICATION)
            ->whereIn('symbolic', [
                ControlledVocab::CONTROLLED_VOCAB_SUBMISSION_KEYWORD,
                ControlledVocab::CONTROLLED_VOCAB_SUBMISSION_SUBJECT,
                ControlledVocab::CONTROLLED_VOCAB_SUBMISSION_DISCIPLINE,
                ControlledVocab::CONTROLLED_VOCAB_SUBMISSION_AGENCY,
            ]);
    }

    /**
     * Data citations of this publication, in the legacy orderBySeq() order.
     * Legacy has no explicit tiebreak; the corpus shows equal-seq rows come
     * back in id order, so make that deterministic here.
     */
    public function dataCitations(): HasMany
    {
        return $this->hasMany(DataCitation::class, 'publication_id', 'publication_id')
            ->orderBy('seq')
            ->orderBy('data_citation_id');
    }

    /**
     * Funders of the publication's submission, in the legacy orderBySeq()
     * order (seq with funder_id tiebreak). Keyed by submission_id on both
     * sides: version siblings share the same funder rows, and under
     * relationship autoloading they receive the SAME Funder model
     * instances — acceptable for read-only bridging.
     */
    public function funders(): HasMany
    {
        return $this->hasMany(Funder::class, 'submission_id', 'submission_id')
            ->orderBy('seq')
            ->orderBy('funder_id');
    }

    /**
     * Bridge to the DataObject representation used by templates, hooks and
     * the rest of the application. Reproduces everything the legacy
     * hydration path produces: EntityDAO::fromRow() conversions,
     * \PKP\publication\DAO::fromRow() attachments and the app-level
     * \APP\publication\DAO::fromRow() galleys wiring.
     *
     * @param ?string $submissionLocale the submission's locale; the caller
     *   usually knows it, otherwise it is fetched as the legacy collector
     *   query does
     * @param ?int $submissionContextId the submission's context id; when
     *   provided, the unassigned-version string is built from a per-run
     *   cached context instead of getVersionString()'s per-publication
     *   submission + context refetch. When null, the legacy lookup runs.
     */
    public function toDataObject(?string $submissionLocale = null, ?int $submissionContextId = null): \APP\publication\Publication
    {
        $attributes = $this->getAttributes();
        $propTypes = static::schemaPropTypes();

        $publication = Repo::publication()->newDataObject();

        // Primary table columns, converted by JSON-schema type exactly as
        // EntityDAO::fromRow() does (nullable: null stays null)
        $data = [];
        foreach (Repo::publication()->dao->primaryTableColumns as $propName => $column) {
            if (!array_key_exists($column, $attributes)) {
                continue;
            }
            $value = $attributes[$column];
            $data[$propName] = $value === null
                ? null
                : self::convertFromDb($value, $propTypes[$propName] ?? 'string');
        }
        $publication->setAllData($data);

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
                    $publication->setData($name, $localized);
                }
            } elseif (array_key_exists($name, $attributes)) {
                $publication->setData($name, self::convertFromDb($attributes[$name], $type));
            }
        }

        // DOI object, as \PKP\publication\DAO::setDoiObject(). When the doi
        // relation is loaded — or batch-loadable via relationship
        // autoloading — the DataObject comes from the read model bridge;
        // otherwise the legacy per-publication fetch runs unchanged.
        if (!empty($publication->getData('doiId'))) {
            $doiModel = null;
            if ($this->relationLoaded('doi')) {
                $doiModel = $this->getRelation('doi');
            } elseif ($this->hasRelationAutoloadCallback()) {
                try {
                    $doiModel = $this->doi;
                } catch (LazyLoadingViolationException) {
                    $doiModel = null;
                }
            }
            $publication->setData(
                'doiObject',
                $doiModel
                    ? $doiModel->toDataObject()
                    : Repo::doi()->get($publication->getData('doiId'))
            );
        }

        // Set the primary locale from the submission; the legacy collector
        // query joins submissions for it, the caller usually passes it
        $submissionLocale ??= DB::table('submissions')
            ->where('submission_id', $publication->getData('submissionId'))
            ->value('locale');
        $publication->setData('locale', $submissionLocale);

        $publicationId = $publication->getId();

        // Citations, as \PKP\publication\DAO::fromRow(): a remembered
        // LazyCollection keyed by citation id in seq-asc order, so citations
        // that are never touched still cost zero queries. When first
        // iterated, the citations relation is used if it is loaded — or
        // batch-loadable via relationship autoloading — and the legacy
        // collector fetch runs unchanged otherwise.
        $publication->setData('citations', LazyCollection::make(function () use ($publicationId) {
            $models = null;
            if ($this->relationLoaded('citations')) {
                $models = $this->getRelation('citations');
            } elseif ($this->hasRelationAutoloadCallback()) {
                try {
                    $models = $this->citations;
                } catch (LazyLoadingViolationException) {
                    $models = null;
                }
            }
            if ($models === null) {
                yield from Repo::citation()->getByPublicationId($publicationId);
                return;
            }
            foreach ($models as $citationModel) {
                yield $citationModel->citationId => $citationModel->toDataObject();
            }
        })->remember());
        // The raw-citations string derives from the loaded citations
        // relation when available (same seq-asc order and PHP_EOL implode
        // as getRawCitationsByPublicationId()); otherwise the legacy query
        // runs at __toString() time, unchanged.
        $publication->setData('citationsRaw', new class ($this, $publicationId) implements \Stringable {
            public function __construct(public Publication $model, public int $publicationId)
            {
            }
            public function __toString()
            {
                if ($this->model->relationLoaded('citations')) {
                    return $this->model->getRelation('citations')
                        ->map(fn (CitationModel $citationModel) => $citationModel->rawCitation)
                        ->implode(PHP_EOL);
                }
                return Repo::citation()->getRawCitationsByPublicationId($this->publicationId)->implode(PHP_EOL);
            }
        });

        // Version string, as \PKP\publication\DAO::fromRow(). When the
        // version stage is unassigned, getVersionString() needs the
        // submission's context for the date format; resolve it by the
        // provided context id through the per-run cache — the same context
        // getVersionString() would fetch by the submission's contextId —
        // and pass it in, avoiding the per-publication submission + context
        // refetch. Without a context id the legacy lookup runs unchanged.
        $versionContext = null;
        if ($submissionContextId !== null && $publication->getVersion() === null) {
            $versionContext = self::$contextsById[$submissionContextId]
                ??= app()->get('context')->get($submissionContextId);
        }
        $publication->setData('versionString', Repo::publication()->getVersionString($publication, null, $versionContext));

        // Contributors from the authors relation, keyed by author id like
        // the legacy collector-backed LazyCollection set by setAuthors()
        $publication->setData(
            'authors',
            LazyCollection::make(function () use ($submissionLocale) {
                foreach ($this->authors as $authorModel) {
                    yield $authorModel->authorId => $authorModel->toDataObject($submissionLocale);
                }
            })->remember()
        );

        // Categories, as \PKP\publication\DAO::setCategories(). When the
        // categories relation is loaded — or batch-loadable via relationship
        // autoloading — the ids come from it; otherwise the legacy
        // per-publication pluck runs unchanged.
        $categoryModels = null;
        if ($this->relationLoaded('categories')) {
            $categoryModels = $this->getRelation('categories');
        } elseif ($this->hasRelationAutoloadCallback()) {
            try {
                $categoryModels = $this->categories;
            } catch (LazyLoadingViolationException) {
                $categoryModels = null;
            }
        }
        $publication->setData(
            'categoryIds',
            $categoryModels !== null
                ? $categoryModels->pluck('categoryId')->all()
                : PublicationCategory::withPublicationId($publicationId)->pluck('category_id')->toArray()
        );

        // Controlled vocabulary, as \PKP\publication\DAO::setControlledVocab(),
        // batched: one query for the four controlled_vocabs rows plus one
        // entries ->get() (rows + settings) covering all of them, instead of
        // four getBySymbolic() calls at two queries each. Each property is
        // built exactly as \PKP\controlledVocab\Repository::getBySymbolic()
        // builds it (per-locale arrays of getEntryData(), in entry retrieval
        // order), and a vocab with no row or no entries yields the same
        // empty array getBySymbolic() returns for it.
        // When the controlledVocabs relation is loaded — or batch-loadable
        // via relationship autoloading — the vocab rows and their entries
        // come from the (nested) relations, batched at both levels across
        // the autoload context; otherwise the standalone two-query fetch
        // below runs unchanged. Both paths produce the same
        // symbolic-grouped entry collections in the same per-vocab order.
        $vocabProps = [
            'keywords' => ControlledVocab::CONTROLLED_VOCAB_SUBMISSION_KEYWORD,
            'subjects' => ControlledVocab::CONTROLLED_VOCAB_SUBMISSION_SUBJECT,
            'disciplines' => ControlledVocab::CONTROLLED_VOCAB_SUBMISSION_DISCIPLINE,
            'supportingAgencies' => ControlledVocab::CONTROLLED_VOCAB_SUBMISSION_AGENCY,
        ];
        $entriesBySymbolic = null;
        $vocabModels = null;
        if ($this->relationLoaded('controlledVocabs')) {
            $vocabModels = $this->getRelation('controlledVocabs');
        } elseif ($this->hasRelationAutoloadCallback()) {
            try {
                $vocabModels = $this->controlledVocabs;
            } catch (LazyLoadingViolationException) {
                $vocabModels = null;
            }
        }
        if ($vocabModels !== null) {
            try {
                $entriesBySymbolic = $vocabModels->mapWithKeys(
                    fn (ControlledVocab $vocab) => [$vocab->symbolic => $vocab->controlledVocabEntries]
                );
            } catch (LazyLoadingViolationException) {
                $entriesBySymbolic = null;
            }
        }
        if ($entriesBySymbolic === null) {
            $vocabIdToSymbolic = ControlledVocab::query()
                ->withSymbolics(array_values($vocabProps))
                ->withAssoc(Application::ASSOC_TYPE_PUBLICATION, $publicationId)
                ->pluck('symbolic', 'controlled_vocab_id');
            $entriesBySymbolic = $vocabIdToSymbolic->isEmpty()
                ? collect()
                : ControlledVocabEntry::query()
                    ->whereIn('controlled_vocab_id', $vocabIdToSymbolic->keys())
                    ->get()
                    ->groupBy(fn (ControlledVocabEntry $entry) => $vocabIdToSymbolic[$entry->controlledVocabId]);
        }
        foreach ($vocabProps as $prop => $symbolic) {
            $result = [];
            foreach ($entriesBySymbolic->get($symbolic, collect()) as $entry) {
                foreach ($entry->name as $locale => $value) {
                    $result[$locale][] = $entry->getEntryData($locale);
                }
            }
            $publication->setData($prop, $result);
        }

        // Data citations, as \PKP\publication\DAO::setDataCitations(): from
        // the relation when loaded or batch-loadable, otherwise the legacy
        // per-publication fetch unchanged
        $dataCitationModels = null;
        if ($this->relationLoaded('dataCitations')) {
            $dataCitationModels = $this->getRelation('dataCitations');
        } elseif ($this->hasRelationAutoloadCallback()) {
            try {
                $dataCitationModels = $this->dataCitations;
            } catch (LazyLoadingViolationException) {
                $dataCitationModels = null;
            }
        }
        $publication->setData(
            'dataCitations',
            $dataCitationModels !== null
                ? $dataCitationModels->values()->all()
                : DataCitation::withPublicationId($publicationId)
                    ->orderBySeq()
                    ->get()
                    ->values()
                    ->all()
        );

        // Funders, as \PKP\publication\DAO::setFunders(): from the relation
        // when loaded or batch-loadable, otherwise the legacy per-submission
        // fetch unchanged. Version siblings share the submission's funder
        // rows; under relationship autoloading they receive the same Funder
        // model instances, which is fine for read-only bridging.
        $funderModels = null;
        if ($this->relationLoaded('funders')) {
            $funderModels = $this->getRelation('funders');
        } elseif ($this->hasRelationAutoloadCallback()) {
            try {
                $funderModels = $this->funders;
            } catch (LazyLoadingViolationException) {
                $funderModels = null;
            }
        }
        $publication->setData(
            'funders',
            $funderModels !== null
                ? $funderModels->values()->all()
                : Funder::withSubmissionId($publication->getData('submissionId'))
                    ->orderBySeq()
                    ->get()
                    ->values()
                    ->all()
        );

        // Galleys from the relation, wrapped to match the app-level
        // \APP\publication\DAO::fromRow() wiring (sequential keys)
        $publication->setData(
            'galleys',
            LazyCollection::make(function () {
                foreach ($this->galleys as $galleyModel) {
                    yield $galleyModel->toDataObject();
                }
            })->remember()
        );

        return $publication;
    }

    /**
     * Scope a query to publications of the given submission id/s
     */
    public function scopeWithSubmissionIds(Builder $query, int|array $submissionIds): Builder
    {
        return $query->whereIn('submission_id', Arr::wrap($submissionIds));
    }

    /**
     * Scope a query to the version ordering used by the legacy publication
     * collector's orderByVersion() (see \PKP\publication\Collector)
     */
    public function scopeOrderByVersion(Builder $query): Builder
    {
        $orderCase = 'CASE version_stage ';
        foreach (VersionStage::cases() as $case) {
            $orderCase .= 'WHEN ' . DB::getPdo()->quote($case->value) . ' THEN ' . $case->order() . ' ';
        }
        $orderCase .= 'ELSE 999 END';

        return $query
            ->orderByRaw('version_stage IS NOT NULL ASC')
            ->orderByRaw('CASE WHEN version_stage IS NULL THEN date_published ELSE NULL END ASC')
            ->orderByRaw($orderCase)
            ->orderBy('version_major', 'asc')
            ->orderBy('version_minor', 'asc')
            ->orderBy('date_published', 'desc');
    }

    /**
     * Map of schema property name => JSON-schema type, for the legacy-
     * equivalent value conversions in toDataObject()
     */
    protected static function schemaPropTypes(): array
    {
        if (static::$schemaPropTypes === null) {
            $schema = app()->get('schema')->get(PKPSchemaService::SCHEMA_PUBLICATION);
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
