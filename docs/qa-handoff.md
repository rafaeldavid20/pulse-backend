# Traspaso durable de dev a QA (TES-347)

QA puede recibir `in_review` antes de que el Runner termine la publicación dev.
Una ocupación temporal, desconexión o verificación local vencida guarda `review.dispatchPending` con los Runners elegibles,
sin crear jobs, runs, gastar presupuesto ni incrementar el intento de revisión.
`review.dispatchError` comunica que el inicio será automático.

`qaCapacityTrigger` reevalúa la espera al completar, cancelar, expirar o eliminar
un job activo. `qaPendingScheduled` corre cada minuto para recuperar carreras
entre completar el job y guardar la espera, eventos perdidos o capacidad que
vuelve más tarde. También reconoce el diagnóstico antiguo «límite de jobs
activos», para recuperar issues anteriores sin mover su estado manualmente.

Cada reevaluación carga la issue vigente y repite selección QA, preparación,
permisos de proyecto/repositorios, budgets, límites de intentos y consulta de
origen/estado/HEAD del PR. La transacción de enqueue vuelve a validar la issue,
asignación, preparación, permisos y capacidad antes de gastar presupuesto.
`review.dispatchedContext` evita emitir dos jobs automáticos para el mismo intento,
conjunto de PRs y SHAs, incluso después de terminar el job y vencer el cooldown.
Las solicitudes manuales conservan sus reglas existentes. QA sigue resolviendo
los snapshots y los SHAs actuales al iniciar la revisión.

La espera conserva los IDs del Runner ante una desconexión, heartbeat vencido o
preparación vencida, incluso si termina el job dev mientras sigue desconectado.
La recuperación programada vuelve a verificar todo antes de encolar. La misma
clasificación se aplica al revalidar y dentro de la transacción de enqueue.
Revocación, sesión inválida y otros errores de configuración no son transitorios.

Los errores permanentes limpian la espera y muestran su diagnóstico. Un Runner
compartido ajeno que no anuncia esta identidad QA no aporta consejos de login o
instalación; si hay un Runner preparado ocupado, sólo se muestra esa espera.
El modo QA no cambia. Issues fuera de `in_review`, con revisión activa/manual,
PRs cerrados/draft o trabajo pendiente no despachan una revisión automática.

## Evidencia local

`functions/src/integration/qa-handoff.test.ts` reproduce TES-340 y TES-341:
un job dev en `delivered` mantiene ocupado un único Runner con identidades dev/QA,
una demora controlada mantiene pendiente QA y completarlo despierta varios
eventos concurrentes. Se verifican un job firmado, un gasto y ningún intento
reservado por esperar, en modos shadow/enforce. Se simulan los límites de GitHub
con respuestas de origen/HEAD; no se modifican PRs ni issues de producción.

La suite verifica además cierre/cancelación, permisos retirados, budgets,
intentos agotados, agente deshabilitado/no autónomo, sesión inválida,
recuperación programada, diagnósticos antiguos, cambio de PR/SHA y eventos
repetidos después de completar QA. El rework del hallazgo `fnd-6ZwMhBwX`
agrega seis regresiones de espera → offline/heartbeat vencido/readiness vencida
→ completar dev todavía indisponible → recuperación concurrente → un job y
un gasto, tanto con QA seleccionado como automático. También verifica que
revocación y sesión inválida limpien la espera aun con preparación vencida,
y desconexión después de consultar el PR antes del preflight transaccional.

Validación del rework: build TypeScript y 69 pruebas unitarias aprobadas;
53 pruebas de emulador de las tres suites abajo más la regresión transaccional
individual aprobadas (54 en total). Las pruebas unitarias del trigger cubren
el cierre del PR detectado en GitHub antes del webhook.

Ejecutar desde la raíz:

```sh
npm --prefix functions test
firebase emulators:exec --only firestore --project demo-pulse-integration \
  'node --test functions/lib/integration/qa-handoff.test.js functions/lib/integration/manual-qa.test.js functions/lib/integration/runner-preflight.test.js'
```

Para activar el comportamiento se deben desplegar las funciones nuevas de
capacidad y recuperación programada, junto con el trigger QA actualizado.
