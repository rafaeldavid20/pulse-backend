import { nanoid } from 'nanoid';
import { FollowUpOrigin, IssueType, PendingWork, PendingWorkReason } from '../domain.generated';
import { CreateIssueAction } from '../../actions/issues/create-issue';
import { CreateCommentAction } from '../../actions/comments/create-comment';
import { MANUAL_WORK_LABEL, MANUAL_WORK_LABEL_COLOR, ensureLabel, withLabel } from './labels';
import { resolveReviewLead } from './review-escalation';
import { createNotification } from './notifications';

/**
 * Trabajo pendiente que ningún run puede retomar (TES-219).
 *
 * El problema que resuelve: hasta acá, un agente que no podía terminar algo lo
 * escribía en el cuerpo del PR. El PR se mergeaba, `github.syncFromWebhook`
 * movía el issue a `done`, y el aviso quedaba en un texto que nadie vuelve a
 * abrir. Pasó con TES-218, cuya migración de keys sigue sin correr.
 *
 * La forma de la solución es la de `PendingRepoWork` (TES-202): una entrada
 * estructurada en el issue, no un comentario. Lo que cambia es el desenlace.
 * Un traspaso entre repos lo puede tomar otro run, así que alcanza con
 * despacharlo; esto, por definición, **no lo puede tomar ningún run** — hacen
 * falta credenciales de producción, una decisión de producto, o directamente
 * otra historia. Así que el desenlace es un issue de seguimiento, y lo crea el
 * servidor: si la creación quedara como un segundo paso del agente, un run
 * apurado declara el pendiente, no crea nada, y volvemos al principio.
 */

const REASONS: PendingWorkReason[] = [
  'needs_prod_credentials',
  'product_decision',
  'out_of_scope',
  'blocked',
  'needs_manual_verification',
];

const REASON_LABEL: Record<PendingWorkReason, string> = {
  needs_prod_credentials: 'Necesita credenciales de producción',
  product_decision: 'Necesita una decisión de producto',
  out_of_scope: 'Quedó fuera del alcance de este issue',
  blocked: 'Bloqueado por algo externo',
  needs_manual_verification: 'Hay que verificarlo a mano',
};

/**
 * Tope de follow-ups que una sola revisión puede generar (TES-219). Un QA recién
 * calibrado marca `unverifiable` de más; el tope evita que un veredicto suelto
 * llene el backlog, y lo que se corta queda igual en el comentario del veredicto.
 */
export const MAX_FOLLOW_UPS_PER_REVIEW = 5;

const MAX_TITLE_LENGTH = 120;

export function normalizeReason(raw: unknown): PendingWorkReason {
  if (typeof raw === 'string' && REASONS.includes(raw as PendingWorkReason)) {
    return raw as PendingWorkReason;
  }
  throw new Error(`Motivo inválido: '${String(raw)}'. Válidos: ${REASONS.join(', ')}.`);
}

/**
 * Dónde cuelga el issue de seguimiento. Un `subtask` no puede tener hijos
 * (`ALLOWED_PARENT_TYPES`), así que el follow-up de una sub-tarea se crea como
 * hermano en vez de fallar: perder el pendiente por una regla de jerarquía
 * sería exactamente el bug que esto viene a arreglar.
 */
