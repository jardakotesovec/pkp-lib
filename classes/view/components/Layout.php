<?php
namespace PKP\view\components;

use APP\core\Application;
use APP\core\Request;
use APP\template\TemplateManager;
use Closure;
use Illuminate\View\Component;
use Illuminate\Contracts\View\View;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\View as ViewFacade;
use PKP\facades\Locale;
use PKP\i18n\LocaleMetadata;
use PKP\plugins\ThemePlugin;

abstract class Layout extends Component
{
    public Request $request;
    public ThemePlugin $theme;
    public TemplateManager $templateMgr;

    public function __construct(
        public string $title,
        public string $description = '',
        public string $bodyClass = '',
        public string $head = '',
    ) {
        $this->request = Application::get()->getRequest();
        $this->templateMgr = TemplateManager::getManager($this->request);
        $this->theme = $this->templateMgr->getTemplateVars('activeTheme');

        $this->addGlobalData();
    }

    public function render(): View|Closure|string
    {
        return view(
            ViewFacade::resolvePluginComponentViewPath(
                $this,
                'components.layout'
            )
        );
    }

    /**
     * Add global template data
     */
    protected function addGlobalData(): void
    {
        view()->share('contextName', $this->contextName());
        view()->share('locales', $this->getLocales());

        if ($this->isPublicationPage()) {
            view()->share('metadata', [$this, 'getMetadataBlocks']);
        }
    }

    /**
     * Get the name of the context or site, depending
     * on what kind of page we're viewing.
     */
    public function contextName() : string
    {
        $context = $this->request->getContext();
        return $context
            ? $context->getLocalizedName()
            : $this->request->getSite()->getLocalizedTitle();
    }

    /**
     * Get the <title> by combining the current page title
     * with the context or site name.
     */
    public function pageTitle() : string
    {
        $page = $this->request->getRequestedPage();

        if ($page === 'index') {
            return $this->title;
        }

        return $this->title . __('common.titleSeparator') . $this->contextName();
    }

    /**
     * Get classes for the <body> tag which indicate the current
     * page and op of the request.
     */
    public function bodyClasses(): string
    {
        $page = $this->request->getRequestedPage();
        $op = $this->request->getRequestedOp();

        $classes = [];

        if ($page) {
            $classes[] = "pkp-page-{$page}";
        }

        if ($op) {
            $classes[] = "pkp-op-{$op}";
        }

        return join(' ', $classes);
    }

    /**
     * Get an array of all locales supported by the
     * current context or site.
     */
    protected function getLocales(): array
    {
        $request = $this->request;
        $context = $request->getContext();

        $locales = Locale::getFormattedDisplayNames(
            isset($context)
                ? $context->getSupportedLocales()
                : $request->getSite()->getSupportedLocales(),
            Locale::getLocales(),
            LocaleMetadata::LANGUAGE_LOCALE_ONLY
        );

        return $locales;
    }

    /**
     * Are we currently viewing the article, book or
     * preprint landing page?
     */
    abstract public function isPublicationPage() : bool;

    /**
     * Get the article metadata blocks
     *
     *
     * @param ?array $blockIds An array of block ids. If passed, it will
     * only load those blocks and will pass them back in the order specified
     * in the array.
     */
    public function getMetadataBlocks(?array $blockIds = null): Collection
    {
        return $this->templateMgr->metadataBlocks->load($blockIds);
    }
}