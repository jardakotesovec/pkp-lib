<?php

/**
 * @file controllers/grid/dataCitations/form/DataCitationForm.php
 *
 * Copyright (c) 2014-2025 Simon Fraser University
 * Copyright (c) 2003-2025 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class DataCitationForm
 *
 * @ingroup controllers_grid_dataCitations_form
 *
 * @see DataCitation
 *
 * @brief Article dataCitation editing form.
 */

namespace PKP\controllers\grid\dataCitations\form;

use APP\core\Request;
use APP\facades\Repo;
use APP\publication\Publication;
use APP\submission\Submission;
use APP\template\TemplateManager;
use PKP\form\Form;
use PKP\dataCitation\DataCitation;

class DataCitationForm extends Form
{
    /** @var Submission */
    public $_submission = null;

    /** @var Publication */
    public $_publication = null;

    /** @var DataCitation current dataCitation */
    public $_dataCitation = null;

    public bool $_isEditable = true;

    /**
     * Constructor.
     *
     * @param Request $request
     * @param Submission $submission
     * @param Publication $publication
     * @param DataCitation $dataCitation (optional)
     * @param bool $isEditable (optional, default = true)
     */
    public function __construct($request, $submission, $publication, $dataCitation = null, bool $isEditable = true)
    {
        parent::__construct('controllers/grid/dataCitations/form/dataCitationForm.tpl');
        $this->_submission = $submission;
        $this->_publication = $publication;
        $this->_dataCitation = $dataCitation;
        $this->_isEditable = $isEditable;

        $this->addCheck(new \PKP\form\validation\FormValidator($this, 'title', 'required', 'editor.issues.dataCitationTitleRequired'));
        $this->addCheck(new \PKP\form\validation\FormValidator($this, 'persistentIdentifier', 'required', 'editor.issues.dataCitationPersistentIdentifierRequired'));
        $this->addCheck(new \PKP\form\validation\FormValidatorPost($this));
        $this->addCheck(new \PKP\form\validation\FormValidatorCSRF($this));

    }

    /**
     * @copydoc Form::fetch()
     *
     * @param null|mixed $template
     */
    public function fetch($request, $template = null, $display = false)
    {
        $templateMgr = TemplateManager::getManager($request);

        if ($this->_dataCitation) {
            $templateMgr->assign([
                'dataCitationId' => $this->_dataCitation->id,
                'dataCitation' => $this->_dataCitation,
            ]);
        }

        $templateMgr->assign([
            'submissionId' => $this->_submission->getId(),
            'publicationId' => $this->_publication->getId(),
            'formDisabled' => !$this->_isEditable
        ]);

        return parent::fetch($request, $template, $display);
    }

    /**
     * @copydoc Form::validate
     */
    public function validate($callHooks = true)
    {

        if (!$this->_isEditable) {
            $this->addError('', __('dataCitation.cantEditPublished'));
        }

        return parent::validate($callHooks);
    }

    /**
     * Initialize form data from current dataCitation (if applicable).
     */
    public function initData()
    {
        if ($this->_dataCitation) {
            $this->_data = [
                'title' => $this->_dataCitation->title,
                'persistentIdentifier' => $this->_dataCitation->persistentIdentifier
            ];
        } else {
            $this->_data = [];
        }
    }

    /**
     * Assign form data to user-submitted data.
     */
    public function readInputData()
    {
        $this->readUserVars(
            [
                'title',
                'persistentIdentifier'
            ]
        );
    }
    
    /**
     * Save changes to the dataCitation.
     *
     * @return DataCitation The resulting Data Citation.
     */
    public function execute(...$functionArgs)
    {

        if ($this->_dataCitation) {
            $dataCitation = DataCitation::find($this->_dataCitation->id);
        } else {
            $dataCitation = new DataCitation;
        }
    
        $dataCitation->publicationId = $this->_publication->getId();
        $dataCitation->title = $this->getData('title');
        $dataCitation->persistentIdentifier = $this->getData('persistentIdentifier');
        $dataCitation->save();

        parent::execute(...$functionArgs);
    
        return $dataCitation;
    }    

}
