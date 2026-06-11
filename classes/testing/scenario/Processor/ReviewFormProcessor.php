<?php

/**
 * @file classes/testing/scenario/Processor/ReviewFormProcessor.php
 *
 * Copyright (c) 2026 Simon Fraser University
 * Copyright (c) 2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class ReviewFormProcessor
 *
 * @brief Creates review forms (+ their elements) for one scratch context.
 *
 * Mirrors the manager UI flows in the review-forms settings grid:
 * - ReviewFormForm::execute() — insert with active=0, seq=REALLY_BIG_NUMBER,
 *   then resequenceReviewForms()
 * - ReviewFormElementForm::execute() — insert each element with
 *   seq=REALLY_BIG_NUMBER, included default 1, possibleResponses only for
 *   the multiple-response element types, then resequenceReviewFormElements()
 * - ReviewFormGridHandler::activateReviewForm() — setActive(1) + updateObject()
 *
 * Intentional deviation: the grid actions also create a trivial (toast)
 * notification for the acting manager; like the other scenario processors
 * we skip that UI-session side effect. See
 * docs/e2e/.audit-fragments/reviewforms.md for the parity entry.
 *
 * Invoked from PKPContextScenarioController after SectionProcessor.
 */

namespace PKP\testing\scenario\Processor;

use APP\core\Application;
use PKP\db\DAORegistry;
use PKP\reviewForm\ReviewFormDAO;
use PKP\reviewForm\ReviewFormElement;
use PKP\reviewForm\ReviewFormElementDAO;

class ReviewFormProcessor
{
    /** Spec element-type names => ReviewFormElement type constants. */
    private const ELEMENT_TYPES = [
        'smalltextfield' => ReviewFormElement::REVIEW_FORM_ELEMENT_TYPE_SMALL_TEXT_FIELD,
        'textfield' => ReviewFormElement::REVIEW_FORM_ELEMENT_TYPE_TEXT_FIELD,
        'textarea' => ReviewFormElement::REVIEW_FORM_ELEMENT_TYPE_TEXTAREA,
        'checkboxes' => ReviewFormElement::REVIEW_FORM_ELEMENT_TYPE_CHECKBOXES,
        'radiobuttons' => ReviewFormElement::REVIEW_FORM_ELEMENT_TYPE_RADIO_BUTTONS,
        'dropdown' => ReviewFormElement::REVIEW_FORM_ELEMENT_TYPE_DROP_DOWN_BOX,
        'dropdownbox' => ReviewFormElement::REVIEW_FORM_ELEMENT_TYPE_DROP_DOWN_BOX,
    ];

