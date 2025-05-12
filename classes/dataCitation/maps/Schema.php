<?php
/**
 * @file classes/dataCitation/maps/Schema.php
 *
 * Copyright (c) 2014-2020 Simon Fraser University
 * Copyright (c) 2000-2020 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class Schema
 *
 * @brief Map Data Citations to the properties defined in the Data Citation schema
 */

namespace PKP\dataCitation\maps;

use APP\core\Application;
use Illuminate\Support\Enumerable;
use PKP\dataCitation\DataCitation;
use PKP\core\PKPApplication;
use PKP\services\PKPSchemaService;

class Schema extends \PKP\core\maps\Schema
{
    public Enumerable $collection;

    public string $schema = PKPSchemaService::SCHEMA_DATA_CITATION;

    /**
     * Map a Data Citation
     *
     * Includes all properties in the Data Citation schema.
     */
    public function map(DataCitation $item): array
    {
        return $this->mapByProperties($this->getProps(), $item);
    }

    /**
     * Summarize a Data Citation
     *
     * Includes properties with the apiSummary flag in the Data Citation schema.
     */
    public function summarize(DataCitation $item): array
    {
        return $this->mapByProperties($this->getSummaryProps(), $item);
    }

    /**
     * Map a collection of Data Citations
     *
     * @see self::map
     */
    public function mapMany(Enumerable $collection): Enumerable
    {
        $this->collection = $collection;
        return $collection->map(function ($item) {
            return $this->map($item);
        });
    }

    /**
     * Summarize a collection of Data Citations
     *
     * @see self::summarize
     */
    public function summarizeMany(Enumerable $collection): Enumerable
    {
        $this->collection = $collection;
        return $collection->map(function ($item) {
            return $this->summarize($item);
        });
    }

    /**
     * Map schema properties of an Data Citation to an assoc array
     */
    protected function mapByProperties(array $props, DataCitation $item): array
    {
        $output = [];
        foreach ($props as $prop) {
            switch ($prop) {
                default:
                    $output[$prop] = $item->getAttribute($prop);
                    break;
            }
        }

        $output = $this->schemaService->addMissingMultilingualValues($this->schema, $output, $this->context->getSupportedSubmissionLocales());

        ksort($output);

        return $this->withExtensions($output, $item);        
    }

}
