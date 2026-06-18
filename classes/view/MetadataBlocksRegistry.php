<?php

/**
 * @file classes/view/MetadataBlocksRegistry.php
 *
 * Copyright (c) 2026 Simon Fraser University
 * Copyright (c) 2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class Repository
 *
 * @brief A repository to register and load metadata blocks.
 */

namespace PKP\view;

use APP\core\Application;
use APP\template\TemplateManager;
use Illuminate\Support\Collection;
use PKP\plugins\interfaces\HasMetadataBlocks;
use PKP\plugins\PluginRegistry;
use PKP\plugins\ThemePlugin;
use PKP\view\MetadataBlock;

class MetadataBlocksRegistry extends BlocksRegistry
{
    public function load(?array $blockIds = null): Collection
    {
        $blocks = $this->get();
        if (!is_null($blockIds)) {
            $blocks = $blocks
                ->filter(fn(MetadataBlock $block) => in_array($block->id, $blockIds))
                ->sort(function(MetadataBlock $a, MetadataBlock $b) use ($blockIds) {
                    return array_search($a->id, $blockIds) - array_search($b->id, $blockIds);
                });
        }
        $templateMgr = TemplateManager::getManager(Application::get()->getRequest());
        $blocks->each(function(MetadataBlock $block) use ($templateMgr) {
            if (isset($block?->loader) && !$block->isLoaded()) {
                $publication = $templateMgr->getTemplateVars('publication');
                $submission = $templateMgr->getTemplateVars('article');
                call_user_func($block->loader, $publication, $submission);
                $block->loaded();
            }
        });

        return $blocks;
    }

    protected function registerAll(): void
    {
        $this->registerDefaultBlocks();
        $this->registerPubIdBlocks();

        $plugins = PluginRegistry::getAllPlugins();
        foreach ($plugins as $plugin) {
            /**
             * Theme plugins are handled differently so that
             * only the active theme and parent themes are
             * called.
             */
            if ($plugin instanceOf ThemePlugin) {
                continue;
            }
            if ($plugin instanceOf HasMetadataBlocks) {
                $plugin->registerMetadataBlocks($this);
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
        if ($theme instanceOf HasMetadataBlocks) {
            $theme->registerMetadataBlocks($this);
        }
    }

    protected function registerDefaultBlocks(): void
    {
        $this->register(
            new MetadataBlock(
                component: 'metadata.date-published',
                title: __('submissions.published'),
            )
        );
        $this->register(
            new MetadataBlock(
                component: 'metadata.version',
                title: __('submission.versions'),
            )
        );
        $this->register(
            new MetadataBlock(
                component: 'metadata.date-submitted',
                title: __('common.dateSubmitted'),
            )
        );
        $this->register(
            new MetadataBlock(
                component: 'metadata.cover-image',
                title: __('category.coverImage'),
            )
        );
        $this->register(
            new MetadataBlock(
                component: 'metadata.doi',
                title: __('doi.readerDisplayName'),
            )
        );
        $this->register(
            new MetadataBlock(
                component: 'metadata.keywords',
                title: __('common.keywords'),
            )
        );
        $this->register(
            new MetadataBlock(
                component: 'metadata.categories',
                title: __('category.category'),
            )
        );
        $this->register(
            new MetadataBlock(
                component: 'metadata.data-availability',
                title: __('submission.dataAvailability'),
            )
        );
        $this->register(
            new MetadataBlock(
                component: 'metadata.funding-statement',
                title: __('submission.fundingStatement'),
            )
        );
        $this->register(
            new MetadataBlock(
                component: 'metadata.license',
                title: __('submission.fundingStatement'),
            )
        );
    }

    protected function registerPubIdBlocks(): void
    {
        $plugins = PluginRegistry::loadCategory('pubIds', true);

        foreach ($plugins as $plugin) {
            $this->register(
                new MetadataBlock(
                    id: $plugin->getPubIdType(),
                    component: 'metadata.pubid',
                    title: $plugin->getPubIdDisplayType(),
                )
            );
        }
    }
}