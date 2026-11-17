# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es esto

Reto técnico 02 de Periferia (Perxia 2.0): agente conversacional que actúa como **punto único
de recepción de contratos**. Lee un buzón simulado, extrae los datos de cada contrato, clasifica
(nuevo / actualización / duplicado / rechazado), archiva en un SharePoint simulado, alimenta el
maestro CSV y genera alertas de vencimiento y pólizas. El PRD autoritativo es
`PRD-02-agente-registro-contratos.md`.

Es **independiente** del reto 01 (`../Reto_IA`): la plataforma (adaptador LLM, ciclo del agente,
servidor, front) se copió de allá, no se importa ni se enlaza. Un cambio aquí no debe tocar
`../Reto_IA` ni al revés. Corre en puertos distintos (backend :3002, front :5174) para que los dos
puedan levantarse a la vez. A diferencia del reto 01, este proyecto **sí usa Git** (el §9.5 del PRD
acepta repo con historial, y permite desplegar en Render).

Código, identificadores, comentarios y docs **en español** (`leerMaestro`, `requiere_revision`).

## Estado

- Hecho: plataforma copiada y adaptada (paso 1) y helpers deterministas de `src/tools/lib/` (paso 2).
- Pendiente: las 5 herramientas en `src/tools/contratos.ts` (hoy es un stub vacío), `demo.ts`,
  `agent/prompt.md`, `src/knowledge/registro-contratos.md`, `README.md`, `SOLUCION.md` (11 secciones,
  incluida la regla de gobierno §7.5), `modulo/`.

## Comandos

```bash
npm install && npm install --prefix web
npm run typecheck        # tsc --noEmit sobre src/, demo.ts y scripts/ (no incluye web/)
npm run demo             # demo.ts: herramientas sin LLM (pendiente de escribir)
npm run dev              # backend :3002 + front :5174
npm run sync:modulo      # regenera modulo/agent.md y SKILL.md desde prompt.md y knowledge/
```

No hay framework de test: la verificación es `typecheck` + `demo`.

## Git y seguridad (criterio eliminatorio del reto)

Cada paso terminado se reporta con un commit. Una falla de seguridad descalifica, así que antes
de cada commit:

- `git add -A --dry-run` y revisar que no entren `.env*` (salvo `.env.example`, que va con las
  claves **vacías**), `out/`, `node_modules/` ni llaves. El `.gitignore` ya los cubre.
- Buscar secretos en lo que se va a commitear (patrones `sk-ant-`, `AIza`, `api_key=…`).
- `npm audit` en la raíz y en `web/` debe dar 0 vulnerabilidades. Por eso el proyecto usa
  **zod 4** (zod 3 tiene GHSA-mrhx-c7xc-m3w5) y los adaptadores convierten esquemas con el nativo
  `z.toJSONSchema`, no con `zod-to-json-schema`. `exceljs`/`pdf-lib` del reto 01 se quitaron: aquí
  no se usan y arrastraban un `uuid` vulnerable.
- Las herramientas no ejecutan shell (PRD §8) y validan toda ruta que venga del modelo
  (`mensajeDir`, `rutaAdjunto` rechazan `..` y `/`).

## Arquitectura

Misma separación que evalúa el PRD §6.5: **comportamiento** en `agent/prompt.md`, **conocimiento**
en `src/knowledge/registro-contratos.md` (ambos se concatenan y cachean en `src/server.ts`;
reiniciar al editarlos), **ejecución** en `src/tools/`.

- `src/agent/tool-registry.ts` expone **cada export** de `src/tools/contratos.ts` como
  `contratos_<export>`. Los helpers van en `src/tools/lib/`, nunca como export de `contratos.ts`.
- Herramientas: `{ description, args (zod con .describe()), execute }`, `execute` devuelve string
  JSON `{ ok, data | error }` y nunca lanza (HU-6: un mensaje malo no aborta el lote).
- **Log único** `out/log.jsonl` (RN7 + CA4) vía `src/tools/lib/log.ts`: lo escriben las propias
  herramientas (así `demo.ts` también deja rastro); el ciclo del agente (`loop.ts`) solo registra
  las llamadas que rechaza antes de ejecutar (herramienta desconocida, args inválidos). Distinto
  del reto 01, que tenía dos logs.
- `src/tools/lib/esquemas.ts`: `contratoSchema` (sección 7.2 con `{ valor, confianza }` por campo)
  es a la vez la salida de `extraer` y la entrada de `validar`/`registrar`. `UMBRAL_CONFIANZA = 0.8`.
- Estado en disco: `out/sharepoint/maestro-contratos.csv` (copia del fixture, RN6, vía
  `inicializarMaestro`), `out/sharepoint/historial.jsonl`, `out/sharepoint/Contratos/<año>/<slug>/`,
  `out/procesados.json`, `out/alertas.md`. `fixtures/` es de solo lectura.

## Trampas de los fixtures (`fixtures/reto-02/`)

- El NIT de Periferia (`NIT_PERIFERIA`) aparece en todo contrato: el cliente es EL CONTRATANTE.
- Montos: buscar solo en la cláusula VALOR. En msg-006 el único monto con código (COP 100.000.000)
  es el umbral de la póliza, no el valor; el contrato es por demanda.
- `buscarPlazoEnMeses` aplicado al contrato entero captura "cuatro (4) meses más" de la póliza de
  msg-001: aplicarlo solo a la cláusula PLAZO.
- msg-001 y msg-002 comparten NIT/RUC con filas existentes pero con objeto distinto (similitud
  0.48 y 0.35): deben salir `nuevo`. msg-003 (otrosí) solo trae `fecha_fin` y `valor`; el resto
  se hereda de la fila. msg-006 no tiene día de firma (`buscarMesSinDia`) y el remitente no está
  en `comerciales.json` (se reporta, no bloquea).
- Convención de plazos del maestro: `finDePlazo(inicio, n)` = aniversario − 1 día.
