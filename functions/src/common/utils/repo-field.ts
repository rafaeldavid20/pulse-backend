import { Firestore } from 'firebase-admin/firestore';

/**
 * Valida un `repoFullName` contra los repos autorizados de la instalación de
 * GitHub del workspace.
 *
 * `git.repoFullName` no puede ir en `ISSUE_WRITABLE_FIELDS`: esa whitelist
 * mapea nombres de campo uno a uno, y este vive anidado bajo `git`. Así que
 * los handlers lo tratan aparte, y este helper es el punto único donde se
 * valida — que un repo inválido falle acá, con la lista de los válidos, es
 * mucho más útil que descubrirlo cuando el dispatch se saltea en silencio
 * horas después.
 */
export async function validateRepoForWorkspace(
  db: Firestore,
  workspaceId: string,
  repoFullName: string
): Promise<void> {
  const snap = await db
    .collection('github_installations')
    .where('workspaceId', '==', workspaceId)
    .limit(1)
    .get();

  if (snap.empty) {
    throw new Error('Este workspace no tiene GitHub conectado todavía (Settings → GitHub).');
  }

  const authorized: string[] = snap.docs[0].data().repositoryFullNames || [];
  if (authorized.length > 0 && !authorized.includes(repoFullName)) {
    throw new Error(
      `'${repoFullName}' no está entre los repos autorizados para esta instalación ` +
        `(${authorized.join(', ')}).`
    );
  }
}
