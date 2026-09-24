import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';
import { generateApiKey, hashApiKeySecret } from '../../common/utils/api-key';
import { mcpKeyPepper } from '../../common/secrets';
import { DEPLOY_SCOPES } from '../../mcp/scopes';
import { putRepoFile, setRepoSecret } from '../../github/client';
import { detachEnvFromRepo, writeEnvSecret } from '../../salesforce/repo-connection';
import {
  DEPLOY_MCP_SECRET_NAME,
  DEPLOY_WORKFLOW_PATH,
  DEPLOY_WORKFLOW_VERSION,
  renderDeployWorkflow,
} from '../../salesforce/templates/pulse-deploy-workflow';
import { loadEnvironmentForWorkspace, sanitizeEnvironment } from './shared';

/**
 * Ata un entorno a un repo (O3/TES-253), calcado de `agents.connectRepo`:
 *
 * 1. Escribe `PULSE_SF_AUTH_<KEY>` con el `SFDX_AUTH_URL` de la org.
 * 2. Emite una key de MCP `deploy:write` dedicada al repo y la escribe como
 *    `PULSE_DEPLOY_MCP_KEY`. Es por repo y no por entorno porque el workflow es
 *    uno solo por repo; la anterior se revoca, así no quedan keys vivas que
 *    ningún secret referencia.
 * 3. Commitea `pulse-deploy.yml` en la rama por defecto con las
 *    `trackingBranch` de **todos** los entornos del workspace atados a ese repo
 *    (el workflow es único: si sólo llevara la de este entorno, atar `demo`
 *    dejaría de desplegar `dev`).
 *
 * Es un admin quien lo hace: deja en un repo una credencial de la org del
 * cliente, mismo listón que conectar la org.
 *
 * También sirve para **cambiar** de repo o de rama (TES-282): con otro
 * `repoFullName`, ata el nuevo primero y después limpia el viejo
 * (`detachEnvFromRepo`). Un entorno queda atado a un solo repo.
 */
