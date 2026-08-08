<?php

/**
 * @file classes/galley/models/Galley.php
 *
 * Copyright (c) 2014-2026 Simon Fraser University
 * Copyright (c) 2000-2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class Galley
 *
 * @brief Eloquent read model for publication galleys, living alongside the
 *   DataObject-based \PKP\galley\Galley. Part of the incremental Eloquent
 *   adoption: batched hydration through SettingsBuilder (one query for the
 *   main rows plus one for all settings, regardless of result size) instead
 *   of the per-object settings query issued by EntityDAO::fromRow().
 *
 *   Schema-less for now because galley.json carries no origin annotations;
 *   the settings list below mirrors what is not in $primaryTableColumns of
 *   \PKP\galley\DAO.
 */

namespace PKP\galley\models;

use APP\facades\Repo;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\LazyLoadingViolationException;
use Illuminate\Support\Arr;
use PKP\core\traits\ModelWithSettings;
use PKP\submissionFile\models\SubmissionFile;

class Galley extends Model
{
    use ModelWithSettings;

    protected $table = 'publication_galleys';

    protected $primaryKey = 'galley_id';

    public $timestamps = false;

    protected $guarded = [
        'galleyId',
        'id',
    ];

    protected function casts(): array
    {
        return [
            'galley_id' => 'integer',
            'locale' => 'string',
            'publication_id' => 'integer',
            'label' => 'string',
            'submission_file_id' => 'integer',
            'seq' => 'float',
            'remote_url' => 'string',
            'is_approved' => 'boolean',
            'url_path' => 'string',
            'doi_id' => 'integer',
        ];
    }

    public function getSettingsTable(): string
    {
        return 'publication_galley_settings';
    }

    public static function getSchemaName(): ?string
    {
        return null;
    }

    public function getSettings(): array
    {
        return [
            'pub-id::publisher-id',
        ];
    }

    public function getMultilingualProps(): array
    {
        return [];
    }

    /**
     * The galley's submission file, fetched with the joined columns
     * (files.path, files.mimetype, submissions.locale) the legacy collector
     * query selects, so toDataObject() on the related model reproduces
     * Repo::submissionFile()->get() exactly. The scope survives eager
     * loading and relationship autoloading: the eager constraint is the
     * qualified `submission_files.submission_file_id IN (...)`, which the
     * joins leave unambiguous.
     */
    public function file(): BelongsTo
    {
        return $this->belongsTo(SubmissionFile::class, 'submission_file_id', 'submission_file_id')
            ->withFileAndLocale();
    }

    /**
     * Bridge to the DataObject representation used by templates, hooks and
     * the rest of the application. Field conversions mirror what
     * EntityDAO::fromRow() + \PKP\galley\DAO::fromRow() produce for the same
     * row (galley.json declares seq as integer, hence the cast).
     *
     * When the file relation is already loaded — or can be batch-loaded via
     * relationship autoloading — the DataObject's public $_submissionFile
     * memo is preloaded from it, so template-time getFile()/isPdfGalley()
     * calls cost no per-galley queries. Otherwise the property is left
     * untouched and the legacy lazy Repo::submissionFile()->get() behavior
     * applies.
     *
     * Missing-file semantics: a galley without a submissionFileId gets no
     * preload (getFile() guards on the id and returns null without a query).
     * A galley whose file row cannot be resolved (relation value null) also
     * gets no preload — and preloading null would be observably identical
     * anyway: the legacy memo check is isset($this->_submissionFile), and
     * isset(null) is false, so legacy getFile() re-fetches on every call for
     * a missing file whether or not null was ever assigned to the property.
     */
    public function toDataObject(): \PKP\galley\Galley
    {
        $galley = Repo::galley()->newDataObject();
        $galley->setAllData([
            'id' => $this->galleyId,
            'locale' => $this->locale,
            'label' => $this->label,
            'publicationId' => $this->publicationId,
            'seq' => (int) $this->seq,
            'submissionFileId' => $this->submissionFileId,
            'urlRemote' => $this->remoteUrl,
            'isApproved' => $this->isApproved,
            'urlPath' => $this->urlPath,
            'doiId' => $this->doiId,
        ]);
        $attributes = $this->getAttributes();
        $publisherId = $attributes['pub-id::publisher-id'] ?? $attributes['pubId::publisherId'] ?? null;
        if ($publisherId !== null) {
            $galley->setData('pub-id::publisher-id', $publisherId);
        }
        if (!empty($this->doiId)) {
            $galley->setData('doiObject', Repo::doi()->get($this->doiId));
        }

        // Preload the DataObject's submission file memo from the relation
        // when it is resolvable without a stray per-galley query: either the
        // relation is already loaded, or a relationship-autoload callback is
        // registered (the wired path — accessing the relation then
        // batch-loads it for every galley in the autoload context at once).
        // Without either, the property is left untouched so the legacy lazy
        // fetch keeps working, and the plain (non-autoloaded) model path
        // never degrades into a hidden N+1. The try/catch covers lazy-
        // loading prevention modes where access would throw instead of load.
        $fileModel = null;
        if ($this->relationLoaded('file')) {
            $fileModel = $this->getRelation('file');
        } elseif ($this->hasRelationAutoloadCallback()) {
            try {
                $fileModel = $this->file;
            } catch (LazyLoadingViolationException) {
                $fileModel = null;
            }
        }
        if ($fileModel !== null) {
            $galley->_submissionFile = $fileModel->toDataObject();
        }

        return $galley;
    }

    /**
     * Scope a query to galleys of the given publication id/s
     */
    public function scopeWithPublicationIds(Builder $query, int|array $publicationIds): Builder
    {
        return $query->whereIn('publication_id', Arr::wrap($publicationIds));
    }

    /**
     * Scope a query to the galley ordering used for display
     */
    public function scopeOrderBySequence(Builder $query): Builder
    {
        return $query->orderBy('seq');
    }
}
