<?php
/**
 * @file pages/dashboard/DashboardHandler.php
 *
 * Copyright (c) 2014-2021 Simon Fraser University
 * Copyright (c) 2003-2021 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class DashboardHandler
 *
 * @ingroup pages_dashboard
 *
 * @brief Handle requests for user's dashboard.
 */

namespace PKP\pages\dashboard;

use APP\core\Application;
use APP\facades\Repo;
use APP\handler\Handler;
use APP\template\TemplateManager;
use PKP\components\forms\dashboard\SubmissionFilters;
use PKP\core\JSONMessage;
use PKP\core\PKPApplication;
use PKP\core\PKPRequest;
use PKP\db\DAORegistry;
use PKP\plugins\Hook;
use PKP\security\authorization\PKPSiteAccessPolicy;
use PKP\security\Role;
use PKP\submission\Collector as SubmissionCollector;
use PKP\submission\GenreDAO;
use PKP\submission\PKPSubmission;

define('SUBMISSIONS_LIST_ACTIVE', 'active');
define('SUBMISSIONS_LIST_ARCHIVE', 'archive');
define('SUBMISSIONS_LIST_MY_QUEUE', 'myQueue');
define('SUBMISSIONS_LIST_UNASSIGNED', 'unassigned');

class DashboardHandler extends Handler
{
    /** @copydoc PKPHandler::_isBackendPage */
    public $_isBackendPage = true;

    public int $perPage = 30;

    /**
     * Constructor
     */
    public function __construct()
    {
        parent::__construct();

        $this->addRoleAssignment(
            [Role::ROLE_ID_SITE_ADMIN, Role::ROLE_ID_MANAGER, Role::ROLE_ID_SUB_EDITOR, Role::ROLE_ID_AUTHOR, Role::ROLE_ID_REVIEWER, Role::ROLE_ID_ASSISTANT],
            ['index', 'tasks', 'myQueue', 'unassigned', 'active', 'archives']
        );
    }

    /**
     * @copydoc PKPHandler::authorize()
     */
    public function authorize($request, &$args, $roleAssignments)
    {
        $this->addPolicy(new PKPSiteAccessPolicy($request, null, $roleAssignments));
        return parent::authorize($request, $args, $roleAssignments);
    }

    /**
     * Display about index page.
     *
     * @param PKPRequest $request
     * @param array $args
     */
    public function index($args, $request)
    {
        $context = $request->getContext();
        $dispatcher = $request->getDispatcher();

        if (!$context) {
            $request->redirect(null, 'user');
        }

        $templateMgr = TemplateManager::getManager($request);
        $this->setupTemplate($request);

        $userRoles = $this->getAuthorizedContextObject(Application::ASSOC_TYPE_USER_ROLES);
        $apiUrl = $dispatcher->url($request, PKPApplication::ROUTE_API, $context->getPath(), '_submissions');

        $sections = Repo::section()
            ->getCollector()
            ->filterByContextIds([$context->getId()])
            ->getMany();

        $categories = Repo::category()
            ->getCollector()
            ->filterByContextIds([$context->getId()])
            ->getMany();

        $filtersForm = new SubmissionFilters(
            $context,
            $userRoles,
            $sections,
            $categories
        );

        $collector = Repo::submission()
            ->getCollector()
            ->filterByContextIds([(int) $request->getContext()->getId()])
            ->filterByStatus([PKPSubmission::STATUS_QUEUED]);

        if (empty(array_intersect([Role::ROLE_ID_MANAGER, Role::ROLE_ID_SITE_ADMIN], $userRoles))) {
            $collector->assignedTo([(int) $request->getUser()->getId()]);
        }

        $userGroups = Repo::userGroup()
            ->getCollector()
            ->filterByContextIds([$context->getId()])
            ->getMany();

        /** @var GenreDAO $genreDao */
        $genreDao = DAORegistry::getDAO('GenreDAO');
        $genres = $genreDao->getByContextId($context->getId())->toArray();

        $templateMgr->setState([
            'apiUrl' => $apiUrl,
            'assignParticipantUrl' => $dispatcher->url(
                $request,
                Application::ROUTE_COMPONENT,
                null,
                'grid.users.stageParticipant.StageParticipantGridHandler',
                'addParticipant',
                null,
                [
                    'submissionId' => '__id__',
                    'stageId' => '__stageId__',
                ]
            ),
            'count' => $this->perPage,
            'currentViewId' => 'active',
            'filtersForm' => $filtersForm->getConfig(),
            'i18nReviewRound' => __('common.reviewRoundNumber'),
            'i18nShowingXofX' => __('common.showingXofX'),
            'submissions' => Repo::submission()
                ->getSchemaMap()
                ->mapManyToSubmissionsList(
                    $collector->limit($this->perPage)->getMany(),
                    $userGroups,
                    $genres
                )
                ->values(),
            'submissionsMax' => $collector->limit(null)->getCount(),
            'views' => $this->getViews(),
        ]);

        $templateMgr->assign([
            'columns' => $this->getColumns(),
            'pageComponent' => 'SubmissionsPage',
            'pageTitle' => __('navigation.submissions'),
            'pageWidth' => TemplateManager::PAGE_WIDTH_FULL,
        ]);

        $templateMgr->setConstants([
            'STAGE_STATUS_SUBMISSION_UNASSIGNED' => Repo::submission()::STAGE_STATUS_SUBMISSION_UNASSIGNED,
        ]);

        $templateMgr->display('dashboard/editors.tpl');
    }

