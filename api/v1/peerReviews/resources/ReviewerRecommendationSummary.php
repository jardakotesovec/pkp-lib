<?php

/**
 * @file api/v1/peerReviews/resources/ReviewerRecommendationSummary.php
 *
 * Copyright (c) 2025 Simon Fraser University
 * Copyright (c) 2025 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING
 *
 * @class ReviewerRecommendationSummary
 *
 * @ingroup api_v1_peerReviews
 *
 * @brief Trait for summarizing reviewer recommendations.
 */

namespace PKP\API\v1\peerReviews\resources;

use APP\core\Application;
use APP\facades\Repo;
use APP\publication\Publication;
use APP\submission\Submission;
use Illuminate\Support\Collection;
use Illuminate\Support\Enumerable;
use PKP\context\Context;
use PKP\db\DAORegistry;
use PKP\submission\reviewAssignment\ReviewAssignment;
use PKP\submission\reviewer\recommendation\ReviewerRecommendation;
use PKP\submission\reviewRound\ReviewRound;
use PKP\submission\reviewRound\ReviewRoundDAO;

trait ReviewerRecommendationSummary
{
    /** @var Enumerable|null Reviewer recommendations of the submission's context, keyed by recommendation id (memoized) */
    private ?Enumerable $availableReviewerRecommendations = null;

    /**
     * Get the context for the given context id, reusing the current request's
     * context when it is the same one to avoid re-fetching it from the database.
     * These resources also serve API routes for other contexts, so the id guard
     * matters: when the ids differ, the context is still fetched by id.
     */
    private function getContextById(int $contextId): Context
    {
        $request = Application::get()->getRequest();
        $requestContext = $request->getRouter() ? $request->getContext() : null;
        if ($requestContext && (int) $requestContext->getId() === $contextId) {
            return $requestContext;
        }

        /** @var Context */
        return Application::getContextDAO()->getById($contextId);
    }

    /**
     * Get the reviewer recommendations configured for the given context, keyed by
     * recommendation id. Memoized: within one resource the same set is needed both
     * for the per-review data and the recommendations summary.
     */
    private function getAvailableReviewerRecommendations(Context $context): Enumerable
    {
        return $this->availableReviewerRecommendations ??= ReviewerRecommendation::withContextId($context->getId())
            ->get()
            ->keyBy('reviewerRecommendationId');
    }

    /**
     * Get the review rounds that are part of the public peer review record.
     * Only rounds whose reviewed publication version is published are included;
     * rounds of an unpublished (in-review) version stay hidden.
     *
     * @return Collection<int, ReviewRound> Review rounds keyed by review round ID
     */
    private function getPublicReviewRounds(Submission $submission): Collection
    {
        /** @var ReviewRoundDAO $reviewRoundDao */
        $reviewRoundDao = DAORegistry::getDAO('ReviewRoundDAO');

        $publishedPublicationIds = collect($submission->getPublishedPublications())
            ->map(fn (Publication $publication) => $publication->getId());

        return collect($reviewRoundDao->getBySubmissionId($submission->getId())->toAssociativeArray())
            ->filter(fn (ReviewRound $reviewRound) => $reviewRound->getPublicationId() !== null
                && $publishedPublicationIds->contains((int) $reviewRound->getPublicationId()));
    }

    /**
     * Aggregates reviewer recommendations into summary counts.
     *  - If a reviewer participates in multiple rounds, only their latest completed review counts
     *  - Incomplete reviews (no completion date) are excluded
     *
     * @param Enumerable $reviewAssignments The Review Assignments to create summary from.
     */
    private function getReviewerRecommendationsSummary(Enumerable $reviewAssignments, Context $context): array
    {
        $reviewAssignmentsGroupedByRoundId = $reviewAssignments
            ->groupBy(fn (ReviewAssignment $ra) => $ra->getReviewRoundId())
            ->map(
                fn ($assignments) => $assignments->filter(fn (ReviewAssignment $ra) => !!$ra->getDateCompleted())
            )
            ->sortKeys();

        return $this->getSummaryCountForReviewerRecommendation($reviewAssignmentsGroupedByRoundId, $context);
    }

