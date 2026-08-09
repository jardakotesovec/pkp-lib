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
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use PKP\affiliation\models\Affiliation;
use PKP\author\contributorRole\ContributorRole;
use PKP\author\contributorRole\ContributorType;
use PKP\author\creditContributorRole\CreditContributorRole;
use PKP\core\traits\DataObjectReadCompat;
use PKP\core\traits\ModelWithSettings;
use PKP\facades\Locale;
use PKP\publication\models\Publication as PublicationModel;

class Author extends Model
{
    use ModelWithSettings;
    use DataObjectReadCompat {
        DataObjectReadCompat::getLocalizedData insteadof ModelWithSettings;
    }

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
     * CRediT/contributor role links of this contributor
     */
    public function creditContributorRoles(): HasMany
    {
        return $this->hasMany(CreditContributorRole::class, 'contributor_id', 'author_id');
    }

    /**
     * Bridge to the DataObject representation used by templates, hooks and
     * the rest of the application. Mirrors what EntityDAO::fromRow() +
     * \PKP\author\DAO::fromRow() produce. The caller may provide the pieces
     * that live outside the authors tables so they can be fetched in
     * batches: the submission locale and the credit/contributor roles
     * (arrays in the formats returned by Repo::creditContributorRole()).
     * When the role side-maps are null they are derived from the
     * creditContributorRoles relation instead (batch-loaded via relationship
     * autoloading in the publication path). Affiliations come from the
     * eager/auto-loaded relation.
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

        if ($creditRoles === null || $contributorRoles === null) {
            // Derive the role side-maps from the relation, reproducing the
            // formats of Repo::creditContributorRole():
            // getCreditRolesByContributorId() returns rows of
            // ['role' => identifier, 'degree' => degree] in credit_role_id
            // order (its unordered join is driven by the credit_roles side);
            // getContributorRolesByContributorId() returns ContributorRole
            // models ordered by contributor_role_id
            $roleLinks = $this->creditContributorRoles;
            $creditRoles ??= $roleLinks
                ->filter(fn (CreditContributorRole $link) => $link->creditRoleId !== null)
                ->sortBy('creditRoleId')
                ->map(fn (CreditContributorRole $link) => [
                    'role' => $link->creditRole?->creditRoleIdentifier,
                    'degree' => $link->creditDegree,
                ])
                ->values()
                ->all();
            $contributorRoles ??= $roleLinks
                ->filter(fn (CreditContributorRole $link) => $link->contributorRoleId !== null)
                ->sortBy('contributorRoleId')
                ->map(fn (CreditContributorRole $link) => $link->contributorRole)
                ->values()
                ->all();
        }
        $author->setCreditRoles($creditRoles);
        $author->setContributorRoles($contributorRoles);

        return $author;
    }

    //
    // EXPERIMENTAL DataObject read-compat surface (see DataObjectReadCompat)
    //

    /**
     * The contributor's publication, for the submissionLocale pseudo prop
     * (the legacy hydration reads it off the joined submission row)
     */
    public function publication(): BelongsTo
    {
        return $this->belongsTo(PublicationModel::class, 'publication_id', 'publication_id');
    }

    /**
     * @copydoc DataObjectReadCompat::dataObjectCompatPseudoProps()
     */
    protected function dataObjectCompatPseudoProps(): array
    {
        return [
            'affiliations' => 'compatAffiliations',
            'creditRoles' => 'compatCreditRoles',
            'contributorRoles' => 'compatContributorRoles',
            'submissionLocale' => 'compatSubmissionLocale',
        ];
    }

    /** Live affiliation models as a plain array (legacy: setAffiliations array) */
    protected function compatAffiliations(): array
    {
        return $this->affiliations->all();
    }

    /**
     * Credit roles in the format of
     * Repo::creditContributorRole()->getCreditRolesByContributorId(), derived
     * from the creditContributorRoles relation like toDataObject() does
     */
    protected function compatCreditRoles(): array
    {
        return $this->creditContributorRoles
            ->filter(fn (CreditContributorRole $link) => $link->creditRoleId !== null)
            ->sortBy('creditRoleId')
            ->map(fn (CreditContributorRole $link) => [
                'role' => $link->creditRole?->creditRoleIdentifier,
                'degree' => $link->creditDegree,
            ])
            ->values()
            ->all();
    }

    /**
     * ContributorRole models in the format of
     * Repo::creditContributorRole()->getContributorRolesByContributorId(),
     * derived from the creditContributorRoles relation like toDataObject()
     */
    protected function compatContributorRoles(): array
    {
        return $this->creditContributorRoles
            ->filter(fn (CreditContributorRole $link) => $link->contributorRoleId !== null)
            ->sortBy('contributorRoleId')
            ->map(fn (CreditContributorRole $link) => $link->contributorRole)
            ->values()
            ->all();
    }

