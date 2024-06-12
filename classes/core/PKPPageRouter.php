<?php

/**
 * @file classes/core/PKPPageRouter.php
 *
 * Copyright (c) 2014-2021 Simon Fraser University
 * Copyright (c) 2000-2021 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class PKPPageRouter
 *
 * @ingroup core
 *
 * @brief Class mapping an HTTP request to a handler or context.
 */

namespace PKP\core;

use APP\core\Application;
use APP\facades\Repo;
use PKP\config\Config;
use Illuminate\Support\Facades\Auth;
use PKP\core\PKPSessionGuard;
use PKP\context\Context;
use PKP\facades\Locale;
use PKP\plugins\Hook;
use PKP\security\Role;
use PKP\security\Validation;

define('ROUTER_DEFAULT_PAGE', './pages/index/index.php');
define('ROUTER_DEFAULT_OP', 'index');

class PKPPageRouter extends PKPRouter
{
    /** @var array pages that don't need an installed system to be displayed */
    public $_installationPages = ['install', 'help', 'header', 'sidebar'];

    //
    // Internal state cache variables
    // NB: Please do not access directly but
    // only via their respective getters/setters
    //
    /** @var string the requested page */
    public $_page;
    /** @var string the requested operation */
    public $_op;
    /** @var string cache filename */
    public $_cacheFilename;

    /**
     * get the installation pages
     *
     * @return array
     */
    public function getInstallationPages()
    {
        return $this->_installationPages;
    }

    /**
     * get the cacheable pages
     *
     * @return array
     */
    public function getCacheablePages()
    {
        // Can be overridden by sub-classes.
        return [];
    }

    /**
     * Determine whether or not the request is cacheable.
     *
     * @param PKPRequest $request
     * @param bool $testOnly required for unit test to
     *  bypass session check.
     *
     */
    public function isCacheable($request, $testOnly = false): bool
    {
        if (PKPSessionGuard::isSessionDisable() && !$testOnly) {
            return false;
        }
        if (Application::isUnderMaintenance()) {
            return false;
        }
        if (!empty($_POST) || Validation::isLoggedIn()) {
            return false;
        }

        if (!empty($_GET)) {
            return false;
        }

        if (in_array($this->getRequestedPage($request), $this->getCacheablePages())) {
            return true;
        }

        return false;
    }

    /**
     * Get the page requested in the URL.
     *
     * @param PKPRequest $request the request to be routed
     *
     * @return string the page path (under the "pages" directory)
     */
    public function getRequestedPage($request)
    {
        if (!isset($this->_page)) {
            $this->_page = $this->_getRequestedUrlParts(Core::getPage(...), $request);
        }
        return $this->_page;
    }

    /**
     * Get the operation requested in the URL (assumed to exist in the requested page handler).
     *
     * @param PKPRequest $request the request to be routed
     *
     * @return string
     */
    public function getRequestedOp($request)
    {
        if (!isset($this->_op)) {
            $this->_op = $this->_getRequestedUrlParts(Core::getOp(...), $request);
        }
        return $this->_op;
    }

    /**
     * Get the arguments requested in the URL.
     *
     * @param PKPRequest $request the request to be routed
     *
     * @return array
     */
    public function getRequestedArgs($request)
    {
        return $this->_getRequestedUrlParts(Core::getArgs(...), $request);
    }

    /**
     * Get the anchor (#anchor) requested in the URL
     *
     * @para $request PKPRequest the request to be routed
     *
     * @return string
     */
    public function getRequestedAnchor($request)
    {
        $url = $request->getRequestUrl();
        $parts = explode('#', $url);
        if (count($parts) < 2) {
            return '';
        }
        return $parts[1];
    }


