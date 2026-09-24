import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { deleteRepoSecret, deleteRepoFile } from '../../github/client';
import { WORKFLOW_PATH } from '../../github/templates/pulse-agent-workflow';
import { QA_WORKFLOW_PATH } from '../../github/templates/pulse-qa-workflow';
import { agentVisibility, getWorkspaceMember, isWorkspaceAdmin } from '../../common/utils/agent-authorization';

const DEV_MCP_SECRET_NAME = 'PULSE_AGENT_MCP_KEY';
const QA_MCP_SECRET_NAME = 'PULSE_QA_MCP_KEY';

/**
 * Desconecta un agente de un repo: revoca su key de MCP y borra el secret.
 *
 * El workflow NO se borra por defecto. Es un archivo commiteado en el repo del
 * usuario, con su historial: borrarlo en silencio porque alguien apretó
 * "desconectar" es destructivo y no es lo que esa palabra promete. Se borra solo
 * con `removeWorkflow: true` explícito.
 *
 * Ninguna falla de GitHub aborta la operación a mitad de camino: lo importante
 * es que la key quede revocada del lado de Pulse, que es lo único que Pulse
 * controla del todo. Lo que no se pudo limpiar se informa en la respuesta.
 *
 * D12/TES-208: el secret y el workflow a limpiar dependen de con qué rol se
 * conectó el agente (`PULSE_QA_MCP_KEY`/`pulse-qa.yml` para `'qa'`,
 * `PULSE_AGENT_MCP_KEY`/`pulse-agent.yml` para `'dev'`). Se usa lo guardado en
 * la propia conexión (`connectedRepos[].secretName`/`workflowPath`) y, si no
 * está (conexiones de antes de D12), se deriva del `role` actual del agente.
 */
export class DisconnectRepoAction extends PlatformActionHandler {
  private workspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('agents.disconnectRepo', request, callerUid, callerEmail);
    this.workspaceId = request.data?.workspaceId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.workspaceId) return false;
    return this.isWorkspaceMember(this.workspaceId);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;

    if (!data.workspaceId || !data.agentId || !data.repoFullName) {
      throw new Error('Parámetros requeridos faltantes: workspaceId, agentId, repoFullName.');
    }

    const agentRef = db.collection('agents').doc(data.agentId);
    const agentSnap = await agentRef.get();
    if (!agentSnap.exists || agentSnap.data()!.workspaceId !== data.workspaceId) {
      throw new Error(`El agente '${data.agentId}' no existe en este workspace.`);
    }
    const agent = agentSnap.data()!;
    const caller = await getWorkspaceMember(db, data.workspaceId, this.caller.uid!);
    if (agentVisibility(agent) === 'public' && !isWorkspaceAdmin(caller)) {
      throw new Error('Solo un admin puede desconectar un agente público.');
    }
    if (agentVisibility(agent) === 'personal' && agent.ownerMemberId !== this.caller.uid && !isWorkspaceAdmin(caller)) {
      throw new Error('Solo el dueño o un admin puede desconectar este agente.');
    }

    const connections: any[] = agent.connectedRepos || [];
    const connection = connections.find((c) => c.repoFullName === data.repoFullName);
    if (!connection) {
      throw new Error(`El agente no está conectado a '${data.repoFullName}'.`);
    }
    const isQa = agentSnap.data()!.role === 'qa';
    const secretName: string = connection.secretName || (isQa ? QA_MCP_SECRET_NAME : DEV_MCP_SECRET_NAME);
    const workflowPath: string = connection.workflowPath || (isQa ? QA_WORKFLOW_PATH : WORKFLOW_PATH);

    const warnings: string[] = [];

    // Lo primero y lo único imprescindible: que la credencial deje de servir.
    if (connection.apiKeyId) {
      await db
        .collection('api_keys')
        .doc(connection.apiKeyId)
        .update({ revokedAt: new Date().toISOString() });
    }

    const installSnap = await db
      .collection('github_installations')
      .where('workspaceId', '==', data.workspaceId)
      .limit(1)
      .get();

    if (!installSnap.empty) {
      const installationId = installSnap.docs[0].data().installationId;

      try {
        await deleteRepoSecret(installationId, data.repoFullName, secretName);
      } catch (error) {
        warnings.push(`No se pudo borrar el secret ${secretName}: ${(error as Error).message}`);
      }

      if (data.removeWorkflow === true) {
        try {
          await deleteRepoFile(
            installationId,
            data.repoFullName,
            workflowPath,
            'chore: desconectar el agente de Pulse de este repo'
          );
        } catch (error) {
          warnings.push(`No se pudo borrar el workflow: ${(error as Error).message}`);
        }
      }
    } else {
      warnings.push('El workspace ya no tiene una instalación de GitHub; solo se revocó la key.');
    }

    await agentRef.update({
      allowedRepos: (agent.allowedRepos || []).filter((repo: string) => repo !== data.repoFullName),
      connectedRepos: connections.filter((c) => c.repoFullName !== data.repoFullName),
    });

    return {
      agentId: data.agentId,
      repoFullName: data.repoFullName,
      apiKeyRevoked: !!connection.apiKeyId,
      workflowRemoved: data.removeWorkflow === true && warnings.length === 0,
      warnings,
    };
  }
}
