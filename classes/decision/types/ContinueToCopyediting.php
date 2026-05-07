<?php

/**
 * @file classes/decision/types/ContinueToCopyediting.php
 *
 * Copyright (c) 2014-2025 Simon Fraser University
 * Copyright (c) 2000-2025 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class ContinueToCopyediting
 *
 * @brief A decision to advance the submission to the copyediting stage while
 *        keeping the active review round open. Reviewers retain visibility of
 *        their pending assignments and can continue to act on them.
 */

namespace PKP\decision\types;

use APP\decision\Decision;
use APP\facades\Repo;
use APP\submission\Submission;
use PKP\context\Context;
use PKP\decision\DecisionType;
use PKP\decision\Steps;
use PKP\decision\steps\PromoteFiles;
use PKP\decision\types\traits\InExternalReviewRound;
use PKP\submission\reviewRound\ReviewRound;
use PKP\submissionFile\SubmissionFile;
use PKP\user\User;

class ContinueToCopyediting extends DecisionType
{
    use InExternalReviewRound;

    public function getDecision(): int
    {
        return Decision::CONTINUE_TO_COPYEDITING;
    }

    public function getNewStageId(Submission $submission, ?int $reviewRoundId): int
    {
        return WORKFLOW_STAGE_ID_EDITING;
    }

    public function getNewStatus(): ?int
    {
        return null;
    }

    public function getNewReviewRoundStatus(): ?int
    {
        // Returning null causes the parent runAdditionalActions to recalculate
        // the round status from review-assignment state, leaving the round in
        // a non-terminal status (PENDING_REVIEWS / REVIEWS_READY / etc.).
        return null;
    }

    public function getLabel(?string $locale = null): string
    {
        return __('editor.submission.decision.continueToCopyediting', [], $locale);
    }

    public function getDescription(?string $locale = null): string
    {
        return __('editor.submission.decision.continueToCopyediting.description', [], $locale);
    }

    public function getLog(): string
    {
        return 'editor.submission.decision.continueToCopyediting.log';
    }

    public function getCompletedLabel(): string
    {
        return __('editor.submission.decision.continueToCopyediting.completed');
    }

    public function getCompletedMessage(Submission $submission): string
    {
        return __('editor.submission.decision.continueToCopyediting.completedDescription', [
            'title' => $submission?->getCurrentPublication()?->getLocalizedFullTitle(null, 'html') ?? '',
        ]);
    }

    public function getSteps(Submission $submission, Context $context, User $editor, ?ReviewRound $reviewRound): Steps
    {
        $steps = new Steps($this, $submission, $context, $reviewRound);

        $steps->addStep((new PromoteFiles(
            'promoteFilesToCopyediting',
            __('editor.submission.selectFiles'),
            __('editor.submission.decision.promoteFiles.copyediting'),
            SubmissionFile::SUBMISSION_FILE_FINAL,
            $submission,
            $this->getFileGenres($context->getId())
        ))->addFileList(
            __('editor.submission.revisions'),
            Repo::submissionFile()
                ->getCollector()
                ->filterBySubmissionIds([$submission->getId()])
                ->filterByFileStages([SubmissionFile::SUBMISSION_FILE_REVIEW_REVISION])
                ->filterByReviewRoundIds([$reviewRound->getId()])
        ));

        return $steps;
    }
}
