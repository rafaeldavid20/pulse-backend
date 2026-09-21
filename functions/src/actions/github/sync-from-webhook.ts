import { getFirestore } from 'firebase-admin/firestore';
import { nanoid } from 'nanoid';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { findIssue } from '../../mcp/tools/read';
import { identifierFromBranch, identifierFromClosesKeyword } from '../../common/utils/issue-refs';
import { upsertGitRef, statusFromGitRefs } from '../../common/utils/project-repos';
import { orphanPendingWork, uncoveredNotMetCriteria } from '../../common/utils/pending-work';
import { MANUAL_WORK_LABEL, MANUAL_WORK_LABEL_COLOR, ensureLabel, withLabel } from '../../common/utils/labels';
import { resolveReviewLead } from '../../common/utils/review-escalation';
import { createNotification } from '../../common/utils/notifications';

interface WebhookSyncInput {
  event: 'create' | 'pull_request';
  repoFullName: string;
  branch: string;
  headSha?: string;
  prAction?: string;
  prNumber?: number;
  prUrl?: string;
  prTitle?: string;
  prBody?: string;
  merged?: boolean;
  draft?: boolean;
}

/**
 * The GitHub webhook's only job after signature verification: figure out
 * which issue (if any) a push/PR event is about, and apply the matching
 * status transition — without a human caller, so it runs `isFromSystem`
 * (see PlatformActionHandler's default `authorize()`). The webhook handler
 * is what actually gates this: it never reaches dispatch without a verified
 * HMAC signature.
 */
