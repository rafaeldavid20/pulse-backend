import { nanoid } from 'nanoid';
import { AcceptanceCriterion } from '../domain.generated';

/**
 * Normaliza la rúbrica que llega de un caller (UI, MCP): a los criterios sin
 * `id` les asigna uno estable, porque los findings y la autoverificación
 * (D13) lo referencian y no pueden depender de la posición en el array.
 *
 * `undefined` cuando `input` no es un array — deja el campo sin tocar en vez
 * de borrar la rúbrica existente por un payload mal formado.
 */
export function normalizeAcceptanceCriteria(input: unknown): AcceptanceCriterion[] | undefined {
  if (!Array.isArray(input)) return undefined;

  return input
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && typeof c.text === 'string' && c.text.trim().length > 0)
    .map((c) => {
      const criterion: AcceptanceCriterion = {
        id: typeof c.id === 'string' && c.id.trim() ? c.id : `crit-${nanoid(8)}`,
        text: (c.text as string).trim(),
      };
      // `source`/`accepted` son de `issues.generateCriteria`, no algo que un
      // caller cualquiera deba poder inventar por MCP — solo se preservan si
      // ya venían así en un criterio existente que el caller devolvió intacto.
      if (c.source === 'generated') {
        criterion.source = 'generated';
        criterion.accepted = c.accepted === true;
      }
      return criterion;
    });
}
