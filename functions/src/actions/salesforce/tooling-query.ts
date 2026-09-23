import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { ResolvedEnvironment, runSoql } from '../../salesforce/read';
import { SalesforceReadAction } from './shared';

/**
 * `salesforce.toolingQuery`: SOQL contra la Tooling API (`ApexClass`,
 * `ApexTrigger`, `FlowDefinitionView`, `CustomField`…). Es lo que sirve para
 * ver la metadata que ya hay en la org sin hacer un retrieve.
 */
export class SalesforceToolingQueryAction extends SalesforceReadAction {
  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('salesforce.toolingQuery', request, callerUid, callerEmail);
  }

  protected async read(env: ResolvedEnvironment) {
    return { ...(await runSoql(env, this.action.data.soql, { tooling: true })) };
  }

  protected auditSummary(response: Record<string, any>) {
    return { soql: this.action.data.soql, totalSize: response.totalSize, returned: response.returned };
  }
}
