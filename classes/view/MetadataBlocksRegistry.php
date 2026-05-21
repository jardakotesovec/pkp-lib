<?php

/**
 * @file classes/view/MetadataBlockRepository.php
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

class MetadataBlocksRegistry
{
    /** @var Collection<MetadataBlock> */
    protected Collection $_blocks;

    /**
     * True when the the default block
     * registration process has been completed.
     */
    protected bool $hasRegistered = false;

    public function __construct()
    {
        $this->_blocks = collect([]);
    }

    public function register(MetadataBlock $block): void
    {
        $this->_blocks->put($block->id, $block);
    }

    /**
     * @param string $id The MetadataBlock::$id to remove from the registry.
     */
    public function unregister(string $id): void
    {
        $this->_blocks->forget($id);
    }

    public function get(): Collection
    {
        if (!$this->hasRegistered) {
            $this->registerAll();
        }

        return $this->_blocks;
    }

    public function load(): Collection
    {
        $blocks = $this->get();
        $templateMgr = TemplateManager::getManager(Application::get()->getRequest());
        $blocks->each(function(MetadataBlock $block) use ($templateMgr) {
            if (isset($block?->loader)) {
                $publication = $templateMgr->getTemplateVars('publication');
                $submission = $templateMgr->getTemplateVars('article');
                call_user_func($block->loader, $publication, $submission);
            }
        });

        return $blocks;
    }

    protected function registerAll(): void
    {
        $this->registerDefaultBlocks();

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

    protected function registerDefaultBlocks(): void
    {
        $this->register(
            new MetadataBlock(
                id: 'keywords',
                title: 'Keywords',
                description: 'Example keywords description',
                component: 'metadata.keywords',
            )
        );
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
}