<?php

/**
 * @file classes/view/HomepageBlocksRegistry.php
 *
 * Copyright (c) 2026 Simon Fraser University
 * Copyright (c) 2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class Repository
 *
 * @brief A repository to register and load homepage blocks.
 */

namespace PKP\view;

use APP\core\Application;
use APP\template\TemplateManager;
use Illuminate\Support\Collection;
use PKP\plugins\interfaces\HasHomepageBlocks;
use PKP\plugins\Plugin;
use PKP\plugins\PluginRegistry;
use PKP\plugins\ThemePlugin;
use PKP\view\HomepageBlock;

class HomepageBlocksRegistry extends BlocksRegistry
{
    public function load(?array $blockIds = null): Collection
    {
        $blocks = $this->get();
        if (!is_null($blockIds)) {
            $blocks = $blocks
                ->filter(fn(HomepageBlock $block) => in_array($block->id, $blockIds))
                ->sort(function(HomepageBlock $a, HomepageBlock $b) use ($blockIds) {
                    return array_search($a->id, $blockIds) - array_search($b->id, $blockIds);
                });
        }
        $blocks->each(function(HomepageBlock $block) {
            if (isset($block?->loader) && !$block->isLoaded()) {
                call_user_func($block->loader);
                $block->loaded();
            }
        });

        return $blocks;
    }

    protected function registerAll(): void
    {
        $this->registerDefaultBlocks();

        $plugins = PluginRegistry::getAllPlugins();
        foreach ($plugins as $plugin) {
            /** @var Plugin $plugin */
            /**
             * Theme plugins are handled differently so that
             * only the active theme and parent themes are
             * called.
             */
            if ($plugin instanceOf ThemePlugin) {
                continue;
            }
            if ($plugin instanceOf HasHomepageBlocks) {
                $plugin->registerHomepageBlocks($this);
            }
        }

        $request = Application::get()->getRequest();
        $templateMgr = TemplateManager::getManager(Application::get()->getRequest());
        $activeTheme = $templateMgr->getActiveTheme($request, $request->getContext());
        if ($activeTheme) {
            $this->registerThemeBlocks($activeTheme);
        }

        $this->hasRegistered = true;
    }

    protected function registerThemeBlocks(ThemePlugin $theme): void
    {
        if ($theme->parent) {
            $this->registerThemeBlocks($theme->parent);
        }
        if ($theme instanceOf HasHomepageBlocks) {
            $theme->registerHomepageBlocks($this);
        }
    }

    protected function registerDefaultBlocks(): void
    {
        $this->register(
            new HomepageBlock(
                component: 'homepage.announcement',
                title: __('manager.announcements.latest'),
            )
        );
    }
}