import { getFirestore } from 'firebase-admin/firestore';
import { identifierFromBranch } from '../common/utils/issue-refs';
import { ReviewFinding } from '../common/domain.generated';

/**
 * Validación de un PR contra la org de dev (O5/TES-255): el workflow de O3
 * corre `sf project deploy validate` sobre el delta del PR y deja un
 * `Deployment` `mode: 'validate'`, `trigger: 'pr_validation'` atado al issue.
 * Es la evidencia dura que lee el QA, y un fallo bloquea sin que el modelo
 * tenga que decidirlo.
 */

/** La rama que el issue ya tiene registrada en este repo (`gitRefs`, o `git` de un solo repo). */
function registeredBranch(issue: FirebaseFirestore.DocumentData, repoFullName: string): string | undefined {
  const ref = (issue.gitRefs || []).find((r: any) => r?.repoFullName === repoFullName && r?.branch);
  if (ref) return ref.branch;
  if (issue.git?.repoFullName === repoFullName && issue.git?.branch) return issue.git.branch;
  return undefined;
}

/**
 * El issue de una rama, con los mismos dos primeros niveles que
 * `sync-from-webhook.ts`: la rama ya registrada en el issue, y si no, la
 * convención `pul/tes-142-slug` — con el mismo guard de TES-242: la convención
 * sólo decide si el issue todavía no tiene otra rama registrada en este repo.
 * Sin él, una rama que se llama como otro issue le ataría una validación, y si
 * falla, un blocker automático a una revisión que no tiene nada que ver. El tercero ("Closes TES-142" en el cuerpo del
 * PR) no aplica: el workflow no tiene el texto del PR, y para cuando corre, el
 * webhook ya registró la rama en el issue.
 */
export async function findIssueIdForBranch(workspaceId: string, repoFullName: string, branch: string): Promise<string | null> {
  const db = getFirestore();
  const byGit = await db
    .collection('issues')
    .where('workspaceId', '==', workspaceId)
    .where('git.repoFullName', '==', repoFullName)
    .where('git.branch', '==', branch)
    .limit(1)
    .get();
  if (!byGit.empty) return byGit.docs[0].id;

  const identifier = identifierFromBranch(branch);
  if (!identifier) return null;
  const byConvention = await db
    .collection('issues')
    .where('workspaceId', '==', workspaceId)
    .where('identifier', '==', identifier)
    .limit(1)
    .get();
  if (byConvention.empty) return null;
  const doc = byConvention.docs[0];
  const registered = registeredBranch(doc.data(), repoFullName);
  return !registered || registered === branch ? doc.id : null;
}

/**
 * La validación vigente de cada PR del issue: la más reciente por repo. Se
 * filtra en memoria después de un `array-contains`, que no necesita índice
 * compuesto.
 */
export async function latestValidations(workspaceId: string, issueId: string): Promise<FirebaseFirestore.DocumentData[]> {
  const snap = await getFirestore().collection('deployments').where('issueIds', 'array-contains', issueId).get();
  const byRepo = new Map<string, FirebaseFirestore.DocumentData>();
  for (const d of snap.docs.map((doc) => doc.data())) {
    if (d.workspaceId !== workspaceId || d.mode !== 'validate' || d.trigger !== 'pr_validation') continue;
    const current = byRepo.get(d.repoFullName);
    if (!current || String(d.startedAt) > String(current.startedAt)) byRepo.set(d.repoFullName, d);
  }
  return [...byRepo.values()];
}

/** Una línea por error, para el mensaje del finding. */
function describeErrors(dep: FirebaseFirestore.DocumentData): string {
  const errors: any[] = dep.errors || [];
  if (errors.length === 0) return 'sin detalle de errores (ver el run)';
  const lines = errors.slice(0, 5).map((e) => {
    const where = [e.componentType, e.fullName].filter(Boolean).join(' ');
    const line = e.lineNumber ? `:${e.lineNumber}` : '';
    return `${where ? `${where}${line}: ` : ''}${e.problem}`;
  });
  const more = errors.length > 5 ? ` (+${errors.length - 5} más)` : '';
  return lines.join(' | ') + more;
}

/**
 * Findings `blocker` que el servidor agrega a un veredicto de QA por cada
 * validación fallida sobre el código revisado (O5): un PR que no despliega no
 * se aprueba, lo vea o no el modelo — es lo que después deja mergear sin
 * humano en O6.
 *
 * Sólo cuenta una validación del SHA que se está revisando: una fallida sobre
 * un commit anterior ya fue reemplazada por el push siguiente (que revalida).
 * Si no se conoce el SHA revisado de un PR, se usa la validación más reciente.
 */
export function validationFindings(
  validations: FirebaseFirestore.DocumentData[],
  reviewedShas: Map<string, string>
): ReviewFinding[] {
  return validations
    .filter((dep) => dep.status === 'failed')
    .filter((dep) => {
      const reviewed = reviewedShas.get(dep.repoFullName);
      return !reviewed || reviewed === dep.sha;
    })
    .map((dep) => ({
      id: `fnd-val-${String(dep.id).replace(/^dep-/, '')}`,
      severity: 'blocker' as const,
      status: 'open' as const,
      repoFullName: dep.repoFullName,
      message:
        `[Validación Salesforce automática] El PR no valida contra la org '${dep.envKey}' ` +
        `(deploy ${dep.id}, ${String(dep.sha).slice(0, 7)}): ${describeErrors(dep)}. ` +
        `Detalle con pulse_get_deployment${dep.runUrl ? `; run: ${dep.runUrl}` : ''}.`,
    }));
}