export function followUpPlacement(issue: FirebaseFirestore.DocumentData): { type: IssueType; parentId?: string } {
  const parentType: IssueType = issue.type || 'task';
  if (parentType === 'epic') return { type: 'task', parentId: issue.id };
  if (parentType === 'subtask') {
    return issue.parentId ? { type: 'subtask', parentId: issue.parentId } : { type: 'task' };
  }
  return { type: 'subtask', parentId: issue.id };
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function criterionText(issue: FirebaseFirestore.DocumentData, criterionId?: string): string | undefined {
  if (!criterionId) return undefined;
  const found = (issue.acceptanceCriteria || []).find((c: any) => c?.id === criterionId);
  return found?.text;
}

function followUpDescription(
  issue: FirebaseFirestore.DocumentData,
  entry: PendingWork,
  criterion?: string
): string {
  const lines = [
    `Seguimiento automático de **${issue.identifier}** — ${issue.title}.`,
    '',
    `**Qué falta:** ${entry.summary}`,
    '',
    `**Por qué no lo hizo el run:** ${REASON_LABEL[entry.reason]}.`,
  ];
  if (entry.context) lines.push('', `**Contexto:** ${entry.context}`);
  if (criterion) {
    lines.push('', `**Criterio que quedó sin cumplir** (\`${entry.criterionId}\` de ${issue.identifier}):`, '', `> ${criterion}`);
  }
  lines.push(
    '',
    '---',
    '',
    entry.source === 'qa'
      ? 'Lo detectó la revisión de QA: un criterio que no se pudo verificar desde el run.'
      : 'Lo declaró el agente que trabajó el issue, con `pulse_report_pending_work`.',
    '',
    'Nace **sin asignar** a propósito: asignarlo a un agente y moverlo a `todo` dispara un run pagado, ' +
      'y este pendiente existe justamente porque un run no lo puede resolver. Revisalo antes de asignarlo.'
  );
  return lines.join('\n');
}

/**
 * Registra un pendiente y crea su issue de seguimiento. Es el único camino:
 * lo llaman tanto `issues.reportPendingWork` (el dev lo declara) como
 * `reviews.submit` (QA lo deduce de un criterio `unverifiable`), y las dos
 * rutas tienen que dejar exactamente el mismo rastro.
 *
 * Idempotente por criterio: declarar dos veces el mismo `criterionId` (o el
 * mismo `summary`, cuando no hay criterio) actualiza la entrada y reusa el
 * follow-up ya creado, en vez de llenar el backlog de duplicados en cada
 * re-trabajo.
 */
export async function registerPendingWork(
  db: FirebaseFirestore.Firestore,
  opts: {
    issueId: string;
    issue: FirebaseFirestore.DocumentData;
    summary: string;
    reason: PendingWorkReason;
    context?: string;
    criterionId?: string;
    source: 'dev' | 'qa';
    actorUid: string;
  }
): Promise<{ entry: PendingWork; pendingWork: PendingWork[]; created: boolean }> {
  const { issue, issueId, actorUid } = opts;
  const summary = opts.summary.trim();
  if (!summary) throw new Error('El pendiente necesita un `summary`: qué es lo que falta hacer.');

  const existing: PendingWork[] = Array.isArray(issue.pendingWork) ? issue.pendingWork : [];
  const sameKey = (e: PendingWork) =>
    opts.criterionId ? e.criterionId === opts.criterionId : !e.criterionId && e.summary === summary;
  const previous = existing.find(sameKey);

  const now = new Date().toISOString();
  const entry: PendingWork = {
    id: previous?.id || `pw-${nanoid(8)}`,
    summary,
    reason: opts.reason,
    source: opts.source,
    reportedBy: actorUid,
    reportedAt: now,
    ...(opts.context ? { context: opts.context.trim() } : {}),
    ...(opts.criterionId ? { criterionId: opts.criterionId } : {}),
    ...(previous?.followUpIssueId
      ? { followUpIssueId: previous.followUpIssueId, followUpIdentifier: previous.followUpIdentifier }
      : {}),
  };

  let created = false;
  if (!entry.followUpIssueId) {
    const followUp = await createFollowUpIssue(db, issue, issueId, entry, actorUid);
    if (followUp) {
      entry.followUpIssueId = followUp.id;
      entry.followUpIdentifier = followUp.identifier;
      created = true;
    }
  }

  const pendingWork = [...existing.filter((e) => !sameKey(e)), entry];
  await db.collection('issues').doc(issueId).update({ pendingWork, updatedAt: now, updatedBy: actorUid });

  await postPendingWorkComment(issueId, issue, entry, actorUid);
  await notifyPendingWork(db, issue, issueId, entry, actorUid);

  return { entry, pendingWork, created };
}

/**
 * Crea el issue de seguimiento reusando `issues.create` (misma validación de
 * jerarquía, mismo contador de identificadores) en vez de escribir el doc a
 * mano — igual que `reviews.submit` reusa `comments.create`.
 *
 * `followUpOf` se escribe aparte porque no está en `ISSUE_WRITABLE_FIELDS`: es
 * un campo que el servidor pone, no algo que un caller pueda mandar en el
 * payload de `issues.create`.
 */
async function createFollowUpIssue(
  db: FirebaseFirestore.Firestore,
  issue: FirebaseFirestore.DocumentData,
  issueId: string,
  entry: PendingWork,
  actorUid: string
): Promise<{ id: string; identifier: string } | null> {
  const labelId = await ensureLabel(db, issue.workspaceId, issue.teamId, MANUAL_WORK_LABEL, MANUAL_WORK_LABEL_COLOR);
  const placement = followUpPlacement({ ...issue, id: issueId });

  const response = await new CreateIssueAction(
    {
      actionCode: 'issues.create',
      data: {
        workspaceId: issue.workspaceId,
        teamId: issue.teamId,
        title: truncate(entry.summary, MAX_TITLE_LENGTH),
        description: followUpDescription(issue, entry, criterionText(issue, entry.criterionId)),
        // `backlog`, no `todo`: `todo` es la bandeja de lo que un agente puede
        // levantar, y este pendiente no lo puede resolver ninguno.
        status: 'backlog',
        priority: issue.priority ?? 3,
        projectId: issue.projectId || undefined,
        labelIds: [labelId],
        type: placement.type,
        parentId: placement.parentId,
      },
    },
    actorUid
  ).run();

  if (!response.success || !response.data?.id) return null;

  const origin: FollowUpOrigin = {
    issueId,
    identifier: issue.identifier,
    reason: entry.reason,
    ...(entry.criterionId ? { criterionId: entry.criterionId } : {}),
  };
  await db.collection('issues').doc(response.data.id).update({ followUpOf: origin });

  return { id: response.data.id, identifier: response.data.identifier };
}

/** El comentario es para las personas; el campo es para el mecanismo. Mismo criterio que `issues.requestRepoWork`. */
async function postPendingWorkComment(
  issueId: string,
  issue: FirebaseFirestore.DocumentData,
  entry: PendingWork,
  actorUid: string
): Promise<void> {
  const lines = [
    `**Trabajo pendiente** — ${REASON_LABEL[entry.reason]}.`,
    '',
    `**Qué falta:** ${entry.summary}`,
  ];
  if (entry.context) lines.push('', `**Contexto:** ${entry.context}`);
  const criterion = criterionText(issue, entry.criterionId);
  if (criterion) lines.push('', `**Criterio sin cumplir** (\`${entry.criterionId}\`): ${criterion}`);
  lines.push(
    '',
    entry.followUpIdentifier
      ? `Seguimiento: **${entry.followUpIdentifier}** (sin asignar, etiquetado \`${MANUAL_WORK_LABEL}\`).`
      : `No se pudo crear el issue de seguimiento. Mientras tanto ${issue.identifier} no se cierra solo.`
  );

  await new CreateCommentAction(
    { actionCode: 'comments.create', data: { issueId, body: lines.join('\n'), source: 'mcp' } },
    actorUid
  ).run();
}

/**
 * Una etiqueta sola no avisa a nadie: solo la ve quien filtre por ella. El
 * pendiente le llega al lead del proyecto (o a quien creó el issue) como
 * `needs_human`, que es el tipo que `createNotification` no deja silenciar por
 * preferencia de tipo — y esto es, literalmente, trabajo que necesita a una
 * persona.
 */
async function notifyPendingWork(
  db: FirebaseFirestore.Firestore,
  issue: FirebaseFirestore.DocumentData,
  issueId: string,
  entry: PendingWork,
  actorUid: string
): Promise<void> {
  const responsibleId = await resolveReviewLead(db, issue);
  if (!responsibleId || responsibleId === actorUid) return;
  await createNotification(db, {
    workspaceId: issue.workspaceId,
    userId: responsibleId,
    actorId: actorUid,
    issueId: entry.followUpIssueId || issueId,
    type: 'needs_human',
    title: entry.followUpIdentifier
      ? `${entry.followUpIdentifier} — trabajo pendiente de ${issue.identifier}`
      : `${issue.identifier} dejó trabajo pendiente`,
    body: `${REASON_LABEL[entry.reason]}: ${entry.summary}`,
  });
}

/**
 * Criterios que el dev declaró `not_met` y que **no** tienen un follow-up que
 * los herede. Es la condición que frena el cierre automático: un criterio
 * incumplido puede convivir con un issue en `done` — pero solo si existe el
 * issue que se lo quedó.
 */
export function uncoveredNotMetCriteria(issue: FirebaseFirestore.DocumentData): string[] {
  const covered = new Set(
    (issue.pendingWork || [])
      .filter((e: PendingWork) => e.followUpIssueId && e.criterionId)
      .map((e: PendingWork) => e.criterionId)
  );
  return (issue.devSelfCheck || [])
    .filter((c: any) => c?.result === 'not_met' && !covered.has(c.criterionId))
    .map((c: any) => c.criterionId);
}

/** Pendientes declarados cuyo issue de seguimiento no se llegó a crear. */
export function orphanPendingWork(issue: FirebaseFirestore.DocumentData): PendingWork[] {
  return (issue.pendingWork || []).filter((e: PendingWork) => !e.followUpIssueId);
}
