<?php

/**
 * @file classes/frontend/JsPayload.php
 *
 * Copyright (c) 2014-2026 Simon Fraser University
 * Copyright (c) 2000-2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class JsPayload
 *
 * @brief Registry for data shipped to the client-side runtime on frontend pages.
 *
 * Holds and assembles the payload exposed to JavaScript through the
 * window.pkp global on reader-facing pages: constants, translated
 * locale keys and arbitrary namespaced entries. Internal to the
 * Frontend service — write through the Frontend facade
 * (addLocaleKeys(), setJsConstants(), addJsData()). Read once at
 * emission, when toScript() also resolves the environment entries
 * (locale, URLs, CSRF token) the client runtime needs.
 */

namespace PKP\frontend;

use APP\core\Application;
use Illuminate\Support\Arr;
use PKP\config\Config;
use PKP\core\PKPApplication;
use PKP\core\PKPSessionGuard;
use PKP\core\PKPString;
use PKP\facades\Locale;
use PKP\i18n\LocaleMetadata;

class JsPayload
{
    /** @var array Key/value list of constants to expose at pkp.const.<constant> */
    protected array $constants = [];

    /** @var array<string, string> Locale key => translated string */
    protected array $localeKeys = [];

    /** @var array<string, mixed> Namespaced entries added via set() */
    protected array $extra = [];

    /**
     * Set constants to be exposed in JavaScript at pkp.const.<constant>
     *
     * @param array $constants Associative array of constant names to values
     */
    public function setConstants(array $constants): void
    {
        $this->constants = deepArrayMerge($this->constants, $constants);
    }

    /**
     * @return array Constants set via setConstants()
     */
    public function constants(): array
    {
        return $this->constants;
    }

    /**
     * Add locale keys to be exposed in JavaScript at pkp.localeKeys.<key>
     *
     * Keys are translated at write time. Keys already present are not
     * translated again.
     *
     * @param string[] $keys
     */
    public function addLocaleKeys(array $keys): void
    {
        foreach ($keys as $key) {
            if (!array_key_exists($key, $this->localeKeys)) {
                $this->localeKeys[$key] = __($key);
            }
        }
    }

    /**
     * Set an arbitrary payload entry, exposed in JavaScript at pkp.<key>.
     * Use a namespaced key, e.g. 'myPlugin.settings'.
     */
    public function set(string $key, mixed $value): void
    {
        Arr::set($this->extra, $key, $value);
    }

    /**
     * Get a payload entry set via set()
     */
    public function get(string $key): mixed
    {
        return Arr::get($this->extra, $key);
    }

    /**
     * @return array<string, string> Locale key => translated string
     */
    public function localeKeys(): array
    {
        return $this->localeKeys;
    }

    /**
     * @return array<string, mixed> All entries added via set()
     */
    public function extra(): array
    {
        return $this->extra;
    }

    /**
     * Assemble the window.pkp script for the client runtime on frontend
     * pages.
     *
     * Ships the registered payload plus the environment the frontend
     * bundle consumes: locale and date/time format information, API and
     * page base URLs, and the current user's id and CSRF token when
     * logged in. Environment values are resolved when this is called,
     * at emission time.
     */
    public function toScript(): string
    {
        $application = Application::get();
        $request = $application->getRequest();
        $dispatcher = $application->getDispatcher();
        $context = $request->getContext();

        $output = 'window.pkp = window.pkp || {};';

        if (!empty($this->constants)) {
            $output .= 'pkp.const = ' . json_encode($this->constants) . ';';
        }

        if (!empty($this->localeKeys)) {
            $output .= 'pkp.localeKeys = pkp.localeKeys || {};';
            $output .= 'Object.assign(pkp.localeKeys, ' . json_encode($this->localeKeys) . ');';
        }

        foreach ($this->extra as $key => $value) {
            $output .= 'pkp.' . $key . ' = ' . json_encode($value) . ';';
        }

        $pageContext = [
            'app' => $application->getName(),
            'currentLocale' => Locale::getLocale(),
            'primaryLocale' => Locale::getPrimaryLocale(),
            'apiBaseUrl' => $dispatcher->url($request, PKPApplication::ROUTE_API, $context?->getPath() ?: Application::SITE_CONTEXT_PATH),
            'pageBaseUrl' => $dispatcher->url($request, PKPApplication::ROUTE_PAGE, $context?->getPath() ?: Application::SITE_CONTEXT_PATH) . '/',
            'helpUrl' => $application->getHelpUrl(),
            'timeZone' => Config::getVar('general', 'time_zone'),
        ];

        if ($context) {
            $pageContext = array_merge($pageContext, [
                'dateFormatShort' => PKPString::convertStrftimeFormat($context->getLocalizedDateFormatShort()),
                'dateFormatLong' => PKPString::convertStrftimeFormat($context->getLocalizedDateFormatLong()),
                'datetimeFormatShort' => PKPString::convertStrftimeFormat($context->getLocalizedDateTimeFormatShort()),
                'datetimeFormatLong' => PKPString::convertStrftimeFormat($context->getLocalizedDateTimeFormatLong()),
                'timeFormat' => PKPString::convertStrftimeFormat($context->getLocalizedTimeFormat()),
                'supportedLocales' => $context->getSupportedLocaleNames(LocaleMetadata::LANGUAGE_LOCALE_ONLY),
                'supportedFormLocales' => $context->getSupportedFormLocaleNames(),
            ]);
        } else {
            $pageContext = array_merge($pageContext, [
                'dateFormatShort' => PKPString::convertStrftimeFormat(Config::getVar('general', 'date_format_short')),
                'dateFormatLong' => PKPString::convertStrftimeFormat(Config::getVar('general', 'date_format_long')),
                'datetimeFormatShort' => PKPString::convertStrftimeFormat(Config::getVar('general', 'datetime_format_short')),
                'datetimeFormatLong' => PKPString::convertStrftimeFormat(Config::getVar('general', 'datetime_format_long')),
                'timeFormat' => PKPString::convertStrftimeFormat(Config::getVar('general', 'time_format')),
                'supportedLocales' => !PKPSessionGuard::isSessionDisable() ? $request->getSite()->getSupportedLocaleNames(LocaleMetadata::LANGUAGE_LOCALE_ONLY) : [],
            ]);
        }

        $output .= 'pkp.context = ' . json_encode($pageContext) . ';';

        if (Application::isInstalled()) {
            $user = $request->getUser();
            if ($user) {
                $output .= 'pkp.currentUser = ' . json_encode([
                    'csrfToken' => $request->getSession()->token(),
                    'id' => (int) $user->getId(),
                ]) . ';';
            }
        }

        return $output;
    }
}
