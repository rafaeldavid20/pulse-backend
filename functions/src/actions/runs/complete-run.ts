import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';
import { AgentRun } from '../../common/domain.generated';

const VALID_OUTCOMES: NonNullable<AgentRun['outcome']>[] = [
  'pr_opened',
  'verdict_submitted',
  'released',
  'ambiguous',
  'failed',
  'timeout',
];

/**
 * `runs.complete` (D15/TES-211): cierra el registro de `agent_runs` que
 * `agentDispatchTrigger`/`qaDispatchTrigger` crea al despachar. Lo llama el
 * paso de reporte de `pulse-agent.yml`/`pulse-qa.yml` al final de cada run,
 * con `turns`/`costUsd` leídos del mensaje `result` del execution file de
 * `claude-code-action` — el propio agente nunca lo invoca a mano.
 *
 * Idempotente a propósito (`endedAt` ya seteado => no-op): el paso de reporte
 * reintenta la llamada MCP ante errores de red, y sin este chequeo un
 * reintento que sí llegó a escribir pero perdió la respuesta duplicaría el
 * incremento de `Issue.agentStats`.
 */
export class CompleteRunAction extends PlatformActionHandler {
  private runId?: string;
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('runs.complete', request, callerUid, callerEmail);
    this.runId = request.data?.runId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.runId) return false;
    const snap = await getFirestore().collection('agent_runs').doc(this.runId).get();
    if (!snap.exists) return false;
    this.resolvedWorkspaceId = snap.data()!.workspaceId;
    return this.isWorkspaceMember(this.resolvedWorkspaceId!);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;

    if (!data.runId || !data.outcome) {
      throw new Error('Parámetros requeridos faltantes: runId, outcome.');
    }
    if (!VALID_OUTCOMES.includes(data.outcome)) {
      throw new Error(`outcome inválido: '${data.outcome}'. Válidos: ${VALID_OUTCOMES.join(', ')}.`);
    }

    const runRef = db.collection('agent_runs').doc(data.runId);
    const runSnap = await runRef.get();
    if (!runSnap.exists) throw new Error(`El run '${data.runId}' no existe.`);
    const run = runSnap.data() as AgentRun;

    if (run.endedAt) {
      return { runId: data.runId, alreadyCompleted: true };
    }

    const now = new Date().toISOString();
    const costUsd: number | undefined = typeof data.costUsd === 'number' ? data.costUsd : undefined;
    const turns: number | undefined = typeof data.turns === 'number' ? data.turns : undefined;

    await runRef.update(
      cleanUndefined({
        endedAt: now,
        turns,
        costUsd,
        outcome: data.outcome,
        runUrl: data.runUrl,
      })
    );

    await db
      .collection('issues')
      .doc(run.issueId)
      .update({
        'agentStats.runs': FieldValue.increment(1),
        'agentStats.costUsd': FieldValue.increment(costUsd || 0),
        'agentStats.lastRunAt': now,
      });

    return { runId: data.runId, completed: true };
  }
}
