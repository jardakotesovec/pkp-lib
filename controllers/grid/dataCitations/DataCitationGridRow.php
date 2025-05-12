<?php

/**
 * @file controllers/grid/dataCitations/DataCitationGridRow.php
 *
 * Copyright (c) 2016-2025 Simon Fraser University
 * Copyright (c) 2000-2025 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class DataCitationGridRow
 *
 * @ingroup controllers_grid_dataCitations
 *
 * @brief Representation of an Data Citation grid row.
 */

namespace PKP\controllers\grid\dataCitations;

use APP\core\Application;
use APP\publication\Publication;
use APP\submission\Submission;
use PKP\controllers\api\file\linkAction\AddFileLinkAction;
use PKP\controllers\grid\GridRow;
use PKP\linkAction\LinkAction;
use PKP\linkAction\request\AjaxModal;
use PKP\linkAction\request\RemoteActionConfirmationModal;
use PKP\security\Role;
use PKP\submissionFile\SubmissionFile;

class DataCitationGridRow extends GridRow
{
    /** @var Submission */
    public $_submission;

    /** @var Publication */
    public $_publication;

    /** @var bool */
    public $_isEditable;

    /**
     * Constructor
     *
     * @param Submission $submission
     * @param bool $isEditable
     */
    public function __construct($submission, $publication, $isEditable)
    {
        $this->_submission = $submission;
        $this->_publication = $publication;
        $this->_isEditable = $isEditable;

        parent::__construct();
    }

    //
    // Overridden methods from GridRow
    //
    /**
     * @copydoc GridRow::initialize()
     *
     * @param null|mixed $template
     */
    public function initialize($request, $template = null)
    {
        // Do the default initialization
        parent::initialize($request, $template);

        // Is this a new row or an existing row?
        $rowId = $this->getId();
        if (!empty($rowId) && is_numeric($rowId)) {
            // Only add row actions if this is an existing row
            $router = $request->getRouter();
            $actionArgs = $this->getRequestArgs();
            $actionArgs['dataCitationId'] = $rowId;

            // Add row-level actions
            $this->addAction(new LinkAction(
                'editDataCitation',
                new AjaxModal(
                    $router->url($request, null, null, 'editDataCitation', null, $actionArgs),
                    ($this->_isEditable) ? __('submission.layout.editDataCitation') : __('submission.layout.viewDataCitation'),
                ),
                ($this->_isEditable) ? __('grid.action.edit') : __('grid.action.view'),
                'edit'
            ));

            if ($this->_isEditable) {
                $dataCitation = $this->getData();
                if (!$dataCitation->getData('urlRemote')) {
                    $this->addAction(new AddFileLinkAction(
                        $request,
                        $this->getSubmission()->getId(),
                        WORKFLOW_STAGE_ID_PRODUCTION,
                        [Role::ROLE_ID_MANAGER, Role::ROLE_ID_SITE_ADMIN, Role::ROLE_ID_SUB_EDITOR, Role::ROLE_ID_ASSISTANT],
                        SubmissionFile::SUBMISSION_FILE_PROOF,
                        Application::ASSOC_TYPE_REPRESENTATION,
                        $rowId,
                        null
                    ));
                }

                $this->addAction(new LinkAction(
                    'deleteDataCitation',
                    new RemoteActionConfirmationModal(
                        $request->getSession(),
                        __('common.confirmDelete'),
                        __('grid.action.delete'),
                        $router->url($request, null, null, 'deleteDataCitation', null, $actionArgs),
                        'negative'
                    ),
                    __('grid.action.delete'),
                    'delete'
                ));
            }
        }
    }

    /**
     * Get the submission for this row (already authorized)
     *
     * @return Submission
     */
    public function getSubmission()
    {
        return $this->_submission;
    }

    /**
     * Get the publication for this row (already authorized)
     *
     * @return Publication
     */
    public function getPublication()
    {
        return $this->_publication;
    }

    /**
     * Get the base arguments that will identify the data in the grid.
     *
     * @return array
     */
    public function getRequestArgs()
    {
        return [
            'submissionId' => $this->getSubmission()->getId(),
            'publicationId' => $this->getPublication()->getId(),
        ];
    }
}
