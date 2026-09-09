import { Firestore } from 'firebase-admin/firestore';

/**
 * Repos en los que se puede trabajar un issue.
 *
 * El límite lo pone el **proyecto** (`Project.repoFullNames`), no el issue ni el
 * agente: dentro de ese conjunto, quien crea la rama elige libremente. Es una
 * capa distinta del ruteo del dispatch, que sigue eligiendo *un* repo donde
 * correr el job — el proyecto dice qué se puede tocar, el issue dice dónde
 * arranca.
 *
 * Un proyecto sin repos declarados (o un issue sin proyecto) cae a todos los de
 * la instalación: así los proyectos anteriores a este campo siguen funcionando
 * en vez de quedarse sin ningún repo permitido.
 */
export async function allowedReposForIssue(
  db: Firestore,
  issue: FirebaseFirestore.DocumentData,
  installationRepos: string[]
): Promise<string[]> {
  if (!issue.projectId) return installationRepos;

  const snap = await db.collection('projects').doc(issue.projectId).get();
  if (!snap.exists) return installationRepos;

  const declared: string[] = snap.data()!.repoFullNames || [];
  if (declared.length === 0) return installationRepos;

  // Intersección: un repo que el proyecto declara pero que salió de la
  // instalación no es utilizable, y conviene que falle como "no permitido" y no
  // como un 404 de GitHub más adelante.
  return declared.filter((r) => installationRepos.includes(r));
}

export function assertRepoAllowed(
  repoFullName: string,
  allowed: string[],
  context: string
): void {
  if (!allowed.includes(repoFullName)) {
    throw new Error(
      `'${repoFullName}' no está entre los repos permitidos para ${context} ` +
        `(${allowed.join(', ') || 'ninguno'}).`
    );
  }
}

/**
 * Inserta o actualiza la entrada de un repo en `gitRefs`, sin tocar las de los
 * otros repos.
 *
 * Es un upsert por `repoFullName` y no un append: si el webhook informa el PR de
 * una rama que ya estaba registrada, tiene que actualizar esa entrada, no
 * agregar una segunda para el mismo repo.
 */
export function upsertGitRef(
  refs: any[] | undefined,
  entry: Record<string, any>
): Record<string, any>[] {
  const list = Array.isArray(refs) ? [...refs] : [];
  const i = list.findIndex((r) => r?.repoFullName === entry.repoFullName);

  if (i === -1) {
    list.push(entry);
  } else {
    list[i] = { ...list[i], ...entry };
  }

  return list;
}

/**
 * Estado que le corresponde a un issue según TODAS sus ramas.
 *
 * La regla es "cuando están todos": `in_review` cuando cada PR está abierto, y
 * `done` cuando cada uno está mergeado. Un issue cuyo cambio de backend se
 * mergeó pero cuyo cambio de modelo sigue abierto no está terminado —
 * exactamente el caso de TES-147.
 *
 * Devuelve `null` cuando el conjunto no determina nada (sin refs, o alguna sin
 * PR todavía), para que el caller no fuerce una transición.
 */
export function statusFromGitRefs(refs: any[] | undefined): string | null {
  if (!Array.isArray(refs) || refs.length === 0) return null;

  const withPr = refs.filter((r) => r?.prNumber !== undefined);
  if (withPr.length === 0) return null;

  // Alguna rama todavía no abrió PR: el trabajo no está completo.
  if (withPr.length < refs.length) return 'in_progress';

  if (withPr.every((r) => r.prState === 'merged')) return 'done';
  if (withPr.every((r) => r.prState === 'open')) return 'in_review';
  if (withPr.some((r) => r.prState === 'closed' && !r.merged)) return 'in_progress';

  // Mezcla de abiertos y mergeados, o algún draft: sigue habiendo trabajo.
  return 'in_progress';
}
