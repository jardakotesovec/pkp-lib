<?php
namespace PKP\view\components;

use APP\core\Application;
use APP\core\Request;
use APP\template\TemplateManager;
use Closure;
use Illuminate\View\Component;
use Illuminate\Contracts\View\View;
use Illuminate\Support\Facades\View as ViewFacade;
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

}