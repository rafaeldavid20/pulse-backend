import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';
import { CliDeploySummary, parseCliSummary } from '../../salesforce/deploy-result';

/**
 * `deployments.report` (O3/TES-253): el workflow cierra el `Deployment` con el
 * resultado del CLI. Un deploy exitoso (no una validación) mueve el
 * `deployedSha` del entorno, que es la base del delta del próximo.
 *
 * Fuera del router del callable por la misma razón que `deployments.start`.
 */
export class ReportDeploymentAction extends PlatformActionHandler {
  private workspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('deployments.report', request, callerUid, callerEmail);
    this.workspaceId = request.data?.workspaceId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.workspaceId) return false;
    return this.isWorkspaceMember(this.workspaceId);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const { deploymentId, status, runUrl, cli } = this.action.data;
    if (!deploymentId) throw new Error('Parámetro requerido faltante: deploymentId.');
    if (status !== 'succeeded' && status !== 'failed') throw new Error("status tiene que ser 'succeeded' o 'failed'.");

    const ref = db.collection('deployments').doc(deploymentId);
    const snap = await ref.get();
    if (!snap.exists || snap.data()!.workspaceId !== this.workspaceId) throw new Error(`No existe el deploy '${deploymentId}'.`);
    const dep = snap.data()!;
    if (dep.status !== 'running') {
      throw new Error(`El deploy '${deploymentId}' está en '${dep.status}', no en 'running': no se puede cerrar de nuevo.`);
    }

    const parsed = parseCliSummary(cli as CliDeploySummary | undefined);
    const now = new Date().toISOString();
    await ref.update(
      cleanUndefined({
        status,
        endedAt: now,
        runUrl: runUrl || dep.runUrl,
        salesforce: parsed.salesforce,
        errors: parsed.errors,
      })
    );

    if (status === 'succeeded' && dep.mode !== 'validate') {
      await db.collection('environments').doc(dep.environmentId).update({ deployedSha: dep.sha, deployedAt: now });
    }

    return { deploymentId, status, errors: parsed.errors?.length ?? 0 };
  }
}
