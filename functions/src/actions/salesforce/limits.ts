import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { getOrgLimits } from '../../salesforce/client';
import { ResolvedEnvironment } from '../../salesforce/read';
import { SalesforceReadAction } from './shared';

/**
 * `salesforce.limits`: los límites de la org (`DailyApiRequests`,
 * `DataStorageMB`, …) como `{ max, remaining }`. Lo que hay que mirar antes de
 * una carga de datos o de un deploy con muchos tests.
 */
export class SalesforceLimitsAction extends SalesforceReadAction {
  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('salesforce.limits', request, callerUid, callerEmail);
  }

  protected async read(env: ResolvedEnvironment) {
    const raw = await getOrgLimits(env.id, env.apiVersion);
    const limits: Record<string, { max: number; remaining: number }> = {};
    for (const [name, value] of Object.entries(raw)) limits[name] = { max: value.Max, remaining: value.Remaining };
    return { limits };
  }

  protected auditSummary(response: Record<string, any>) {
    return { dailyApiRequests: response.limits?.DailyApiRequests };
  }
}
