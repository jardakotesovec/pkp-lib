<?php

/**
 * @file api/v1/peerReviews/resources/SubmissionPeerReviewSummaryResource.php
 *
 * Copyright (c) 2025 Simon Fraser University
 * Copyright (c) 2025 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING
 *
 * @class SubmissionPeerReviewSummaryResource
 *
 * @ingroup api_v1_peerReviews
 *
 * @brief Resource that maps a submission to a summary of its peer reviews
 */

namespace PKP\API\v1\peerReviews\resources;

use APP\facades\Repo;
use APP\submission\Submission;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;
use Illuminate\Support\Collection;
use Illuminate\Support\Enumerable;
use PKP\context\Context;
use PKP\submission\reviewAssignment\ReviewAssignment;
use PKP\submission\reviewRound\PublicReviewStatusData;
use PKP\submission\reviewRound\ReviewRound;

class SubmissionPeerReviewSummaryResource extends JsonResource
{
    use ReviewerRecommendationSummary;

    /** @var Collection<int, ReviewRound>|null Public review rounds precomputed by a caller, see withPrecomputed() */
    private ?Collection $precomputedPublicReviewRounds = null;

    /** @var Collection<int, ReviewAssignment>|null Review assignments precomputed by a caller, see withPrecomputed() */
    private ?Collection $precomputedReviewAssignments = null;

    /** @var Context|null Context precomputed by a caller, see withPrecomputed() */
    private ?Context $precomputedContext = null;

    /**
     * Reuse data a SubmissionPeerReviewResource already computed for the same
     * submission (e.g. when both resources are rendered within one page view),
     * avoiding duplicate fetches. All values must belong to the same submission
     * this resource wraps; when not called, the resource fetches everything itself.
     *
     * @param Collection<int, ReviewRound> $publicReviewRounds Public review rounds keyed by review round id
     * @param Collection<int, ReviewAssignment> $reviewAssignments Accepted, publicly visible review assignments of those rounds
     * @param Context $context The submission's context
     * @param ?Enumerable $availableReviewerRecommendations The context's reviewer recommendations keyed by recommendation id
     */
    public function withPrecomputed(
        Collection $publicReviewRounds,
        Collection $reviewAssignments,
        Context $context,
        ?Enumerable $availableReviewerRecommendations = null
    ): static {
        $this->precomputedPublicReviewRounds = $publicReviewRounds;
        $this->precomputedReviewAssignments = $reviewAssignments;
        $this->precomputedContext = $context;
        $this->availableReviewerRecommendations = $availableReviewerRecommendations;

        return $this;
    }

    public function toArray(Request $request)
    {
        /** @var Submission $submission */
        $submission = $this->resource;

        // Summarize only what the full peer review record exposes: reviews from
        // rounds whose reviewed publication version is published
        $publicReviewRounds = $this->precomputedPublicReviewRounds ?? $this->getPublicReviewRounds($submission);
        $roundIds = $publicReviewRounds->keys()->all();

        $reviewAssignments = $this->precomputedReviewAssignments
            ?? (empty($roundIds) ? collect() : Repo::reviewAssignment()->getCollector()
                ->filterByReviewRoundIds($roundIds)
                ->filterByIsPubliclyVisible(true)
                ->filterByIsAccepted(true)
                ->getMany()
                ->collect());

        /** @var Context $context */
        $context = $this->precomputedContext ?? $this->getContextById((int) $submission->getData('contextId'));

        return [
            'submissionId' => $submission->getId(),
            'reviewerRecommendations' => $this->getReviewerRecommendationsSummary($reviewAssignments, $context),
            'submissionPublishedVersionsCount' => count($submission->getPublishedPublications()),
            'reviewerCount' => $this->getReviewerCount($reviewAssignments),
            'submissionCurrentVersion' => $this->getSubmissionLatestPublishedPublication($submission),
            'reviewStatus' => $this->getReviewStatus($reviewAssignments, $publicReviewRounds),
        ];
    }

    /**
     * Gets aggregated review round status for submission as a whole.
     *
     * @param Collection<ReviewAssignment> $reviewAssignments
     * @param Collection<int, ReviewRound> $reviewRounds Review rounds keyed by review round ID
     *
     * @return array{dateStarted: ?string, dateInProgress: ?string, dateCompleted: ?string}
     */
    private function getReviewStatus(Enumerable $reviewAssignments, Collection $reviewRounds): array
    {
        $roundsStatusData = $this->getReviewRoundsStatusData($reviewAssignments, $reviewRounds->all());
        return PublicReviewStatusData::fromRoundsData(collect($roundsStatusData))->toArray();
    }
}
