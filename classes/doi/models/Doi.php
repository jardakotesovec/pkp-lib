<?php

/**
 * @file classes/doi/models/Doi.php
 *
 * Copyright (c) 2014-2026 Simon Fraser University
 * Copyright (c) 2000-2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class Doi
 *
 * @brief Eloquent read model for DOIs, living alongside the DataObject-based
 *   \PKP\doi\Doi. Batched hydration through SettingsBuilder (one query for
 *   the main rows plus one for all settings) replaces the per-DOI row +
 *   settings queries issued by Repo::doi()->get(), and as a relation target
 *   it lets relationship autoloading batch the DOI fetch across a whole
 *   collection of publications or galleys.
 *
 *   Schema-less for the trait (doi.json carries no origin annotations); the
 *   settings and multilingual lists are derived at runtime from the schema
 *   service so app-level schema additions are included automatically.
 */

namespace PKP\doi\models;

use APP\facades\Repo;
use Illuminate\Database\Eloquent\Model;
use PKP\core\traits\ModelWithSettings;
use PKP\services\PKPSchemaService;

class Doi extends Model
{
    use ModelWithSettings;

    /**
     * Schema properties that never appear as settings rows: resolvingUrl is
     * computed and attached by \PKP\doi\DAO::fromRow() at hydration time.
     */
    protected const NON_SETTING_PROPS = [
        '_href',
        'resolvingUrl',
    ];

    protected $table = 'dois';

    protected $primaryKey = 'doi_id';

    public $timestamps = false;

    protected $guarded = [
        'doiId',
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
            'doi_id' => 'integer',
            'context_id' => 'integer',
            'doi' => 'string',
            'status' => 'integer',
        ];
    }

    public function getSettingsTable(): string
    {
        return 'doi_settings';
    }

    public static function getSchemaName(): ?string
    {
        return null;
    }

    /**
     * Settings are every schema property that is not a primary table column
     * of the app-level DOI DAO and not attached at hydration time. Derived
     * at runtime so app-level schema additions are included automatically.
     */
    public function getSettings(): array
    {
        if (static::$settingsFromSchema === null) {
            $schema = app()->get('schema')->get(PKPSchemaService::SCHEMA_DOI);
            static::$settingsFromSchema = array_values(array_diff(
                array_keys(get_object_vars($schema->properties)),
                array_keys(Repo::doi()->dao->primaryTableColumns),
                self::NON_SETTING_PROPS
            ));
        }
        return static::$settingsFromSchema;
    }

    public function getMultilingualProps(): array
    {
        if (static::$multilingualFromSchema === null) {
            static::$multilingualFromSchema = array_values(array_intersect(
                app()->get('schema')->getMultilingualProps(PKPSchemaService::SCHEMA_DOI),
                $this->getSettings()
            ));
        }
        return static::$multilingualFromSchema;
    }

    /**
     * Bridge to the DataObject representation used by templates, hooks and
     * the rest of the application. Reproduces everything Repo::doi()->get()
     * produces: EntityDAO::fromRow() conversions plus the resolvingUrl
     * attachment of \PKP\doi\DAO::fromRow().
     */
    public function toDataObject(): \PKP\doi\Doi
    {
        $attributes = $this->getAttributes();
        $propTypes = static::schemaPropTypes();

        $doi = Repo::doi()->newDataObject();

        // Primary table columns, converted by JSON-schema type exactly as
        // EntityDAO::fromRow() does (nullable: null stays null)
        $data = [];
        foreach (Repo::doi()->dao->primaryTableColumns as $propName => $column) {
            if (!array_key_exists($column, $attributes)) {
                continue;
            }
            $value = $attributes[$column];
            $data[$propName] = $value === null
                ? null
                : self::convertFromDb($value, $propTypes[$propName] ?? 'string');
        }
        $doi->setAllData($data);

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
                    $doi->setData($name, $localized);
                }
            } elseif (array_key_exists($name, $attributes)) {
                $doi->setData($name, self::convertFromDb($attributes[$name], $type));
            }
        }

        // Resolving URL, as \PKP\doi\DAO::fromRow()
        if (empty($doi->getData('doi'))) {
            $doi->setData('resolvingUrl', '');
        } else {
            $doi->setData('resolvingUrl', $doi->getResolvingUrl());
        }

        return $doi;
    }

    /**
     * Map of schema property name => JSON-schema type, for the legacy-
     * equivalent value conversions in toDataObject()
     */
    protected static function schemaPropTypes(): array
    {
        if (static::$schemaPropTypes === null) {
            $schema = app()->get('schema')->get(PKPSchemaService::SCHEMA_DOI);
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
