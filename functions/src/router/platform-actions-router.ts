import { PlatformActionRequest, PlatformActionResponse } from '../common/platform-actions/interfaces';
import { CreateIssueAction } from '../actions/issues/create-issue';
import { UpdateIssueAction } from '../actions/issues/update-issue';
import { DeleteIssueAction } from '../actions/issues/delete-issue';
import { ReparentIssueAction } from '../actions/issues/reparent-issue';
import { DuplicateIssueAction } from '../actions/issues/duplicate-issue';
import { CreateProjectAction } from '../actions/projects/create-project';
import { UpdateProjectAction } from '../actions/projects/update-project';
import { DeleteProjectAction } from '../actions/projects/delete-project';
import { CreateWorkspaceAction } from '../actions/workspaces/create-workspace';
import { InviteMemberAction } from '../actions/workspaces/invite-member';
import { UpdateWorkspaceAction } from '../actions/workspaces/update-workspace';
import { GetAgentBudgetAction } from '../actions/workspaces/get-agent-budget';
import { CreateApiKeyAction } from '../actions/apikeys/create-api-key';
import { RevokeApiKeyAction } from '../actions/apikeys/revoke-api-key';
import { ListApiKeysAction } from '../actions/apikeys/list-api-keys';
import { CreateAgentAction } from '../actions/agents/create-agent';
import { UpdateAgentAction } from '../actions/agents/update-agent';
import { ListAgentsAction } from '../actions/agents/list-agents';
import { ConnectRepoAction } from '../actions/agents/connect-repo';
import { DisconnectRepoAction } from '../actions/agents/disconnect-repo';
import { GetQaCalibrationAction } from '../actions/agents/get-qa-calibration';
import { CreateCommentAction } from '../actions/comments/create-comment';
import { ClaimIssueAction } from '../actions/issues/claim-issue';
import { ClaimNextIssueAction } from '../actions/issues/claim-next-issue';
import { ReleaseIssueAction } from '../actions/issues/release-issue';
import { RequestRepoWorkAction } from '../actions/issues/request-repo-work';
import { ReportPendingWorkAction } from '../actions/issues/report-pending-work';
import { AssignExecutionAgentAction } from '../actions/issues/assign-execution-agent';
import { CreateInstallUrlAction } from '../actions/github/create-install-url';
import { GithubStatusAction } from '../actions/github/github-status';
import { CreateBranchAction } from '../actions/github/create-branch';
import { LinkPrAction } from '../actions/github/link-pr';
import { SyncFromWebhookAction } from '../actions/github/sync-from-webhook';
import { CreateEnvironmentAction } from '../actions/environments/create-environment';
import { ListEnvironmentsAction } from '../actions/environments/list-environments';
import { UpdateEnvironmentAction } from '../actions/environments/update-environment';
import { VerifyEnvironmentAction } from '../actions/environments/verify-environment';
import { DisconnectEnvironmentAction } from '../actions/environments/disconnect-environment';
import { ConnectEnvironmentRepoAction } from '../actions/environments/connect-repo';
import { CancelDeploymentAction } from '../actions/deployments/cancel-deployment';
import { SalesforceQueryAction } from '../actions/salesforce/query';
import { SalesforceToolingQueryAction } from '../actions/salesforce/tooling-query';
import { SalesforceDescribeAction } from '../actions/salesforce/describe';
import { SalesforceLimitsAction } from '../actions/salesforce/limits';
import { CreateLabelAction } from '../actions/labels/create-label';
import { CreateCycleAction } from '../actions/cycles/create-cycle';
import { UpdateCycleAction } from '../actions/cycles/update-cycle';
import { CloseCycleAction } from '../actions/cycles/close-cycle';
import { UpdateCycleSettingsAction } from '../actions/cycles/update-cycle-settings';
import { MarkNotificationReadAction } from '../actions/notifications/mark-read';
import { MarkAllNotificationsReadAction } from '../actions/notifications/mark-all-read';
import { MuteIssueAction } from '../actions/notifications/mute-issue';
import { SnoozeNotificationAction } from '../actions/notifications/snooze-notification';
import { UpdateNotificationPreferencesAction } from '../actions/notifications/update-preferences';
import { ReviewsStartAction } from '../actions/reviews/start-review';
import { ReviewsSubmitAction } from '../actions/reviews/submit-review';
import { ReviewsOverrideAction } from '../actions/reviews/override-review';
import { ResolveFindingAction } from '../actions/reviews/resolve-finding';
import { ReportCriteriaAction } from '../actions/reviews/report-criteria';
import { DismissFindingAction } from '../actions/reviews/dismiss-finding';
import { ReviewsRerunAction } from '../actions/reviews/rerun-review';
import { ReturnToAgentAction } from '../actions/reviews/return-to-agent';
import { RegisterRunnerAction } from '../actions/runners/register-runner';
import { IssueRunnerJobAction } from '../actions/runners/issue-runner-job';

