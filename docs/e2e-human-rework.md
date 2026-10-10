# Corrección humana después de QA

Esta guía acompaña la validación controlada de TES-343 sobre TES-339 y TES-342.
El PR inicial es un fixture deliberadamente incompleto; QA debe revisar los
criterios del issue y registrar lo que realmente falta.

## Recorrido en Pulse

1. QA revisa el PR abierto y registra `changes_requested` con findings.
2. La persona responsable abre el issue y pulsa **Solicitar corrección**.
3. Escribe las indicaciones y pulsa **Enviar al agente**.
4. Pulse crea un trabajo `rework` y el Runner lo ejecuta en la rama del mismo PR.
5. El dev delegado completa el trabajo, reporta sus criterios y resuelve los
   findings con la credencial del job; el responsable humano se conserva.
6. QA revisa nuevamente los PRs sobre sus SHAs vigentes. El veredicto debe
   corresponder al código actualizado, sin sustituirlo por un override humano.

## Límites y bloqueos

- QA en modo sombra registra el veredicto, pero no despacha automáticamente una
  corrección ni cambia el estado o la asignación del issue. La persona responsable
  debe solicitar la corrección desde Pulse.
- Solicitar una corrección retoma el intento existente: no reinicia los
  presupuestos ni los intentos de revisión, y conserva el modo de QA.
- La corrección requiere permisos válidos para solicitarla y ejecutar el trabajo,
  un Runner preparado y el PR abierto. Si falta alguno de estos requisitos, el
  recorrido queda bloqueado hasta resolverlo.
- El trabajo continúa en la misma rama y el mismo PR, conservando al responsable
  humano. Este PR de prueba no debe mergearse automáticamente.

## Alcance de la evidencia

Las pruebas locales de UI, Functions y Firestore no demuestran por sí solas que
el Runner y el proveedor ejecutaron un trabajo real o que QA revisó un PR real.
La evidencia desplegada se registra en los comentarios y ejecuciones de TES-343.
Esta prueba concreta no completa toda la matriz de TES-217: plataformas,
proveedores, cancelación, revocación, reinicio y otros escenarios siguen teniendo
sus propios criterios de aceptación.
