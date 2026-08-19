<?php

/**
 * @file classes/facades/Frontend.php
 *
 * Copyright (c) 2014-2026 Simon Fraser University
 * Copyright (c) 2000-2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class Frontend
 *
 * @brief Facade for the Frontend service. See PKP\frontend\Frontend.
 */

namespace PKP\facades;

use Illuminate\Support\Facades\Facade;

/**
 * @method static void boot()
 * @method static bool isBooted()
 * @method static void addLocaleKeys(array $keys)
 * @method static void setJsConstants(array $constants)
 * @method static void addJsData(string $key, mixed $value)
 * @method static void addIcons(array $icons)
 * @method static string[] getIcons()
 * @method static \APP\view\MetadataBlocksRegistry metadataBlocks()
 * @method static \APP\view\HomepageBlocksRegistry homepageBlocks()
 * @method static array getComposers()
 *
 * @see \PKP\frontend\Frontend
 */
class Frontend extends Facade
{
    protected static function getFacadeAccessor(): string
    {
        return \PKP\frontend\Frontend::class;
    }
}