export async function dispatchPlatformAction(
  request: PlatformActionRequest,
  callerUid?: string,
  callerEmail?: string
): Promise<PlatformActionResponse> {
  if (!request || !request.actionCode) {
    return {
      success: false,
      error: 'Solicitud inválida: "actionCode" es obligatorio.',
    };
  }

  switch (request.actionCode) {
    case 'issues.create':
      return new CreateIssueAction(request, callerUid, callerEmail).run();
    case 'issues.update':
      return new UpdateIssueAction(request, callerUid, callerEmail).run();
    case 'issues.delete':
      return new DeleteIssueAction(request, callerUid, callerEmail).run();
    case 'issues.reparent':
      return new ReparentIssueAction(request, callerUid, callerEmail).run();
    case 'issues.duplicate':
      return new DuplicateIssueAction(request, callerUid, callerEmail).run();

    case 'projects.create':
      return new CreateProjectAction(request, callerUid, callerEmail).run();
    case 'projects.update':
      return new UpdateProjectAction(request, callerUid, callerEmail).run();
    case 'projects.delete':
      return new DeleteProjectAction(request, callerUid, callerEmail).run();

    case 'workspaces.create':
      return new CreateWorkspaceAction(request, callerUid, callerEmail).run();
    case 'workspaces.inviteMember':
      return new InviteMemberAction(request, callerUid, callerEmail).run();
    case 'workspaces.update':
      return new UpdateWorkspaceAction(request, callerUid, callerEmail).run();
    case 'workspaces.getAgentBudget':
      return new GetAgentBudgetAction(request, callerUid, callerEmail).run();

    case 'apikeys.create':
      return new CreateApiKeyAction(request, callerUid, callerEmail).run();
    case 'apikeys.revoke':
      return new RevokeApiKeyAction(request, callerUid, callerEmail).run();
    case 'apikeys.list':
      return new ListApiKeysAction(request, callerUid, callerEmail).run();

    case 'agents.create':
      return new CreateAgentAction(request, callerUid, callerEmail).run();
    case 'agents.update':
      return new UpdateAgentAction(request, callerUid, callerEmail).run();
    case 'agents.list':
      return new ListAgentsAction(request, callerUid, callerEmail).run();
    case 'agents.connectRepo':
      return new ConnectRepoAction(request, callerUid, callerEmail).run();
    case 'agents.disconnectRepo':
      return new DisconnectRepoAction(request, callerUid, callerEmail).run();
    case 'agents.getQaCalibration':
      return new GetQaCalibrationAction(request, callerUid, callerEmail).run();
    case 'runners.register':
      return new RegisterRunnerAction(request, callerUid, callerEmail).run();
    case 'runners.issueJob':
      return new IssueRunnerJobAction(request, callerUid, callerEmail).run();
    case 'comments.create':
      return new CreateCommentAction(request, callerUid, callerEmail).run();
    case 'issues.claim':
      return new ClaimIssueAction(request, callerUid, callerEmail).run();
    case 'issues.claimNext':
      return new ClaimNextIssueAction(request, callerUid, callerEmail).run();
    case 'issues.release':
      return new ReleaseIssueAction(request, callerUid, callerEmail).run();
    case 'issues.requestRepoWork':
      return new RequestRepoWorkAction(request, callerUid, callerEmail).run();
    case 'issues.reportPendingWork':
      return new ReportPendingWorkAction(request, callerUid, callerEmail).run();
    case 'issues.assignExecutionAgent':
      return new AssignExecutionAgentAction(request, callerUid, callerEmail).run();

    case 'github.createInstallUrl':
      return new CreateInstallUrlAction(request, callerUid, callerEmail).run();
    case 'github.status':
      return new GithubStatusAction(request, callerUid, callerEmail).run();
    case 'github.createBranch':
      return new CreateBranchAction(request, callerUid, callerEmail).run();
    case 'github.linkPr':
      return new LinkPrAction(request, callerUid, callerEmail).run();
    case 'github.syncFromWebhook':
      return new SyncFromWebhookAction(request, callerUid, callerEmail).run();

    case 'environments.create':
      return new CreateEnvironmentAction(request, callerUid, callerEmail).run();
    case 'environments.list':
      return new ListEnvironmentsAction(request, callerUid, callerEmail).run();
    case 'environments.update':
      return new UpdateEnvironmentAction(request, callerUid, callerEmail).run();
    case 'environments.verify':
      return new VerifyEnvironmentAction(request, callerUid, callerEmail).run();
    case 'environments.disconnect':
      return new DisconnectEnvironmentAction(request, callerUid, callerEmail).run();

    case 'environments.connectRepo':
      return new ConnectEnvironmentRepoAction(request, callerUid, callerEmail).run();
    // `deployments.start`/`deployments.report` no están acá a propósito: sólo
    // las llama el workflow por el MCP con una key `deploy:write`.
    case 'deployments.cancel':
      return new CancelDeploymentAction(request, callerUid, callerEmail).run();

    case 'salesforce.query':
      return new SalesforceQueryAction(request, callerUid, callerEmail).run();
    case 'salesforce.toolingQuery':
      return new SalesforceToolingQueryAction(request, callerUid, callerEmail).run();
    case 'salesforce.describe':
      return new SalesforceDescribeAction(request, callerUid, callerEmail).run();
    case 'salesforce.limits':
      return new SalesforceLimitsAction(request, callerUid, callerEmail).run();

    case 'labels.create':
      return new CreateLabelAction(request, callerUid, callerEmail).run();

    case 'cycles.create':
      return new CreateCycleAction(request, callerUid, callerEmail).run();
    case 'cycles.update':
      return new UpdateCycleAction(request, callerUid, callerEmail).run();
    case 'cycles.close':
      return new CloseCycleAction(request, callerUid, callerEmail).run();
    case 'cycles.updateSettings':
      return new UpdateCycleSettingsAction(request, callerUid, callerEmail).run();

    case 'notifications.markRead':
      return new MarkNotificationReadAction(request, callerUid, callerEmail).run();
    case 'notifications.markAllRead':
      return new MarkAllNotificationsReadAction(request, callerUid, callerEmail).run();
    case 'notifications.muteIssue':
      return new MuteIssueAction(request, callerUid, callerEmail).run();
    case 'notifications.snooze':
      return new SnoozeNotificationAction(request, callerUid, callerEmail).run();
    case 'notifications.updatePreferences':
      return new UpdateNotificationPreferencesAction(request, callerUid, callerEmail).run();

    case 'reviews.start':
      return new ReviewsStartAction(request, callerUid, callerEmail).run();
    case 'reviews.submit':
      return new ReviewsSubmitAction(request, callerUid, callerEmail).run();
    case 'reviews.override':
      return new ReviewsOverrideAction(request, callerUid, callerEmail).run();
    case 'reviews.resolveFinding':
      return new ResolveFindingAction(request, callerUid, callerEmail).run();
    case 'reviews.reportCriteria':
      return new ReportCriteriaAction(request, callerUid, callerEmail).run();
    case 'reviews.dismissFinding':
      return new DismissFindingAction(request, callerUid, callerEmail).run();
    case 'reviews.rerun':
      return new ReviewsRerunAction(request, callerUid, callerEmail).run();
    case 'reviews.returnToAgent':
      return new ReturnToAgentAction(request, callerUid, callerEmail).run();

    default:
      return {
        success: false,
        error: `Código de acción de plataforma desconocido: '${request.actionCode}'`,
      };
  }
}
