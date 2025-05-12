<?php

/**
 * @file controllers/grid/dataCitations/DataCitationGridHandler.php
 *
 * Copyright (c) 2016-2025 Simon Fraser University
 * Copyright (c) 2000-2025 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class DataCitationGridHandler
 *
 * @ingroup controllers_grid_dataCitations
 *
 * @brief Handle Data Citation grid requests.
 */

namespace PKP\controllers\grid\dataCitations;

use PKP\controllers\grid\dataCitations\form\DataCitationForm;
use APP\controllers\tab\pubIds\form\PublicIdentifiersForm;
use APP\core\Application;
use APP\core\Request;
use APP\facades\Repo;
use APP\notification\NotificationManager;
use APP\publication\Publication;
use APP\submission\Submission;
use APP\template\TemplateManager;
use PKP\controllers\grid\feature\OrderGridItemsFeature;
use PKP\controllers\grid\GridColumn;
use PKP\controllers\grid\GridHandler;
use PKP\core\JSONMessage;
use PKP\core\PKPApplication;
use PKP\db\DAO;
use PKP\dataCitation\DataCitation;
use PKP\linkAction\LinkAction;
use PKP\linkAction\request\AjaxModal;
use PKP\notification\Notification;
use PKP\plugins\PluginRegistry;
use PKP\security\authorization\internal\DataCitationRequiredPolicy;
use PKP\security\authorization\PublicationAccessPolicy;
use PKP\security\authorization\WorkflowStageAccessPolicy;
use PKP\security\Role;
use PKP\submission\PKPSubmission;

class DataCitationGridHandler extends GridHandler
{
    /** @var Request */
    public $_request;

    /**
     * Constructor
     */
    public function __construct()
    {
        parent::__construct();
        $this->addRoleAssignment(
            [Role::ROLE_ID_AUTHOR, Role::ROLE_ID_MANAGER, Role::ROLE_ID_SITE_ADMIN, Role::ROLE_ID_SUB_EDITOR, Role::ROLE_ID_ASSISTANT],
            ['fetchGrid', 'fetchRow']
        );
        $this->addRoleAssignment(
            [Role::ROLE_ID_MANAGER, Role::ROLE_ID_SITE_ADMIN, Role::ROLE_ID_SUB_EDITOR, Role::ROLE_ID_ASSISTANT],
            ['addDataCitation', 'editDataCitation', 'updateDataCitation', 'deleteDataCitation', 'saveSequence']
        );
    }


    //
    // Getters/Setters
    //
    /**
     * Get the authorized submission.
     *
     * @return Submission
     */
    public function getSubmission()
    {
        return $this->getAuthorizedContextObject(Application::ASSOC_TYPE_SUBMISSION);
    }

    /**
     * Get the authorized publication.
     *
     * @return Publication
     */
    public function getPublication()
    {
        return $this->getAuthorizedContextObject(Application::ASSOC_TYPE_PUBLICATION);
    }

    /**
     * Get the authorized dataCitation.
     *
     * @return DataCitation
     */
    public function getDataCitation()
    {
        return $this->getAuthorizedContextObject(Application::ASSOC_TYPE_DATA_CITATION);
    }


    //
    // Overridden methods from PKPHandler.
    //
    /**
     * @see GridHandler::getJSHandler()
     */    
    public function getJSHandler()
    {
        return '$.pkp.controllers.grid.dataCitations.DataCitationGridHandler';
    }

    /**
     * @copydoc PKPHandler::authorize()
     */
    public function authorize($request, &$args, $roleAssignments)
    {
        $this->_request = $request;

        $this->addPolicy(new WorkflowStageAccessPolicy($request, $args, $roleAssignments, 'submissionId', WORKFLOW_STAGE_ID_PRODUCTION));

        $this->addPolicy(new PublicationAccessPolicy($request, $args, $roleAssignments));

        if ($request->getUserVar('dataCitationId')) {
            $this->addPolicy(new DataCitationRequiredPolicy($request, $args));
        }

        return parent::authorize($request, $args, $roleAssignments);
    }

    /**
     * @copydoc GridHandler::initialize()
     *
     * @param null|mixed $args
     */
    public function initialize($request, $args = null)
    {
        parent::initialize($request, $args);
        $this->setTitle('submission.dataCitation.dataCitations');

        $cellProvider = new DataCitationGridCellProvider($this->getSubmission(), $this->getPublication(), $this->canEdit());

        // Columns
        $this->addColumn(new GridColumn(
            'label',
            'submission.dataCitation.title',
            null,
            null,
            $cellProvider
        ));

        $this->addColumn(new GridColumn(
            'label',
            'submission.dataCitation.persistentIdentifier',
            null,
            null,
            $cellProvider
        ));

        if ($this->canEdit()) {
            $this->addAction(new LinkAction(
                'addDataCitation',
                new AjaxModal(
                    $request->getRouter()->url($request, null, null, 'addDataCitation', null, $this->getRequestArgs()),
                    __('submission.layout.newDataCitation'),
                ),
                __('grid.action.addDataCitation'),
                'add_item'
            ));
        }
    }

