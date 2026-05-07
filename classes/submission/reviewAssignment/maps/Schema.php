<?php
/**
 * @file classes/reviewAssignment/maps/Schema.php
 *
 * Copyright (c) 2014-2024 Simon Fraser University
 * Copyright (c) 2000-2024 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class Schema
 *
 * @brief Map review assignments to the properties defined in the review assignment schema
 */

namespace PKP\submission\reviewAssignment\maps;

use APP\facades\Repo;
use APP\submission\Submission;
use Illuminate\Support\Enumerable;
use Illuminate\Support\Facades\DB;
use PKP\services\PKPSchemaService;
use PKP\submission\reviewAssignment\ReviewAssignment;

class Schema extends \PKP\core\maps\Schema
{
    public Enumerable $collection;

    public string $schema = PKPSchemaService::SCHEMA_REVIEW_ASSIGNMENT;

    /**
     * Cache of review_round_id => status for the current mapMany / summarizeMany batch,
     * populated up-front to avoid N+1 lookups when rendering reviewer dashboards.
     */
    protected array $reviewRoundStatuses = [];

    /**
     * Map the Review Assignment
     *
     * Includes all properties in the review assignment schema.
     */
    public function map(ReviewAssignment $item, Submission $submission): array
    {
        return $this->mapByProperties($this->getProps(), $item, $submission);
    }

    /**
     * Summarize the Review Assignment
     *
     * Includes properties with the apiSummary flag in the review assignment schema.
     */
    public function summarize(ReviewAssignment $item, Submission $submission): array
    {
        return $this->mapByProperties($this->getSummaryProps(), $item, $submission);
    }

    /**
     * Map a collection of Review Assignments
     *
     * @see self::map
     */
    public function mapMany(Enumerable $collection): Enumerable
    {
        $this->collection = $collection;
        $submissions = Repo::submission()->getCollector()
            ->filterByContextIds([$this->context->getId()])
            ->filterByReviewIds($collection->keys()->toArray())
            ->getMany()
            ->remember();

        $associatedSubmissions = $this->collection->map(
            fn (ReviewAssignment $reviewAssignment) =>
            $reviewAssignment->getData('submissionId')
        );

        $this->loadReviewRoundStatuses($collection);

        return $collection->map(
            fn ($item) =>
            $this->map($item, $submissions->get($associatedSubmissions->get($item->getId())))
        );
    }

    /**
     * Summarize a collection of Review Assignments
     *
     * @see self::summarize
     */
    public function summarizeMany(Enumerable $collection): Enumerable
    {
        $this->collection = $collection;
        $submissions = Repo::submission()->getCollector()
            ->filterByContextIds([$this->context->getId()])
            ->filterByReviewIds($collection->keys()->toArray())
            ->getMany()
            ->remember();

        $associatedSubmissions = $this->collection->map(
            fn (ReviewAssignment $reviewAssignment) =>
                $reviewAssignment->getData('submissionId')
        );

        $this->loadReviewRoundStatuses($collection);

        return $collection->map(
            fn ($item) =>
            $this->summarize($item, $submissions->get($associatedSubmissions->get($item->getId())))
        );
    }

    /**
     * Resolve the review round status for a single assignment, preferring the
     * pre-loaded batch cache and falling back to a direct lookup for one-off map() calls.
     */
    protected function getReviewRoundStatus(ReviewAssignment $item): ?int
    {
        $reviewRoundId = $item->getData('reviewRoundId');
        if (!$reviewRoundId) {
            return null;
        }

        if (array_key_exists($reviewRoundId, $this->reviewRoundStatuses)) {
            return $this->reviewRoundStatuses[$reviewRoundId];
        }

        $status = DB::table('review_rounds')
            ->where('review_round_id', $reviewRoundId)
            ->value('status');

        return $status !== null ? (int) $status : null;
    }

    /**
     * Populate $this->reviewRoundStatuses with one row per distinct review_round_id
     * referenced by the assignments being mapped, so that mapByProperties can read
     * the status without issuing a query per row.
     */
    protected function loadReviewRoundStatuses(Enumerable $collection): void
    {
        $reviewRoundIds = $collection
            ->map(fn (ReviewAssignment $ra) => $ra->getData('reviewRoundId'))
            ->filter()
            ->unique()
            ->values()
            ->toArray();

        if (empty($reviewRoundIds)) {
            $this->reviewRoundStatuses = [];
            return;
        }

        $this->reviewRoundStatuses = DB::table('review_rounds')
            ->whereIn('review_round_id', $reviewRoundIds)
            ->pluck('status', 'review_round_id')
            ->map(fn ($status) => (int) $status)
            ->toArray();
    }

    /**
     * Map schema properties of the Review Assignment to an assoc array
     */
    protected function mapByProperties(array $props, ReviewAssignment $item, Submission $submission): array
    {
        $output = [];
        foreach ($props as $prop) {
            switch ($prop) {
                case 'submissionLocale':
                    $output[$prop] = $submission->getData('locale');
                    break;
                case 'submissionStageId':
                    $output[$prop] = $submission->getData('stageId');
                    break;
                case 'reviewRoundStatus':
                    $output[$prop] = $this->getReviewRoundStatus($item);
                    break;
                case 'publicationTitle':
                    $output[$prop] = $submission->getCurrentPublication()->getFullTitles('html');
                    break;
                case 'status':
                    $output[$prop] = $item->getStatus();
                    break;
                case '_href':
                    $output[$prop] = $this->getApiUrl('_submissions/reviewAssignments/' . $item->getId());
                    break;
                default:
                    $output[$prop] = $item->getData($prop);
                    break;
            }
        }

        $output = $this->schemaService->addMissingMultilingualValues($this->schema, $output, $this->context->getSupportedFormLocales());

        ksort($output);

        return $this->withExtensions($output, $item);
    }
}
