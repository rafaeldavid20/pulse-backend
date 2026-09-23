import { getFirestore } from 'firebase-admin/firestore';
import { nanoid } from 'nanoid';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';
import { Deployment, DeploymentMode, DeploymentTrigger, SalesforceTestLevel } from '../../common/domain.generated';
import { envSecretName } from '../../salesforce/repo-connection';
import { ENV_KEY_PATTERN } from '../environments/shared';

const MODES: DeploymentMode[] = ['validate', 'deploy', 'quick'];
const TRIGGERS: DeploymentTrigger[] = ['promotion', 'push', 'manual', 'pr_validation'];

/**
 * `deployments.start` (O3/TES-253): lo llama el workflow `pulse-deploy.yml`
 * antes de tocar la org, con `pulse_start_deployment`. Resuelve el entorno
 * (por la rama pusheada, o por la clave de un `repository_dispatch`), abre el
 * `Deployment` en `running` y le devuelve al workflow lo que necesita: el
 * secret a usar, el `fromSha` del delta y el nivel de tests.
 *
 * **No está en el router del callable**, igual que `runs.complete`: sólo se
 * llega por el MCP con una key `deploy:write`. Si cualquier miembro pudiera
 * abrir y cerrar deploys, podría mover el `deployedSha` de un entorno y hacer
 * que el próximo delta se saltee cambios.
 *
 * Un entorno con `requiresApproval` no despliega sin aprobación: el deploy
 * queda en `awaiting_approval` y el workflow no toca la org. La aprobación
 * es O8 (TES-258); hasta entonces la puerta existe aunque no haya cómo abrirla,
 * que es el orden correcto.
 */
export class StartDeploymentAction extends PlatformActionHandler {
  private workspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('deployments.start', request, callerUid, callerEmail);
    this.workspaceId = request.data?.workspaceId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.workspaceId) return false;
    return this.isWorkspaceMember(this.workspaceId);
  }

  private async findEnvironment(repoFullName: string, branch?: string, key?: string) {
    const snap = await getFirestore().collection('environments').where('workspaceId', '==', this.workspaceId).get();
    const envs = snap.docs.map((d) => d.data());
    if (key) {
      if (!ENV_KEY_PATTERN.test(key)) throw new Error(`Clave de entorno inválida: '${key}'.`);
      const env = envs.find((e) => e.key === key);
      if (!env) throw new Error(`No existe el entorno '${key}' en este workspace.`);
      return env;
    }
    const matches = envs.filter((e) => e.trackingBranch === branch);
    const inRepo = matches.filter(
      (e) => (e.connectedRepos || []).some((c: any) => c.repoFullName === repoFullName) || e.repoFullName === repoFullName
    );
    if (inRepo.length === 0) throw new Error(`Ningún entorno sigue la rama '${branch}' en ${repoFullName}.`);
    if (inRepo.length > 1) {
      throw new Error(`Hay ${inRepo.length} entornos que siguen la rama '${branch}' en ${repoFullName}; tiene que ser uno solo.`);
    }
    return inRepo[0];
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;
    const repoFullName: string = data.repoFullName;
    const sha: string = data.sha;
    if (!repoFullName || !sha) throw new Error('Parámetros requeridos faltantes: repoFullName, sha.');
    if (!data.branch && !data.environment) throw new Error('Indicá branch (push) o environment (dispatch).');

    const mode: DeploymentMode = data.mode || 'deploy';
    if (!MODES.includes(mode)) throw new Error(`Modo inválido: '${mode}'. Usá ${MODES.join(', ')}.`);
    const trigger: DeploymentTrigger = data.trigger || 'push';
    if (!TRIGGERS.includes(trigger)) throw new Error(`Trigger inválido: '${trigger}'.`);
    if (mode === 'quick' && !data.validationId) throw new Error('Un quick deploy necesita el validationId de una validación exitosa.');

    const env = await this.findEnvironment(repoFullName, data.branch, data.environment);
    if (!(env.connectedRepos || []).some((c: any) => c.repoFullName === repoFullName)) {
      throw new Error(`El entorno '${env.key}' no está atado a ${repoFullName}. Atalo desde Configuración → Salesforce.`);
    }
    if (env.connectionState === 'expired' || env.connectionState === 'revoked') {
      throw new Error(`La conexión con la org de '${env.key}' caducó o fue revocada; volvé a conectarla.`);
    }

    // Salesforce no acepta NoTestRun en producción, y RunSpecifiedTests
    // necesita la lista de tests, que recién llega con la validación de PR (O5).
    let testLevel: SalesforceTestLevel = env.defaultTestLevel || 'NoTestRun';
    if (testLevel === 'RunSpecifiedTests') testLevel = 'RunLocalTests';
    if (env.isProduction && testLevel === 'NoTestRun') testLevel = 'RunLocalTests';

    const now = new Date().toISOString();
    let existing: FirebaseFirestore.DocumentData | undefined;
    if (data.deploymentId) {
      const snap = await db.collection('deployments').doc(data.deploymentId).get();
      if (!snap.exists || snap.data()!.workspaceId !== this.workspaceId || snap.data()!.environmentId !== env.id) {
        throw new Error(`No existe el deploy '${data.deploymentId}' para el entorno '${env.key}'.`);
      }
      existing = snap.data();
    }

    const needsApproval = mode !== 'validate' && (env.requiresApproval || env.isProduction) && !existing?.approvedAt;
    const deployment: Deployment = cleanUndefined({
      ...(existing || {}),
      id: existing?.id || `dep-${nanoid(10)}`,
      workspaceId: this.workspaceId!,
      environmentId: env.id,
      envKey: env.key,
      repoFullName,
      branch: data.branch || existing?.branch || env.trackingBranch,
      sha,
      fromSha: env.deployedSha || undefined,
      mode,
      status: needsApproval ? 'awaiting_approval' : 'running',
      issueIds: existing?.issueIds || [],
      trigger,
      requestedBy: existing?.requestedBy || this.caller.uid || 'system',
      runUrl: data.runUrl || undefined,
      startedAt: now,
      date: now.slice(0, 10),
    });
    await db.collection('deployments').doc(deployment.id).set(deployment);

    if (needsApproval) {
      return {
        proceed: false,
        deploymentId: deployment.id,
        envKey: env.key,
        mode,
        message: `El entorno '${env.key}' requiere aprobación antes de desplegar. El deploy quedó esperando en Pulse y no se tocó la org.`,
      };
    }

    return {
      proceed: true,
      deploymentId: deployment.id,
      envKey: env.key,
      secretName: envSecretName(env.key),
      fromSha: deployment.fromSha || '',
      testLevel,
      mode,
      validationId: data.validationId || '',
    };
  }
}
