<?php

/**
 * @file classes/testing/scenario/GenreLookup.php
 *
 * Copyright (c) 2026 Simon Fraser University
 * Copyright (c) 2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class GenreLookup
 *
 * @brief Friendly-string → Genre resolver for the test scenario layer.
 *
 * Sibling of UserGroupLookup. Lets scenario specs reference genres by
 * stable, human-readable handles ('ARTICLE') instead of the raw
 * `entry_key` from registry/genres.xml. Today only the article-text genre
 * is needed (every wizard upload defaults to it); add more keys here as
 * scenarios grow to cover dependent / supplementary file types.
 */

namespace PKP\testing\scenario;

use PKP\db\DAORegistry;
use PKP\submission\Genre;
use PKP\submission\GenreDAO;

class GenreLookup
{
    /**
     * Friendly handles accepted in scenario specs → candidate entry_key
     * values in the genres table (installed per-context from the app's
     * registry/genres.xml). Each handle lists the keys in preference
     * order; the first one that exists in the context wins. The list
     * exists because the same *concept* ships under different keys per
     * app — the main text file is `SUBMISSION` in OJS and OPS but
     * `MANUSCRIPT` in OMP — and scenario specs must stay app-neutral.
     */
    public const FRIENDLY_TO_GENRE_KEY = [
        'ARTICLE' => ['SUBMISSION', 'MANUSCRIPT'],
        // Media-file seeding (publications[].mediaFiles[]): the IMAGE
        // genre ships supportsFileVariants=1 (registry/genres.xml), the
        // gate the Media tab's variant-type select keys on.
        'IMAGE' => ['IMAGE'],
    ];

    /**
     * Translate a friendly handle to its candidate registry/genres.xml
     * entry_keys. Throws on unknown handles so mistyped specs fail loudly.
     *
     * @return string[]
     */
    public static function friendlyToGenreKeys(string $friendly): array
    {
        if (!isset(self::FRIENDLY_TO_GENRE_KEY[$friendly])) {
            throw new \InvalidArgumentException(
                "Unknown genre handle '{$friendly}'. Known handles: "
                . implode(', ', array_keys(self::FRIENDLY_TO_GENRE_KEY))
            );
        }
        return self::FRIENDLY_TO_GENRE_KEY[$friendly];
    }

    /**
     * Return the Genre row matching the given friendly handle in the
     * given context. Relies on the default genres installed by
     * GenreDAO::installDefaults() at context creation time.
     */
    public static function genreForKey(int $contextId, string $friendly): Genre
    {
        $entryKeys = self::friendlyToGenreKeys($friendly);
        /** @var GenreDAO $genreDao */
        $genreDao = DAORegistry::getDAO('GenreDAO');

        foreach ($entryKeys as $entryKey) {
            $genre = $genreDao->getByKey($entryKey, $contextId);
            if ($genre) {
                return $genre;
            }
        }

        throw new \RuntimeException(
            "Could not find a default genre for handle '{$friendly}' (tried "
            . implode(', ', $entryKeys) . ") in context {$contextId}. "
            . 'Was the context created through the standard service (which installs genres.xml)?'
        );
    }
}
