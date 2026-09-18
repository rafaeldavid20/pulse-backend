import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';
import { CYCLE_SETTINGS_WRITABLE_FIELDS, CycleSettings } from '../../common/domain.generated';
import { pickWritableFields } from '../../common/utils/issue-fields';

const VALID_LENGTH_WEEKS = [1, 2, 3, 4];

const DEFAULT_CYCLE_SETTINGS: CycleSettings = {
  enabled: false,
  lengthWeeks: 2,
  startDayOfWeek: 1,
  autoCreate: false,
};

export class UpdateCycleSettingsAction extends PlatformActionHandler {
  private teamId?: string;
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('cycles.updateSettings', request, callerUid, callerEmail);
    this.teamId = request.data?.teamId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.teamId) return false;
    const snap = await getFirestore().collection('teams').doc(this.teamId).get();
    if (!snap.exists) return false;
    this.resolvedWorkspaceId = snap.data()!.workspaceId;
    return this.isWorkspaceMember(this.resolvedWorkspaceId!);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;
    const teamId = data.teamId as string | undefined;

    if (!teamId) {
      throw new Error('Identificador de equipo (teamId) es obligatorio para actualizar cycleSettings.');
    }

    const teamRef = db.collection('teams').doc(teamId);
    const snap = await teamRef.get();
    if (!snap.exists) {
      throw new Error(`El equipo con ID '${teamId}' no existe.`);
    }

    // Whitelist, no un spread: esta acción puede llamarse desde un tool MCP
    // manejado por un LLM, y un spread dejaría escribir cualquier clave de
    // `data` dentro de `cycleSettings`.
    const patch = pickWritableFields(data, CYCLE_SETTINGS_WRITABLE_FIELDS);

    if ('lengthWeeks' in patch && !VALID_LENGTH_WEEKS.includes(patch.lengthWeeks)) {
      throw new Error('lengthWeeks debe ser 1, 2, 3 o 4.');
    }
    if ('startDayOfWeek' in patch) {
      const day = patch.startDayOfWeek;
      if (!Number.isInteger(day) || day < 0 || day > 6) {
        throw new Error('startDayOfWeek debe ser un entero entre 0 (domingo) y 6 (sábado), según Date.getUTCDay().');
      }
    }

    const current: CycleSettings = (snap.data()!.cycleSettings as CycleSettings | undefined) ?? DEFAULT_CYCLE_SETTINGS;
    const cycleSettings: CycleSettings = { ...current, ...patch };

    await teamRef.update(cleanUndefined({ cycleSettings }));

    return { teamId, cycleSettings };
  }
}