export class ConnectEnvironmentRepoAction extends PlatformActionHandler {
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('environments.connectRepo', request, callerUid, callerEmail);
  }

  protected async authorize(): Promise<boolean> {
    const environmentId = this.action.data?.environmentId;
    if (!environmentId) return false;
    const snap = await getFirestore().collection('environments').doc(environmentId).get();
    if (!snap.exists) return false;
    this.resolvedWorkspaceId = snap.data()!.workspaceId;
    return this.assertWorkspaceMember(this.resolvedWorkspaceId!, 'admin');
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const environmentId: string = this.action.data.environmentId;
    const workspaceId = this.resolvedWorkspaceId!;
    const env = await loadEnvironmentForWorkspace(environmentId, workspaceId);
    // Un entorno puede haberse conectado sin repo ni rama (TES-277): se dan acá.
    const repoFullName: string = (this.action.data.repoFullName || env.repoFullName || '').trim();
    const trackingBranch: string = (this.action.data.trackingBranch || env.trackingBranch || '').trim();
    if (!repoFullName) throw new Error('Elegí el repo al que se ata este entorno (repoFullName).');
    if (!trackingBranch) throw new Error('Indicá la rama cuyo push despliega a este entorno (trackingBranch).');

    const installSnap = await db.collection('github_installations').where('workspaceId', '==', workspaceId).limit(1).get();
    if (installSnap.empty) throw new Error('Este workspace no tiene GitHub conectado todavía (Configuración → Integraciones).');
    const installation = installSnap.docs[0].data();
    const authorized: string[] = installation.repositoryFullNames || [];
    if (authorized.length > 0 && !authorized.includes(repoFullName)) {
      throw new Error(`'${repoFullName}' no está entre los repos de esta instalación (${authorized.join(', ')}).`);
    }

    // Una rama despliega a un solo entorno por repo: si no, `deployments.start`
    // no sabría a cuál mandar un push. Se valida antes de escribir secrets.
    const siblings = await db.collection('environments').where('workspaceId', '==', workspaceId).get();
    const clash = siblings.docs
      .map((d) => d.data())
      .find(
        (e) =>
          e.id !== environmentId &&
          e.trackingBranch === trackingBranch &&
          (e.connectedRepos || []).some((c: any) => c.repoFullName === repoFullName)
      );
    if (clash) {
      throw new Error(`La rama '${trackingBranch}' ya despliega a '${clash.key}' en ${repoFullName}. Elegí otra.`);
    }
    // Repo y rama nuevos se guardan recién al final, junto con `connectedRepos`
    // (finding de QA en TES-282): guardarlos antes y fallar al escribir en el
    // repo nuevo dejaba el entorno apuntando a una rama que ya no matchea en
    // `deployments.start`, así que el repo viejo, que funcionaba, dejaba de
    // desplegar.

    const permissionHint =
      'Si es un 403, a la GitHub App le faltan los permisos "Secrets: Read and write" y "Workflows: Read and write".';

    // 1. Credencial de la org.
    let secretName: string;
    try {
      secretName = await writeEnvSecret(env, repoFullName);
    } catch (error) {
      throw new Error(`No se pudo escribir la credencial de la org en '${repoFullName}': ${(error as Error).message}. ${permissionHint}`);
    }

    // 2. Key de MCP del workflow, una por repo.
    const { keyId, secret, fullKey, prefix } = generateApiKey();
    await db.collection('api_keys').doc(keyId).set(
      cleanUndefined({
        id: keyId,
        workspaceId,
        name: `Pulse Deploy @ ${repoFullName}`,
        hash: hashApiKeySecret(secret, mcpKeyPepper.value()),
        prefix,
        scopes: DEPLOY_SCOPES,
        agentId: null,
        purpose: 'deploy',
        connectedRepo: repoFullName,
        createdBy: this.caller.uid || 'system',
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        revokedAt: null,
      })
    );
    try {
      await setRepoSecret(installation.installationId, repoFullName, DEPLOY_MCP_SECRET_NAME, fullKey);
    } catch (error) {
      await db.collection('api_keys').doc(keyId).update({ revokedAt: new Date().toISOString() });
      throw new Error(`No se pudo escribir ${DEPLOY_MCP_SECRET_NAME} en '${repoFullName}': ${(error as Error).message}. ${permissionHint}`);
    }
    const previousKeys = await db
      .collection('api_keys')
      .where('workspaceId', '==', workspaceId)
      .where('connectedRepo', '==', repoFullName)
      .where('purpose', '==', 'deploy')
      .get();
    const now = new Date().toISOString();
    await Promise.all(
      previousKeys.docs.filter((d) => d.id !== keyId && !d.data().revokedAt).map((d) => d.ref.update({ revokedAt: now }))
    );

    // 3. Workflow con las ramas de todos los entornos atados a este repo.
    const branches = [
      trackingBranch,
      ...siblings.docs
        .map((d) => d.data())
        .filter((e) => e.id !== environmentId && (e.connectedRepos || []).some((c: any) => c.repoFullName === repoFullName))
        .map((e) => e.trackingBranch)
        .filter(Boolean),
    ];
    let file: { sha: string; created: boolean };
    try {
      file = await putRepoFile(
        installation.installationId,
        repoFullName,
        DEPLOY_WORKFLOW_PATH,
        renderDeployWorkflow(branches),
        `chore: atar el entorno ${env.key} de Pulse a este repo`
      );
    } catch (error) {
      throw new Error(`No se pudo commitear ${DEPLOY_WORKFLOW_PATH} en '${repoFullName}': ${(error as Error).message}. ${permissionHint}`);
    }

    const connection = {
      repoFullName,
      secretName,
      workflowPath: DEPLOY_WORKFLOW_PATH,
      workflowVersion: DEPLOY_WORKFLOW_VERSION,
      deployKeyId: keyId,
      connectedAt: now,
    };
    // Un entorno se despliega desde un solo repo: los que tenía antes se limpian
    // después de que el nuevo quedó atado, así un fallo a mitad de camino nunca
    // lo deja sin ninguno.
    const previousRepos = ((env.connectedRepos || []) as any[]).filter((c) => c.repoFullName !== repoFullName);
    const otherEnvs = siblings.docs.map((d) => d.data()).filter((e) => e.id !== environmentId);
    const warnings: string[] = [];
    for (const old of previousRepos) {
      warnings.push(
        ...(await detachEnvFromRepo({
          installationId: installation.installationId,
          workspaceId,
          envKey: env.key,
          repoFullName: old.repoFullName,
          secretName: old.secretName,
          otherEnvs,
        }))
      );
    }
    const connectedRepos = [connection];
    await db
      .collection('environments')
      .doc(environmentId)
      .update({ repoFullName, trackingBranch, connectedRepos, repoSecretsStale: false });
    env.repoFullName = repoFullName;
    env.trackingBranch = trackingBranch;

    // Los otros entornos atados al mismo repo comparten el workflow y la key:
    // su entrada queda apuntando a la versión y la key nuevas.
    await Promise.all(
      siblings.docs
        .filter((d) => d.id !== environmentId)
        .map(async (d) => {
          const conns: any[] = d.data().connectedRepos || [];
          if (!conns.some((c) => c.repoFullName === repoFullName)) return;
          await d.ref.update({
            connectedRepos: conns.map((c) =>
              c.repoFullName === repoFullName ? { ...c, workflowVersion: DEPLOY_WORKFLOW_VERSION, deployKeyId: keyId } : c
            ),
          });
        })
    );

    return {
      environment: sanitizeEnvironment({ ...env, connectedRepos, repoSecretsStale: false }),
      repoFullName,
      secretName,
      workflowPath: DEPLOY_WORKFLOW_PATH,
      workflowCreated: file.created,
      workflowVersion: DEPLOY_WORKFLOW_VERSION,
      trackingBranches: [...new Set(branches)],
      detachedFrom: previousRepos.map((c) => c.repoFullName),
      warnings,
    };
  }
}
