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

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Arr;
use PKP\core\traits\ModelWithSettings;

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
