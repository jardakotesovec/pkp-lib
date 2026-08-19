<?php

/**
 * @file classes/frontend/Frontend.php
 *
 * Copyright (c) 2014-2026 Simon Fraser University
 * Copyright (c) 2000-2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class Frontend
 *
 * @brief Central service for the reader-facing frontend.
 *
 * The Frontend service holds frontend registries (content blocks, the
 * client-side JS payload) and registers data providers (view composers)
 * for frontend views. It is the single surface through which core, apps,
 * themes and plugins configure the reader-facing side of the application.
 *
 * It never holds template data (page handlers and view composers provide
 * that), never derives display values and never renders.
 *
 * Lifecycle: the service is a lazily-constructed container singleton.
 * boot() is called when frontend rendering begins and wires the composer
 * manifest. Registries can be written and read at any point of any
 * request, independent of boot(): response paths that never render a
 * frontend template (e.g. galley file responses) still rely on registry
 * contents.
 */

namespace PKP\frontend;

use APP\view\HomepageBlocksRegistry;
use APP\view\MetadataBlocksRegistry;
use Closure;
use Illuminate\Support\Facades\View;
use PKP\plugins\Hook;
use PKP\view\composers\BodyClassesComposer;
use PKP\view\composers\ContextNameComposer;
use PKP\view\composers\LocalesComposer;

class Frontend
{
    /** Whether boot() has run for this request */
    protected bool $booted = false;

    protected ?JsPayload $js = null;

    /** @var string[] Names of SVG icons required by the page */
    protected array $icons = [];

    protected ?MetadataBlocksRegistry $metadataBlocks = null;
    protected ?HomepageBlocksRegistry $homepageBlocks = null;

    /** @var array<int, array{id: ?string, views: string[], composer: string, source: ?string}> */
    protected array $registeredComposers = [];

    /**
     * Data provided to frontend views.
     *
     * This is the canonical list of template variables the frontend
     * supplies beyond what page handlers assign. Each entry is one
     * composer, keyed by a stable id — usually the variable the
     * composer provides. The composer is a class implementing
     * compose(View $view) or a Closure receiving the View instance.
     * Composers with views '*' are global: their variables are
     * available in every frontend view, so themes can consume them
     * from any template without core having to know the theme's
     * template names. Name views to scope a composer (theme-namespaced
     * renditions are matched too). The variables never reach backend
     * views: the composers are only registered when the frontend
     * boots.
     *
     * Apps extend the list by adding onto parent::composers(). Plugins
     * and themes add, override or remove entries by their id through
     * the Frontend::composers hook fired in boot():
     *
     *   Hook::add('Frontend::composers', function ($hookName, $args) {
     *       $composers =& $args[0];
     *       $composers['locales'] = [                             // override
     *           'composer' => MyLocalesComposer::class,
     *           'views' => '*',
     *       ];
     *       $composers['myPluginData'] = [                        // add
     *           'composer' => MyComposer::class,
     *           'views' => 'frontend.pages.indexJournal',
     *       ];
     *       unset($composers['contextName']);                     // remove
     *       return Hook::CONTINUE;
     *   });
     *
     * Keep it declarative — any logic belongs in the composer class
     * itself.
     *
     * @return array<string, array{composer: Closure|class-string, views: string|string[]}>
     */
    protected function composers(): array
    {
        return [
            'locales' => [
                'composer' => LocalesComposer::class,
                'views' => '*',
            ],
            'contextName' => [
                'composer' => ContextNameComposer::class,
                'views' => '*',
            ],
            'bodyClasses' => [
                'composer' => BodyClassesComposer::class,
                'views' => '*',
            ],
        ];
    }

    /**
     * Boot the frontend: wire the composer manifest. Called when
     * frontend rendering begins. Idempotent.
     *
     * @hook Frontend::composers [[&$composers]] Modify the composer
     *  manifest before it is wired; same shape as composers(). Fires
     *  only when a frontend page is rendered, so composers added here
     *  never reach backend views.
     */
    public function boot(): void
    {
        if ($this->booted) {
            return;
        }
        $this->booted = true;

        $composers = $this->composers();
        Hook::call('Frontend::composers', [&$composers]);

        foreach ($composers as $id => $entry) {
            $this->registerComposer((array) $entry['views'], $entry['composer'], $id, static::class);
        }
    }

    public function isBooted(): bool
    {
        return $this->booted;
    }

    /**
     * Add locale keys to be exposed to JavaScript at pkp.localeKeys.<key>
     *
     * @param string[] $keys
     */
    public function addLocaleKeys(array $keys): void
    {
        $this->js()->addLocaleKeys($keys);
    }

    /**
     * Set constants to be exposed to JavaScript at pkp.const.<constant>
     *
     * @param array $constants Associative array of constant names to values
     */
    public function setJsConstants(array $constants): void
    {
        $this->js()->setConstants($constants);
    }

    /**
     * Add an arbitrary entry to be exposed to JavaScript at pkp.<key>.
     * Use a namespaced key, e.g. 'myPlugin.settings'.
     */
    public function addJsData(string $key, mixed $value): void
    {
        $this->js()->set($key, $value);
    }

    /**
     * Register SVG icons needed by components on this page. Icons
     * registered here are included in the page's SVG sprite sheet.
     *
     * @param string[] $icons Icon names, e.g. ['Add', 'Edit']
     */
    public function addIcons(array $icons): void
    {
        foreach ($icons as $icon) {
            if (!in_array($icon, $this->icons, true)) {
                $this->icons[] = $icon;
            }
        }
    }

    /**
     * @return string[] The registered SVG icon names
     */
    public function getIcons(): array
    {
        return $this->icons;
    }

    /**
     * The payload shipped to the client-side runtime on frontend pages
     */
    public function js(): JsPayload
    {
        return $this->js ??= new JsPayload();
    }

    /**
     * The registry of metadata blocks displayed with a publication
     */
    public function metadataBlocks(): MetadataBlocksRegistry
    {
        return $this->metadataBlocks ??= new MetadataBlocksRegistry();
    }

    /**
     * The registry of blocks displayed on the homepage
     */
    public function homepageBlocks(): HomepageBlocksRegistry
    {
        return $this->homepageBlocks ??= new HomepageBlocksRegistry();
    }

    /**
     * Register a composer for the given views, matching theme-namespaced
     * renditions of non-namespaced view names, and record its provenance.
     *
     * Works like View::composer(), with two additions: view names
     * without a namespace also match theme-namespaced renditions of the
     * same template, and the registration is recorded for introspection.
     * All registrations flow through the composers() manifest and the
     * Frontend::composers hook.
     *
     * @param string[] $views
     */
    protected function registerComposer(array $views, Closure|string $composer, ?string $id = null, ?string $source = null): void
    {
        $targets = [];
        foreach ($views as $view) {
            $targets[] = $view;
            if (!str_contains($view, '::') && !str_contains($view, '*')) {
                // Match the same template rendered under a theme or plugin
                // namespace, e.g. eidostheme::components.user-options
                $targets[] = "*::{$view}";
            }
        }

        View::composer($targets, $composer);

        $this->registeredComposers[] = [
            'id' => $id,
            'views' => $views,
            'composer' => $composer instanceof Closure ? Closure::class : $composer,
            'source' => $source,
        ];
    }

    /**
     * List the registered view composers, for introspection and debugging
     *
     * @return array<int, array{id: ?string, views: string[], composer: string, source: ?string}>
     */
    public function getComposers(): array
    {
        return $this->registeredComposers;
    }
}
