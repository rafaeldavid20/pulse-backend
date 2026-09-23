import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { ResolvedEnvironment, runSoql } from '../../salesforce/read';
import { SalesforceReadAction } from './shared';

/** `salesforce.query`: SOQL contra la Data API. `{ workspaceId, environment, soql }`. */
export class SalesforceQueryAction extends SalesforceReadAction {
  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('salesforce.query', request, callerUid, callerEmail);
  }

  protected async read(env: ResolvedEnvironment) {
    return { ...(await runSoql(env, this.action.data.soql, { tooling: false })) };
  }

  protected auditSummary(response: Record<string, any>) {
    return { soql: this.action.data.soql, totalSize: response.totalSize, returned: response.returned };
  }
}
