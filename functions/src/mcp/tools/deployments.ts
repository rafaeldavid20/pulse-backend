import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// Static import — ver el comentario de cabecera de `read.ts` sobre TS2589.
import { z } from 'zod';
import { McpPrincipal } from '../auth';
import { findIssue, textResult } from './read';
import { getFirestore } from 'firebase-admin/firestore';
import { latestValidations } from '../../salesforce/validation';
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
      prNumber: z.number().int().optional().describe('PR being validated (trigger pr_validation).'),
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
    'pulse_get_deployment',
    'Salesforce deploy/validation evidence. With identifier: the current PR validation of that issue for each repo (check-only deploy of the PR delta against the dev org) — failed components with file/line, failed Apex tests and coverage. With deploymentId: that deployment. For QA: a failed validation on the reviewed commit is added as a blocker finding automatically when you submit the review; use this to explain it, not to decide it.',
    {
      identifier: z.string().optional().describe('Issue identifier ("TES-142").'),
      deploymentId: z.string().optional(),
    },
    async ({ identifier, deploymentId }) => {
      const view = (d: FirebaseFirestore.DocumentData) => ({
        id: d.id,
        environment: d.envKey,
        repoFullName: d.repoFullName,
        branch: d.branch,
        prNumber: d.prNumber,
        sha: d.sha,
        mode: d.mode,
        trigger: d.trigger,
        status: d.status,
        salesforce: d.salesforce,
        errors: d.errors || [],
        runUrl: d.runUrl,
        startedAt: d.startedAt,
        endedAt: d.endedAt,
      });
      if (deploymentId) {
        const snap = await getFirestore().collection('deployments').doc(deploymentId).get();
        if (!snap.exists || snap.data()!.workspaceId !== principal.workspaceId) return textResult({ found: false });
        return textResult({ found: true, deployment: view(snap.data()!) });
      }
      if (!identifier) return textResult({ error: 'Pasá identifier o deploymentId.' });
      const doc = await findIssue(principal.workspaceId, identifier);
      if (!doc) return textResult({ error: `No issue found for '${identifier}'.` });
      const validations = await latestValidations(principal.workspaceId, doc.id);
      return textResult({
        validations: validations.map(view),
        ...(validations.length === 0
          ? { note: 'Este issue no tiene validaciones de Salesforce: o su repo no está atado a un entorno, o el workflow todavía no corrió.' }
          : {}),
      });
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