    /**
     * @copydoc GridHandler::getDataElementSequence()
     */
    public function getDataElementSequence($row)
    {
        return $row->seq;
    }

    /**
     * @copydoc GridHandler::setDataElementSequence()
     */
    public function setDataElementSequence($request, $rowId, $gridDataElement, $newSequence)
    {
        $dataCitation = DataCitation::findOrFail((int) $rowId);
        $dataCitation->seq = $newSequence;
        $dataCitation->save();
    }

    //
    // Overridden methods from GridHandler
    //
    /**
     * @copydoc GridHandler::initFeatures()
     */
    public function initFeatures($request, $args)
    {
        if ($this->canEdit()) {
            return [new OrderGridItemsFeature()];
        }

        return [];
    }

    //
    // Overridden methods from GridHandler
    //
    /**
     * @copydoc GridHandler::getRowInstance()
     *
     * @return DataCitationGridRow
     */
    public function getRowInstance()
    {
        return new DataCitationGridRow(
            $this->getSubmission(),
            $this->getPublication(),
            $this->canEdit()
        );
    }

    /**
     * Get the arguments that will identify the data in the grid.
     * Overridden by child grids.
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

    /**
     * @copydoc GridHandler::loadData()
     *
     * @param null|mixed $filter
     */
    public function loadData($request, $filter = null)
    {
        return DataCitation::where('publication_id', $this->getPublication()->getId())
            ->orderBy('seq')
            ->get();
    }

    //
    // Public DataCitation Grid Actions
    //

    /**
     * Add a dataCitation
     *
     * @param array $args
     * @param Request $request
     *
     * @return JSONMessage JSON object
     */
    public function addDataCitation($args, $request)
    {
        $dataCitationForm = new DataCitationForm(
            $request,
            $this->getSubmission(),
            $this->getPublication()
        );
        $dataCitationForm->initData();
        return new JSONMessage(true, $dataCitationForm->fetch($request));
    }

    /**
     * Delete a dataCitation.
     *
     * @param array $args
     * @param Request $request
     *
     * @return JSONMessage JSON object
     */
    public function deleteDataCitation($args, $request)
    {
        $dataCitation = $this->getDataCitation();
        if (!$dataCitation || !$request->checkCSRF()) {
            return new JSONMessage(false);
        }
    
        $dataCitation->delete();    
        return DAO::getDataChangedEvent($dataCitation->id);
    }

    /**
     * Edit a dataCitation
     *
     * @param array $args
     * @param Request $request
     *
     * @return JSONMessage JSON object
     */
    public function editDataCitation($args, $request)
    {
        // Form handling
        $dataCitationForm = new DataCitationForm(
            $request,
            $this->getSubmission(),
            $this->getPublication(),
            $this->getDataCitation(),
            $this->canEdit()
        );
        $dataCitationForm->initData();
        return new JSONMessage(true, $dataCitationForm->fetch($request));
    }

    /**
     * Save a dataCitation
     *
     * @param array $args
     * @param Request $request
     *
     * @return JSONMessage JSON object
     */
    public function updateDataCitation($args, $request)
    {
        $dataCitation = $this->getDataCitation();

        $dataCitationForm = new DataCitationForm($request, $this->getSubmission(), $this->getPublication(), $dataCitation, $this->canEdit());
        $dataCitationForm->readInputData();

        if ($dataCitationForm->validate()) {
            $dataCitation = $dataCitationForm->execute();

            return DAO::getDataChangedEvent($dataCitation->id);
        }
        return new JSONMessage(true, $dataCitationForm->fetch($request));
    }

    /**
     * @copydoc GridHandler::fetchRow()
     */
    public function fetchRow($args, $request)
    {
        $json = parent::fetchRow($args, $request);
        if ($row = $this->getRequestedRow($request, $args)) {
            $dataCitation = $row->getData();
        }

        return $json;
    }

    /**
     * Can the current user edit the dataCitations in this grid?
     *
     * The user must have an allowed role in one of the assigned stages.
     * If the user is not assigned, they can edit if they are an editor
     * or admin.
     *
     * @return bool
     */
    public function canEdit()
    {
        return $this->getPublication()->getData('status') !== PKPSubmission::STATUS_PUBLISHED &&
            Repo::user()->canUserAccessStage(
                WORKFLOW_STAGE_ID_PRODUCTION,
                PKPApplication::WORKFLOW_TYPE_EDITORIAL,
                $this->getAuthorizedContextObject(Application::ASSOC_TYPE_ACCESSIBLE_WORKFLOW_STAGES),
                $this->getAuthorizedContextObject(Application::ASSOC_TYPE_USER_ROLES)
            );
    }
}
