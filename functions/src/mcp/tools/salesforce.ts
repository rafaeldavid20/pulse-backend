import { getFirestore } from 'firebase-admin/firestore';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// Static import — ver el comentario de cabecera de `read.ts` sobre TS2589.
// Este archivo tiene que quedar bajo ~400 líneas por la misma razón.
import { z } from 'zod';
import { McpPrincipal } from '../auth';
import { textResult } from './read';
import { PlatformActionCode, PlatformActionResponse } from '../../common/platform-actions/interfaces';
import { sanitizeEnvironment } from '../../actions/environments/shared';
import { SalesforceQueryAction } from '../../actions/salesforce/query';
import { SalesforceToolingQueryAction } from '../../actions/salesforce/tooling-query';
import { SalesforceDescribeAction } from '../../actions/salesforce/describe';
import { SalesforceLimitsAction } from '../../actions/salesforce/limits';
import { MAX_ROWS } from '../../salesforce/read';

type SalesforceActionCode = 'salesforce.query' | 'salesforce.toolingQuery' | 'salesforce.describe' | 'salesforce.limits';

const ACTIONS: Record<SalesforceActionCode, new (request: any, callerUid?: string) => { run(): Promise<PlatformActionResponse> }> = {
  'salesforce.query': SalesforceQueryAction,
  'salesforce.toolingQuery': SalesforceToolingQueryAction,
  'salesforce.describe': SalesforceDescribeAction,
  'salesforce.limits': SalesforceLimitsAction,
};

const environmentParam = z
  .string()
  .describe('Environment key ("dev", "demo", "uat", …) or id ("env-xxxx"). Call pulse_sf_list_orgs to see the ones in this workspace.');

/**
 * Tools de lectura de una org de Salesforce (O2/TES-252).
 *
 * El invariante: el entorno se resuelve **siempre** dentro de
 * `principal.workspaceId`. El modelo elige *cuál* de sus entornos, nunca de
 * qué workspace — el `workspaceId` que reciben las acciones `salesforce.*` sale
 * del principal, y ellas buscan el entorno sólo ahí. Un id de entorno de otro
 * workspace da "no existe", igual que uno inventado. Es la misma regla que
 * protege `workspaceId` en `write.ts`.
 *
 * Si el workspace no tiene ningún proyecto Salesforce, el wrapper de
 * `mcp/server.ts` responde por todas las `pulse_sf_*` antes de llegar acá
 * (TES-270). Ese chequeo **no** es de seguridad; lo es el de arriba.
 */
export function registerSalesforceTools(server: McpServer, principal: McpPrincipal) {
  const actorUid = principal.agentId ?? principal.createdBy;

  async function runAction(actionCode: SalesforceActionCode, data: Record<string, any>) {
    const ActionClass = ACTIONS[actionCode];
    const request = { actionCode, data: { ...data, workspaceId: principal.workspaceId } } satisfies {
      actionCode: PlatformActionCode;
      data: Record<string, any>;
    };
    const res = await new ActionClass(request, actorUid).run();
    return textResult(res.success ? res.data : { error: res.error });
  }

  server.tool(
    'pulse_sf_list_orgs',
    'Lists the Salesforce orgs (environments) connected to this workspace: key, org, sandbox or production, connection state, and the git branch that tracks what is deployed there. Start here before querying an org.',
    {},
    async () => {
      const snap = await getFirestore().collection('environments').where('workspaceId', '==', principal.workspaceId).get();
      const orgs = snap.docs
        .map((d) => sanitizeEnvironment(d.data()))
        .sort((a, b) => a.position - b.position)
        .map((e) => ({
          id: e.id,
          key: e.key,
          displayName: e.displayName,
          isProduction: e.isProduction,
          allowDirectWrites: e.allowDirectWrites,
          connectionState: e.connectionState,
          trackingBranch: e.trackingBranch,
          repoFullName: e.repoFullName,
          orgId: e.salesforce?.orgId,
          instanceUrl: e.salesforce?.instanceUrl,
          isSandbox: e.salesforce?.isSandbox,
          apiVersion: e.salesforce?.apiVersion,
        }));
      return textResult({
        orgs,
        ...(orgs.length === 0 ? { note: 'No hay orgs conectadas. Se conectan desde Configuración → Salesforce.' } : {}),
      });
    }
  );

  server.tool(
    'pulse_sf_query',
    `Runs a read-only SOQL query against a connected org (Data API). Returns at most ${MAX_ROWS} rows, without the "attributes" metadata. A query without LIMIT on a large object is rejected — add LIMIT, filter with WHERE, or use SELECT COUNT().`,
    { environment: environmentParam, soql: z.string().describe('A SOQL SELECT statement.') },
    async ({ environment, soql }) => runAction('salesforce.query', { environment, soql })
  );

  server.tool(
    'pulse_sf_tooling_query',
    `Runs a read-only SOQL query against the Tooling API of a connected org — metadata already in the org: ApexClass, ApexTrigger, CustomField, FlowDefinitionView, ValidationRule, LightningComponentBundle… Returns at most ${MAX_ROWS} rows.`,
    { environment: environmentParam, soql: z.string().describe('A Tooling API SOQL SELECT statement.') },
    async ({ environment, soql }) => runAction('salesforce.toolingQuery', { environment, soql })
  );

  server.tool(
    'pulse_sf_describe',
    'Describes a connected org. With sobject: its fields (type, length, references, active picklist values, flags), child relationships and record types. Without sobject: the list of queryable objects. Set tooling=true to describe Tooling API objects. Cached for 1h.',
    {
      environment: environmentParam,
      sobject: z.string().optional().describe('API name, e.g. "Account" or "Invoice__c". Omit to list objects.'),
      tooling: z.boolean().optional().describe('Describe Tooling API objects instead of data objects.'),
    },
    async ({ environment, sobject, tooling }) => runAction('salesforce.describe', { environment, sobject, tooling })
  );

  server.tool(
    'pulse_sf_limits',
    'Returns the org limits (DailyApiRequests, DataStorageMB, …) as { max, remaining } — check before a data load or a heavy deploy.',
    { environment: environmentParam },
    async ({ environment }) => runAction('salesforce.limits', { environment })
  );
}
