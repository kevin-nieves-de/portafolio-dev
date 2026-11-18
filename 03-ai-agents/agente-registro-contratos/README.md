# Agente de registro de contratos vigentes

Agente conversacional que actúa como **punto único de recepción de contratos**: lee un buzón,
extrae los datos de cada contrato con su nivel de confianza, detecta duplicados y otrosíes,
archiva el documento en una estructura tipo SharePoint, alimenta el maestro y genera alertas de
vencimiento y de pólizas pendientes. Lo dudoso nunca se registra sin confirmación humana.

Reto técnico 02 del proceso de selección de Periferia IT Group (equipo Perxia 2.0). El
planteamiento completo de la solución está en [`SOLUCION.md`](SOLUCION.md).

| | |
|---|---|
| **Link de prueba** | _se publica al desplegar en Render (ver [Despliegue](#despliegue))_ |
| **Clave de acceso** | No se requiere: el gasto se limita con topes de tokens por sesión y globales. |
| **Stack** | TypeScript · Node 20+ · Express · React + Vite · zod · Anthropic (o Gemini) |

## Levantar en local

Requisitos: Node 20 o superior y una API key de Anthropic (o de Google Gemini).

```bash
cp .env.example .env      # y completa ANTHROPIC_API_KEY (o LLM_PROVIDER=gemini + GEMINI_API_KEY)
npm install               # instala backend y front (el postinstall instala web/)
npm run dev               # backend en :3002 y chat en http://localhost:5174
```

En el chat, el botón **Procesar el buzón** carga el prompt de la demo. Después de la respuesta, el
botón **Confirmar msg-006** carga la confirmación del único contrato que queda en revisión.

Modo producción en local (un solo servicio que sirve el front construido y la API):

```bash
npm run build && npm start    # http://localhost:3002
```

## Demo sin modelo de lenguaje

```bash
npm run demo
```

`demo.ts` llama directamente a las herramientas (mismo registro y misma validación zod que usa el
agente), sin API key. Borra `out/` al inicio y procesa los 6 mensajes del buzón:

| Mensaje | Clasificación | Acción |
|---|---|---|
| msg-001 | nuevo | Registra `CT-2026-015`, póliza `pendiente` |
| msg-002 | nuevo | Registra `CT-2026-016`, póliza `no_aplica` |
| msg-003 | actualización | Otrosí de `CT-2026-011`: valor 350.000 → 520.000 PEN y fecha fin 2027-05-01 → 2027-11-01 |
| msg-004 | duplicado | Nada que escribir (`CT-2026-012` ya está igual en el maestro) |
| msg-005 | rechazado | Es una cotización, no un contrato |
| msg-006 | nuevo, en revisión | No se registra en la primera pasada; la segunda, con `confirmado: true`, registra `CM-2026-03` |

Luego genera las alertas al 2026-09-03, ejercita 7 casos de error (HU-6) y comprueba que el
modelo no puede alterar un valor sin que el humano lo confirme (CA2). Cada paso imprime `ok` o `x`;
la corrida esperada es **29 `ok` y 0 `x`**. La evidencia queda en `out/`:

| Archivo | Contenido |
|---|---|
| `out/sharepoint/maestro-contratos.csv` | Copia de trabajo del maestro (el fixture nunca se modifica) |
| `out/sharepoint/Contratos/<año>/<cliente>/` | Documentos archivados |
| `out/sharepoint/historial.jsonl` | Cada inserción o actualización con el antes y el después |
| `out/procesados.json` | Mensajes ya atendidos |
| `out/alertas.md` | Reporte de vencimientos, pólizas pendientes y lo registrado desde el corte |
| `out/log.jsonl` | Una línea por llamada a herramienta |

## Verificación

```bash
npm run typecheck                 # backend, demo, scripts y módulo (TypeScript estricto, sin any)
npm run demo                      # 29 ok, 0 x
npm run sync:modulo -- --check    # modulo/ coincide con el prompt y el conocimiento
npm run lint --prefix web         # front
npm run build                     # compila el front
```

## Variables de entorno

Todas están en [`.env.example`](.env.example), sin valores secretos. La API key solo se lee en el
backend: nunca llega al front, al repositorio, a los logs ni a las respuestas de la API.

| Variable | Por defecto | Uso |
|---|---|---|
| `LLM_PROVIDER` | `anthropic` | `anthropic` o `gemini` |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | — / `claude-opus-5-5` | Proveedor Anthropic |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | — / `gemini-2.5-flash` | Proveedor Gemini |
| `PORT` | `3002` | Puerto del backend |
| `AGENT_MAX_ITERATIONS` | `25` | Tope de llamadas herramienta → modelo por turno |
| `AGENT_MAX_TOKENS_PER_SESSION` | `1000000` | Tope de tokens por sesión de chat |
| `AGENT_MAX_TOKENS_TOTAL` | `10000000` | Tope de tokens de todo el servidor |
| `AGENT_MAX_SESSIONS` | `100` | Sesiones en memoria (se descarta la más antigua) |
| `AGENT_LLM_TIMEOUT_MS` | `120000` | Tope de cada llamada al modelo |
| `AGENT_SESIONES_AISLADAS` | vacío | `true` = cada sesión trabaja en `out/sesiones/<id>/` (activado en el despliegue) |
| `ACCESS_KEY` | vacío | Si se define, `/api/*` exige el header `x-access-key` |

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation }` |
| `GET` | `/api/sessions/:id` | Historial completo de la sesión |
| `GET` | `/api/health` | `{ ok, provider, model, accessKeyRequired }`, sin exponer claves |

`toolCalls[]` trae, por cada llamada del turno, `{ nombre, argumentos, ok, resumen }`; el chat las
muestra todas. `needsConfirmation` es `true` cuando el agente termina su turno con una pregunta.

## Estructura

```
agent/prompt.md                      comportamiento: system prompt del agente
src/knowledge/registro-contratos.md  conocimiento: reglas del proceso
src/tools/contratos.ts               ejecución: las 5 herramientas (cada export → contratos_<export>)
src/tools/lib/                       lógica determinista (extracción, validación, registro, alertas)
src/agent/                           ciclo del agente y registro de herramientas
src/llm/                             adaptador propio + implementaciones Anthropic y Gemini
src/server.ts                        API HTTP
web/                                 chat en React
modulo/                              agente empaquetado para otras plataformas (bonus)
fixtures/reto-02/                    datos entregados por Periferia (solo lectura)
demo.ts                              herramientas sin modelo
```

## Módulo reutilizable

`modulo/` empaqueta el agente sin depender del servidor:

- `modulo/agent.md` y `modulo/skill/registro-contratos/SKILL.md` se **generan** con
  `npm run sync:modulo` a partir de `agent/prompt.md` y `src/knowledge/registro-contratos.md`.
- `modulo/tools/contratos.ts` reexporta `src/tools/contratos.ts`: son las mismas herramientas, no
  una copia.

## Despliegue

`render.yaml` define un único servicio web en Render (plan free) que construye el front y sirve
front y API desde la misma URL.

1. En Render: **New → Blueprint** y conecta el repositorio `portafolio-dev` (rama `main`).
   `rootDir` limita el build y el auto-deploy a esta carpeta.
2. Render pide los valores marcados como secretos: carga `ANTHROPIC_API_KEY` ahí, nunca en el
   repositorio. `ACCESS_KEY` puede quedar vacía.
3. Al terminar el build, el link queda en `https://<nombre-del-servicio>.onrender.com`.
   `GET /api/health` confirma proveedor y modelo.

En el despliegue cada sesión del chat tiene su propio buzón (`AGENT_SESIONES_AISLADAS=true`): lo
que procese un visitante no afecta a otro. El plan free se duerme tras 15 minutos sin tráfico (la
primera visita tarda alrededor de un minuto) y su disco es efímero, así que `out/` vuelve a cero en
cada reinicio. Recomendado: definir además un límite de gasto mensual en la consola del proveedor.

## Seguridad

- La API key vive solo en variables de entorno del backend. `.env` está en `.gitignore` y
  `.env.example` va sin valores.
- Las herramientas no ejecutan comandos de shell, validan con zod todo argumento del modelo y
  rechazan rutas fuera del buzón. Los campos que van al CSV se neutralizan contra inyección de
  fórmulas.
- El servidor no habilita CORS (el front se sirve desde el mismo origen), envía cabeceras de
  seguridad con una CSP estricta, limita el tamaño de las entradas y compara la clave de acceso en
  tiempo constante.
- El chat renderiza el Markdown del agente como elementos de React, nunca como HTML crudo.
- `npm audit` del backend: 0 vulnerabilidades. Front: ver la sección de riesgos de `SOLUCION.md`
  (aviso de `picomatch` sin versión corregida, solo en herramientas de build).
