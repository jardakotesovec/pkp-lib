<?php

/**
 * @file lib/pkp/classes/template/ViewHelper.php
 *
 * Copyright (c) 2014-2025 Simon Fraser University
 * Copyright (c) 2000-2025 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class ViewHelper
 * @brief Helper class providing utility methods for view templates
 */

namespace PKP\template;

use APP\core\Application;
use PKP\core\PKPString;
use PKP\facades\Locale;

class ViewHelper
{
    /**
     * Generate a URL using PKPTemplateManager
     *
     * @param array $parameters URL parameters (page, op, path, etc.)
     * @return string The generated URL
     */
    public static function url(array $parameters): string
    {
        return PKPTemplateManager::getManager()->smartyUrl($parameters);
    }

    public static function urlArray(array $parameters): string
    {
        $page = $parameters[0] ?? '';
        $op = $parameters[1] ?? '';
        $path = $parameters[2] ?? '';
        $anchor = $parameters[3] ?? '';
        return PKPTemplateManager::getManager()->smartyUrl([
            'page' => $page,
            'op' => $op,
            'path' => $path,
            'anchor' => $anchor,
        ]);
    }

    /**
     * Format a date with locale-aware formatting
     * Delegates to PKPTemplateManager::smartyDateFormat() for consistency
     *
     * @param string|null $dateString The date string to format
     * @param string|null $format The date format (if null, uses default)
     * @return string The formatted date string
     */
    public static function dateFormat($dateString, ?string $format = null): string
    {
        return PKPTemplateManager::getManager()->smartyDateFormat($dateString, $format);
    }

    /**
     * Sanitize HTML content
     *
     * @param string|null $input The HTML content to sanitize
     * @param string $configKey The configuration key for allowed HTML tags
     * @return string The sanitized HTML
     */
    public static function sanitizeHtml(?string $input, string $configKey = 'allowed_html'): string
    {
        $result = PKPString::stripUnsafeHtml($input, $configKey);
        return self::escapeVueDelimiters($result);
    }

    /**
     * Convert HTML to plain text
     */
    public static function html2Text(?string $html): string
    {
        $result = PKPString::html2text($html);
        return self::escapeVueDelimiters($result);
    }

    /**
     * Get the value of a multilingual field from mapped (API-shaped) data
     * in the preferred locale, falling back to the first non-empty value.
     *
     * Mirrors DataObject::getLocalizedData() for data mapped by the
     * schema maps, where multilingual fields are associative arrays
     * keyed by locale.
     *
     * @param mixed $multilingual The multilingual array, or a plain value
     * @param ?string $preferredLocale Defaults to the current locale
     */
    public static function localize(mixed $multilingual, ?string $preferredLocale = null): mixed
    {
        if (!is_array($multilingual)) {
            return $multilingual;
        }
        $preferredLocale ??= Locale::getLocale();
        if (!empty($multilingual[$preferredLocale])) {
            return $multilingual[$preferredLocale];
        }
        foreach ($multilingual as $value) {
            if (!empty($value)) {
                return $value;
            }
        }
        return null;
    }

    /**
     * Add a hidden form field with the user's CSRF token
     */
    public static function csrfFormField(): string
    {
        $csrfToken = Application::get()->getRequest()->getSession()->token();
        if (!$csrfToken) {
            return '';
        }
        return '<input type="hidden" name="csrfToken" value="' . htmlspecialchars($csrfToken) . '" />';
    }

    /**
     * Escape value for safe output in Blade templates within Vue.js context
     *
     * This combines Laravel's e() HTML escaping with Vue delimiter escaping.
     * Used as the default echo format for Blade's {{ }} syntax.
     *
     * @param mixed $value The value to escape
     * @return string The escaped value safe for HTML and Vue
     */
    public static function vueEscape($value): string
    {
        return self::escapeVueDelimiters(e($value));
    }

    /**
     * Escape Vue.js template delimiters to prevent XSS via Vue template injection
     *
     * When user content containing {{ }} is rendered in a Vue-mounted element,
     * Vue will interpret it as a template expression and execute it.
     * This wraps delimiters in v-pre spans to prevent Vue compilation.
     *
     * @param string|null $value The value to escape
     * @return string The escaped value
     */
    protected static function escapeVueDelimiters($value): string
    {
        if ($value === null || $value === '') {
            return '';
        }

        return str_replace(
            ['{{', '}}'],
            ['<span v-pre>{{</span>', '<span v-pre>}}</span>'],
            (string) $value
        );
    }
}
