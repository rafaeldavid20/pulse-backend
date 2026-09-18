import { getFirestore } from 'firebase-admin/firestore';
import { nanoid } from 'nanoid';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { allowedReposForIssue, assertRepoAllowed } from '../../common/utils/project-repos';

/**
 * Registra en el issue trabajo pendiente en OTRO repo (TES-202).
 *
 * Un run solo tiene credenciales sobre el repo que lo recibió, así que cuando
 * descubre que hace falta un cambio en otro no lo empuja: lo deja anotado acá y
 * `agentDispatchTrigger` despacha un run nuevo al repo destino cuando este
 * termina. La entrada vive en `issue.pendingRepoWork` (estructurada, para que el
 * run siguiente no dependa de interpretar texto libre) y además se publica como
 * comentario, que es lo que ven las personas en la Activity.
 *
 * Falla —con un mensaje que el agente ve— si el destino no se puede trabajar:
 * fuera de la instalación, fuera de los repos del proyecto, o sin el workflow
 * del agente conectado. Es mejor rechazar acá que dejar un traspaso que nadie
 * va a tomar.
 */
export class RequestRepoWorkAction extends PlatformActionHandler {
  private issueId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('issues.requestRepoWork', request, callerUid, callerEmail);
    this.issueId = request.data?.issueId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.issueId) return false;
    const snap = await getFirestore().collection('issues').doc(this.issueId).get();
    if (!snap.exists) return false;
    return this.isWorkspaceMember(snap.data()!.workspaceId);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;

    const repoFullName = String(data.repoFullName || '').trim();
    const summary = String(data.summary || '').trim();
    if (!data.issueId || !repoFullName || !summary) {
      throw new Error('Parámetros requeridos faltantes: issueId, repoFullName, summary.');
    }

    const issueRef = db.collection('issues').doc(data.issueId);
    const snap = await issueRef.get();
    if (!snap.exists) throw new Error(`El issue con ID '${data.issueId}' no existe.`);
    const issue = snap.data()!;

    const installSnap = await db
      .collection('github_installations')
      .where('workspaceId', '==', issue.workspaceId)
      .limit(1)
      .get();
    if (installSnap.empty) {
      throw new Error('Este workspace no tiene GitHub conectado todavía (Settings → GitHub).');
    }
    const installed: string[] = installSnap.docs[0].data().repositoryFullNames || [];
    const allowed = await allowedReposForIssue(db, issue, installed);
    assertRepoAllowed(repoFullName, allowed, `el proyecto de ${issue.identifier}`);

    // Sin workflow en el destino el dispatch no arranca nada: el traspaso
    // quedaría pendiente para siempre sin que nadie se entere.
    const agentId = issue.assigneeId || this.caller.uid;
    const agentSnap = agentId ? await db.collection('agents').doc(agentId).get() : null;
    const connected: Array<{ repoFullName: string }> = agentSnap?.exists ? agentSnap.data()!.connectedRepos || [] : [];
    if (!connected.some((r) => r.repoFullName === repoFullName)) {
      throw new Error(
        `'${repoFullName}' no tiene el workflow del agente conectado (agents.connectRepo), así que ningún run podría retomar el trabajo ahí. ` +
          `Repos conectados: ${connected.map((r) => r.repoFullName).join(', ') || 'ninguno'}.`
      );
    }

    const now = new Date().toISOString();
    const entry: Record<string, any> = {
      repoFullName,
      summary,
      requestedBy: this.caller.uid || 'system',
      requestedAt: now,
    };
    if (data.done) entry.done = String(data.done).trim();
    if (data.sourceRepoFullName) entry.sourceRepoFullName = data.sourceRepoFullName;
    if (data.sourceBranch) entry.sourceBranch = data.sourceBranch;
    if (data.sourcePrNumber !== undefined) entry.sourcePrNumber = data.sourcePrNumber;

    // Un repo, una entrada: pedir de nuevo lo mismo reemplaza el pedido (y
    // vuelve a quedar sin despachar), no lo duplica.
    const pending = (issue.pendingRepoWork || []).filter((e: any) => e.repoFullName !== repoFullName);
    pending.push(entry);

    const updates: Record<string, any> = { pendingRepoWork: pending, updatedAt: now, updatedBy: this.caller.uid || 'system' };
    // Si el PR de este repo ya se abrió y el webhook lo pasó a `in_review`, con
    // trabajo pendiente en otro repo ya no lo está. Se registra como el estado
    // del último sync para que el guard de override manual del webhook no lo
    // tome por un cambio hecho a mano.
    if (issue.status === 'in_review') {
      updates.status = 'in_progress';
      updates['git.lastSyncedStatus'] = 'in_progress';
    }
    await issueRef.update(updates);

    const commentId = `cmt-${nanoid(8)}`;
    const lines = [
      `**Traspaso a \`${repoFullName}\`** — falta trabajo en otro repo; un run nuevo lo retoma cuando este termine.`,
      '',
      `**Qué falta:** ${summary}`,
    ];
    if (entry.done) lines.push('', `**Ya hecho:** ${entry.done}`);
    const from = [entry.sourceRepoFullName, entry.sourceBranch].filter(Boolean).join(' @ ');
    if (from) lines.push('', `**Origen:** ${from}${entry.sourcePrNumber ? ` (PR #${entry.sourcePrNumber})` : ''}`);
    await db.collection('comments').doc(commentId).set({
      id: commentId,
      workspaceId: issue.workspaceId,
      issueId: data.issueId,
      authorId: this.caller.uid || 'system',
      body: lines.join('\n'),
      source: 'mcp',
      createdAt: now,
    });

    return { issueId: data.issueId, pendingRepoWork: pending };
  }
}