    //
    // Implement template methods from PKPRouter
    //
    /**
     * @copydoc PKPRouter::getCacheFilename()
     */
    public function getCacheFilename($request)
    {
        if (!isset($this->_cacheFilename)) {
            $id = $_SERVER['PATH_INFO'] ?? 'index';
            $id .= '-' . Locale::getLocale();
            $path = Core::getBaseDir();
            $this->_cacheFilename = $path . '/cache/wc-' . md5($id) . '.html';
        }
        return $this->_cacheFilename;
    }

    /**
     * @copydoc PKPRouter::route()
     *
     * @hook LoadHandler [[&$page, &$op, &$sourceFile, &$handler]]
     */
    public function route($request)
    {
        // Determine the requested page and operation
        $page = $this->getRequestedPage($request);
        $op = $this->getRequestedOp($request);

        // If the application has not yet been installed we only
        // allow installer pages to be displayed,
        // or is installed and one of the installer pages was called
        if (!Application::isInstalled() && !in_array($page, $this->getInstallationPages())) {
            // A non-installation page was called although
            // the system is not yet installed. Redirect to
            // the installation page.
            $request->redirect('index', 'install');
        } else if (Application::isInstalled() && in_array($page, $this->getInstallationPages())) {
            // Redirect to the index page
            $request->redirect('index', 'index');
        }

        // Redirect requests from logged-out users to a context which is not
        // publicly enabled
        if (!PKPSessionGuard::isSessionDisable()) {
            $user = $request->getUser();
            $currentContext = $request->getContext();
            if ($currentContext && !$currentContext->getEnabled() && !$user instanceof \PKP\user\User) {
                if ($page != 'login') {
                    $request->redirect(null, 'login');
                }
            }
        }

        // Determine the page index file. This file contains the
        // logic to resolve a page to a specific handler class.
        $sourceFile = sprintf('pages/%s/index.php', $page);

        // If a hook has been registered to handle this page, give it the
        // opportunity to load required resources and set the handler.
        $handler = null;
        if (!Hook::call('LoadHandler', [&$page, &$op, &$sourceFile, &$handler])) {
            if (file_exists($sourceFile)) {
                $result = require('./' . $sourceFile);
                if (is_object($result)) {
                    $handler = $result;
                }
            } elseif (file_exists(PKP_LIB_PATH . "/{$sourceFile}")) {
                $result = require('./' . PKP_LIB_PATH . "/{$sourceFile}");
                if (is_object($result)) {
                    $handler = $result;
                }
            } elseif (empty($page)) {
                $handler = require(ROUTER_DEFAULT_PAGE);
            } else {
                $dispatcher = $this->getDispatcher();
                $dispatcher->handle404();
            }
        }

        // Set locale from URL or from 'setLocale'-op/search-params
        $setLocale = ($op === 'setLocale'
            ? ($this->getRequestedArgs($request)[0] ?? null)
            : ($page === 'install'
                ? ($_GET['setLocale'] ?? null)
                : null));
        $this->_setLocale($request, $setLocale);

        // Call the selected handler's index operation if
        // no operation was defined in the request.
        if (empty($op)) {
            $op = ROUTER_DEFAULT_OP;
        }

        // Redirect to 404 if the operation doesn't exist
        // for the handler.
        $methods = [];
        if ($handler) {
            $methods = get_class_methods($handler);
        } elseif (defined('HANDLER_CLASS')) {
            // The use of HANDLER_CLASS is DEPRECATED with 3.4.0 pkp/pkp-lib#6019
            $methods = get_class_methods(HANDLER_CLASS);
        }
        if (!in_array($op, $methods)) {
            $dispatcher = $this->getDispatcher();
            $dispatcher->handle404();
        }

        // Instantiate the handler class
        if (!$handler) {
            // The use of HANDLER_CLASS is DEPRECATED with 3.4.0 pkp/pkp-lib#6019
            $handlerClass = HANDLER_CLASS;
            $handler = new $handlerClass($request);
        }
        $this->setHandler($handler);

        // Authorize and initialize the request but don't call the
        // validate() method on page handlers.
        // FIXME: We should call the validate() method for page
        // requests also (last param = true in the below method
        // call) once we've made sure that all validate() calls can
        // be removed from handler operations without damage (i.e.
        // they don't depend on actions being performed before the
        // call to validate().
        $args = $this->getRequestedArgs($request);
        $serviceEndpoint = [$handler, $op];
        $this->_authorizeInitializeAndCallRequest($serviceEndpoint, $request, $args, false);
    }

