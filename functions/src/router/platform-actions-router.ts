import { PlatformActionRequest, PlatformActionResponse } from '../common/platform-actions/interfaces';
import { CreateIssueAction } from '../actions/issues/create-issue';
import { UpdateIssueAction } from '../actions/issues/update-issue';
import { DeleteIssueAction } from '../actions/issues/delete-issue';
import { CreateProjectAction } from '../actions/projects/create-project';
import { UpdateProjectAction } from '../actions/projects/update-project';
import { DeleteProjectAction } from '../actions/projects/delete-project';
import { CreateWorkspaceAction } from '../actions/workspaces/create-workspace';
import { InviteMemberAction } from '../actions/workspaces/invite-member';

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

    default:
      return {
        success: false,
        error: `Código de acción de plataforma desconocido: '${request.actionCode}'`,
      };
  }
}
