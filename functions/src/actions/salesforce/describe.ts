import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { describeGlobal, describeSObject, ResolvedEnvironment } from '../../salesforce/read';
import { SalesforceReadAction } from './shared';

/**
 * `salesforce.describe`: con `sobject`, campos/relaciones/record types de ese
 * objeto; sin él, la lista de objetos consultables de la org. `tooling: true`
 * describe objetos de la Tooling API. Cacheado 1h por instancia.
 */
export class SalesforceDescribeAction extends SalesforceReadAction {
  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('salesforce.describe', request, callerUid, callerEmail);
  }

  protected async read(env: ResolvedEnvironment) {
    const { sobject, tooling } = this.action.data;
    const opts = { tooling: !!tooling };
    if (sobject) return { sobject: await describeSObject(env, String(sobject), opts) };
    return { sobjects: await describeGlobal(env, opts) };
  }

  protected auditSummary(response: Record<string, any>) {
    return response.sobject
      ? { sobject: response.sobject.name, fields: response.sobject.fields.length }
      : { sobjects: response.sobjects.length };
  }
}