    /**
     * @copydoc PKPRouter::url()
     *
     * @param null|mixed $newContext
     * @param null|mixed $page
     * @param null|mixed $op
     * @param null|mixed $path
     * @param null|mixed $params
     * @param null|mixed $anchor
     * @param null|string $urlLocaleForPage
     */
    public function url(
        PKPRequest $request,
        ?string $newContext = null,
        $page = null,
        $op = null,
        $path = null,
        $params = null,
        $anchor = null,
        $escape = false,
        ?string $urlLocaleForPage = null,
    ) {
        //
        // Base URL and Context
        //
        $baseUrlAndContext = $this->_urlGetBaseAndContext($request, $newContext);
        $baseUrl = array_shift($baseUrlAndContext);
        $context = array_shift($baseUrlAndContext);

        //
        // Additional path info
        //
        if (empty($path)) {
            $additionalPath = [];
        } else {
            if (is_array($path)) {
                $additionalPath = array_map('rawurlencode', $path);
            } else {
                $additionalPath = [rawurlencode($path)];
            }
        }

        //
        // Page and Operation
        //

        // Are we in a page request?
        $currentRequestIsAPageRequest = $request->getRouter() instanceof \PKP\core\PKPPageRouter;

        // Determine the operation
        if ($op) {
            // If an operation has been explicitly set then use it.
            $op = rawurlencode($op);
        } else {
            // No operation has been explicitly set so let's determine a sensible
            // default operation.
            if (empty($newContext) && empty($page) && $currentRequestIsAPageRequest) {
                // If we remain in the existing context and on the existing page then
                // we will default to the current operation. We can only determine a
                // current operation if the current request is a page request.
                $op = $this->getRequestedOp($request);
            } else {
                // If a new context (or page) has been set then we'll default to the
                // index operation within the new context (or on the new page).
                if (empty($additionalPath)) {
                    // If no additional path is set we can simply leave the operation
                    // undefined which automatically defaults to the index operation
                    // but gives shorter (=nicer) URLs.
                    $op = null;
                } else {
                    // If an additional path is set then we have to explicitly set the
                    // index operation to disambiguate the path info.
                    $op = 'index';
                }
            }
        }

        // Determine the page
        if ($page) {
            // If a page has been explicitly set then use it.
            $page = rawurlencode($page);
        } else {
            // No page has been explicitly set so let's determine a sensible default page.
            if (empty($newContext) && $currentRequestIsAPageRequest) {
                // If we remain in the existing context then we will default to the current
                // page. We can only determine a current page if the current request is a
                // page request.
                $page = $this->getRequestedPage($request);
            } else {
                // If a new context has been set then we'll default to the index page
                // within the new context.
                if (empty($op)) {
                    // If no explicit operation is set we can simply leave the page
                    // undefined which automatically defaults to the index page but gives
                    // shorter (=nicer) URLs.
                    $page = null;
                } else {
                    // If an operation is set then we have to explicitly set the index
                    // page to disambiguate the path info.
                    $page = 'index';
                }
            }
        }

        //
        // Additional query parameters
        //
        $additionalParameters = $this->_urlGetAdditionalParameters($request, $params, $escape);

        //
        // Anchor
        //
        $anchor = (empty($anchor) ? '' : '#' . preg_replace("/[^a-zA-Z0-9\-\_\/\.\~]/", '', $anchor));

        //
        // Assemble URL
        //
        // Context, locale?, page, operation and additional path go into the path info.
        $pathInfoArray = $context;
        if ($urlLocaleForPage !== '') {
            [$contextObject, $contextLocales] = $this->_getContextAndLocales($request, $context[0] ?? "");
            if (count($contextLocales) > 1) {
                $pathInfoArray[] = $this->_getLocaleForUrl($request, $contextObject, $contextLocales, $urlLocaleForPage);
            }
        }
        if (!empty($page)) {
            $pathInfoArray[] = $page;
            if (!empty($op)) {
                $pathInfoArray[] = $op;
            }
        }
        $pathInfoArray = array_merge($pathInfoArray, $additionalPath);

        // Query parameters
        $queryParametersArray = $additionalParameters;

        return $this->_urlFromParts($baseUrl, $pathInfoArray, $queryParametersArray, $anchor, $escape);
    }