    /**
     * @param int $contextId       the freshly created scratch context
     * @param array $reviewFormSpecs [{title, description?, elements: [{type, question, required?, options?, includedInReview?}]}]
     * @param string $primaryLocale  locale used when a localized value is given as a plain string
     *
     * @return array one entry per created form, in spec order:
     *               [{id, title (primary-locale string), elementIds: [int]}]
     */
    public function run(int $contextId, array $reviewFormSpecs, string $primaryLocale = 'en'): array
    {
        /** @var ReviewFormDAO $reviewFormDao */
        $reviewFormDao = DAORegistry::getDAO('ReviewFormDAO');
        /** @var ReviewFormElementDAO $reviewFormElementDao */
        $reviewFormElementDao = DAORegistry::getDAO('ReviewFormElementDAO');

        $assocType = Application::getContextAssocType();
        $created = [];

        foreach ($reviewFormSpecs as $formSpec) {
            $title = $this->localized($formSpec['title'], $primaryLocale);

            // ReviewFormForm::execute() — new forms start inactive at the
            // bottom of the list, then get a clean sequence number.
            $reviewForm = $reviewFormDao->newDataObject();
            $reviewForm->setAssocType($assocType);
            $reviewForm->setAssocId($contextId);
            $reviewForm->setActive(0);
            $reviewForm->setSequence(REALLY_BIG_NUMBER);
            $reviewForm->setTitle($title, null);
            $reviewForm->setDescription($this->localized($formSpec['description'] ?? [], $primaryLocale), null);
            $reviewFormId = $reviewFormDao->insertObject($reviewForm);
            $reviewFormDao->resequenceReviewForms($assocType, $contextId);

            $elementIds = [];
            foreach ($formSpec['elements'] ?? [] as $elementSpec) {
                $elementIds[] = $this->addElement($reviewFormElementDao, $reviewFormId, $elementSpec, $primaryLocale);
            }

            // ReviewFormGridHandler::activateReviewForm() — only active
            // forms are selectable when assigning reviewers. Re-fetch by
            // ID first (as the grid action does): the in-memory object
            // still carries the pre-resequence REALLY_BIG_NUMBER sequence,
            // and updateObject() would write it back.
            $reviewForm = $reviewFormDao->getById($reviewFormId, $assocType, $contextId);
            $reviewForm->setActive(1);
            $reviewFormDao->updateObject($reviewForm);

            $created[] = [
                'id' => $reviewFormId,
                'title' => $title[$primaryLocale] ?? reset($title),
                'elementIds' => $elementIds,
            ];
        }

        return $created;
    }

    /**
     * Mirror ReviewFormElementForm::execute() for one new element.
     */
    private function addElement(ReviewFormElementDAO $reviewFormElementDao, int $reviewFormId, array $elementSpec, string $primaryLocale): int
    {
        $typeName = $elementSpec['type'];
        $elementType = self::ELEMENT_TYPES[$typeName]
            ?? throw new \InvalidArgumentException("ReviewFormProcessor: unknown element type '{$typeName}' — expected one of " . implode(', ', array_keys(self::ELEMENT_TYPES)));

        $element = $reviewFormElementDao->newDataObject();
        $element->setReviewFormId($reviewFormId);
        $element->setSequence(REALLY_BIG_NUMBER);
        $element->setQuestion($this->localized($elementSpec['question'], $primaryLocale), null);
        $element->setRequired(!empty($elementSpec['required']) ? 1 : 0);
        // The UI element form defaults "included in message to author" on.
        $element->setIncluded(($elementSpec['includedInReview'] ?? true) ? 1 : 0);
        $element->setElementType($elementType);

        if (in_array($elementType, $element->getMultipleResponsesElementTypes())) {
            if (empty($elementSpec['options'])) {
                throw new \InvalidArgumentException("ReviewFormProcessor: element type '{$typeName}' requires non-empty options[]");
            }
            $element->setPossibleResponses($this->localizedOptions($elementSpec['options'], $primaryLocale), null);
        } else {
            // Free-text types never carry possibleResponses (the UI form
            // clears them) — ignore options if a spec passes them.
            $element->setPossibleResponses(null, null);
        }

        $elementId = $reviewFormElementDao->insertObject($element);
        $reviewFormElementDao->resequenceReviewFormElements($reviewFormId);

        return $elementId;
    }

    /**
     * Normalise a spec value that may be a plain string (primary locale)
     * or a locale => string map.
     *
     * @return array<string,string>
     */
    private function localized(string|array $value, string $primaryLocale): array
    {
        return is_array($value) ? $value : [$primaryLocale => $value];
    }

    /**
     * Build the per-locale possibleResponses arrays the element form's
     * listbuilder produces: locale => [option, option, …] in spec order.
     *
     * @param array $options list of localized strings
     *
     * @return array<string,array<int,string>>
     */
    private function localizedOptions(array $options, string $primaryLocale): array
    {
        $byLocale = [];
        foreach ($options as $option) {
            foreach ($this->localized($option, $primaryLocale) as $locale => $label) {
                $byLocale[$locale][] = $label;
            }
        }
        return $byLocale;
    }
}
