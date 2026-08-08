<?php

/**
 * @file classes/submissionFile/models/SubmissionFile.php
 *
 * Copyright (c) 2014-2026 Simon Fraser University
 * Copyright (c) 2000-2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class SubmissionFile
 *
 * @brief Eloquent read model for submission files, living alongside the
 *   DataObject-based \PKP\submissionFile\SubmissionFile. Part of the
 *   incremental Eloquent adoption: batched hydration through SettingsBuilder
 *   (one query for the main rows plus one for all settings, regardless of
 *   result size) instead of the per-object main + settings query pair issued
 *   by \PKP\submissionFile\DAO::get() for every galley file on a landing
 *   page or issue TOC.
 *
 *   Schema-less for the trait (submissionFile.json carries no origin
 *   annotations); the settings and multilingual lists are derived at runtime
 *   from the schema service so app-level schema additions are included
 *   automatically.
 *
 *   The legacy DataObject carries three joined fields set by
 *   \PKP\submissionFile\DAO::fromRow(): submissionLocale (submissions.locale)
 *   plus path and mimetype (files table). Fetch through
 *   scopeWithFileAndLocale() so the row carries those columns; the file()
 *   relation on \PKP\galley\models\Galley applies the scope already.
 */

namespace PKP\submissionFile\models;

use APP\facades\Repo;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use PKP\core\traits\ModelWithSettings;
use PKP\services\PKPSchemaService;

class SubmissionFile extends Model
{
    use ModelWithSettings;

    /**
     * Schema properties that never appear as settings rows: composed or
     * attached by the repository at read time (dependent files, genre
     * details, urls), write-only upload payloads, or read from the joined
     * submissions/files rows (locale, path, mimetype — carried on the
     * DataObject as submissionLocale, path and mimetype by
     * \PKP\submissionFile\DAO::fromRow()). Everything else in the schema
     * that is not a primary table column is folded from the settings table
     * by the legacy EntityDAO::fromRow() and must be treated as a setting
     * here.
     */
    protected const NON_SETTING_PROPS = [
        '_href',
        'dependentFiles',
        'documentType',
        'file',
        'genreIsDependent',
        'genreIsSupplementary',
        'genreMetadataType',
        'genreName',
        'genreSupportsFileVariants',
        'locale',
        'mimetype',
        'path',
        'revisions',
        'uploaderUserName',
        'url',
    ];

    protected $table = 'submission_files';

    protected $primaryKey = 'submission_file_id';

    public $timestamps = false;

    protected $guarded = [
        'submissionFileId',
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
            'submission_file_id' => 'integer',
            'submission_id' => 'integer',
            'file_id' => 'integer',
            'source_submission_file_id' => 'integer',
            'genre_id' => 'integer',
            'file_stage' => 'integer',
            // monograph leftovers present in the table but outside the
            // schema and \PKP\submissionFile\DAO::$primaryTableColumns
            'direct_sales_price' => 'string',
            'sales_type' => 'string',
            'viewable' => 'boolean',
            // plain cast columns, not Eloquent-managed timestamps
            'created_at' => 'string',
            'updated_at' => 'string',
            'uploader_user_id' => 'integer',
            'assoc_type' => 'integer',
            'assoc_id' => 'integer',
            'variant_group_id' => 'integer',
            'variant_type' => 'string',
            // joined columns added by scopeWithFileAndLocale()
            'path' => 'string',
            'mimetype' => 'string',
            'submission_locale' => 'string',
        ];
    }

    public function getSettingsTable(): string
    {
        return 'submission_file_settings';
    }

    public static function getSchemaName(): ?string
    {
        return null;
    }

    /**
     * Settings are every schema property that is not a primary table column
     * of the submission file DAO and not composed/joined/write-only. Derived
     * at runtime so app-level schema additions are included automatically.
     */
    public function getSettings(): array
    {
        if (static::$settingsFromSchema === null) {
            $schema = app()->get('schema')->get(PKPSchemaService::SCHEMA_SUBMISSION_FILE);
            static::$settingsFromSchema = array_values(array_diff(
                array_keys(get_object_vars($schema->properties)),
                array_keys(Repo::submissionFile()->dao->primaryTableColumns),
                self::NON_SETTING_PROPS
            ));
        }
        return static::$settingsFromSchema;
    }

    public function getMultilingualProps(): array
    {
        if (static::$multilingualFromSchema === null) {
            static::$multilingualFromSchema = array_values(array_intersect(
                app()->get('schema')->getMultilingualProps(PKPSchemaService::SCHEMA_SUBMISSION_FILE),
                $this->getSettings()
            ));
        }
        return static::$multilingualFromSchema;
    }

    /**
     * Scope a query to carry the joined columns the legacy collector query
     * selects (`sf.*, f.*, s.locale as submission_locale`): the file's path
     * and mimetype and the submission's locale. toDataObject() needs them to
     * reproduce \PKP\submissionFile\DAO::fromRow() exactly.
     */
    public function scopeWithFileAndLocale(Builder $query): Builder
    {
        return $query
            ->join('submissions', 'submissions.submission_id', '=', 'submission_files.submission_id')
            ->join('files', 'files.file_id', '=', 'submission_files.file_id')
            ->select('submission_files.*')
            ->addSelect([
                'files.path',
                'files.mimetype',
                'submissions.locale as submission_locale',
            ]);
    }

    /**
     * Bridge to the DataObject representation used by templates, hooks and
     * the rest of the application. Reproduces exactly what
     * Repo::submissionFile()->get() produces: EntityDAO::fromRow()
     * conversions per JSON-schema type plus the three joined fields set by
     * \PKP\submissionFile\DAO::fromRow() (submissionLocale, path, mimetype).
     * The model must have been fetched through scopeWithFileAndLocale() (as
     * the galley file() relation does) for the joined fields to carry values.
     */
    public function toDataObject(): \PKP\submissionFile\SubmissionFile
    {
        $attributes = $this->getAttributes();
        $propTypes = static::schemaPropTypes();

        $submissionFile = Repo::submissionFile()->dao->newDataObject();

        // Primary table columns, converted by JSON-schema type exactly as
        // EntityDAO::fromRow() does (nullable: null stays null)
        $data = [];
        foreach (Repo::submissionFile()->dao->primaryTableColumns as $propName => $column) {
            if (!array_key_exists($column, $attributes)) {
                continue;
            }
            $value = $attributes[$column];
            $data[$propName] = $value === null
                ? null
                : self::convertFromDb($value, $propTypes[$propName] ?? 'string');
        }
        $submissionFile->setAllData($data);

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
                    $submissionFile->setData($name, $localized);
                }
            } elseif (array_key_exists($name, $attributes)) {
                $submissionFile->setData($name, self::convertFromDb($attributes[$name], $type));
            }
        }

        // Joined fields, set unconditionally and unconverted exactly as
        // \PKP\submissionFile\DAO::fromRow() sets them from the collector row
        $submissionFile->setData('submissionLocale', $attributes['submission_locale'] ?? null);
        $submissionFile->setData('path', $attributes['path'] ?? null);
        $submissionFile->setData('mimetype', $attributes['mimetype'] ?? null);

        return $submissionFile;
    }

    /**
     * Map of schema property name => JSON-schema type, for the legacy-
     * equivalent value conversions in toDataObject()
     */
    protected static function schemaPropTypes(): array
    {
        if (static::$schemaPropTypes === null) {
            $schema = app()->get('schema')->get(PKPSchemaService::SCHEMA_SUBMISSION_FILE);
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