    /**
     * @copydoc PKPRouter::handleAuthorizationFailure()
     */
    public function handleAuthorizationFailure(
        $request,
        $authorizationMessage,
        array $messageParams = []
    ) {
        // Redirect to the authorization denied page.
        if (!$request->getUser()) {
            Validation::redirectLogin();
        }
        $request->redirect(null, 'user', 'authorizationDenied', null, ['message' => $authorizationMessage]);
    }

    /**
     * Redirect to user home page (or the user group home page if the user has one user group).
     */
    public function redirectHome(PKPRequest $request)
    {
        $request->redirectUrl($this->getHomeUrl($request));
    }

    /**
     * Get the user's "home" page URL (e.g. where they are sent after login).
     *
     * @param PKPRequest $request the request to be routed
     */
    public function getHomeUrl($request)
    {
        $user = Auth::user(); /** @var \PKP\user\User $user */
        $userId = $user->getId();

        if ($context = $this->getContext($request)) {
            // If the user has no roles, or only one role and this is reader, go to "Index" page.
            // Else go to "submissions" page
            $userGroups = Repo::userGroup()->userUserGroups($userId, $context->getId());

            if ($userGroups->isEmpty()
                || ($userGroups->count() == 1 && $userGroups->first()->getRoleId() == Role::ROLE_ID_READER)
            ) {
                return $request->url(null, 'index');
            }

            if(Config::getVar('features', 'enable_new_submission_listing')) {

                $roleIds = $userGroups->map(function ($group) {
                    return $group->getRoleId();
                });

                $roleIdsArray = $roleIds->all();

                if (count(array_intersect([Role::ROLE_ID_MANAGER, Role::ROLE_ID_SITE_ADMIN, Role::ROLE_ID_SUB_EDITOR, Role::ROLE_ID_ASSISTANT], $roleIdsArray))) {
                    return $request->url(null, 'dashboard', 'editorial');

                }
                if(count(array_intersect([ Role::ROLE_ID_REVIEWER], $roleIdsArray))) {
                    return $request->url(null, 'dashboard', 'reviewAssignments');

                }
                if(count(array_intersect([  Role::ROLE_ID_AUTHOR], $roleIdsArray))) {
                    return $request->url(null, 'dashboard', 'mySubmissions');
                }
            }

            return $request->url(null, 'submissions');
        } else {
            // The user is at the site context, check to see if they are
            // only registered in one place w/ one role
            $userGroups = Repo::userGroup()->userUserGroups($userId, \PKP\core\PKPApplication::CONTEXT_ID_NONE);
            if ($userGroups->count() == 1) {
                $firstUserGroup = $userGroups->first();
                $contextDao = Application::getContextDAO();
                $context = $contextDao->getById($firstUserGroup->getContextId());
                if (!isset($context)) {
                    $request->redirect('index', 'index');
                }
                if ($firstUserGroup->getRoleId() == Role::ROLE_ID_READER) {
                    $request->redirect(null, 'index');
                }
            }
            return $request->url('index', 'index');
        }
    }


