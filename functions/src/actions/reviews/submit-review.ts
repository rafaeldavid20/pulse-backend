import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';
import { normalizeFindings, normalizeCriteriaResults } from '../../common/utils/review-findings';
import { resolveReviewLead, getProjectLeadId, ensureNeedsHumanLabel, notifyNeedsHuman } from '../../common/utils/review-escalation';
import { createNotification } from '../../common/utils/notifications';
import { CreateCommentAction } from '../comments/create-comment';
import { getPullRequestHeadSha, createPullRequestReview, PullRequestReviewComment } from '../../github/client';
import {
  AcceptanceCriterion,
  IssueReview,
  IssueReviewAttempt,
  ReviewCriterionResult,
  ReviewFinding,
  ReviewPrRef,
} from '../../common/domain.generated';

const DEFAULT_MAX_REVIEW_ATTEMPTS = 2;

type Outcome = 'approved' | 'changes_requested' | 'needs_human';

interface ReviewablePr {
  repoFullName: string;
  prNumber: number;
  prUrl?: string;
}

function reviewablePrs(issue: FirebaseFirestore.DocumentData): ReviewablePr[] {
  const refs: any[] =
    Array.isArray(issue.gitRefs) && issue.gitRefs.length > 0
      ? issue.gitRefs
      : issue.git?.repoFullName && issue.git?.prNumber !== undefined
        ? [issue.git]
        : [];
  return refs
    .filter((r) => r?.prNumber !== undefined)
    .map((r) => ({ repoFullName: r.repoFullName, prNumber: r.prNumber, prUrl: r.prUrl }));
}

/**
 * `reviews.submit` (D5): valida el veredicto de QA contra los criterios y
 * findings estructurados (no confía en un "decision" que mande el modelo),
 * escribe la revisión, publica el resumen como comentario en Pulse y una
 * review en cada PR del issue, y aplica la transición de status/asignación
 * que corresponda.
 *
 * La mitad del valor del diseño: un agente no puede aprobar su propio
 * trabajo. Se valida acá, en el servidor — no alcanza con que el prompt del
 * QA lo pida amablemente.
 *
 * Modo sombra (D17/TES-213): con `Agent.qaMode !== 'enforce'` (default al
 * crear un agente `qa`) el veredicto se registra igual de completo, pero no
 * se aplica ninguna transición de status/asignado/labels ni se dispara
 * re-trabajo — el issue sigue el flujo humano de hoy hasta que alguien pase
 * el QA a `enforce` en Settings.
 */
