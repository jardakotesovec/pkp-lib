<?php

/**
 * @file classes/testing/bootstrap/Processor/AnnouncementProcessor.php
 *
 * Copyright (c) 2026 Simon Fraser University
 * Copyright (c) 2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class AnnouncementProcessor
 *
 * @brief Seeds context-scoped announcements for a scratch context.
 *
 * Announcements are cross-app (OJS/OMP/OPS) — the reader announcement
 * list/detail pages and the home page's in-content announcements section
 * read them. Each seeded announcement is posted now (date_posted = now,
 * matching the API's add path) so it counts as "active by date"; the home
 * page section additionally requires the journal's enableAnnouncements +
 * numAnnouncementsHomepage gate, which tests set through the context spec.
 */

namespace PKP\testing\bootstrap\Processor;

use APP\core\Application;
use PKP\announcement\Announcement;

class AnnouncementProcessor
{
    /**
     * @param int $contextId
     * @param array $announcementSpecs [{title, descriptionShort?, description?, dateExpire?}]
     *   Each localized field is either a plain string (wrapped under
     *   $primaryLocale) or an explicit <locale> => <string> map.
     * @param string $primaryLocale locale for bare-string values
     */
    public function run(int $contextId, array $announcementSpecs, string $primaryLocale = 'en'): array
    {
        $results = [];
        foreach ($announcementSpecs as $spec) {
            $params = [
                'assocType' => Application::get()->getContextAssocType(),
                'assocId' => $contextId,
                'title' => $this->localize($spec['title'] ?? '', $primaryLocale),
            ];
            foreach (['descriptionShort', 'description'] as $field) {
                if (isset($spec[$field])) {
                    $params[$field] = $this->localize($spec[$field], $primaryLocale);
                }
            }
            if (isset($spec['dateExpire'])) {
                $params['dateExpire'] = $spec['dateExpire'];
            }

            $announcement = Announcement::create($params);
            $results[] = ['id' => $announcement->id];
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
