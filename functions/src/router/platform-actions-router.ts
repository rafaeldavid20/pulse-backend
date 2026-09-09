import { PlatformActionRequest, PlatformActionResponse } from '../common/platform-actions/interfaces';
import { CreateIssueAction } from '../actions/issues/create-issue';
import { UpdateIssueAction } from '../actions/issues/update-issue';
import { DeleteIssueAction } from '../actions/issues/delete-issue';
import { ReparentIssueAction } from '../actions/issues/reparent-issue';
import { CreateProjectAction } from '../actions/projects/create-project';
import { UpdateProjectAction } from '../actions/projects/update-project';
import { DeleteProjectAction } from '../actions/projects/delete-project';
import { CreateWorkspaceAction } from '../actions/workspaces/create-workspace';
import { InviteMemberAction } from '../actions/workspaces/invite-member';
import { CreateApiKeyAction } from '../actions/apikeys/create-api-key';
import { RevokeApiKeyAction } from '../actions/apikeys/revoke-api-key';
import { ListApiKeysAction } from '../actions/apikeys/list-api-keys';
import { CreateAgentAction } from '../actions/agents/create-agent';
import { UpdateAgentAction } from '../actions/agents/update-agent';
import { ListAgentsAction } from '../actions/agents/list-agents';
import { ConnectRepoAction } from '../actions/agents/connect-repo';
import { DisconnectRepoAction } from '../actions/agents/disconnect-repo';
import { CreateCommentAction } from '../actions/comments/create-comment';
import { ClaimIssueAction } from '../actions/issues/claim-issue';
import { ClaimNextIssueAction } from '../actions/issues/claim-next-issue';
import { ReleaseIssueAction } from '../actions/issues/release-issue';
import { CreateInstallUrlAction } from '../actions/github/create-install-url';
import { GithubStatusAction } from '../actions/github/github-status';
import { CreateBranchAction } from '../actions/github/create-branch';
import { LinkPrAction } from '../actions/github/link-pr';
import { SyncFromWebhookAction } from '../actions/github/sync-from-webhook';
import { CreateLabelAction } from '../actions/labels/create-label';

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
    case 'comments.create':
      return new CreateCommentAction(request, callerUid, callerEmail).run();
    case 'issues.claim':
      return new ClaimIssueAction(request, callerUid, callerEmail).run();
    case 'issues.claimNext':
      return new ClaimNextIssueAction(request, callerUid, callerEmail).run();
    case 'issues.release':
      return new ReleaseIssueAction(request, callerUid, callerEmail).run();

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

    case 'labels.create':
      return new CreateLabelAction(request, callerUid, callerEmail).run();

    default:
      return {
        success: false,
        error: `Código de acción de plataforma desconocido: '${request.actionCode}'`,
      };
  }
}
