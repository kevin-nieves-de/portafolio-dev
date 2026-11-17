import { promises as fs, existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import cors from "cors"
import "dotenv/config"
import express from "express"
import { z } from "zod"

import { ejecutarTurno } from "./agent/loop.js"
import { construirRegistroHerramientas } from "./agent/tool-registry.js"
import type { AdaptadorLLM, Mensaje } from "./llm/adapter.js"
import { crearAdaptadorLLM } from "./llm/index.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, "..")

const PORT = Number(process.env.PORT ?? 3002)
const MAX_ITERACIONES = Number(process.env.AGENT_MAX_ITERATIONS ?? 25)
const MAX_TOKENS_SESION = Number(process.env.AGENT_MAX_TOKENS_PER_SESSION ?? 200_000)
const ACCESS_KEY = process.env.ACCESS_KEY || null
const TIMEOUT_LLM_MS = 60_000

interface Sesion {
  historial: Mensaje[]
  tokensUsados: number
  creada: string
}

const sesiones = new Map<string, Sesion>()
const herramientas = construirRegistroHerramientas()

let adaptadorCache: AdaptadorLLM | null = null
/** Se crea al primer uso, no al arrancar el servidor, para que /api/health no exija la API key. */
function obtenerAdaptador(): AdaptadorLLM {
  adaptadorCache ??= crearAdaptadorLLM()
  return adaptadorCache
}

let systemPromptCache: string | null = null
async function obtenerSystemPrompt(): Promise<string> {
  if (systemPromptCache === null) {
    const [prompt, conocimiento] = await Promise.all([
      fs.readFile(path.join(PROJECT_ROOT, "agent", "prompt.md"), "utf-8"),
      fs.readFile(path.join(PROJECT_ROOT, "src", "knowledge", "registro-contratos.md"), "utf-8"),
    ])
    systemPromptCache = `${prompt}\n\n---\n\n${conocimiento}`
  }
  return systemPromptCache
}

function obtenerSesion(sessionId: string): Sesion {
  let sesion = sesiones.get(sessionId)
  if (!sesion) {
    sesion = { historial: [], tokensUsados: 0, creada: new Date().toISOString() }
    sesiones.set(sessionId, sesion)
  }
  return sesion
}

const app = express()
app.use(cors())
app.use(express.json())

// La clave de acceso (si se define) solo protege /api/*, nunca los estáticos del front.
app.use((req, res, next) => {
  const esApiProtegida = req.path.startsWith("/api/") && req.path !== "/api/health"
  if (!ACCESS_KEY || !esApiProtegida || req.header("x-access-key") === ACCESS_KEY) {
    next()
    return
  }
  res.status(401).json({ ok: false, error: "acceso no autorizado" })
})

app.get("/api/health", (_req, res) => {
  const provider = process.env.LLM_PROVIDER ?? "anthropic"
  const model =
    provider === "gemini"
      ? (process.env.GEMINI_MODEL ?? "gemini-2.5-flash")
      : (process.env.ANTHROPIC_MODEL ?? "claude-opus-5")
  res.json({ ok: true, provider, model })
})

const cuerpoChatSchema = z.object({
  sessionId: z.string().min(1),
  message: z.string().min(1),
})

app.post("/api/chat", async (req, res) => {
  const parseo = cuerpoChatSchema.safeParse(req.body)
  if (!parseo.success) {
    res.status(400).json({ ok: false, error: "cuerpo inválido: se espera { sessionId, message }" })
    return
  }
  const { sessionId, message } = parseo.data
  const sesion = obtenerSesion(sessionId)

  if (sesion.tokensUsados >= MAX_TOKENS_SESION) {
    res.json({
      reply: "Esta sesión alcanzó el límite de tokens configurado (AGENT_MAX_TOKENS_PER_SESSION). Inicia una sesión nueva para continuar.",
      toolCalls: [],
      needsConfirmation: false,
    })
    return
  }

  // CA5: un error de herramienta o del proveedor LLM se muestra en el chat, la sesión no muere.
  try {
    const adaptador = obtenerAdaptador()
    const systemPrompt = await obtenerSystemPrompt()

    const resultado = await conTimeout(
      ejecutarTurno(sesion.historial, message, {
        directory: PROJECT_ROOT,
        sessionId,
        adaptador,
        systemPrompt,
        herramientas,
        maxIteraciones: MAX_ITERACIONES,
      }),
      TIMEOUT_LLM_MS,
      "El proveedor de modelo de lenguaje no respondió a tiempo",
    )

    sesion.tokensUsados += resultado.tokensConsumidos
    res.json({ reply: resultado.reply, toolCalls: resultado.toolCalls, needsConfirmation: resultado.needsConfirmation })
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : "error desconocido"
    res.json({
      reply: `No pude completar la solicitud: ${mensaje}. La sesión sigue activa, puedes intentar de nuevo.`,
      toolCalls: [],
      needsConfirmation: false,
    })
  }
})

app.get("/api/sessions/:id", (req, res) => {
  const sesion = sesiones.get(req.params.id)
  if (!sesion) {
    res.status(404).json({ ok: false, error: "sesión no encontrada" })
    return
  }
  res.json({ ok: true, data: sesion })
})

// En producción (deploy o `npm start`) el mismo servicio sirve el front construido, así
// hay una sola URL y un solo puerto. En dev no existe web/dist y el front lo sirve Vite.
const WEB_DIST = path.join(PROJECT_ROOT, "web", "dist")
if (existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST))
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(WEB_DIST, "index.html"))
  })
  console.log(`[server] sirviendo front desde ${WEB_DIST}`)
}

function conTimeout<T>(promesa: Promise<T>, ms: number, mensaje: string): Promise<T> {
  return Promise.race([
    promesa,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(mensaje)), ms)
    }),
  ])
}

app.listen(PORT, () => {
  console.log(`[server] escuchando en http://localhost:${PORT}`)
})
