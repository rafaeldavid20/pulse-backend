import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// Static import — ver el comentario de cabecera de `read.ts` sobre TS2589.
import { z } from 'zod';
import { McpPrincipal } from '../auth';
import { textResult } from './read';
import { StartDeploymentAction } from '../../actions/deployments/start-deployment';
import { ReportDeploymentAction } from '../../actions/deployments/report-deployment';

/**
 * Tools del workflow `pulse-deploy.yml` (O3/TES-253), bajo `deploy:write`. No
 * son para un modelo: las llama el workflow con la key `PULSE_DEPLOY_MCP_KEY`.
 * Como en el resto del MCP, el `workspaceId` sale del principal.
 */
export function registerDeploymentTools(server: McpServer, principal: McpPrincipal) {
  const actorUid = principal.agentId ?? principal.createdBy;

  server.tool(
    'pulse_start_deployment',
    'Opens a Deployment before touching the org. Called by the pulse-deploy workflow, not by agents. Returns whether to proceed, the repo secret holding the org credential, the delta base sha and the test level.',
    {
      repoFullName: z.string(),
      sha: z.string(),
      branch: z.string().optional().describe('Pushed branch (push trigger). Resolves the environment by its trackingBranch.'),
      environment: z.string().optional().describe('Environment key (repository_dispatch).'),
      mode: z.enum(['validate', 'deploy', 'quick']).optional(),
      trigger: z.enum(['promotion', 'push', 'manual', 'pr_validation']).optional(),
      deploymentId: z.string().optional(),
      validationId: z.string().optional(),
      runUrl: z.string().optional(),
    },
    async (args) => {
      const res = await new StartDeploymentAction(
        { actionCode: 'deployments.start', data: { ...args, workspaceId: principal.workspaceId } },
        actorUid
      ).run();
      return textResult(res.success ? res.data : { error: res.error });
    }
  );

  server.tool(
    'pulse_report_deployment',
    'Closes a Deployment with the Salesforce CLI result (components, tests, coverage, errors). Called by the pulse-deploy workflow.',
    {
      deploymentId: z.string(),
      status: z.enum(['succeeded', 'failed']),
      runUrl: z.string().optional(),
      cli: z.record(z.string(), z.unknown()).optional().describe('Trimmed `result` of `sf project deploy … --json`.'),
    },
    async (args) => {
      const res = await new ReportDeploymentAction(
        { actionCode: 'deployments.report', data: { ...args, workspaceId: principal.workspaceId } },
        actorUid
      ).run();
      return textResult(res.success ? res.data : { error: res.error });
    }
  );
}