    /**
     * View tasks popup
     *
     * @param array $args
     * @param PKPRequest $request
     *
     * @return JSONMessage JSON object
     */
    public function tasks($args, $request)
    {
        $templateMgr = TemplateManager::getManager($request);
        $this->setupTemplate($request);

        return $templateMgr->fetchJson('dashboard/tasks.tpl');
    }

    /**
     * Get a list of the pre-configured views
     */
    protected function getViews(): array
    {
        $request = Application::get()->getRequest();
        $context = $request->getContext();
        $user = $request->getUser();
        $userRoles = $this->getAuthorizedContextObject(Application::ASSOC_TYPE_USER_ROLES);

        $views = [
            [
                'id' => 'assigned-to-me',
                'name' => 'Assigned to me',
                'count' => Repo::submission()->getCollector()
                    ->filterByContextIds([$context->getId()])
                    ->filterByStatus([PKPSubmission::STATUS_QUEUED])
                    ->assignedTo([$user->getId()])
                    ->getCount(),
                'op' => 'assigned',
                'queryParams' => [
                    'status' => [PKPSubmission::STATUS_QUEUED],
                ]
            ],
            [
                'id' => 'active',
                'name' => 'Active Submissions',
                'count' => Repo::submission()->getCollector()
                    ->filterByContextIds([$context->getId()])
                    ->filterByStatus([PKPSubmission::STATUS_QUEUED])
                    ->getCount(),
                'queryParams' => [
                    'status' => [PKPSubmission::STATUS_QUEUED],
                ]
            ],
            [
                'id' => 'needs-editor',
                'name' => 'Needs editor',
                'count' => Repo::submission()->getCollector()
                    ->filterByContextIds([$context->getId()])
                    ->assignedTo(SubmissionCollector::UNASSIGNED)
                    ->filterByStatus([PKPSubmission::STATUS_QUEUED])
                    ->getCount(),
                'queryParams' => [
                    'assignedTo' => SubmissionCollector::UNASSIGNED,
                    'status' => [PKPSubmission::STATUS_QUEUED],
                ]
            ],
            [
                'id' => 'needs-reviewers',
                'name' => 'Needs reviewers',
                'count' => Repo::submission()->getCollector()
                    ->filterByContextIds([$context->getId()])
                    ->filterByStageIds([WORKFLOW_STAGE_ID_INTERNAL_REVIEW, WORKFLOW_STAGE_ID_EXTERNAL_REVIEW])
                    ->
            ],
            [
                'id' => 'initial-review',
                'name' => 'All in desk/initial review',
                'count' => Repo::submission()->getCollector()
                    ->filterByContextIds([$context->getId()])
                    ->filterByStageIds([WORKFLOW_STAGE_ID_SUBMISSION])
                    ->filterByStatus([PKPSubmission::STATUS_QUEUED])
                    ->getCount(),
                'queryParams' => [
                    'stageIds' => [WORKFLOW_STAGE_ID_SUBMISSION],
                    'status' => [PKPSubmission::STATUS_QUEUED],
                ]
            ],
            [
                'id' => 'external-review',
                'name' => 'All in peer review',
                'count' => Repo::submission()->getCollector()
                    ->filterByContextIds([$context->getId()])
                    ->filterByStageIds([WORKFLOW_STAGE_ID_EXTERNAL_REVIEW])
                    ->filterByStatus([PKPSubmission::STATUS_QUEUED])
                    ->getCount(),
                'queryParams' => [
                    'stageIds' => [WORKFLOW_STAGE_ID_EXTERNAL_REVIEW],
                    'status' => [PKPSubmission::STATUS_QUEUED],
                ]
            ],
            [
                'id' => 'copyediting',
                'name' => 'All in copyediting',
                'count' => Repo::submission()->getCollector()
                    ->filterByContextIds([$context->getId()])
                    ->filterByStageIds([WORKFLOW_STAGE_ID_EDITING])
                    ->filterByStatus([PKPSubmission::STATUS_QUEUED])
                    ->getCount(),
                'queryParams' => [
                    'stageIds' => [WORKFLOW_STAGE_ID_EDITING],
                    'status' => [PKPSubmission::STATUS_QUEUED],
                ]
            ],
            [
                'id' => 'production',
                'name' => 'All in production',
                'count' => Repo::submission()->getCollector()
                    ->filterByContextIds([$context->getId()])
                    ->filterByStageIds([WORKFLOW_STAGE_ID_PRODUCTION])
                    ->filterByStatus([PKPSubmission::STATUS_QUEUED])
                    ->getCount(),
                'queryParams' => [
                    'stageIds' => [WORKFLOW_STAGE_ID_PRODUCTION],
                    'status' => [PKPSubmission::STATUS_QUEUED],
                ]
            ],
            [
                'id' => 'scheduled',
                'name' => 'Scheduled for publication',
                'count' => Repo::submission()->getCollector()
                    ->filterByContextIds([$context->getId()])
                    ->filterByStatus([PKPSubmission::STATUS_SCHEDULED])
                    ->getCount(),
                'queryParams' => [
                    'status' => [PKPSubmission::STATUS_SCHEDULED],
                ]
            ],
            [
                'id' => 'published',
                'name' => 'Published',
                'count' => Repo::submission()->getCollector()
                    ->filterByContextIds([$context->getId()])
                    ->filterByStatus([PKPSubmission::STATUS_PUBLISHED])
                    ->getCount(),
                'queryParams' => [
                    'status' => [PKPSubmission::STATUS_PUBLISHED],
                ]
            ],
            [
                'id' => 'declined',
                'name' => 'Declined',
                'count' => Repo::submission()->getCollector()
                    ->filterByContextIds([$context->getId()])
                    ->filterByStatus([PKPSubmission::STATUS_DECLINED])
                    ->getCount(),
                'queryParams' => [
                    'status' => [PKPSubmission::STATUS_DECLINED],
                ]
            ],
        ];

        Hook::call('Dashboard::views', [&$views, $userRoles]);

        return $views;
    }

    /**
     * Define the columns in the submissions table
     */
    protected function getColumns(): array
    {
        $columns = [
            new Column('id', __('common.id'), 'dashboard/column-id.tpl', true),
            new Column('title', __('navigation.submissions'), 'dashboard/column-title.tpl'),
            new Column('stage', __('workflow.stage'), 'dashboard/column-stage.tpl'),
            new Column('days', __('editor.submission.days'), 'dashboard/column-days.tpl'),
            new Column('activity', __('stats.editorialActivity'), 'dashboard/column-activity.tpl'),
            new Column(
                'actions',
                '<span class="-screenReader">' . __('admin.jobs.list.actions') . '</span>',
                'dashboard/column-actions.tpl'
            ),
        ];

        $userRoles = $this->getAuthorizedContextObject(Application::ASSOC_TYPE_USER_ROLES);

        Hook::call('Dashboard::columns', [&$columns, $userRoles]);

        return $columns;
    }
}
