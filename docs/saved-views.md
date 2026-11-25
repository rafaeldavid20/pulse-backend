# Vistas guardadas

`saved_views` se lee únicamente con membresía vigente y cuando la vista es
compartida o pertenece al usuario. Las escrituras de cliente están cerradas;
`views.create`, `views.update` y `views.delete` aplican las reglas de owner y
de administración de vistas de sistema. Las consultas se validan y las
referencias literales se guardan como IDs; las funciones dinámicas y fechas
relativas permanecen en la expresión.

`views.update` requiere `expectedUpdatedAt`, la versión que el editor leyó.
Si otra edición llegó primero, la transacción rechaza el cambio y el cliente
conserva el borrador para copiarlo o descartarlo. El tablero admite agrupar por
estado o épica; una combinación anterior incompatible requiere elegir una de
ellas o cambiar a lista antes de guardar.

Al crear un equipo, un trigger crea idempotentemente las cuatro vistas globales
y una vista de ciclo de ese equipo. Para workspaces existentes, después de
desplegar funciones y reglas, compilar Functions y ejecutar explícitamente:

```sh
cd functions
npm run build
npm run backfill:views -- --project PROJECT_ID --apply
```

El proceso usa las credenciales de aplicación disponibles en el entorno,
recorre los equipos existentes y no reemplaza vistas ya creadas ni ediciones.
Registrar por separado proyecto, fecha, salida y credencial autorizada usada;
agregar este script no implica que el backfill se haya ejecutado. Las vistas
de "Bloqueados" reflejan el estado del agente, no todas las dependencias.
