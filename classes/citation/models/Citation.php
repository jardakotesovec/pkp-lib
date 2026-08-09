<?php

/**
 * @file classes/citation/models/Citation.php
 *
 * Copyright (c) 2014-2026 Simon Fraser University
 * Copyright (c) 2000-2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class Citation
 *
 * @brief Eloquent read model for citations, living alongside the
 *   DataObject-based \PKP\citation\Citation. Batched hydration through
 *   SettingsBuilder (one query for the main rows plus one for all settings)
 *   replaces the per-citation settings query issued by
 *   EntityDAO::fromRow(), and as a relation target it lets relationship
 *   autoloading batch the citations fetch across a whole collection of
 *   publications.
 *
 *   Schema-less for the trait (citation.json carries no origin
 *   annotations); the settings and multilingual lists are derived at
 *   runtime from the schema service so schema additions are included
 *   automatically.
 */

namespace PKP\citation\models;

use APP\facades\Repo;
use Illuminate\Database\Eloquent\Model;
use PKP\core\traits\ModelWithSettings;
use PKP\services\PKPSchemaService;

class Citation extends Model
{
    use ModelWithSettings;

    /**
     * Schema properties that never appear as settings rows: computed or
     * API-only properties that EntityDAO::fromRow() never hydrates.
     */
    protected const NON_SETTING_PROPS = [
        '_href',
    ];

    protected $table = 'citations';

    protected $primaryKey = 'citation_id';

    public $timestamps = false;

    protected $guarded = [
        'citationId',
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
            'citation_id' => 'integer',
            'publication_id' => 'integer',
            'raw_citation' => 'string',
            // citation.json declares seq as integer
            'seq' => 'integer',
        ];
    }

    public function getSettingsTable(): string
    {
        return 'citation_settings';
    }

    public static function getSchemaName(): ?string
    {
        return null;
    }

    /**
     * Settings are every schema property that is not a primary table column
     * of the citation DAO and not computed at hydration time. Derived at
     * runtime so schema additions are included automatically.
     */
    public function getSettings(): array
    {
        if (static::$settingsFromSchema === null) {
            $schema = app()->get('schema')->get(PKPSchemaService::SCHEMA_CITATION);
            static::$settingsFromSchema = array_values(array_diff(
                array_keys(get_object_vars($schema->properties)),
                array_keys(Repo::citation()->dao->primaryTableColumns),
                self::NON_SETTING_PROPS
            ));
        }
        return static::$settingsFromSchema;
    }

    public function getMultilingualProps(): array
    {
        if (static::$multilingualFromSchema === null) {
            static::$multilingualFromSchema = array_values(array_intersect(
                app()->get('schema')->getMultilingualProps(PKPSchemaService::SCHEMA_CITATION),
                $this->getSettings()
            ));
        }
        return static::$multilingualFromSchema;
    }

    /**
     * Bridge to the DataObject representation used by templates, hooks and
     * the rest of the application. Reproduces exactly what the DataObjects
     * yielded by Repo::citation()->getByPublicationId() carry:
     * EntityDAO::fromRow() conversions for the primary table columns and
     * the settings rows (\PKP\citation\DAO adds no extra hydration).
     */
    public function toDataObject(): \PKP\citation\Citation
    {
        $attributes = $this->getAttributes();
        $propTypes = static::schemaPropTypes();

        $citation = Repo::citation()->newDataObject();

        // Primary table columns, converted by JSON-schema type exactly as
        // EntityDAO::fromRow() does (nullable: null stays null)
        $data = [];
        foreach (Repo::citation()->dao->primaryTableColumns as $propName => $column) {
            if (!array_key_exists($column, $attributes)) {
                continue;
            }
            $value = $attributes[$column];
            $data[$propName] = $value === null
                ? null
                : self::convertFromDb($value, $propTypes[$propName] ?? 'string');
        }
        $citation->setAllData($data);

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
                    $citation->setData($name, $localized);
                }
            } elseif (array_key_exists($name, $attributes)) {
                $citation->setData($name, self::convertFromDb($attributes[$name], $type));
            }
        }

        return $citation;
    }

    /**
     * Map of schema property name => JSON-schema type, for the legacy-
     * equivalent value conversions in toDataObject()
     */
    protected static function schemaPropTypes(): array
    {
        if (static::$schemaPropTypes === null) {
            $schema = app()->get('schema')->get(PKPSchemaService::SCHEMA_CITATION);
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
