<?php
/**
 * @file classes/dataCitation/Repository.php
 *
 * Copyright (c) 2014-2025 Simon Fraser University
 * Copyright (c) 2000-2025 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class Repository
 *
 * @brief A helper class to handle operations with Data Citations
 */

namespace PKP\dataCitation;

use APP\core\Application;
use APP\core\Request;
use PKP\context\Context;
use PKP\plugins\Hook;
use PKP\services\PKPSchemaService;
use PKP\validation\ValidatorFactory;

class Repository
{
    /** @var string $schemaMap The name of the class to map this entity to its schema */
    public string $schemaMap = maps\Schema::class;

    /**  */
    protected Request $request;

    /** @var PKPSchemaService<DataCitation> $schemaService */
    protected PKPSchemaService $schemaService;

    public function __construct(Request $request, PKPSchemaService $schemaService)
    {
        $this->request = $request;
        $this->schemaService = $schemaService;
    }

    /**
     * Validate properties for a Data Citation
     *
     * Perform validation checks on data used to add or edit a Data Citation.
     *
     * @param array $props A key/value array with the new data to validate
     * @param array $allowedLocales The context's supported locales
     * @param string $primaryLocale The context's primary locale
     *
     * @return array A key/value array with validation errors. Empty if no errors
     *
     * @hook DataCitation::validate [[&$errors, $object, $props, $allowedLocales, $primaryLocale]]
     */
    public function validate(?DataCitation $object, array $props, array $allowedLocales, string $primaryLocale): array
    {
        $schema = DataCitation::getSchemaName();

        $validator = ValidatorFactory::make(
            $props,
            $this->schemaService->getValidationRules($schema, $allowedLocales),
            [
                'dateExpire.date_format' => __('stats.dateRange.invalidDate'),
            ]
        );

        // Check required fields
        ValidatorFactory::required(
            $validator,
            $object,
            $this->schemaService->getRequiredProps($schema),
            $this->schemaService->getMultilingualProps($schema),
            $allowedLocales,
            $primaryLocale
        );

        // Check for input from disallowed locales
        ValidatorFactory::allowedLocales($validator, $this->schemaService->getMultilingualProps($schema), $allowedLocales);

        $errors = [];

        if ($validator->fails()) {
            $errors = $this->schemaService->formatValidationErrors($validator->errors());
        }

        Hook::call('DataCitation::validate', [&$errors, $object, $props, $allowedLocales, $primaryLocale]);

        return $errors;
    }

    /**
     * Get an instance of the map class for mapping
     * announcements to their schema
     */
    public function getSchemaMap(): maps\Schema
    {
        return app('maps')->withExtensions($this->schemaMap);
    }

}