    /** The submission's locale, as the legacy author hydration attaches it */
    protected function compatSubmissionLocale(): ?string
    {
        return $this->publication?->submission?->locale;
    }

    /**
     * @copydoc \PKP\author\Author::getDefaultLocale()
     */
    public function getDefaultLocale(): ?string
    {
        return $this->getData('submissionLocale');
    }

    /**
     * @copydoc \PKP\author\Author::getFullName()
     *
     * Dispatch on contributor type as \PKP\author\Author::getFullName() does,
     * with the PERSON branch inlined from \PKP\identity\Identity::getFullName()
     */
    public function getFullName(bool $preferred = true, bool $familyFirst = false, ?string $preferredLocale = null): string
    {
        return match ($this->getData('contributorType')) {
            ContributorType::PERSON->getName() => $this->getPersonFullName($preferred, $familyFirst, $preferredLocale),
            ContributorType::ORGANIZATION->getName() => $this->getLocalizedOrganizationName($preferredLocale),
            ContributorType::ANONYMOUS->getName() => __('submission.submit.contributorType.anonymous', locale: $preferredLocale),
        };
    }

    /**
     * @copydoc \PKP\identity\Identity::getFullName()
     */
    protected function getPersonFullName(bool $preferred = true, bool $familyFirst = false, ?string $preferredLocale = null): string
    {
        $locale = $preferredLocale ?? Locale::getLocale();
        if ($preferred) {
            $preferredPublicName = $this->getPreferredPublicName($locale);
            if (!empty($preferredPublicName)) {
                return $preferredPublicName;
            }
        }
        $givenName = $this->getGivenName($locale);
        if (empty($givenName)) {
            $locale = $this->getDefaultLocale();
            $givenName = $this->getGivenName($locale);
        }
        $familyName = $this->getFamilyName($locale);
        if ($familyFirst) {
            return ($familyName != '' ? "{$familyName}, " : '') . $givenName;
        }
        return $givenName . ($familyName != '' ? " {$familyName}" : '');
    }

    /**
     * @copydoc \PKP\identity\Identity::getGivenName()
     */
    public function getGivenName($locale)
    {
        return $this->getData('givenName', $locale);
    }

    /**
     * @copydoc \PKP\identity\Identity::getFamilyName()
     */
    public function getFamilyName($locale)
    {
        return $this->getData('familyName', $locale);
    }

    /**
     * @copydoc \PKP\identity\Identity::getPreferredPublicName()
     */
    public function getPreferredPublicName($locale)
    {
        return $this->getData('preferredPublicName', $locale);
    }

    /**
     * @copydoc \PKP\author\Author::getLocalizedOrganizationName()
     */
    public function getLocalizedOrganizationName(?string $preferredLocale = null): ?string
    {
        return $this->getLocalizedData('organizationName', $preferredLocale);
    }

    /**
     * @copydoc \PKP\author\Author::getAffiliations()
     */
    public function getAffiliations(): array
    {
        return $this->getData('affiliations') ?? [];
    }

    /**
     * @copydoc \PKP\author\Author::getLocalizedAffiliationNames()
     */
    public function getLocalizedAffiliationNames(?string $preferredLocale = null): array
    {
        return array_map(fn ($affiliation) => $affiliation->getLocalizedName($preferredLocale), $this->getAffiliations());
    }

    /**
     * @copydoc \PKP\author\Author::getLocalizedAffiliationNamesAsString()
     */
    public function getLocalizedAffiliationNamesAsString(?string $preferredLocale = null, ?string $separator = '; '): string
    {
        return implode(
            $separator,
            $this->getLocalizedAffiliationNames($preferredLocale)
        );
    }

    /**
     * @copydoc \PKP\author\Author::getLocalizedContributorRoleNames()
     */
    public function getLocalizedContributorRoleNames(?string $preferredLocale = null): array
    {
        return collect($this->getData('contributorRoles'))
            ->map(fn (ContributorRole $role): string => $role->getLocalizedData('name', $preferredLocale))
            ->toArray();
    }

    /**
     * @copydoc \PKP\identity\Identity::getOrcid()
     */
    public function getOrcid()
    {
        return $this->getData('orcid');
    }

    /**
     * @copydoc \PKP\orcid\traits\HasOrcid::hasVerifiedOrcid()
     */
    public function hasVerifiedOrcid(): bool
    {
        return !empty($this->getData('orcidIsVerified'));
    }

    /**
     * @copydoc \PKP\identity\Identity::getOrcidDisplayValue()
     */
    public function getOrcidDisplayValue(): ?string
    {
        if (!$this->getOrcid()) {
            return null;
        }
        return $this->hasVerifiedOrcid() ? $this->getOrcid() : $this->getOrcid() . ' ' . __('orcid.unauthenticated');
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
        // Tiebreak matches the id order legacy yields for equal seq values
        return $query->orderBy('seq')->orderBy('author_id');
    }
}