export class ReviewsSubmitAction extends PlatformActionHandler {
  private issueId?: string;
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('reviews.submit', request, callerUid, callerEmail);
    this.issueId = request.data?.issueId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.issueId) return false;
    const snap = await getFirestore().collection('issues').doc(this.issueId).get();
    if (!snap.exists) return false;
    this.resolvedWorkspaceId = snap.data()!.workspaceId;
    return this.isWorkspaceMember(this.resolvedWorkspaceId!);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;
    const actorUid = this.caller.uid!;

    if (!data.issueId || !data.verdict || !String(data.verdict).trim()) {
      throw new Error('Parámetros requeridos faltantes: issueId, verdict.');
    }

    const issueRef = db.collection('issues').doc(data.issueId);
    const issueSnap = await issueRef.get();
    if (!issueSnap.exists) throw new Error(`El issue con ID '${data.issueId}' no existe.`);
    const issue = issueSnap.data()!;

    const review = issue.review as IssueReview | undefined;
    if (!review || review.state !== 'running' || review.claimedBy !== actorUid) {
      throw new Error(
        `No hay una revisión en curso reclamada por este agente para '${issue.identifier}'. Llamá a pulse_next_review primero.`
      );
    }

    const agentSnap = await db.collection('agents').doc(actorUid).get();
    const agent = agentSnap.exists ? agentSnap.data()! : null;
    if (!agent || agent.role !== 'qa') {
      throw new Error('Solo un agente con role "qa" puede enviar un veredicto de revisión (pulse_submit_review).');
    }
    if (issue.assigneeId && issue.assigneeId === actorUid) {
      throw new Error('Un agente no puede revisar su propio trabajo: este agente es el asignado dev de este issue.');
    }

    const findings = normalizeFindings(data.findings);
    const criteriaResults = normalizeCriteriaResults(data.criteriaResults);
    const verdict = String(data.verdict).trim();

    const hasBlockingFinding = findings.some((f) => f.status === 'open' && (f.severity === 'blocker' || f.severity === 'major'));
    const hasFailedCriterion = criteriaResults.some((c) => c.result === 'fail');
    const hasUnverifiable = criteriaResults.some((c) => c.result === 'unverifiable');

    let outcome: Outcome;
    let capped = false;
    if (hasBlockingFinding || hasFailedCriterion) {
      const maxAttempts = agent.maxReviewAttempts ?? DEFAULT_MAX_REVIEW_ATTEMPTS;
      if (review.attempt >= maxAttempts) {
        outcome = 'needs_human';
        capped = true;
      } else {
        outcome = 'changes_requested';
      }
    } else if (hasUnverifiable) {
      outcome = 'needs_human';
    } else {
      outcome = 'approved';
    }

    // SHA revisado de cada PR (D3/D10): la fuente de verdad para saber, la
    // próxima vez que el issue entre a `in_review`, si el dev pusheó algo
    // nuevo desde este veredicto.
    const prs = reviewablePrs(issue);
    const prRefs: ReviewPrRef[] = [];
    let installation: FirebaseFirestore.DocumentData | null = null;
    if (prs.length > 0) {
      const installSnap = await db.collection('github_installations').where('workspaceId', '==', issue.workspaceId).limit(1).get();
      installation = installSnap.empty ? null : installSnap.docs[0].data();
      if (installation) {
        for (const pr of prs) {
          try {
            const headSha = await getPullRequestHeadSha(installation.installationId, pr.repoFullName, pr.prNumber);
            prRefs.push({ repoFullName: pr.repoFullName, prNumber: pr.prNumber, headSha });
          } catch (error) {
            console.error(`[ReviewsSubmit] no se pudo leer el head SHA de ${pr.repoFullName}#${pr.prNumber}:`, error);
          }
        }
      }
    }

    const now = new Date().toISOString();
    const closedAttempt: IssueReviewAttempt = {
      state: outcome,
      reviewerId: actorUid,
      attempt: review.attempt,
      verdict,
      prs: prRefs.length > 0 ? prRefs : undefined,
      findings,
      criteriaResults,
      startedAt: review.startedAt,
      completedAt: now,
    };

    const nextReview: IssueReview = {
      ...closedAttempt,
      history: review.history,
    };

    const updates: Record<string, any> = {
      updatedAt: now,
      updatedBy: actorUid,
    };

    // Modo sombra (D17): mientras no se sepa si el criterio del QA coincide
    // con el humano, `reviews.submit` registra el veredicto completo (abajo)
    // pero no toca status/asignado/labels ni dispara re-trabajo — el issue
    // sigue el flujo humano de hoy como si no hubiera QA automático. El
    // re-trabajo (D9) se gatea aparte, en `agentDispatchTrigger`, porque ese
    // trigger reacciona a `review.state` y no pasa por acá.
    const qaMode = agent.qaMode === 'enforce' ? 'enforce' : 'shadow';

    let needsHumanLeadId: string | undefined;
    if (qaMode === 'enforce') {
      if (outcome === 'changes_requested') {
        updates.status = 'in_progress';
        // El guard de override manual del webhook (`sync-from-webhook.ts`) trata
        // como cambio humano cualquier status que no coincida con
        // `git.lastSyncedStatus` — así que esta transición de sistema tiene que
        // dejarlo al día, o el webhook deja de sincronizar este issue (D10).
        updates['git.lastSyncedStatus'] = 'in_progress';
      } else if (outcome === 'needs_human') {
        needsHumanLeadId = await resolveReviewLead(db, issue);
        nextReview.previousAssigneeId = issue.assigneeId || undefined;
        updates.assigneeId = needsHumanLeadId || null;
        if (capped) {
          // Intentos agotados: es un rechazo real, solo que lo termina de
          // resolver una persona en vez de un re-trabajo automático (D9).
          updates.status = 'in_progress';
          updates['git.lastSyncedStatus'] = 'in_progress';
        }
        // `unverifiable`-only no es un rechazo (D3): el status del flujo no se
        // toca, solo se escala la asignación.
        const currentLabels: string[] = Array.isArray(issue.labelIds) ? issue.labelIds : [];
        const labelId = await ensureNeedsHumanLabel(db, issue.workspaceId, issue.teamId);
        if (!currentLabels.includes(labelId)) {
          updates.labelIds = [...currentLabels, labelId];
        }
      }
      // 'approved': el status no cambia — el merge sigue siendo humano en el MVP.
    }

    updates.review = cleanUndefined(nextReview);
    await issueRef.update(updates);

    if (qaMode === 'enforce') {
      await this.notifyOutcome(db, issue, data.issueId, outcome, capped, actorUid, prs, verdict, needsHumanLeadId);
    }

    const commentBody = this.buildCommentBody(issue, outcome, capped, verdict, findings, criteriaResults, review.attempt, qaMode);
    await new CreateCommentAction({ actionCode: 'comments.create', data: { issueId: data.issueId, body: commentBody, source: 'mcp' } }, actorUid).run();

    if (installation) {
      await this.publishGithubReviews(installation, prs, outcome, verdict, findings, criteriaResults, issue, qaMode);
    }

    return { issueId: data.issueId, outcome, attempt: review.attempt, status: updates.status || issue.status, qaMode };
  }

  /**
   * Notificaciones del veredicto (D16/TES-212): además del comentario en el
   * issue (que ya notifica al assignee como parte del flujo genérico de
   * `comments.create`), cada desenlace tiene su propia audiencia y tipo —
   * distinto de simplemente "alguien comentó" — porque el destinatario que
   * importa no siempre es el assignee actual.
   */
  private async notifyOutcome(
    db: FirebaseFirestore.Firestore,
    issue: FirebaseFirestore.DocumentData,
    issueId: string,
    outcome: Outcome,
    capped: boolean,
    actorUid: string,
    prs: ReviewablePr[],
    verdict: string,
    needsHumanLeadId: string | undefined
  ): Promise<void> {
    if (outcome === 'needs_human') {
      const reason = capped
        ? 'Se agotaron los intentos de revisión.'
        : 'Hay un criterio de aceptación no verificable.';
      await notifyNeedsHuman(db, issue, issueId, needsHumanLeadId, actorUid, reason);
      return;
    }

    // approved/changes_requested van al creador y al lead del proyecto (no al
    // assignee, que ya se entera por el comentario del veredicto): son
    // quienes deciden el merge o le siguen el paso al issue, no quien lo
    // implementó.
    const leadId = await getProjectLeadId(db, issue.projectId);
    const recipients = new Set<string>([issue.creatorId, leadId].filter((id): id is string => Boolean(id)));

    if (outcome === 'approved') {
      const links = prs
        .map((pr) => pr.prUrl || `https://github.com/${pr.repoFullName}/pull/${pr.prNumber}`)
        .join('\n');
      for (const userId of recipients) {
        await createNotification(db, {
          workspaceId: issue.workspaceId,
          userId,
          actorId: actorUid,
          issueId,
          type: 'review_result',
          title: `${issue.identifier} aprobado por QA, listo para merge`,
          body: links || 'QA aprobó la revisión.',
        });
      }
    } else if (outcome === 'changes_requested') {
      for (const userId of recipients) {
        await createNotification(db, {
          workspaceId: issue.workspaceId,
          userId,
          actorId: actorUid,
          issueId,
          type: 'changes_requested',
          title: `${issue.identifier}: QA pidió cambios`,
          body: verdict,
        });
      }
    }
  }

  private buildCommentBody(
    issue: FirebaseFirestore.DocumentData,
    outcome: Outcome,
    capped: boolean,
    verdict: string,
    findings: ReviewFinding[],
    criteriaResults: ReviewCriterionResult[],
    attempt: number,
    qaMode: 'shadow' | 'enforce'
  ): string {
    const criteriaById = new Map<string, string>(((issue.acceptanceCriteria || []) as AcceptanceCriterion[]).map((c) => [c.id, c.text]));
    const outcomeLabel =
      outcome === 'approved'
        ? '✅ Aprobado'
        : outcome === 'changes_requested'
          ? '🔁 Cambios solicitados'
          : capped
            ? '🧑 Necesita humano (intentos agotados)'
            : '🧑 Necesita humano (criterio no verificable)';

    const lines = [`**Revisión de QA — intento ${attempt}: ${outcomeLabel}**`, ''];
    if (qaMode === 'shadow') {
      lines.push(
        '🌓 _Modo sombra: este veredicto no cambia el estado del issue ni dispara re-trabajo — es para calibrar al QA. El flujo sigue en manos de un humano._',
        ''
      );
    }
    lines.push(verdict);

    if (criteriaResults.length > 0) {
      lines.push('', '**Criterios**');
      for (const c of criteriaResults) {
        const icon = c.result === 'pass' ? '✅' : c.result === 'fail' ? '❌' : '❔';
        const text = criteriaById.get(c.criterionId) || c.criterionId;
        lines.push(`- ${icon} ${text}${c.evidence ? ` — ${c.evidence}` : ''}`);
      }
    }

    if (findings.length > 0) {
      lines.push('', '**Findings**');
      const icons: Record<string, string> = { blocker: '🚫', major: '⚠️', minor: '📝', nit: '💬' };
      for (const f of findings) {
        const loc = f.file ? ` (\`${f.file}${f.line ? `:${f.line}` : ''}\`)` : '';
        lines.push(`- ${icons[f.severity]} **${f.severity}**${loc}: ${f.message}`);
      }
    }

    return lines.join('\n');
  }

  private async publishGithubReviews(
    installation: FirebaseFirestore.DocumentData,
    prs: ReviewablePr[],
    outcome: Outcome,
    verdict: string,
    findings: ReviewFinding[],
    criteriaResults: ReviewCriterionResult[],
    issue: FirebaseFirestore.DocumentData,
    qaMode: 'shadow' | 'enforce'
  ): Promise<void> {
    const criteriaById = new Map<string, string>(((issue.acceptanceCriteria || []) as AcceptanceCriterion[]).map((c) => [c.id, c.text]));
    const outcomeLabel = outcome === 'approved' ? 'Approved' : outcome === 'changes_requested' ? 'Changes requested' : 'Needs a human';

    for (const pr of prs) {
      const inlineForThisPr = findings.filter((f) => f.file && f.line && (!f.repoFullName || f.repoFullName === pr.repoFullName));
      const bodyOnly = findings.filter((f) => !(f.file && f.line) && (!f.repoFullName || f.repoFullName === pr.repoFullName));

      const bodyLines = [`**Pulse QA review — ${outcomeLabel}**`, ''];
      if (qaMode === 'shadow') {
        bodyLines.push('_Shadow mode: this verdict is informational only, it does not block or change the issue._', '');
      }
      bodyLines.push(verdict);
      if (criteriaResults.length > 0) {
        bodyLines.push('', '**Criteria**');
        for (const c of criteriaResults) {
          const text = criteriaById.get(c.criterionId) || c.criterionId;
          bodyLines.push(`- [${c.result}] ${text}${c.evidence ? ` — ${c.evidence}` : ''}`);
        }
      }
      if (bodyOnly.length > 0) {
        bodyLines.push('', '**Other findings**');
        for (const f of bodyOnly) bodyLines.push(`- [${f.severity}] ${f.message}`);
      }

      const comments: PullRequestReviewComment[] = inlineForThisPr.map((f) => ({
        path: f.file!,
        line: f.line!,
        body: `**${f.severity}**: ${f.message}`,
      }));

      try {
        await createPullRequestReview(installation.installationId, pr.repoFullName, pr.prNumber, bodyLines.join('\n'), comments);
      } catch (error) {
        // Best-effort: la fuente de verdad es la revisión en Pulse. Un fallo
        // acá (ej. una línea fuera del rango del diff) no debe tumbar
        // `reviews.submit`.
        console.error(`[ReviewsSubmit] no se pudo publicar la review en ${pr.repoFullName}#${pr.prNumber}:`, error);
      }
    }
  }
}
