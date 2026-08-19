<?php

/**
 * @file classes/facades/ContentHelper.php
 *
 * Copyright (c) 2014-2026 Simon Fraser University
 * Copyright (c) 2000-2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class ContentHelper
 *
 * @brief Facade for the frontend content helpers. See PKP\frontend\ContentHelper.
 */

namespace PKP\facades;

use Illuminate\Support\Facades\Facade;

/**
 * @method static \PKP\galley\Galley[] primaryGalleys(iterable $galleys, int $contextId)
 * @method static \PKP\galley\Galley[] supplementaryGalleys(iterable $galleys, int $contextId)
 * @method static void macro(string $name, object|callable $macro)
 * @method static bool hasMacro(string $name)
 *
 * @see \PKP\frontend\ContentHelper
 */
class ContentHelper extends Facade
{
    protected static function getFacadeAccessor(): string
    {
        return \PKP\frontend\ContentHelper::class;
    }
}
