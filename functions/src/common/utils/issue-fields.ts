/**
 * La whitelist de campos escribibles de un issue se movió a
 * `src/common/domain.generated.ts` — la copia generada de
 * `pulse-app/src/types/domain.ts`, que es la fuente única del modelo de
 * dominio para ambos repos. Antes esta lista estaba duplicada a mano a los dos
 * lados del límite entre repos; `npm run sync:types` (desde `pulse-app`) y el
 * check en su `npm run lint` son lo que ahora impide que deriven.
 *
 * Este módulo se mantiene como re-export para no tocar los imports existentes,
 * y conserva `pickWritableFields`, que es lógica de servidor y no parte del
 * modelo compartido.
 */
export { ISSUE_WRITABLE_FIELDS } from '../domain.generated';
export type { IssueWritableField } from '../domain.generated';

/**
 * Devuelve una copia superficial de `source` con solo las claves listadas en
 * `fields` que estén realmente presentes (así los campos omitidos no se
 * vuelven claves con `undefined` explícito que después haya que limpiar).
 */
export function pickWritableFields<T extends Record<string, any>>(
  source: T,
  fields: readonly string[]
): Partial<T> {
  const picked: Partial<T> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      (picked as Record<string, any>)[field] = source[field];
    }
  }
  return picked;
}
