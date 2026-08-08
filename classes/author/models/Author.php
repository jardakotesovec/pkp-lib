<?php

/**
 * @file classes/author/models/Author.php
 *
 * Copyright (c) 2014-2026 Simon Fraser University
 * Copyright (c) 2000-2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class Author
 *
 * @brief Eloquent read model for contributors, living alongside the
 *   DataObject-based \PKP\author\Author. Batched hydration through
 *   SettingsBuilder plus eager-loadable affiliations replaces the
 *   4-7 queries EntityDAO issues per author (settings, affiliations,
 *   affiliation settings, credit roles, contributor roles).
 *
 *   Schema-less because author.json carries no origin annotations; the
 *   settings list mirrors the schema properties that are not in
 *   $primaryTableColumns of \PKP\author\DAO and not readOnly/composed.
 */

namespace PKP\author\models;

use APP\facades\Repo;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Arr;
use PKP\affiliation\models\Affiliation;
use PKP\core\traits\ModelWithSettings;

class Author extends Model
{
    use ModelWithSettings;

    protected $table = 'authors';

    protected $primaryKey = 'author_id';

    public $timestamps = false;

    protected $guarded = [
        'authorId',
        'id',
    ];

    protected function casts(): array
    {
        return [
            'author_id' => 'integer',
            'email' => 'string',
            'include_in_browse' => 'boolean',
            'publication_id' => 'integer',
            'seq' => 'integer',
            'contributor_type' => 'string',
        ];
    }

    public function getSettingsTable(): string
    {
        return 'author_settings';
    }

    public static function getSchemaName(): ?string
    {
        return null;
    }

    public function getSettings(): array
    {
        return [
            'biography',
            'competingInterests',
            'country',
            'familyName',
            'givenName',
            'orcid',
            'organizationName',
            'preferredPublicName',
            'url',
            'rorId',
            'orcidSandbox',
            'orcidAccessToken',
            'orcidAccessScope',
            'orcidRefreshToken',
            'orcidAccessExpiresOn',
            'orcidAccessDenied',
            'orcidEmailToken',
            'orcidIsVerified',
            'orcidWorkPutCode',
            'orcidVerificationRequested',
        ];
    }

    public function getMultilingualProps(): array
    {
        return [
            'biography',
            'competingInterests',
            'familyName',
            'givenName',
            'organizationName',
            'preferredPublicName',
        ];
    }

    /**
     * Affiliations of this contributor
     */
    public function affiliations(): HasMany
    {
        return $this->hasMany(Affiliation::class, 'author_id', 'author_id');
    }

    /**
     * Bridge to the DataObject representation used by templates, hooks and
     * the rest of the application. Mirrors what EntityDAO::fromRow() +
     * \PKP\author\DAO::fromRow() produce. The caller provides the pieces
     * that live outside the authors tables so they can be fetched in
     * batches: the submission locale and the credit/contributor roles
     * (arrays in the formats returned by Repo::creditContributorRole()).
     * Affiliations come from the eager-loaded relation.
     */
    public function toDataObject(
        ?string $submissionLocale = null,
        ?array $creditRoles = null,
        ?array $contributorRoles = null,
        ?array $rorObjects = null
    ): \PKP\author\Author {
        $author = Repo::author()->newDataObject();
        $author->setAllData([
            'id' => $this->authorId,
            'email' => $this->email,
            'includeInBrowse' => $this->includeInBrowse,
            'publicationId' => $this->publicationId,
            'seq' => $this->seq,
            'contributorType' => $this->contributorType,
        ]);

        foreach ($this->getSettings() as $setting) {
            $value = $this->getAttribute($setting);
            if (in_array($setting, $this->getMultilingualProps())) {
                // Match DataObject::setData() semantics: null locale values
                // are dropped, and a prop with no remaining locales is absent
                $value = array_filter($value ?? [], fn ($localeValue) => $localeValue !== null);
                if ($value === []) {
                    continue;
                }
            }
            if ($value !== null) {
                $author->setData($setting, $value);
            }
        }

        if ($submissionLocale !== null) {
            $author->setData('submissionLocale', $submissionLocale);
        }

        $author->setAffiliations(
            $this->affiliations->map(fn (Affiliation $affiliation) => $affiliation->toDataObject($rorObjects))->all()
        );
        $author->setCreditRoles($creditRoles ?? []);
        $author->setContributorRoles($contributorRoles ?? []);

        return $author;
    }

    /**
     * Scope a query to contributors of the given publication id/s
     */
    public function scopeWithPublicationIds(Builder $query, int|array $publicationIds): Builder
    {
        return $query->whereIn('publication_id', Arr::wrap($publicationIds));
    }

    /**
     * Scope a query to the contributor ordering used for display
     */
    public function scopeOrderBySequence(Builder $query): Builder
    {
        return $query->orderBy('seq');
    }
}
