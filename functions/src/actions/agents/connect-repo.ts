import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';
import { generateApiKey, hashApiKeySecret } from '../../common/utils/api-key';
import { mcpKeyPepper } from '../../common/secrets';
import { setRepoSecret, putRepoFile, listRepoSecretNames } from '../../github/client';
import {
  renderAgentWorkflow,
  WORKFLOW_PATH,
  WORKFLOW_VERSION,
} from '../../github/templates/pulse-agent-workflow';

const MCP_SECRET_NAME = 'PULSE_AGENT_MCP_KEY';
const ANTHROPIC_SECRET_NAME = 'CLAUDE_CODE_OAUTH_TOKEN';

/**
 * Conecta un agente a un repo: deja el repo listo para recibir dispatches sin
 * que el usuario toque `gh` ni copie YAML.
 *
 * Provisiona SOLO la key de MCP, que es la que Pulse genera. El
 * `CLAUDE_CODE_OAUTH_TOKEN` es del usuario y está atado a su suscripción de
 * Claude: Pulse no lo guarda ni lo transporta, ni siquiera de paso. La respuesta
 * incluye si ese secret ya está presente en el repo (GitHub devuelve nombres de
 * secrets, nunca valores) para que la UI pueda mostrar el paso manual como
 * pendiente o listo en vez de dejar al usuario adivinando.
 *
 * La key de MCP es dedicada por repo, no compartida: revocar la de un repo no
 * debería dejar mudos a los demás.
 */
export class ConnectRepoAction extends PlatformActionHandler {
  private workspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('agents.connectRepo', request, callerUid, callerEmail);
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

    const installSnap = await db
      .collection('github_installations')
      .where('workspaceId', '==', data.workspaceId)
      .limit(1)
      .get();
    if (installSnap.empty) {
      throw new Error('Este workspace no tiene GitHub conectado todavía (Configuración → GitHub).');
    }
    const installation = installSnap.docs[0].data();
    const authorized: string[] = installation.repositoryFullNames || [];
    if (authorized.length > 0 && !authorized.includes(data.repoFullName)) {
      throw new Error(
        `'${data.repoFullName}' no está entre los repos de esta instalación (${authorized.join(', ')}).`
      );
    }

    // 1. Key de MCP dedicada a este par agente+repo.
    const { keyId, secret, fullKey, prefix } = generateApiKey();
    await db.collection('api_keys').doc(keyId).set(
      cleanUndefined({
        id: keyId,
        workspaceId: data.workspaceId,
        name: `${agent.displayName} @ ${data.repoFullName}`,
        hash: hashApiKeySecret(secret, mcpKeyPepper.value()),
        prefix,
        scopes: ['issues:read', 'issues:write', 'projects:write', 'comments:write'],
        agentId: data.agentId,
        connectedRepo: data.repoFullName,
        createdBy: this.caller.uid || 'system',
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        revokedAt: null,
      })
    );

    // 2. Escribirla como secret. Si esto falla (típicamente 403 por permisos
    //    faltantes en la App), la key recién creada queda huérfana — se revoca
    //    para no dejar credenciales vivas que nadie va a usar.
    try {
      await setRepoSecret(installation.installationId, data.repoFullName, MCP_SECRET_NAME, fullKey);
    } catch (error) {
      await db.collection('api_keys').doc(keyId).update({ revokedAt: new Date().toISOString() });
      throw new Error(
        `No se pudo escribir el secret en '${data.repoFullName}': ${(error as Error).message}. ` +
          'Si es un 403, a la GitHub App le faltan los permisos "Secrets: Read and write" y ' +
          '"Workflows: Read and write", y hay que aprobar el upgrade en la instalación.'
      );
    }

    // 3. Workflow en la rama por defecto. repository_dispatch solo dispara
    //    workflows que estén ahí, así que commitearlo en otra rama no serviría.
    const file = await putRepoFile(
      installation.installationId,
      data.repoFullName,
      WORKFLOW_PATH,
      renderAgentWorkflow(),
      `chore: ${'conectar'} el agente ${agent.displayName} de Pulse a este repo`
    );

    // 4. Estado del secret que Pulse deliberadamente no gestiona.
    let anthropicSecretPresent = false;
    try {
      anthropicSecretPresent = (
        await listRepoSecretNames(installation.installationId, data.repoFullName)
      ).includes(ANTHROPIC_SECRET_NAME);
    } catch {
      // Poder listar no es esencial: si falla, la UI muestra el paso como
      // pendiente en vez de romper la conexión que ya quedó hecha.
    }

    await agentRef.update({
      connectedRepos: FieldValue.arrayUnion({
        repoFullName: data.repoFullName,
        apiKeyId: keyId,
        workflowSha: file.sha,
        workflowVersion: WORKFLOW_VERSION,
        connectedAt: new Date().toISOString(),
      }),
    });

    return {
      agentId: data.agentId,
      repoFullName: data.repoFullName,
      apiKeyId: keyId,
      workflowCreated: file.created,
      workflowVersion: WORKFLOW_VERSION,
      anthropicSecretPresent,
      anthropicSecretName: ANTHROPIC_SECRET_NAME,
      // El comando exacto para el paso que queda a mano, listo para copiar.
      manualStep: anthropicSecretPresent
        ? null
        : `gh secret set ${ANTHROPIC_SECRET_NAME} -R ${data.repoFullName}`,
    };
  }
}