    /**
     * Get the summary count for reviews.
     */
    private function getSummaryCountForReviewerRecommendation(Enumerable $reviewAssignmentsGroupedByRoundId, Context $context): array
    {
        $responses = collect();

        $availableRecommendationTypes = $this->getAvailableReviewerRecommendations($context);

        foreach ($reviewAssignmentsGroupedByRoundId as $reviews) {
            /** @var ReviewAssignment $review */
            foreach ($reviews as $review) {
                // For each review in each round, record the reviewer's decision, overriding any decision from previous rounds, keeping their latest recommendation
                $responses->put(
                    $review->getReviewerId(),
                    $availableRecommendationTypes->get($review->getReviewerRecommendationId())->type,
                );
            }
        }

        return $this->buildSummaryCount($responses->countBy(), $availableRecommendationTypes);
    }

    /**
     * Tally review recommendations for each Recommendation type
     */
    private function buildSummaryCount(Enumerable $reviewerResponseCount, $recommendationTypes): array
    {
        $summary = [];
        $recommendationTypes = $recommendationTypes->groupBy('type');
        $recommendationTypeLabels = Repo::reviewerRecommendation()->getRecommendationTypeLabels();

        foreach ($recommendationTypes as $typeId => $recommendation) {
            $summary[] = [
                'recommendationTypeId' => $typeId,
                'recommendationTypeLabel' => $recommendationTypeLabels[$typeId],
                'count' => $reviewerResponseCount->get($typeId, 0),
            ];
        }
        return $summary;
    }

    /**
     * Get count of reviewers who have contributed to reviews.
     *
     * @param Enumerable $reviewAssignments - List of review assignments to generate count from.
     */
    private function getReviewerCount(Enumerable $reviewAssignments)
    {
        $reviewerIds = $reviewAssignments
            ->filter(fn (ReviewAssignment $reviewAssignment) => $reviewAssignment->getDateCompleted() !== null)
            ->map(fn (ReviewAssignment $reviewAssignment) => $reviewAssignment->getReviewerId())
            ->all();

        return count(array_unique($reviewerIds));
    }

    /**
     * Get info for the latest published publication for a submission.
     *
     * @return array{'versionString': string, 'datePublished': string}|null
     * - versionString: The version string of the latest published publication.
     * - datePublished: The publication date as a string.
     */
    private function getSubmissionLatestPublishedPublication(Submission $submission): ?array
    {
        /** @var Publication $latestVersion */
        $latestVersion = collect(array_reverse($submission->getPublishedPublications()))->first();

        return $latestVersion ? [
            'versionString' => $latestVersion->getData('versionString'),
            'datePublished' => $latestVersion->getData('datePublished'),
        ] : null;
    }

    /**
     * Gets array of review round status date info
     *
     * @param Enumerable $reviewAssignments All public assignments, not limited by round
     * @param array $reviewRounds Iterative array keyed by review round ID
     * @return list<array{roundId: int, round: int, status: string, dateStarted: ?string, dateInProgress: ?string, dateCompleted: ?string}>
     */
    private function getReviewRoundsStatusData(Enumerable $reviewAssignments, array $reviewRounds): array
    {
        $assignmentsByRound = $reviewAssignments
            ->groupBy(fn (ReviewAssignment $reviewAssignment) => $reviewAssignment->getReviewRoundId())
            ->sortKeys();

        $roundsData = [];
        /** @var ReviewRound $reviewRound */
        foreach ($reviewRounds as $roundId => $reviewRound) {
            $roundAssignments = $assignmentsByRound->get($roundId, collect());
            $reviewStatusData = $reviewRound->getPublicReviewStatusByAssignments($roundAssignments);

            $roundsData[] = [
                'roundId' => $reviewRound->getId(),
                'round' => $reviewRound->getRound(),
                ...$reviewStatusData->toArray(),
            ];
        }

        return $roundsData;
    }
}
