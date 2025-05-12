<?php

/**
 * @file controllers/grid/dataCitations/DataCitationGridCellProvider.php
 *
 * Copyright (c) 2016-2025 Simon Fraser University
 * Copyright (c) 2000-2025 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class DataCitationGridCellProvider
 *
 * @ingroup controllers_grid_dataCitations
 *
 * @brief Base class for a cell provider for Data Citations.
 */

namespace PKP\controllers\grid\dataCitations;

use APP\facades\Repo;
use APP\publication\Publication;
use APP\submission\Submission;
use PKP\controllers\api\file\linkAction\DownloadFileLinkAction;
use PKP\controllers\grid\DataObjectGridCellProvider;
use PKP\controllers\grid\GridHandler;
use PKP\facades\Locale;
use PKP\dataCitation\DataCitation;

class DataCitationGridCellProvider extends DataObjectGridCellProvider
{
    /** @var Submission */
    public $_submission;

    /** @var Publication */
    public $_publication;

    public $_isEditable;

    /**
     * Constructor
     *
     * @param Submission $submission
     */
    public function __construct($submission, $publication, $isEditable)
    {
        parent::__construct();
        $this->_submission = $submission;
        $this->_publication = $publication;
        $this->_isEditable = $isEditable;
    }

    //
    // Template methods from GridCellProvider
    //
    /**
     * @copydoc GridCellProvider::getTemplateVarsFromRowColumn()
     */
    public function getTemplateVarsFromRowColumn($row, $column)
    {
        $element = $row->getData();
        $columnId = $column->getId();
        assert($element instanceof \PKP\core\DataObject && !empty($columnId));
        /** @var DataCitation $element */
        switch ($columnId) {
            case 'namel':
                return [
                    'label' => $element->getData('title')
                ];
            case 'persistentIdentifier':
                return [
                    'label' => $element->getData('persistentIdentifier')
                ];
            default: assert(false);
        }
        return parent::getTemplateVarsFromRowColumn($row, $column);
    }

    /**
     * Get request arguments.
     *
     * @param \PKP\controllers\grid\GridRow $row
     *
     * @return array
     */
    public function getRequestArgs($row)
    {
        return [
            'submissionId' => $this->_submission->getId(),
            'publicationId' => $this->_publication->getId(),
        ];
    }

}
