<?php

/**
 * @file classes/ror/models/Ror.php
 *
 * Copyright (c) 2014-2026 Simon Fraser University
 * Copyright (c) 2000-2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class Ror
 *
 * @brief Eloquent read model for ROR (Research Organization Registry)
 *   records, living alongside the DataObject-based \PKP\ror\Ror.
 *   Schema-less because ror.json carries no origin annotations.
 */

namespace PKP\ror\models;

use APP\facades\Repo;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Arr;
use PKP\core\traits\ModelWithSettings;

class Ror extends Model
{
    use ModelWithSettings;

    protected $table = 'rors';

    protected $primaryKey = 'ror_id';

    public $timestamps = false;

    protected $guarded = [
        'rorId',
        'id',
    ];

    protected function casts(): array
    {
        return [
            'ror_id' => 'integer',
            'ror' => 'string',
            'display_locale' => 'string',
            'is_active' => 'boolean',
            'search_phrase' => 'string',
        ];
    }

    public function getSettingsTable(): string
    {
        return 'ror_settings';
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
     * Bridge to the DataObject representation, mirroring what
     * EntityDAO::fromRow() produces for the same row.
     */
    public function toDataObject(): \PKP\ror\Ror
    {
        $ror = Repo::ror()->newDataObject();
        $ror->setAllData([
            'id' => $this->rorId,
            'ror' => $this->ror,
            'displayLocale' => $this->displayLocale,
            'isActive' => $this->isActive,
            'searchPhrase' => $this->searchPhrase,
        ]);
        // Match DataObject::setData() semantics: null locale values are
        // dropped, and a prop with no remaining locales is absent
        $name = array_filter($this->name ?? [], fn ($localeValue) => $localeValue !== null);
        if ($name !== []) {
            $ror->setData('name', $name);
        }
        return $ror;
    }

    /**
     * Scope a query to the given ROR uri/s
     */
    public function scopeWithRors(Builder $query, string|array $rors): Builder
    {
        return $query->whereIn('ror', Arr::wrap($rors));
    }
}
