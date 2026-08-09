<?php

/**
 * @file classes/core/traits/DataObjectReadCompat.php
 *
 * Copyright (c) 2014-2026 Simon Fraser University
 * Copyright (c) 2000-2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class DataObjectReadCompat
 *
 * @brief EXPERIMENTAL read-only \PKP\core\DataObject API surface for the
 *   Eloquent read models (ModelWithSettings), letting templates, frontend
 *   plugins and hooks consume the models directly — without a
 *   toDataObject() bridge on the read path.
 *
 *   The trait mirrors DataObject's exact read semantics:
 *   - getData($key): the value under the prop name. Primary table columns
 *     resolve through the model's camelCase attribute mapping and casts,
 *     settings resolve verbatim under their (camelCase) setting name, and
 *     relation-backed pseudo props (e.g. a publication's 'authors',
 *     'galleys', 'doiObject') resolve through per-model resolvers declared
 *     in dataObjectCompatPseudoProps() — returning LIVE models, so the
 *     compat surface cascades down the object graph. A per-model
 *     dataObjectCompatConvert() hook applies the legacy
 *     EntityDAO::fromRow() value conversions (JSON-schema typed casts,
 *     null-locale dropping for multilingual props) so values match what
 *     the DataObject would have carried. Missing props return null, like
 *     a missing _data key.
 *   - getData($key, $locale): element of the (multilingual) array under
 *     $locale, null when absent — DataObject casts the value to array for
 *     the lookup, and so does this.
 *   - getLocalizedData($key, $preferredLocale, &$selectedLocale): returns
 *     non-arrays as-is, otherwise delegates to
 *     LocalizedData::getBestLocalizedData() — the SAME trait DataObject
 *     uses (ModelWithSettings already mixes it in), so the locale
 *     precedence (preferred → current → model's getDefaultLocale() →
 *     context primary → site primary → first non-empty) is byte-identical
 *     by construction. Models override getDefaultLocale() where the
 *     DataObject subclass does (e.g. submission locale).
 *
 *   Known, documented deviations from DataObject (read-only surface):
 *   - getData() does not return by reference (DataObject's `&getData`);
 *     no read consumer on the page path writes through the reference.
 *   - getAllData() returns the model's raw attribute array (snake_case
 *     columns + camelCase settings), not the _data prop map. No page-path
 *     consumer calls it; it exists to complete the surface.
 *   - Write methods (setData etc.) are intentionally absent: models on
 *     this path are read-only.
 *
 *   NOTE ModelWithSettings::getLocalizedData() has an incompatible
 *   signature (bool $localeMatch third parameter, throws on
 *   non-multilingual props). Classes mixing in this trait must resolve
 *   the collision:
 *     use ModelWithSettings, DataObjectReadCompat {
 *         DataObjectReadCompat::getLocalizedData insteadof ModelWithSettings;
 *     }
 */

namespace PKP\core\traits;

trait DataObjectReadCompat
{
    /**
     * Map of DataObject prop name => method name on the model resolving it.
     * For props that are not stored attributes: relation-backed collections
     * ('authors', 'galleys', 'publications', ...), composed values
     * ('versionString', 'citationsRaw'), attribute aliases whose DataObject
     * prop name differs from the column-derived attribute name
     * ('urlRemote' => remote_url), and values read from related rows
     * (a publication's 'locale' from its submission).
     */
    protected function dataObjectCompatPseudoProps(): array
    {
        return [];
    }

    /**
     * Per-model value conversion mirroring what EntityDAO::fromRow() (via
     * \PKP\db\DAO::convertFromDB()) does to raw settings values. Identity by
     * default; schema-backed models override this with their JSON-schema
     * typed conversion.
     */
    protected function dataObjectCompatConvert(string $key, mixed $value): mixed
    {
        return $value;
    }

    /**
     * @copydoc \PKP\core\DataObject::getData()
     *
     * (Read-only: does not return by reference.)
     */
    public function getData(string $key, ?string $locale = null): mixed
    {
        $pseudoProps = $this->dataObjectCompatPseudoProps();
        $value = isset($pseudoProps[$key])
            ? $this->{$pseudoProps[$key]}()
            : $this->dataObjectCompatConvert($key, $this->getAttribute($key));

        if ($locale === null) {
            return $value;
        }
        // DataObject: array_key_exists($locale, (array) ($this->_data[$key] ?? []))
        $localized = (array) ($value ?? []);
        return array_key_exists($locale, $localized) ? $localized[$locale] : null;
    }

    /**
     * @copydoc \PKP\core\DataObject::getLocalizedData()
     */
    public function getLocalizedData(string $key, ?string $preferredLocale = null, ?string &$selectedLocale = null): mixed
    {
        $value = $this->getData($key);
        if (!is_array($value)) {
            return $value;
        }
        return $this->getBestLocalizedData($value, $preferredLocale, $selectedLocale);
    }

    /**
     * @copydoc \PKP\core\DataObject::hasData()
     */
    public function hasData(string $key, ?string $locale = null): bool
    {
        $value = $this->getData($key);
        if ($locale === null) {
            return $value !== null;
        }
        return array_key_exists($locale, (array) ($value ?? []));
    }

    /**
     * @copydoc \PKP\core\DataObject::getId()
     */
    public function getId(): ?int
    {
        $id = $this->getAttribute('id');
        return $id === null ? null : (int) $id;
    }

    /**
     * Complete the DataObject read surface. Returns the model's attribute
     * array (snake_case primary columns plus camelCase settings), NOT a
     * _data prop map — see the class docblock.
     */
    public function getAllData(): array
    {
        return $this->getAttributes();
    }
}
