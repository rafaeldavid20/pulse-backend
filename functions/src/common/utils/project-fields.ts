import { PROJECT_KINDS, ProjectKind } from '../domain.generated';

/**
 * Mismo razonamiento que `issue-fields.ts`: la whitelist vive ahora en
 * `src/common/domain.generated.ts`, la copia generada de la fuente única
 * `pulse-app/src/types/domain.ts`. Se mantiene el re-export para no tocar los
 * imports existentes.
 *
 * Es una whitelist y no un spread ciego del payload: `update-project.ts`
 * spreadeaba `data` directo, lo que dejaba a un caller sobrescribir `id`,
 * `workspaceId` o `teamId` de un proyecto existente.
 */
export { PROJECT_WRITABLE_FIELDS } from '../domain.generated';
export type { ProjectWritableField } from '../domain.generated';

/**
 * Valida `Project.kind` (TES-270). Un valor desconocido se rechaza en vez de
 * guardarse: el gate de Salesforce compara contra `'salesforce'` literal, y un
 * typo guardado dejaría un proyecto que no es ni una cosa ni la otra.
 */
export function normalizeProjectKind(input: unknown): ProjectKind {
  if (input === undefined || input === null || input === '') return 'generic';
  if (!PROJECT_KINDS.includes(input as ProjectKind)) {
    throw new Error(`Tipo de proyecto inválido: '${String(input)}'. Debe ser uno de: ${PROJECT_KINDS.join(', ')}.`);
  }
  return input as ProjectKind;
}
