<?php

/**
 * @file classes/frontend/ContentHelper.php
 *
 * Copyright (c) 2014-2026 Simon Fraser University
 * Copyright (c) 2000-2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class ContentHelper
 *
 * @brief Helper methods for presenting content in frontend templates.
 *
 * Helpers derive display values from content data, such as the primary
 * galleys of a publication. They complement ViewHelper, which provides
 * fixed utilities about the page and template machinery (URLs,
 * escaping, dates) rather than the content.
 *
 * Helpers are functions over the data they are given — mapped
 * (API-shaped) data where available, data objects during the
 * transition: they return values, not markup. During the transition
 * the galley helpers resolve the genre configuration of a context
 * internally (memoized per request); once galleys are consumed as
 * mapped data, the genre information rides on the data and the helpers
 * become pure filters.
 *
 * Templates call helpers through the ContentHelper facade:
 *
 *   ContentHelper::primaryGalleys($galleys, $contextId)
 *
 * Apps add or override helpers on their ContentHelper subclass, bound
 * in the container. Themes and plugins add helpers as macros, e.g. in
 * a theme's init():
 *
 *   ContentHelper::macro('stringSize', fn (string $str) => ...);
 *
 * Macro closures may capture what they need; they are bound to the
 * ContentHelper instance when called.
 */

namespace PKP\frontend;

use Illuminate\Support\Traits\Macroable;
use PKP\db\DAORegistry;
use PKP\galley\Galley;
use PKP\submission\GenreDAO;

class ContentHelper
{
    use Macroable;

    /** @var array<int, int[]> Primary genre ids memoized by context id */
    protected array $primaryGenreIds = [];

    /** @var array<int, int[]> Supplementary genre ids memoized by context id */
    protected array $supplementaryGenreIds = [];

    /**
     * Get the galleys that are primary representations of the
     * publication, such as the full text: galleys with a remote URL
     * or whose file has one of the context's primary genres.
     *
     * @param iterable<Galley> $galleys
     * @param int $contextId The id of the context the galleys belong
     *  to; the genre configuration can differ per context, e.g. in
     *  site-wide search results
     *
     * @return Galley[]
     */
    public function primaryGalleys(iterable $galleys, int $contextId): array
    {
        $primaryGenreIds = $this->getPrimaryGenreIds($contextId);

        $primaryGalleys = [];
        foreach ($galleys as $galley) {
            if ($galley->getData('urlRemote')) {
                $primaryGalleys[] = $galley;
                continue;
            }
            $file = $galley->getFile();
            if ($file && in_array($file->getGenreId(), $primaryGenreIds)) {
                $primaryGalleys[] = $galley;
            }
        }
        return $primaryGalleys;
    }

    /**
     * Get the galleys that are supplementary to the publication, such
     * as data sets or research materials: galleys whose file has one
     * of the context's supplementary genres.
     *
     * @param iterable<Galley> $galleys
     * @param int $contextId The id of the context the galleys belong to
     *
     * @return Galley[]
     */
    public function supplementaryGalleys(iterable $galleys, int $contextId): array
    {
        $supplementaryGenreIds = $this->getSupplementaryGenreIds($contextId);

        $supplementaryGalleys = [];
        foreach ($galleys as $galley) {
            if ($galley->getData('urlRemote')) {
                continue;
            }
            $file = $galley->getFile();
            if ($file && in_array($file->getGenreId(), $supplementaryGenreIds)) {
                $supplementaryGalleys[] = $galley;
            }
        }
        return $supplementaryGalleys;
    }

    /**
     * Get the primary genre ids of a context, memoized per request
     *
     * @return int[]
     */
    protected function getPrimaryGenreIds(int $contextId): array
    {
        if (!array_key_exists($contextId, $this->primaryGenreIds)) {
            $genreDao = DAORegistry::getDAO('GenreDAO'); /** @var GenreDAO $genreDao */
            $this->primaryGenreIds[$contextId] = array_map(
                fn ($genre) => $genre->getId(),
                $genreDao->getPrimaryByContextId($contextId)->toArray()
            );
        }
        return $this->primaryGenreIds[$contextId];
    }

    /**
     * Get the supplementary genre ids of a context, memoized per request
     *
     * @return int[]
     */
    protected function getSupplementaryGenreIds(int $contextId): array
    {
        if (!array_key_exists($contextId, $this->supplementaryGenreIds)) {
            $genreDao = DAORegistry::getDAO('GenreDAO'); /** @var GenreDAO $genreDao */
            $this->supplementaryGenreIds[$contextId] = array_map(
                fn ($genre) => $genre->getId(),
                $genreDao->getBySupplementaryAndContextId(true, $contextId)->toArray()
            );
        }
        return $this->supplementaryGenreIds[$contextId];
    }
}
