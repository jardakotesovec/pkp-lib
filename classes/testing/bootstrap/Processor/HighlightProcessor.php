<?php

/**
 * @file classes/testing/bootstrap/Processor/HighlightProcessor.php
 *
 * Copyright (c) 2026 Simon Fraser University
 * Copyright (c) 2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class HighlightProcessor
 *
 * @brief Seeds context-scoped highlights for a scratch context.
 *
 * Highlights are cross-app (OJS/OMP/OPS). The active theme renders a
 * context's highlights as a carousel across the top of the reader home
 * page (PKPIndexHandler::getHighlights()); seeding at least one lets a
 * homepage spec assert the carousel render without an image upload
 * (image is optional — a highlight is a title + url + urlText).
 */

namespace PKP\testing\bootstrap\Processor;

use APP\facades\Repo;

class HighlightProcessor
{
    /**
     * @param int $contextId
     * @param array $highlightSpecs [{title, url, urlText?, description?, sequence?}]
     *   Localized fields (title/urlText/description) accept a bare string
     *   (wrapped under $primaryLocale) or an explicit <locale> => <string>
     *   map; `url` is a single non-localized string.
     * @param string $primaryLocale locale for bare-string values
     */
    public function run(int $contextId, array $highlightSpecs, string $primaryLocale = 'en'): array
    {
        $results = [];
        $seq = 0;
        foreach ($highlightSpecs as $spec) {
            $data = [
                'contextId' => $contextId,
                'sequence' => $spec['sequence'] ?? ++$seq,
                'url' => $spec['url'] ?? '',
                'title' => $this->localize($spec['title'] ?? '', $primaryLocale),
            ];
            foreach (['urlText', 'description'] as $field) {
                if (isset($spec[$field])) {
                    $data[$field] = $this->localize($spec[$field], $primaryLocale);
                }
            }

            $highlight = Repo::highlight()->newDataObject($data);
            $id = Repo::highlight()->add($highlight);
            $results[] = ['id' => $id];
        }
        return $results;
    }

    /**
     * Normalise a localized-string field to a <locale> => <string> map.
     *
     * @param string|array $value
     */
    private function localize($value, string $primaryLocale): array
    {
        return is_array($value) ? $value : [$primaryLocale => $value];
    }
}
