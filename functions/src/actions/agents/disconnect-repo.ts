import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { deleteRepoSecret, deleteRepoFile } from '../../github/client';
import { WORKFLOW_PATH } from '../../github/templates/pulse-agent-workflow';

const MCP_SECRET_NAME = 'PULSE_AGENT_MCP_KEY';

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

    const connections: any[] = agentSnap.data()!.connectedRepos || [];
    const connection = connections.find((c) => c.repoFullName === data.repoFullName);
    if (!connection) {
      throw new Error(`El agente no está conectado a '${data.repoFullName}'.`);
    }

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
        await deleteRepoSecret(installationId, data.repoFullName, MCP_SECRET_NAME);
      } catch (error) {
        warnings.push(`No se pudo borrar el secret ${MCP_SECRET_NAME}: ${(error as Error).message}`);
      }

      if (data.removeWorkflow === true) {
        try {
          await deleteRepoFile(
            installationId,
            data.repoFullName,
            WORKFLOW_PATH,
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
