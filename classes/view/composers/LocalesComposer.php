<?php

/**
 * @file classes/view/composers/LocalesComposer.php
 *
 * Copyright (c) 2014-2026 Simon Fraser University
 * Copyright (c) 2000-2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class LocalesComposer
 *
 * @brief Provides the locales supported by the current context or site
 *  to the views rendering the language selection.
 */

namespace PKP\view\composers;

use APP\core\Application;
use Illuminate\View\View;
use PKP\facades\Locale;
use PKP\i18n\LocaleMetadata;

class LocalesComposer
{
    /** @var ?array Memoized for repeat renders within the same request */
    protected ?array $locales = null;

    public function compose(View $view): void
    {
        $view->with('locales', $this->locales ??= $this->getLocales());
    }

    /**
     * Get an array of all locales supported by the current context or site
     */
    protected function getLocales(): array
    {
        $request = Application::get()->getRequest();
        $context = $request->getContext();

        $locales = Locale::getFormattedDisplayNames(
            isset($context)
                ? $context->getSupportedLocales()
                : $request->getSite()->getSupportedLocales(),
            Locale::getLocales(),
            LocaleMetadata::LANGUAGE_LOCALE_ONLY
        );

        return $locales;
    }
}
