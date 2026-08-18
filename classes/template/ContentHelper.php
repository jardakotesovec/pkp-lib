<?php

/**
 * @file lib/pkp/classes/template/ContentHelper.php
 *
 * Copyright (c) 2014-2026 Simon Fraser University
 * Copyright (c) 2000-2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class ContentHelper
 * @brief Helper methods for presenting content in view templates
 *
 * Content helpers derive display values from mapped (API-shaped) data,
 * such as the label to display for a galley. They complement ViewHelper,
 * which provides utilities about the page and template machinery (URLs,
 * escaping, dates) rather than the content.
 *
 * Content helpers are pure functions over mapped data: they perform no
 * queries and return values, not markup. Method names are prefixed by
 * the entity they act on, e.g. galleyLabel(), issueIdentification().
 *
 * Themes and plugins can register additional helpers before rendering
 * begins, e.g. in a theme's init():
 *
 *   ContentHelper::macro('galleyCoverUrl', fn (array $galley) => ...);
 */

namespace PKP\template;

use Illuminate\Support\Traits\Macroable;
use PKP\facades\Locale;

class ContentHelper
{
    use Macroable;

    /**
     * Get the label to display for a galley, adding the galley's
     * language when it differs from the given locale.
     *
     * @param array $galley A galley mapped by the galley schema map
     * @param ?string $locale Defaults to the current locale
     */
    public static function galleyLabel(array $galley, ?string $locale = null): string
    {
        $label = (string) $galley['label'];
        $locale ??= Locale::getLocale();
        if ($galley['locale'] && $galley['locale'] !== $locale) {
            $localeNames = Locale::getSubmissionLocaleDisplayNames([$galley['locale']]);
            $label .= ' (' . ($localeNames[$galley['locale']] ?? $galley['locale']) . ')';
        }
        return $label;
    }
}
