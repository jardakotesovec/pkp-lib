<?php

/**
 * @file classes/view/composers/BodyClassesComposer.php
 *
 * Copyright (c) 2014-2026 Simon Fraser University
 * Copyright (c) 2000-2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class BodyClassesComposer
 *
 * @brief Provides the classes for the <body> tag which indicate the
 *  current page and op of the request.
 */

namespace PKP\view\composers;

use APP\core\Application;
use Illuminate\View\View;

class BodyClassesComposer
{
    /** @var ?string Memoized for repeat renders within the same request */
    protected ?string $bodyClasses = null;

    public function compose(View $view): void
    {
        $view->with('bodyClasses', $this->bodyClasses ??= $this->getBodyClasses());
    }

    /**
     * Get the classes indicating the current page and op
     */
    protected function getBodyClasses(): string
    {
        $request = Application::get()->getRequest();

        $classes = [];

        if ($page = $request->getRequestedPage()) {
            $classes[] = "pkp-page-{$page}";
        }

        if ($op = $request->getRequestedOp()) {
            $classes[] = "pkp-op-{$op}";
        }

        return join(' ', $classes);
    }
}