    //
    // Private helper methods.
    //
    /**
     * Retrieve part of the current requested
     * url using the passed callback method.
     *
     * @param array $callback Core method to retrieve
     * page, operation or arguments from url.
     * @param PKPRequest $request
     *
     */
    private function _getRequestedUrlParts($callback, $request): array|string|null
    {
        $url = null;
        assert($request->getRouter() instanceof \PKP\core\PKPPageRouter);

        if (isset($_SERVER['PATH_INFO'])) {
            $url = $_SERVER['PATH_INFO'];
        }

        $userVars = $request->getUserVars();
        return $callback($url ?? '', $userVars);
    }

    /**
     * Get context object and context/site/all locales.
     */
    private function _getContextAndLocales(PKPRequest $request, string $contextPath): array
    {
        return [
            $context = $this->getCurrentContext() ?? (($contextPath === 'index' || !$contextPath || $contextPath === Application::CONTEXT_ID_ALL)
                ? null
                : Application::getContextDAO()->getByPath($contextPath)),
            $context?->getSupportedLocales()
                ?? (($contextPath === 'index')
                    ? (Application::isInstalled()
                        ? $request->getSite()->getSupportedLocales()
                        : array_keys(Locale::getLocales()))
                    : [])
        ];
    }

    /**
     * Get locale for URL from session or primary
     */
    private function _getLocaleForUrl(PKPRequest $request, ?Context $context, array $locales, ?string $urlLocaleForPage): string
    {
        return in_array($locale = $urlLocaleForPage ?: Locale::getLocale(), $locales)
            ? $locale
            : (($context ?? $request->getSite())?->getPrimaryLocale() ?? Locale::getLocale());
    }

    /**
     * Change the locale for the current user.
     * Redirect to url with(out) locale if locale changed or context set to multi/monolingual.
     */
    private function _setLocale(PKPRequest $request, ?string $setLocale): void
    {
        $contextPath = $this->_getRequestedUrlParts(['Core', 'getContextPath'], $request);
        $urlLocale = $this->_getRequestedUrlParts(['Core', 'getLocalization'], $request);
        $multiLingual = count($this->_getContextAndLocales($request, $contextPath)[1]) > 1;

        if (!$multiLingual && !$urlLocale && !$setLocale || $multiLingual && !$setLocale && $urlLocale === Locale::getLocale()) {
            return;
        }

        $sessionLocale = (function (string $l) use ($request): string {
            $session = $request->getSession();
            if (Locale::isSupported($l) && $l !== $session->get('currentLocale')) {
                $session->put('currentLocale', $l);
                $request->setCookieVar('currentLocale', $l);
            }
            // In case session current locale has been set to non-supported locale, or is null, somewhere else
            if (!Locale::isSupported($session->get('currentLocale') ?? "")) {
                $session->put('currentLocale', Locale::getLocale());
                $request->setCookieVar('currentLocale', Locale::getLocale());
            }
            return $session->get('currentLocale');
        })($setLocale ?? $urlLocale);

        if (preg_match('#^/\w#', $source = $request->getUserVar('source') ?? "")) {
            $request->redirectUrl($source);
        }

        $indexUrl = $this->getIndexUrl($request);
        $uri = preg_replace("#^$indexUrl#", "", $setLocale ? ($_SERVER['HTTP_REFERER'] ?? "") : $request->getCompleteUrl(), 1);
        $newUrlLocale = $multiLingual ? "/$sessionLocale" : "";
        $pathInfo = ($uri)
            ? preg_replace("#^/$contextPath" . ($urlLocale ? "/$urlLocale" : "") . "(?=[/?\\#]|$)#", "/$contextPath$newUrlLocale", $uri, 1)
            : "/index$newUrlLocale";

        $request->redirectUrl($indexUrl . $pathInfo);
    }
}

if (!PKP_STRICT_MODE) {
    class_alias('\PKP\core\PKPPageRouter', '\PKPPageRouter');
}
