import { Deployment, DeploymentError } from '../common/domain.generated';

/**
 * Lo que el workflow manda de `sf project deploy … --json`, ya recortado en el
 * runner (ver `pulse-deploy-workflow.ts`): el `--json` entero puede pasar
 * varios MB y trae cosas que Pulse no usa.
 */
export interface CliDeploySummary {
  status?: string;
  id?: string;
  numberComponentsTotal?: number;
  numberComponentErrors?: number;
  numberTestsTotal?: number;
  numberTestErrors?: number;
  componentFailures?: { componentType?: string; fullName?: string; problem?: string; lineNumber?: number; columnNumber?: number }[];
  testFailures?: { name?: string; methodName?: string; message?: string; stackTrace?: string }[];
  codeCoverage?: { name?: string; numLocations?: number; numLocationsNotCovered?: number }[];
  noChanges?: boolean;
  message?: string;
}

const MAX_ERRORS = 50;
const MAX_TEXT = 1000;

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function text(v: unknown): string {
  return String(v ?? '').slice(0, MAX_TEXT);
}

/** Pasa el resumen del CLI a los campos de `Deployment`. Tolera campos ausentes o con tipos raros. */
export function parseCliSummary(cli: CliDeploySummary | undefined): Pick<Deployment, 'salesforce' | 'errors'> {
  if (!cli || typeof cli !== 'object') return { errors: [] };

  const errors: DeploymentError[] = [];
  for (const f of (Array.isArray(cli.componentFailures) ? cli.componentFailures : []).slice(0, MAX_ERRORS)) {
    errors.push({
      kind: 'component',
      componentType: f.componentType ? text(f.componentType) : undefined,
      fullName: f.fullName ? text(f.fullName) : undefined,
      problem: text(f.problem) || 'Error sin descripción',
      lineNumber: num(f.lineNumber),
      columnNumber: num(f.columnNumber),
    });
  }
  for (const t of (Array.isArray(cli.testFailures) ? cli.testFailures : []).slice(0, MAX_ERRORS)) {
    errors.push({
      kind: 'test',
      componentType: t.name ? text(t.name) : undefined,
      fullName: [t.name, t.methodName].filter(Boolean).join('.') || undefined,
      problem: text(t.message) || 'Test fallido',
    });
  }
  if (cli.message) errors.push({ kind: 'general', problem: text(cli.message) });

  let coveragePercent: number | undefined;
  const coverage = Array.isArray(cli.codeCoverage) ? cli.codeCoverage : [];
  const total = coverage.reduce((acc, c) => acc + (num(c.numLocations) ?? 0), 0);
  if (total > 0) {
    const uncovered = coverage.reduce((acc, c) => acc + (num(c.numLocationsNotCovered) ?? 0), 0);
    coveragePercent = Math.round(((total - uncovered) / total) * 1000) / 10;
  }

  return {
    salesforce: {
      deployRequestId: cli.id ? text(cli.id) : undefined,
      componentsTotal: num(cli.numberComponentsTotal),
      componentsFailed: num(cli.numberComponentErrors),
      testsRun: num(cli.numberTestsTotal),
      testsFailed: num(cli.numberTestErrors),
      coveragePercent,
    },
    errors,
  };
}
