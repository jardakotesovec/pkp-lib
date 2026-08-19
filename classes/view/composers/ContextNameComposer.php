<?php

/**
 * @file classes/view/composers/ContextNameComposer.php
 *
 * Copyright (c) 2014-2026 Simon Fraser University
 * Copyright (c) 2000-2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class ContextNameComposer
 *
 * @brief Provides the name of the current context, falling back to the
 *  site title on site-level pages, to the views displaying it.
 */

namespace PKP\view\composers;

use APP\core\Application;
use Illuminate\View\View;

class ContextNameComposer
{
    /** @var ?string Memoized for repeat renders within the same request */
    protected ?string $contextName = null;

    public function compose(View $view): void
    {
        $view->with('contextName', $this->contextName ??= $this->getContextName());
    }

    /**
     * Get the name of the context, or the site title when no context
     * is present (e.g. site-level pages)
     */
    protected function getContextName(): string
    {
        $request = Application::get()->getRequest();
        $context = $request->getContext();

        return $context
            ? $context->getLocalizedName()
            : $request->getSite()->getLocalizedTitle();
    }
}
