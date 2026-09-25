import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';
import { normalizeAcceptanceCriteria } from '../../common/utils/acceptance-criteria';
import { ISSUE_WRITABLE_FIELDS, pickWritableFields } from '../../common/utils/issue-fields';
import { canHaveChildren } from '../../common/domain.generated';
import { validateRepoForWorkspace } from '../../common/utils/repo-field';
import { upsertGitRef } from '../../common/utils/project-repos';
import { agentVisibility, getWorkspaceMember, isWorkspaceAdmin } from '../../common/utils/agent-authorization';
import {
  adjustParentCounters,
  childIdsOf,
  doneWeight,
  normalizeIssueType,
  recomputeSubtreeEpicId,
  resolvePlacement,
} from '../../common/utils/hierarchy';

export class UpdateIssueAction extends PlatformActionHandler {
  private issueId?: string;
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('issues.update', request, callerUid, callerEmail);
    this.issueId = request.data?.id;
  }

  // Loads the issue to authorize against its *real* workspaceId — trusting
  // a client-supplied workspaceId would let anyone update any workspace's
  // issue just by guessing/copying an issueId (same lesson as
  // comments.create / issues.claim).
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
    const issueId = data.id as string | undefined;

    if (!issueId) {
      throw new Error('Identificador de issue (id) es obligatorio para actualizar.');
    }

    const issueRef = db.collection('issues').doc(issueId);
    const snap = await issueRef.get();
    if (!snap.exists) {
      throw new Error(`El issue con ID '${issueId}' no existe.`);
    }
    const current = snap.data()!;

    // Whitelist, not a blind spread of `data`: this can be called from an MCP
    // tool driven by an LLM, and a spread would let it overwrite
    // server-owned fields like `workspaceId`, `identifier` or `creatorId`.
    const updates: Record<string, any> = {
      ...pickWritableFields(data, ISSUE_WRITABLE_FIELDS),
      updatedAt: new Date().toISOString(),
      // Le permite a `issueNotificationsTrigger` (TES-156) saber quién hizo el
      // cambio, para no notificarle a alguien su propia acción.
      updatedBy: this.caller.uid || 'system',
    };

    // TES-284: `assigneeId` representa a la persona responsable. Un agente
    // se elige por la action específica, así no puede reemplazar el dueño del
    // resultado ni saltar las reglas de visibilidad vía el update genérico.
    if ('assigneeId' in data) {
      const nextResponsible = data.assigneeId || null;
      const callerMember = await getWorkspaceMember(db, current.workspaceId, this.caller.uid!);
      const responsibilityChanged = nextResponsible !== (current.responsibleMemberId || current.assigneeId || null);
      if (nextResponsible) {
        const responsible = await getWorkspaceMember(db, current.workspaceId, nextResponsible);
        if (!responsible || responsible.isAgent) {
          throw new Error('El responsable debe ser un miembro humano. Elegí el agente ejecutor por separado.');
        }
        if (!isWorkspaceAdmin(callerMember) && nextResponsible !== this.caller.uid) {
          throw new Error('Solo un admin puede asignar un issue a otra persona.');
        }
      }
      updates.assigneeId = nextResponsible;
      updates.responsibleMemberId = nextResponsible;
      // Cambiar de responsable no arrastra una suscripción personal ajena.
      if (responsibilityChanged) {
        if (data.confirmKeepExecution === true) {
          if (!isWorkspaceAdmin(callerMember)) {
            throw new Error('Solo un admin puede conservar explícitamente un agente al reasignar el responsable.');
          }
          if (!nextResponsible) {
            throw new Error('Un agente ejecutor no puede conservarse sin un responsable humano.');
          }
          const executionAgentId = current.execution?.agentId;
          if (!executionAgentId) {
            throw new Error('No hay agente ejecutor para conservar.');
          }
          const executionAgentSnap = await db.collection('agents').doc(executionAgentId).get();
          if (!executionAgentSnap.exists || executionAgentSnap.data()!.workspaceId !== current.workspaceId) {
            throw new Error('El agente ejecutor actual ya no existe en este workspace.');
          }
          const executionAgent = executionAgentSnap.data()!;
          // Un admin no puede conservar silenciosamente el agente personal de
          // otra persona sobre un issue reasignado. Solo puede conservar su
          // propio agente personal en un issue que queda a su nombre; los
          // agentes públicos están precisamente hechos para este caso.
          if (
            agentVisibility(executionAgent) === 'personal' &&
            (executionAgent.ownerMemberId !== this.caller.uid || nextResponsible !== this.caller.uid)
          ) {
            throw new Error('Solo se puede conservar un agente personal si el admin es su dueño y sigue siendo el responsable.');
          }
        } else {
          updates.execution = FieldValue.delete();
        }
      }
    }

    // Igual que `type`/`parentId`: `pickWritableFields` ya copió el valor
    // crudo del caller arriba, y acá se pisa con la versión normalizada (ids
    // estables asignados a los criterios que no traían uno).
    if ('acceptanceCriteria' in data) {
      updates.acceptanceCriteria = normalizeAcceptanceCriteria(data.acceptanceCriteria) || [];
    }

    // Si `dueDate` cambia, cualquier alerta `due_soon` (F5) ya emitida para el
    // valor anterior deja de tener sentido — se resetea para permitir una
    // nueva cuando corresponda con la nueva fecha.
    if ('dueDate' in data && data.dueDate !== current.dueDate) {
      updates.dueSoonNotifiedAt = FieldValue.delete();
    }

    // --- Jerarquía --------------------------------------------------------
    // `type` y `parentId` están en la whitelist, así que ya vinieron copiados
    // arriba con el valor crudo del caller. Acá se revalidan y se reemplazan
    // por el resultado de `resolvePlacement`, que además deriva `epicId`
    // (nunca aceptado del payload).
    const touchesHierarchy = 'type' in data || 'parentId' in data;

    const nextType = normalizeIssueType('type' in data ? data.type : current.type);
    const previousParentId: string | null = current.parentId || null;
    const nextParentIdRaw: string | null =
      'parentId' in data ? data.parentId || null : previousParentId;

    let nextParentId = previousParentId;
    let nextEpicId: string | null = current.epicId || null;

    if (touchesHierarchy) {
      // Cambiar el tipo a uno que no admite hijos rompería a los que ya tiene.
      if (nextType !== normalizeIssueType(current.type) && !canHaveChildren(nextType)) {
        const children = await childIdsOf(db, issueId);
        if (children.length > 0) {
          throw new Error(
            `No se puede cambiar el tipo a '${nextType}': el issue tiene ${children.length} ` +
              'sub-issue(s). Movelos o eliminalos primero.'
          );
        }
      }

      const placement = await resolvePlacement(db, {
        workspaceId: current.workspaceId,
        type: nextType,
        parentId: nextParentIdRaw,
        issueId,
      });

      nextParentId = placement.parentId;
      nextEpicId = placement.epicId;

      updates.type = placement.type;
      updates.parentId = placement.parentId ?? FieldValue.delete();
      updates.epicId = placement.epicId ?? FieldValue.delete();
    }

    // --- Repo ------------------------------------------------------------
    // `git.repoFullName` va anidado, así que no puede pasar por la whitelist
    // (que mapea nombres de campo planos). Se acepta como `repoFullName` a
    // nivel raíz y se escribe en su lugar real. Cadena vacía o null lo borran,
    // que es cómo la UI dice "volvé a heredar de la épica".
    if ('repoFullName' in data) {
      const repo = data.repoFullName || null;
      const previousRepo: string | null = current.git?.repoFullName || null;
      if (repo) {
        await validateRepoForWorkspace(db, current.workspaceId, repo);
        updates['git.repoFullName'] = repo;
      } else {
        updates['git.repoFullName'] = FieldValue.delete();
      }

      // Cambiar el repo invalida la rama principal: esa rama vive en el repo
      // *anterior*. Antes solo se pisaba `git.repoFullName` y quedaban `branch`
      // y `branchUrl` del otro repo — TES-130 terminó diciendo "rama X en
      // pulse-app" cuando X estaba en pulse-backend, y el agente que la tomó no
      // encontró ninguna rama que trabajar.
      //
      // Si esa rama llegó a tener PR, es trabajo real y se conserva en
      // `gitRefs`; una rama sin PR se descarta (el caso típico es un run mal
      // ruteado que abandonó la rama).
      if (repo !== previousRepo && current.git?.branch) {
        if (current.git.prNumber !== undefined && previousRepo) {
          updates.gitRefs = upsertGitRef(current.gitRefs, {
            repoFullName: previousRepo,
            branch: current.git.branch,
            branchUrl: current.git.branchUrl,
            baseBranch: current.git.baseBranch,
            prNumber: current.git.prNumber,
            prUrl: current.git.prUrl,
            prState: current.git.prState,
          });
        }
        for (const f of ['branch', 'branchUrl', 'baseBranch', 'prNumber', 'prUrl', 'prState', 'lastSyncedAt', 'lastSyncedStatus']) {
          updates[`git.${f}`] = FieldValue.delete();
        }
      }
      delete updates.repoFullName;
    }

    await issueRef.update(cleanUndefined(updates));

    // --- Contadores del padre --------------------------------------------
    // Después del write, para no dejar contadores movidos si el update falla.
    const previousDone = doneWeight(current.status);
    const nextDone = doneWeight('status' in data ? data.status : current.status);

    if (nextParentId !== previousParentId) {
      await adjustParentCounters(db, previousParentId, -1, -previousDone);
      await adjustParentCounters(db, nextParentId, 1, nextDone);
      // Las sub-tareas siguen a su historia cuando cambia de épica.
      await recomputeSubtreeEpicId(db, issueId, nextEpicId);
    } else if (nextDone !== previousDone) {
      await adjustParentCounters(db, previousParentId, 0, nextDone - previousDone);
    }

    return { id: issueId, ...updates };
  }
}