export class SyncFromWebhookAction extends PlatformActionHandler {
  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('github.syncFromWebhook', request, callerUid, callerEmail);
  }

  // The base class no longer grants access to `isFromSystem` callers by
  // default (see handler.ts) — this action is the one legitimate exception,
  // so it opts in explicitly. The real gate is the HMAC signature check in
  // webhook.ts, which runs before this action is ever dispatched.
  protected async authorize(): Promise<boolean> {
    return this.caller.isFromSystem;
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const input = this.action.data as WebhookSyncInput;

    if (!input.repoFullName || !input.branch || !input.event) {
      throw new Error('Parámetros requeridos faltantes: event, repoFullName, branch.');
    }

    const installSnap = await db
      .collection('github_installations')
      .where('repositoryFullNames', 'array-contains', input.repoFullName)
      .limit(1)
      .get();
    if (installSnap.empty) {
      return { matched: false, reason: 'no_installation_for_repo' };
    }
    const workspaceId = installSnap.docs[0].data().workspaceId as string;

    const issueDoc = await this.resolveIssue(workspaceId, input);
    if (!issueDoc) {
      return { matched: false, reason: 'no_matching_issue' };
    }
    const issue = issueDoc.data()!;

    // La entrada de ESTE repo se actualiza sin tocar las de los otros: un issue
    // puede tener ramas en varios repos y el evento habla de uno solo.
    const refEntry: Record<string, any> = {
      repoFullName: input.repoFullName,
      branch: input.branch,
      lastSyncedAt: new Date().toISOString(),
    };
    if (input.prNumber !== undefined) refEntry.prNumber = input.prNumber;
    if (input.prUrl !== undefined) refEntry.prUrl = input.prUrl;
    if (input.event === 'pull_request') {
      refEntry.prState = input.merged ? 'merged' : input.draft ? 'draft' : this.prStateFor(input.prAction);
      refEntry.merged = !!input.merged;
      // Fuente de verdad del SHA revisable (D10/TES-206): antes solo se
      // conocía pidiéndolo en vivo a GitHub (ver el anti-ping-pong de D4 en
      // `qa-dispatch.ts`), y sin `synchronize` procesado acá tampoco se
      // actualizaba en cada push.
      if (input.headSha) {
        refEntry.headSha = input.headSha;
        refEntry.headShaAt = new Date().toISOString();
      }
    }
    const nextRefs = upsertGitRef(issue.gitRefs, refEntry);

    // Push nuevo sobre una revisión ya aprobada (D3/D10): la aprobación era de
    // otro código, así que no puede seguir contando como vigente.
    const isNewPush = input.event === 'pull_request' && input.prAction === 'synchronize';
    const reviewGoesStale = isNewPush && issue.review?.state === 'approved';

    // El veredicto vigente revisó un PR que ya no es de este issue (TES-242).
    // Pasa cuando una rama ajena se emparejó por convención de nombre, QA la
    // revisó, y después llegó el PR verdadero: `gitRefs` apunta a uno y
    // `review.prs` a otro, sin que nada lo señale. Ese veredicto no puede
    // seguir contando —sus findings son sobre otro código— ni puede haber
    // consumido un intento: se marca `stale` y el contador vuelve a cero para
    // que la revisión real empiece limpia.
    const reviewedPrNumbers: number[] = (issue.review?.prs || [])
      .map((p: any) => p?.prNumber)
      .filter((n: unknown): n is number => typeof n === 'number');
    const livePrNumbers = new Set(
      nextRefs.map((r: any) => r?.prNumber).filter((n: unknown): n is number => typeof n === 'number')
    );
    const reviewIsOrphaned =
      !!issue.review?.state &&
      issue.review.state !== 'stale' &&
      reviewedPrNumbers.length > 0 &&
      livePrNumbers.size > 0 &&
      reviewedPrNumbers.every((n) => !livePrNumbers.has(n));

    // Con varias ramas, el estado sale del conjunto y no de este evento suelto:
    // `in_review` cuando TODOS los PRs están abiertos, `done` cuando todos están
    // mergeados. Un issue cuyo cambio de backend se mergeó pero cuyo cambio de
    // modelo sigue abierto no está terminado.
    //
    // Con una sola rama, la regla del conjunto y la de siempre coinciden, así
    // que los issues de un repo se comportan igual que antes.
    // El PR de este repo cierra su traspaso (TES-202). Los que quedan son trabajo
    // que otro repo todavía no hizo: mientras haya alguno, el issue no puede
    // pasar a `in_review` ni a `done` — se queda en `in_progress` a la vista,
    // en vez de dar por terminado un issue a medias.
    const hasPr = input.event === 'pull_request' && input.prNumber !== undefined;
    const nextPending = (issue.pendingRepoWork || []).filter(
      (e: any) => !(hasPr && e.repoFullName === input.repoFullName)
    );
    const pendingClosed = nextPending.length !== (issue.pendingRepoWork || []).length;

    const computed =
      nextRefs.length > 1
        ? statusFromGitRefs(nextRefs)
        : this.desiredStatus(input, issue.status);
    const afterRepoWork =
      nextPending.length > 0 && (computed === 'in_review' || computed === 'done') ? 'in_progress' : computed;

    // Invariante de TES-219: un merge no cierra un issue que dejó trabajo
    // declarado sin dueño. Dos casos, los dos con el mismo desenlace — el
    // issue se queda en `in_review` etiquetado, en vez de irse a `done` con el
    // pendiente enterrado en el cuerpo del PR (que es exactamente lo que pasó
    // con TES-218):
    //  - un criterio que el dev declaró `not_met` y que ningún follow-up hereda;
    //  - un pendiente declarado cuyo issue de seguimiento no se llegó a crear.
    //
    // Lo que NO bloquea: un criterio `not_met` que ya tiene su follow-up. Esa
    // es la decisión de diseño de la historia — el pendiente sobrevive en un
    // issue propio y el padre puede cerrar, porque hay trabajo (credenciales
    // de producción, una decisión de producto) que este issue no va a poder
    // terminar nunca y dejarlo abierto para siempre solo agrega ruido.
    const uncovered = uncoveredNotMetCriteria(issue);
    const orphans = orphanPendingWork(issue);
    const blockedByPendingWork = afterRepoWork === 'done' && (uncovered.length > 0 || orphans.length > 0);
    const desiredStatus = blockedByPendingWork ? 'in_review' : afterRepoWork;

    // Manual-override guard: if a human moved the status away from the
    // status *we* last set via sync, a webhook event shouldn't silently
    // pull it back — that's how "I moved it back to todo because the PR
    // needs rework" gets undone by the next push event.
    const overriddenManually =
      desiredStatus && issue.git?.lastSyncedStatus && issue.status !== issue.git.lastSyncedStatus;

    const now = new Date().toISOString();
    const updates: Record<string, any> = {
      gitRefs: nextRefs,
      ...(pendingClosed ? { pendingRepoWork: nextPending } : {}),
      'git.lastSyncedAt': now,
      updatedAt: now,
    };

    // `git` solo se mueve si el evento habla de la rama principal; si no, un
    // push en el repo secundario reapuntaría el ruteo del dispatch.
    const isPrimary = !issue.git?.branch || issue.git.repoFullName === input.repoFullName;
    if (isPrimary) {
      updates['git.repoFullName'] = input.repoFullName;
      updates['git.branch'] = input.branch;
    }
    if (isPrimary) {
      if (input.prNumber !== undefined) updates['git.prNumber'] = input.prNumber;
      if (input.prUrl !== undefined) updates['git.prUrl'] = input.prUrl;
      if (input.event === 'pull_request') {
        updates['git.prState'] = refEntry.prState;
      }
    }

    let statusChanged = false;
    if (desiredStatus && !overriddenManually && desiredStatus !== issue.status) {
      updates.status = desiredStatus;
      updates['git.lastSyncedStatus'] = desiredStatus;
      // Sentinel de sistema, no un uid — mismo criterio que `authorId: 'github'`
      // en `postComment`. Le dice a `issueNotificationsTrigger` (TES-156) que
      // este cambio no lo hizo el propio asignado.
      updates.updatedBy = 'github';
      if (desiredStatus === 'done') {
        updates['agent.state'] = 'idle';
      }
      statusChanged = true;
    }

    if (reviewGoesStale || reviewIsOrphaned) {
      updates['review.state'] = 'stale';
    }
    if (reviewIsOrphaned) {
      updates['review.attempt'] = 0;
    }

    if (blockedByPendingWork) {
      const labelId = await ensureLabel(
        db,
        issue.workspaceId,
        issue.teamId,
        MANUAL_WORK_LABEL,
        MANUAL_WORK_LABEL_COLOR
      );
      const nextLabels = withLabel(issue.labelIds, labelId);
      if (nextLabels) updates.labelIds = nextLabels;
    }

    await issueDoc.ref.update(updates);

    if (blockedByPendingWork) {
      await this.notifyBlockedClose(db, issue, issueDoc.id, uncovered, orphans.length);
    }

    if (input.event === 'pull_request' && input.prAction === 'closed') {
      await this.recordQaCalibration(db, workspaceId, issueDoc.id, issue, input);
    }

    if (blockedByPendingWork) {
      const detail = uncovered.length
        ? `hay ${uncovered.length} criterio(s) declarado(s) \`not_met\` sin un issue de seguimiento que los herede`
        : `hay ${orphans.length} pendiente(s) declarado(s) sin issue de seguimiento`;
      await this.postComment(
        db,
        workspaceId,
        issueDoc.id,
        `GitHub: ${this.describeEvent(input)}, pero el issue **no se cerró**: ${detail}. ` +
          'Creá el seguimiento con `pulse_report_pending_work` (o a mano) y movelo a `done` cuando el pendiente tenga dueño.'
      );
    } else if (statusChanged) {
      await this.postComment(
        db,
        workspaceId,
        issueDoc.id,
        `GitHub: ${this.describeEvent(input)} → estado actualizado a \`${desiredStatus}\`.`
      );
    } else if (reviewIsOrphaned) {
      await this.postComment(
        db,
        workspaceId,
        issueDoc.id,
        `GitHub: ${this.describeEvent(input)}. La revisión anterior había mirado el PR ` +
          `#${reviewedPrNumbers.join(', #')}, que ya no es de este issue: queda marcada como \`stale\` y no cuenta ` +
          'como intento. La revisión se rehace sobre el PR vigente.'
      );
    } else if (reviewGoesStale) {
      await this.postComment(
        db,
        workspaceId,
        issueDoc.id,
        `GitHub: ${this.describeEvent(input)} → la aprobación de QA quedó desactualizada (\`stale\`), había código nuevo después de aprobar.`
      );
    } else if (overriddenManually) {
      await this.postComment(
        db,
        workspaceId,
        issueDoc.id,
        `GitHub: ${this.describeEvent(input)}, pero el estado se dejó sin tocar porque alguien lo cambió manualmente después del último sync.`
      );
    }

    return { matched: true, issueId: issueDoc.id, statusChanged, newStatus: statusChanged ? desiredStatus : issue.status };
  }

  /**
   * El issue quedó sin cerrar por un pendiente sin dueño: eso tiene que llegarle
   * a una persona. La etiqueta sola no alcanza — solo la ve quien filtre por
   * ella, y el punto de TES-219 es que nadie vuelve a mirar lo que no le
   * llega. Va como `needs_human` (el tipo que no se puede silenciar por
   * preferencia) al lead del proyecto, o a quien creó el issue si no hay lead.
   */
  private async notifyBlockedClose(
    db: FirebaseFirestore.Firestore,
    issue: FirebaseFirestore.DocumentData,
    issueId: string,
    uncovered: string[],
    orphanCount: number
  ): Promise<void> {
    const responsibleId = await resolveReviewLead(db, issue);
    if (!responsibleId) return;
    const body = uncovered.length
      ? `El PR se mergeó pero ${uncovered.length} criterio(s) siguen declarados como no cumplidos y nadie los heredó.`
      : `El PR se mergeó pero ${orphanCount} pendiente(s) declarado(s) no llegaron a tener issue de seguimiento.`;
    await createNotification(db, {
      workspaceId: issue.workspaceId,
      userId: responsibleId,
      actorId: 'github',
      issueId,
      type: 'needs_human',
      title: `${issue.identifier} no se cerró: quedó trabajo sin dueño`,
      body,
    });
  }

  /**
   * Rama que el issue ya tiene registrada en este repo, si tiene alguna:
   * `gitRefs` primero (multi-repo, K9/TES-202) y `git` como respaldo para los
   * issues anteriores a ese campo.
   */
  private registeredBranchForIssue(issue: FirebaseFirestore.DocumentData, repoFullName: string): string | undefined {
    const refs: any[] = Array.isArray(issue.gitRefs) ? issue.gitRefs : [];
    const ref = refs.find((r) => r?.repoFullName === repoFullName && r?.branch);
    if (ref) return ref.branch as string;
    if (issue.git?.repoFullName === repoFullName && issue.git?.branch) return issue.git.branch as string;
    return undefined;
  }

  private async resolveIssue(workspaceId: string, input: WebhookSyncInput) {
    const db = getFirestore();

    // Level 1: the issue already links to this exact repo+branch.
    const byGitFields = await db
      .collection('issues')
      .where('workspaceId', '==', workspaceId)
      .where('git.repoFullName', '==', input.repoFullName)
      .where('git.branch', '==', input.branch)
      .limit(1)
      .get();
    if (!byGitFields.empty) return byGitFields.docs[0];

    // Level 2: branch naming convention (pul/eng-142-slug).
    //
    // La convención empareja por NOMBRE, así que cualquier rama que se llame
    // `pul/tes-241-...` queda atada a TES-241 — incluida una que no es el
    // trabajo del issue (TES-242: una rama que preparaba el terreno secuestró
    // el issue, lo mandó a `in_review` y disparó QA contra el diff
    // equivocado). Con QA en `enforce` eso despacha re-trabajo pagado sobre
    // findings que no corresponden.
    //
    // Regla: la convención sólo decide cuando el issue TODAVÍA no tiene una
    // rama registrada en este repo. Si ya tiene una —la creó `createBranch`, o
    // la registró un push anterior— esa es la rama del issue, y otra con
    // nombre parecido no la reemplaza por llamarse igual.
    const fromBranch = identifierFromBranch(input.branch);
    if (fromBranch) {
      const doc = await findIssue(workspaceId, fromBranch);
      if (doc) {
        const registered = this.registeredBranchForIssue(doc.data()!, input.repoFullName);
        if (!registered || registered === input.branch) return doc;
        console.log(
          `[SyncFromWebhook] la rama '${input.branch}' matchea por convención con '${fromBranch}', ` +
            `pero ese issue ya tiene registrada la rama '${registered}' en '${input.repoFullName}': no se empareja.`
        );
      }
    }

    // Level 3: "Closes ENG-142" in the PR title/body.
    if (input.event === 'pull_request') {
      const fromText = identifierFromClosesKeyword(`${input.prTitle || ''}\n${input.prBody || ''}`);
      if (fromText) {
        const doc = await findIssue(workspaceId, fromText);
        if (doc) return doc;
      }
    }

    return null;
  }

  private desiredStatus(input: WebhookSyncInput, currentStatus: string): string | null {
    if (input.event === 'create') {
      return currentStatus === 'todo' ? 'in_progress' : null;
    }
    // pull_request
    //
    // `synchronize` (push nuevo a un PR abierto) es lo que cierra el ciclo
    // rechazo → push → `in_review` sin intervención humana (D10/TES-206): sin
    // procesarlo acá, un issue que `reviews.submit` dejó en `in_progress`
    // nunca volvía a `in_review` después del re-trabajo del dev.
    // `converted_to_draft` siempre llega con `draft: true`, así que cae en la
    // misma rama que las demás y empuja a `in_progress`.
    if (['opened', 'reopened', 'ready_for_review', 'synchronize', 'converted_to_draft'].includes(input.prAction || '')) {
      return input.draft ? 'in_progress' : 'in_review';
    }
    if (input.prAction === 'closed') {
      return input.merged ? 'done' : 'in_progress';
    }
    return null;
  }

  private prStateFor(prAction?: string): 'open' | 'closed' {
    return prAction === 'closed' ? 'closed' : 'open';
  }

  private describeEvent(input: WebhookSyncInput): string {
    if (input.event === 'create') return `se creó la rama \`${input.branch}\``;
    if (input.prAction === 'closed' && input.merged) return `el PR #${input.prNumber} se mergeó`;
    if (input.prAction === 'closed') return `el PR #${input.prNumber} se cerró sin mergear`;
    if (input.prAction === 'synchronize') return `el PR #${input.prNumber} recibió un push nuevo`;
    return `el PR #${input.prNumber} pasó a "${input.prAction}"`;
  }

  /**
   * Calibración del modo sombra (D17): cuando el humano cierra el PR (merge o
   * close sin merge), compara ese desenlace con el último veredicto de QA
   * registrado en el issue — `approved + merged = acuerdo`,
   * `changes_requested + merged sin cambios = desacuerdo` (y sus simétricos).
   * `needs_human`/`stale`/`running` no dan una señal clara y se ignoran.
   *
   * `changes_requested` solo llega hasta acá "sin cambios" porque cualquier
   * push nuevo después del veredicto ya lo marcó `stale` (`reviewGoesStale`
   * arriba, en el evento `synchronize` anterior a este `closed`).
   *
   * El id del doc es determinístico (`issueId_attempt`): un issue multi-repo
   * (`gitRefs[]`) puede cerrar varios PRs para el mismo intento, y el webhook
   * puede reintentar la entrega — las dos cosas deben pisar el mismo registro,
   * no duplicarlo.
   */
  private async recordQaCalibration(
    db: FirebaseFirestore.Firestore,
    workspaceId: string,
    issueId: string,
    issue: FirebaseFirestore.DocumentData,
    input: WebhookSyncInput
  ): Promise<void> {
    const review = issue.review as Record<string, any> | undefined;
    if (!review?.reviewerId || (review.state !== 'approved' && review.state !== 'changes_requested')) return;

    const merged = !!input.merged;
    const agreed = review.state === 'approved' ? merged : !merged;

    const recordId = `${issueId}_${review.attempt}`;
    await db
      .collection('qa_calibration_records')
      .doc(recordId)
      .set({
        id: recordId,
        workspaceId,
        agentId: review.reviewerId,
        issueId,
        issueIdentifier: issue.identifier,
        attempt: review.attempt,
        verdict: review.state,
        humanOutcome: merged ? 'merged' : 'closed_unmerged',
        agreed,
        repoFullName: input.repoFullName,
        prNumber: input.prNumber,
        decidedAt: new Date().toISOString(),
      });
  }

  private async postComment(db: FirebaseFirestore.Firestore, workspaceId: string, issueId: string, body: string) {
    const commentId = `cmt-${nanoid(8)}`;
    await db.collection('comments').doc(commentId).set({
      id: commentId,
      workspaceId,
      issueId,
      authorId: 'github',
      body,
      source: 'github',
      createdAt: new Date().toISOString(),
    });
  }
}
