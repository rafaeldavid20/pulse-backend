import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { ENVIRONMENT_WRITABLE_FIELDS } from '../../common/domain.generated';
import { cleanUndefined } from '../../common/utils/clean';
import { loadEnvironmentForWorkspace, sanitizeEnvironment, VALID_TEST_LEVELS } from './shared';

/**
 * Cambia la configuración de un entorno ya conectado. Deliberadamente **no**
 * toca `key`, `repoFullName`, `provider` ni nada de `salesforce`: la clave
 * está grabada en el nombre del secret de cada repo conectado, y la org es la
 * que autorizó el usuario. Cambiar cualquiera de esas cosas es reconectar.
 */
export class UpdateEnvironmentAction extends PlatformActionHandler {
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('environments.update', request, callerUid, callerEmail);
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
    const data = this.action.data;
    const environmentId: string = data.environmentId;
    const current = await loadEnvironmentForWorkspace(environmentId, this.resolvedWorkspaceId!);

    const updates: Record<string, any> = {};
    for (const field of ENVIRONMENT_WRITABLE_FIELDS) {
      if (data[field] !== undefined) updates[field] = data[field];
    }
    if (Object.keys(updates).length === 0) {
      throw new Error('No hay campos modificables en la solicitud.');
    }

    if (updates.defaultTestLevel && !VALID_TEST_LEVELS.includes(updates.defaultTestLevel)) {
      throw new Error(`defaultTestLevel inválido: '${updates.defaultTestLevel}'.`);
    }
    if (updates.trackingBranch !== undefined && !String(updates.trackingBranch).trim()) {
      throw new Error('trackingBranch no puede quedar vacío: es la rama que dispara el deploy.');
    }

    // El mismo candado que en el callback, por si alguien intenta habilitar
    // escritura directa en prod por la puerta de atrás de un update.
    if (current.isProduction && updates.allowDirectWrites) {
      throw new Error('Un entorno de producción no puede habilitar escritura directa contra la org.');
    }

    await getFirestore().collection('environments').doc(environmentId).set(cleanUndefined(updates), { merge: true });

    return { environment: sanitizeEnvironment({ ...current, ...updates }) };
  }
}
