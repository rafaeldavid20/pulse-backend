import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore, Firestore, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { nanoid } from 'nanoid';
import { cleanUndefined } from '../common/utils/clean';
import { nextCycleNumber } from '../common/utils/counters';
import { CycleSettings } from '../common/domain.generated';

/**
 * Cuántos días antes de `startsAt` se crea el próximo ciclo — le da a un
 * equipo margen para revisar/ajustar el ciclo entrante (nombre, fechas)
 * antes de que arranque, sin dejarlo aparecer con demasiada anticipación.
 */
const CREATION_LEAD_DAYS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function startOfUTCDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Próxima fecha (a partir de `from`, inclusive) cuyo `getUTCDay()` sea `weekday`. */
function nextOccurrenceOfWeekday(from: Date, weekday: number): Date {
  const start = startOfUTCDay(from);
  const diff = (weekday - start.getUTCDay() + 7) % 7;
  start.setUTCDate(start.getUTCDate() + diff);
  return start;
}

function addWeeks(date: Date, weeks: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + weeks * 7);
  return next;
}

/**
 * Cloud Function programada (E4): para cada equipo con `cycleSettings.enabled
 * && autoCreate`, crea el siguiente ciclo con `CREATION_LEAD_DAYS` de
 * anticipación (status `upcoming`; el pasaje a `active` en su `startsAt` es
 * el mismo mecanismo manual de `cycles.update` — ver el comentario en
 * `CYCLE_WRITABLE_FIELDS`). Equipos sin `cycleSettings` o con `autoCreate`
 * desactivado quedan fuera del query y no se tocan.
 *
 * Nunca lanza fuera del try/catch por equipo: que un equipo falle (datos
 * inconsistentes, timeout) no debe frenar el resto ni hacer que Cloud
 * Scheduler reintente el job entero.
 */
export const autoCreateCyclesScheduled = onSchedule(
  { schedule: 'every day 06:00', timeZone: 'Etc/UTC', region: 'us-east4' },
  async () => {
    const db = getFirestore();
    const teamsSnap = await db
      .collection('teams')
      .where('cycleSettings.enabled', '==', true)
      .where('cycleSettings.autoCreate', '==', true)
      .get();

    const now = new Date();

    for (const teamDoc of teamsSnap.docs) {
      try {
        await maybeCreateNextCycle(db, teamDoc, now);
      } catch (error) {
        console.error(`[autoCreateCycles] Falló para el equipo '${teamDoc.id}':`, error);
      }
    }
  }
);

async function maybeCreateNextCycle(db: Firestore, teamDoc: QueryDocumentSnapshot, now: Date): Promise<void> {
  const team = teamDoc.data();
  const teamId = teamDoc.id;
  const workspaceId = team.workspaceId as string;
  const settings = team.cycleSettings as CycleSettings;

  // Sin orderBy: la cantidad de ciclos por equipo es chica (uno cada
  // `lengthWeeks` semanas), así que traerlos todos y resolver el último acá
  // evita mantener un índice compuesto solo para esta lectura.
  const cyclesSnap = await db.collection('cycles').where('teamId', '==', teamId).get();

  let lastEndsAt: string | undefined;
  cyclesSnap.forEach((doc) => {
    const endsAt = doc.data().endsAt as string;
    if (!lastEndsAt || endsAt > lastEndsAt) lastEndsAt = endsAt;
  });

  const nextStart = lastEndsAt ? new Date(lastEndsAt) : nextOccurrenceOfWeekday(now, settings.startDayOfWeek);
  const creationThreshold = new Date(nextStart.getTime() - CREATION_LEAD_DAYS * MS_PER_DAY);
  if (now < creationThreshold) return;

  const startsAt = nextStart.toISOString();
  const endsAt = addWeeks(nextStart, settings.lengthWeeks).toISOString();

  // Idempotencia: si ya existe un ciclo de este equipo con este mismo rango
  // (p. ej. una segunda corrida del scheduler antes de que cambie
  // `lastEndsAt`), no duplicar.
  const alreadyExists = cyclesSnap.docs.some((doc) => doc.data().startsAt === startsAt);
  if (alreadyExists) return;

  const cycleId = `cycle-${nanoid(8)}`;
  const number = await nextCycleNumber(db, workspaceId, teamId);
  const nowIso = new Date().toISOString();

  const cycle = cleanUndefined({
    id: cycleId,
    workspaceId,
    teamId,
    number,
    name: `Ciclo ${number}`,
    startsAt,
    endsAt,
    status: 'upcoming',
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  await db.collection('cycles').doc(cycleId).set(cycle);
  console.log(`[autoCreateCycles] Creado ciclo '${cycleId}' (número ${number}) para el equipo '${teamId}'.`);
}
