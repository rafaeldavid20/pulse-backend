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
