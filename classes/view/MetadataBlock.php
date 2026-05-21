<?php

namespace PKP\view;

use Closure;

/**
 * A class to define a block of metadata for an article, book
 * or preprint, that will be displayed when viewing the landing
 * page in the reader-facing UI.
 */
class MetadataBlock
{
    public function __construct(
        /**
         * A unique id for this block
         */
        public string $id,

        /**
         * A human-facing title for this block
         */
        public string $title,

        /**
         * A human-facing description of this block
         */
        public string $description,

        /**
         * The component template path
         *
         * For example, a value of `metadata.keywords` will look for a
         * Blade template file in the following locations.
         *
         * plugins/themes/<current-theme>/templates/components/metadata/keywords.blade
         * plugins/themes/<parent-theme>/templates/components/metadata/keywords.blade
         * templates/components/metadata/keywords.blade
         * lib/pkp/templates/components/metadata/keywords.blade
         *
         * Plugins that are not Themes should use a namespaced component
         * template path, such as `mypluginnamespace::metadata.keywords`.
         *
         * @see https://github.com/pkp/pkp-lib/issues/9968
         * @see https://laravel.com/docs/11.x/blade#anonymous-components
         */
        public string $component,

        /**
         * An optional callback function to load data for this block.
         *
         * By default, all data available to the article landing page
         * will be available to the block's template. Use this callback
         * function if you need to retrieve additional data.
         *
         * To make data available to the template, use the
         * `view()->share(key, value)` method.
         *
         * Example:
         *
         * function(Publication $publication, Submission $submission) {
         *     view()->share('myPluginData', 'My test data');
         * }
         *
         * You can then use the data in the template like this:
         *
         * <div>{{ $myPluginData }}</ddiv>
         *
         * All keys are global so use a unique key.
         */
        public ?Closure $loader = null,
    ) {
        //
    }
}