import { nanoid } from 'nanoid';
import { DefinitionOfDoneCriterion } from '../domain.generated';

const SEVERITIES: DefinitionOfDoneCriterion['severity'][] = ['blocker', 'major'];

/**
 * Normaliza la Definition of Done que llega de un caller (el modal del
 * proyecto): a los ítems sin `id` les asigna uno estable, porque los findings
 * del QA (D14, `ReviewFinding.dodId`) lo referencian y no pueden depender de
 * la posición en el array.
 *
 * `undefined` cuando `input` no es un array — deja el campo sin tocar en vez
 * de borrar la DoD existente por un payload mal formado, igual que
 * `normalizeAcceptanceCriteria`.
 */
export function normalizeDefinitionOfDone(input: unknown): DefinitionOfDoneCriterion[] | undefined {
  if (!Array.isArray(input)) return undefined;

  return input
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && typeof c.text === 'string' && c.text.trim().length > 0)
    .map((c) => {
      const severity = c.severity as DefinitionOfDoneCriterion['severity'];
      if (!SEVERITIES.includes(severity)) {
        throw new Error(`Severidad de Definition of Done inválida: '${String(c.severity)}'. Debe ser una de: ${SEVERITIES.join(', ')}.`);
      }
      return {
        id: typeof c.id === 'string' && c.id.trim() ? c.id : `dod-${nanoid(8)}`,
        text: (c.text as string).trim(),
        severity,
      };
    });
}
