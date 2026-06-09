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
    protected $_loaded = false;

    public function __construct(
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
         * A human-facing title for this block
         */
        public string $title,

        /**
         * An optional id
         *
         * Use this if multiple metadata blocks will use
         * the same component.
         *
         * If no id is provided, the component template
         * will be used as the id.
         */
        public string $id = '',

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
        if (!$this->id) {
            $this->id = $component;
        }
    }

    /**
     * This function should be called whenever the `$loader`
     * callback is run to avoid loading data twice.
     */
    public function loaded(): void
    {
        $this->_loaded = true;
    }

    /**
     * Check if the `$loader` function has already been called.
     */
    public function isLoaded(): bool
    {
        return $this->_loaded;
    }
}