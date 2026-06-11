<?php

/**
 * @file classes/testing/scenario/Processor/UserCommentProcessor.php
 *
 * Copyright (c) 2026 Simon Fraser University
 * Copyright (c) 2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class UserCommentProcessor
 *
 * @brief Seeds public reader comments on the scenario submission's
 *        current (published) publication from the spec's top-level
 *        `userComments` array.
 *
 * Mirrors the UserComment REST controller's create path
 * (lib/pkp/api/v1/comments/UserCommentController.php::submit, lines
 * 269-296): UserComment::query()->create() with isApproved=false plus a
 * LEVEL_TASK notification per moderator (site admins + managers in the
 * context). When the spec marks a comment approved (the default), the
 * moderation flow's setApproval path (same controller, lines 334-364) is
 * applied on top: isApproved=true, approvedAt=now, approvedByUserId.
 * Comment reports are deliberately out of scope.
 *
 * Runs after PublicationsProcessor because commenting requires a
 * published current publication — the reader-facing comment form only
 * exists on a published article page, and the REST create path rejects
 * any publication that isn't the submission's current version
 * (AddComment::after(), lib/pkp/api/v1/comments/formRequests/AddComment.php).
 */

namespace PKP\testing\scenario\Processor;

use APP\facades\Repo;
use APP\notification\NotificationManager;
use APP\core\Application;
use PKP\core\PKPString;
use PKP\notification\Notification;
use PKP\security\Role;
use PKP\submission\PKPSubmission;
use PKP\testing\scenario\ScenarioContext;
use PKP\testing\scenario\ScenarioProcessor;
use PKP\userComment\UserComment;

class UserCommentProcessor implements ScenarioProcessor
{
    public function appliesTo(array $spec): bool
    {
        return !empty($spec['userComments']);
    }

    public function run(array $spec, ScenarioContext $ctx): array
    {
        $submission = Repo::submission()->get($ctx->submissionId());
        $publication = $submission->getCurrentPublication();
        $contextId = $ctx->submissionContextId();

        if ((int)$publication->getData('status') !== PKPSubmission::STATUS_PUBLISHED) {
            throw new \RuntimeException(
                'userComments requires the submission\'s current publication to be published. '
                . 'Add `published: true` to the (last) publications[] entry of the spec.'
            );
        }

        foreach ($spec['userComments'] as $commentSpec) {
            $this->createComment($commentSpec, (int)$publication->getId(), $contextId, $ctx);
        }

        return [];
    }

    /**
     * Write one user_comments row the way UserCommentController::submit
     * does — created unapproved, moderators notified — then, when the spec
     * says approved (default true), apply the moderation flow's approval
     * mutation on top.
     */
    private function createComment(array $commentSpec, int $publicationId, int $contextId, ScenarioContext $ctx): void
    {
        $user = $ctx->userByUsername($commentSpec['user']);

        // UserCommentController::submit (lines 279-287); commentText is
        // sanitized the same way AddComment::validated() does (line 100).
        $comment = UserComment::query()->create([
            'userId' => $user->getId(),
            'contextId' => $contextId,
            'publicationId' => $publicationId,
            'commentText' => PKPString::stripUnsafeHtml($commentSpec['text']),
            'isApproved' => false,
        ]);

        // UserCommentController::notifyModerators (lines 485-509): one
        // LEVEL_TASK NOTIFICATION_TYPE_USER_COMMENT_POSTED row per site
        // admin / manager in the context. Production keeps these rows even
        // after approval (setApproval doesn't remove them), so neither do we.
        $this->notifyModerators((int)$comment->id, $contextId);

        if ($commentSpec['approved'] ?? true) {
            $this->approve($comment);
        }
    }

    /**
     * Mirror UserCommentController::setApproval (lines 357-361). The
     * approving moderator is attributed to the admin user since the
     * Processor runs out-of-session (admin is a valid moderator — the
     * route is gated to site admins and managers); same convention as
     * ReviewRoundProcessor's event-log attribution.
     */
    private function approve(UserComment $comment): void
    {
        $admin = Repo::user()->getByUsername('admin', true);
        $comment->isApproved = true;
        $comment->approvedAt = now();
        $comment->approvedByUserId = $admin?->getId();
        $comment->save();
    }

    /**
     * Mirror UserCommentController::notifyModerators for the
     * comment-posted event.
     */
    private function notifyModerators(int $commentId, int $contextId): void
    {
        $notificationManager = new NotificationManager();

        $moderators = Repo::user()
            ->getCollector()
            ->filterByRoleIds([
                Role::ROLE_ID_SITE_ADMIN,
                Role::ROLE_ID_MANAGER,
            ])
            ->filterByContextIds([$contextId])
            ->getMany();

        foreach ($moderators as $moderator) {
            $notificationManager->createNotification(
                userId: $moderator->getId(),
                notificationType: Notification::NOTIFICATION_TYPE_USER_COMMENT_POSTED,
                contextId: $contextId,
                assocType: Application::ASSOC_TYPE_COMMENT,
                assocId: $commentId,
                level: Notification::NOTIFICATION_LEVEL_TASK
            );
        }
    }
}
