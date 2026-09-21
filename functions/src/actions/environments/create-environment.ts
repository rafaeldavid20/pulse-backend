import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { beginSalesforceConnect, PendingEnvironmentConfig } from '../../salesforce/oauth-flow';
import { ENV_KEY_PATTERN, VALID_LOGIN_HOSTS, VALID_TEST_LEVELS } from './shared';

/**
 * Primer paso de conectar una org: valida la configuración y devuelve la URL
 * de autorización de Salesforce a la que el frontend manda el navegador.
 *
 * **No escribe el entorno.** El doc lo crea `salesforceCallback` cuando
 * Salesforce confirma la autorización — si se escribiera acá, un usuario que
 * cancela en la pantalla de login dejaría un entorno fantasma sin credencial.
 */
export class CreateEnvironmentAction extends PlatformActionHandler {
  private workspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('environments.create', request, callerUid, callerEmail);
    this.workspaceId = request.data?.workspaceId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.workspaceId) return false;
    // Conectar una org es dar acceso a un sistema externo del cliente, con
    // credenciales que después usan los agentes: mismo listón que invitar
    // gente o conectar GitHub.
    return this.assertWorkspaceMember(this.workspaceId, 'admin');
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const data = this.action.data;
    const workspaceId: string = data.workspaceId;
    const key: string = (data.key || '').trim().toLowerCase();

    if (!workspaceId) throw new Error('Parámetro requerido faltante: workspaceId.');
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new Error(
        'La clave del entorno debe empezar con una letra y usar sólo minúsculas, números y guiones bajos (máx. 24).'
      );
    }
    if (!data.repoFullName) throw new Error('Parámetro requerido faltante: repoFullName.');
    if (!data.trackingBranch) throw new Error('Parámetro requerido faltante: trackingBranch.');

    const loginHost: string = data.loginHost || 'login';
    if (!VALID_LOGIN_HOSTS.includes(loginHost)) {
      throw new Error(`loginHost inválido: '${loginHost}'. Usá login, test o custom.`);
    }
    if (loginHost === 'custom' && !data.customDomain) {
      throw new Error('Un login host personalizado necesita el My Domain de la org (customDomain).');
    }

    const defaultTestLevel: string = data.defaultTestLevel || 'RunLocalTests';
    if (!VALID_TEST_LEVELS.includes(defaultTestLevel)) {
      throw new Error(`defaultTestLevel inválido: '${defaultTestLevel}'.`);
    }

    const db = getFirestore();
    const environmentId: string | undefined = data.environmentId;

    // La clave es única por workspace: es la que va en el nombre del secret
    // del repo (`PULSE_SF_AUTH_<KEY>`), así que dos entornos con la misma se
    // pisarían la credencial mutuamente.
    const clash = await db
      .collection('environments')
      .where('workspaceId', '==', workspaceId)
      .where('key', '==', key)
      .limit(1)
      .get();
    if (!clash.empty && clash.docs[0].id !== environmentId) {
      throw new Error(`Ya hay un entorno con la clave '${key}' en este workspace.`);
    }

    if (environmentId) {
      const existing = await db.collection('environments').doc(environmentId).get();
      if (!existing.exists || existing.data()!.workspaceId !== workspaceId) {
        throw new Error(`No existe el entorno '${environmentId}'.`);
      }
    }

    const isProduction = !!data.isProduction;
    const config: PendingEnvironmentConfig = {
      key,
      displayName: (data.displayName || key).trim(),
      position: typeof data.position === 'number' ? data.position : 0,
      trackingBranch: data.trackingBranch,
      repoFullName: data.repoFullName,
      isProduction,
      // Prod arranca protegido salvo que alguien lo desactive a propósito
      // después; al revés sería un default que sorprende en el peor momento.
      requiresApproval: data.requiresApproval ?? isProduction,
      defaultTestLevel,
      allowDirectWrites: isProduction ? false : !!data.allowDirectWrites,
      loginHost: loginHost as PendingEnvironmentConfig['loginHost'],
      customDomain: data.customDomain,
      environmentId,
    };

    const authorizeUrl = await beginSalesforceConnect(workspaceId, this.caller.uid!, config);
    return { authorizeUrl };
  }
}
