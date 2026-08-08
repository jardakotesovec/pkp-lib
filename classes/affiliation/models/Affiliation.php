<?php

/**
 * @file classes/affiliation/models/Affiliation.php
 *
 * Copyright (c) 2014-2026 Simon Fraser University
 * Copyright (c) 2000-2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class Affiliation
 *
 * @brief Eloquent read model for author affiliations, living alongside the
 *   DataObject-based \PKP\affiliation\Affiliation. Schema-less because
 *   affiliation.json carries no origin annotations; the settings list
 *   mirrors what is not in $primaryTableColumns of \PKP\affiliation\DAO.
 */

namespace PKP\affiliation\models;

use APP\facades\Repo;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Arr;
use PKP\core\traits\ModelWithSettings;

class Affiliation extends Model
{
    use ModelWithSettings;

    protected $table = 'author_affiliations';

    protected $primaryKey = 'author_affiliation_id';

    public $timestamps = false;

    protected $guarded = [
        'authorAffiliationId',
        'id',
    ];

    protected function casts(): array
    {
        return [
            'author_affiliation_id' => 'integer',
            'author_id' => 'integer',
            'ror' => 'string',
        ];
    }

    public function getSettingsTable(): string
    {
        return 'author_affiliation_settings';
    }

    public static function getSchemaName(): ?string
    {
        return null;
    }

    public function getSettings(): array
    {
        return [
            'name',
        ];
    }

    public function getMultilingualProps(): array
    {
        return [
            'name',
        ];
    }

    /**
     * Bridge to the DataObject representation. Mirrors what
     * EntityDAO::fromRow() + \PKP\affiliation\DAO::fromRow() produce,
     * including the rorObject attach for ROR-linked affiliations.
     *
     * @param ?array $rorObjects optional batch-fetched map of ror uri =>
     *   \PKP\ror\Ror DataObject (missing keys mean the uri is not in the
     *   registry table). When null, ROR-linked affiliations fall back to
     *   the legacy per-object lookup.
     */
    public function toDataObject(?array $rorObjects = null): \PKP\affiliation\Affiliation
    {
        $affiliation = Repo::affiliation()->newDataObject();
        $affiliation->setAllData([
            'id' => $this->authorAffiliationId,
            'authorId' => $this->authorId,
            'ror' => $this->ror,
        ]);
        // Match DataObject::setData() semantics: null locale values are
        // dropped, and a prop with no remaining locales is absent
        $name = array_filter($this->name ?? [], fn ($localeValue) => $localeValue !== null);
        if ($name !== []) {
            $affiliation->setData('name', $name);
        }
        if (!empty($this->ror)) {
            $affiliation->setData(
                'rorObject',
                $rorObjects !== null
                    ? ($rorObjects[$this->ror] ?? null)
                    : Repo::ror()->getCollector()->filterByRor($this->ror)->getMany()->first()
            );
        }
        return $affiliation;
    }

    /**
     * Scope a query to affiliations of the given author id/s
     */
    public function scopeWithAuthorIds(Builder $query, int|array $authorIds): Builder
    {
        return $query->whereIn('author_id', Arr::wrap($authorIds));
    }
}
