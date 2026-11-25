import { getFirestore } from 'firebase-admin/firestore';
import { nanoid } from 'nanoid';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import type { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { validateView } from './validation';

type Mode = 'create' | 'update' | 'delete';
export class SavedViewAction extends PlatformActionHandler {
  private mode: Mode;
  private workspaceId?: string;
  private existing?: FirebaseFirestore.DocumentData;
  constructor(mode: Mode, request: PlatformActionRequest, uid?: string, email?: string) {
    super(`views.${mode}`, request, uid, email);
    this.mode = mode;
  }
  protected auditResponse(response: Record<string, any>): Record<string, any> { return { id: response.id }; }
  protected async authorize(): Promise<boolean> {
    const uid = this.caller.uid;
    if (!uid) return false;
    const db = getFirestore();
    if (this.mode === 'create') this.workspaceId = this.action.data.workspaceId;
    else {
      if (typeof this.action.data.id !== 'string' || this.action.data.id.includes('/')) return false;
      const snap = await db.collection('saved_views').doc(this.action.data.id).get();
      if (!snap.exists) return false;
      this.existing = snap.data(); this.workspaceId = this.existing?.workspaceId;
    }
    if (typeof this.workspaceId !== 'string' || !this.workspaceId || this.workspaceId.includes('/')) return false;
    const member = await db.collection('members').doc(`${this.workspaceId}_${uid}`).get();
    if (!member.exists || member.data()?.isAgent) return false;
    if (this.mode === 'create') return true;
    const view = this.existing!;
    return view.ownerId === uid || (view.shared === true && !!view.systemKey && ['admin', 'owner'].includes(member.data()?.role));
  }
  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore(); const uid = this.caller.uid!; const workspaceId = this.workspaceId!; const data = this.action.data;
    if (this.mode !== 'create' && ['workspaceId', 'ownerId', 'createdAt', 'updatedAt', 'systemKey'].some(key => key in data)) throw new Error('No se puede modificar la identidad ni los metadatos de la vista.');
    if (this.mode === 'create' && ['ownerId', 'createdAt', 'updatedAt', 'systemKey', 'id'].some(key => key in data)) throw new Error('Los metadatos los fija el servidor.');
    if (this.mode === 'update' && (typeof data.expectedUpdatedAt !== 'string' || !data.expectedUpdatedAt)) throw new Error('Falta la versión de la vista; recargala antes de guardar.');
    const id = this.mode === 'create' ? `view-${nanoid(10)}` : data.id;
    const ref = db.collection('saved_views').doc(id);
    const mutable = ['teamId', 'name', 'icon', 'query', 'queryVersion', 'grouping', 'ordering', 'display', 'shared'];
    const input: Record<string, any> = {};
    for (const key of mutable) if (this.existing && key in this.existing) input[key] = this.existing[key];
    for (const key of Object.keys(data)) {
      if (!mutable.includes(key) && !['id', 'workspaceId', ...(this.mode === 'update' ? ['expectedUpdatedAt'] : [])].includes(key)) throw new Error(`Campo no editable: ${key}.`);
      if (mutable.includes(key)) input[key] = data[key];
    }
    const validated = this.mode === 'delete' ? null : await validateView(input, workspaceId, uid);
    if (this.existing?.systemKey && validated && !validated.shared) throw new Error('Las vistas de sistema deben permanecer compartidas.');
    return db.runTransaction(async tx => {
      const member = await tx.get(db.collection('members').doc(`${workspaceId}_${uid}`));
      const current = this.mode === 'create' ? null : await tx.get(ref);
      if (!member.exists || member.data()?.isAgent) throw new Error('Vista no disponible o no autorizada.');
      if (current) {
        if (!current.exists || current.data()?.workspaceId !== workspaceId) throw new Error('Vista no disponible o no autorizada.');
        const view = current.data()!;
        if (view.updatedAt !== this.existing?.updatedAt) throw new Error('La vista cambió; recargala antes de guardar.');
        if (this.mode === 'update' && view.updatedAt !== data.expectedUpdatedAt) throw new Error('La vista cambió desde que la abriste. Descartá los cambios para cargar la versión actual o guardá una copia.');
        if (view.ownerId !== uid && !(view.shared === true && view.systemKey && ['owner', 'admin'].includes(member.data()?.role))) throw new Error('Vista no disponible o no autorizada.');
        if (this.mode === 'delete') { tx.delete(ref); return { id }; }
      }
      if (validated?.teamId) {
        const team = await tx.get(db.collection('teams').doc(validated.teamId));
        if (!team.exists || team.data()?.workspaceId !== workspaceId) throw new Error('Equipo no disponible.');
      }
      const previous = current?.data()?.updatedAt;
      const previousMs = typeof previous === 'string' ? Date.parse(previous) : NaN;
      const now = new Date(Math.max(Date.now(), Number.isFinite(previousMs) ? previousMs + 1 : 0)).toISOString();
      const view = { id, workspaceId, ownerId: current?.data()?.ownerId ?? uid, createdAt: current?.data()?.createdAt ?? now, updatedAt: now, ...(current?.data()?.systemKey ? { systemKey: current.data()!.systemKey } : {}), ...validated };
      tx.set(ref, view);
      return view;
    });
  }
}
