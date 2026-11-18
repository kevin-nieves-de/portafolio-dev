import { createHash, timingSafeEqual } from "node:crypto"
import { promises as fs, existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
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
const MAX_TOKENS_SESION = Number(process.env.AGENT_MAX_TOKENS_PER_SESSION ?? 1_000_000)
/** Tope de todo el proceso: sin él, abrir sesiones nuevas esquivaría el tope por sesión. */
const MAX_TOKENS_TOTAL = Number(process.env.AGENT_MAX_TOKENS_TOTAL ?? 10_000_000)
const MAX_SESIONES = Number(process.env.AGENT_MAX_SESSIONS ?? 100)
const ACCESS_KEY = process.env.ACCESS_KEY || null
const TIMEOUT_LLM_MS = Number(process.env.AGENT_LLM_TIMEOUT_MS ?? 120_000)
/**
 * Con el link público, varias personas comparten el servidor: si todas escribieran en el mismo
 * out/, quien procese el buzón primero se lo "consumiría" a los demás. Aislado, cada sesión trabaja
 * en out/sesiones/<sessionId>/ con su propio maestro, historial y log, y fixtures/ enlazado (solo
 * lectura). En local queda apagado para que las rutas coincidan con el PRD (out/log.jsonl, etc.).
 */
const SESIONES_AISLADAS = process.env.AGENT_SESIONES_AISLADAS === "true"

interface Sesion {
  historial: Mensaje[]
  tokensUsados: number
  creada: string
  /** Un turno a la vez: dos turnos simultáneos intercalarían mensajes en el mismo historial. */
  ocupada: boolean
}

const sesiones = new Map<string, Sesion>()
const herramientas = construirRegistroHerramientas()
let tokensTotales = 0

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
    // Las sesiones viven en memoria: al llegar al tope se descarta la más antigua que esté libre.
    if (sesiones.size >= MAX_SESIONES) {
      const libre = [...sesiones.entries()].find(([, s]) => !s.ocupada)
      if (libre) {
        sesiones.delete(libre[0])
        if (SESIONES_AISLADAS) void fs.rm(carpetaDeSesion(libre[0]), { recursive: true, force: true })
      }
    }
    sesion = { historial: [], tokensUsados: 0, creada: new Date().toISOString(), ocupada: false }
    sesiones.set(sessionId, sesion)
  }
  return sesion
}

/** El sessionId ya pasó por `sessionIdSchema` ([A-Za-z0-9_-]), así que es un segmento de ruta seguro. */
function carpetaDeSesion(sessionId: string): string {
  return path.join(PROJECT_ROOT, "out", "sesiones", sessionId)
}

/** Raíz que reciben las herramientas como `ctx.directory`. */
async function directorioDeTrabajo(sessionId: string): Promise<string> {
  if (!SESIONES_AISLADAS) return PROJECT_ROOT
  const carpeta = carpetaDeSesion(sessionId)
  const enlace = path.join(carpeta, "fixtures")
  if (!existsSync(enlace)) {
    await fs.mkdir(carpeta, { recursive: true })
    // "junction" hace que el enlace a un directorio funcione también en Windows sin permisos de admin.
    await fs.symlink(path.join(PROJECT_ROOT, "fixtures"), enlace, "junction")
  }
  return carpeta
}

/** Compara en tiempo constante (sobre hashes de igual largo) para no filtrar la clave por tiempos. */
function claveValida(recibida: string | undefined): boolean {
  if (!ACCESS_KEY) return true
  if (!recibida) return false
  const hash = (texto: string): Buffer => createHash("sha256").update(texto).digest()
  return timingSafeEqual(hash(recibida), hash(ACCESS_KEY))
}

const app = express()
app.disable("x-powered-by")
app.use(express.json({ limit: "64kb" }))

// El front se sirve desde este mismo origen (y en dev, vía el proxy de Vite), así que no se
// habilita CORS: ningún otro sitio puede llamar a la API desde el navegador de un usuario.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.setHeader("X-Frame-Options", "DENY")
  res.setHeader("Referrer-Policy", "no-referrer")
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  )
  next()
})

// La clave de acceso (si se define) solo protege /api/*, nunca los estáticos del front.
app.use((req, res, next) => {
  const esApiProtegida = req.path.startsWith("/api/") && req.path !== "/api/health"
  if (!esApiProtegida || claveValida(req.header("x-access-key"))) {
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
      : (process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5")
  res.json({ ok: true, provider, model, accessKeyRequired: ACCESS_KEY !== null })
})

const sessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "sessionId inválido")
const cuerpoChatSchema = z.object({
  sessionId: sessionIdSchema,
  message: z.string().trim().min(1).max(4000),
})

app.post("/api/chat", async (req, res) => {
  const parseo = cuerpoChatSchema.safeParse(req.body)
  if (!parseo.success) {
    res.status(400).json({ ok: false, error: "cuerpo inválido: se espera { sessionId, message } con un mensaje de hasta 4000 caracteres" })
    return
  }
  const { sessionId, message } = parseo.data
  const sesion = obtenerSesion(sessionId)

  const respuestaCorta = (reply: string): void => {
    res.json({ reply, toolCalls: [], needsConfirmation: false })
  }
  if (sesion.ocupada) {
    respuestaCorta("Todavía estoy procesando tu mensaje anterior en esta sesión. Espera la respuesta antes de enviar otro.")
    return
  }
  if (sesion.tokensUsados >= MAX_TOKENS_SESION) {
    respuestaCorta("Esta sesión alcanzó el límite de tokens configurado (AGENT_MAX_TOKENS_PER_SESSION). Inicia una sesión nueva para continuar.")
    return
  }
  if (tokensTotales >= MAX_TOKENS_TOTAL) {
    respuestaCorta("El servicio alcanzó el límite global de uso del modelo configurado (AGENT_MAX_TOKENS_TOTAL). Intenta más tarde.")
    return
  }

  // CA5: un error de herramienta o del proveedor LLM se muestra en el chat, la sesión no muere.
  sesion.ocupada = true
  try {
    const adaptador = obtenerAdaptador()
    const systemPrompt = await obtenerSystemPrompt()

    const resultado = await ejecutarTurno(sesion.historial, message, {
      directory: await directorioDeTrabajo(sessionId),
      sessionId,
      adaptador,
      systemPrompt,
      herramientas,
      maxIteraciones: MAX_ITERACIONES,
      timeoutLlmMs: TIMEOUT_LLM_MS,
    })

    sesion.tokensUsados += resultado.tokensConsumidos
    tokensTotales += resultado.tokensConsumidos
    res.json({ reply: resultado.reply, toolCalls: resultado.toolCalls, needsConfirmation: resultado.needsConfirmation })
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : "error desconocido"
    respuestaCorta(`No pude completar la solicitud: ${mensaje}. La sesión sigue activa, puedes intentar de nuevo.`)
  } finally {
    sesion.ocupada = false
  }
})

app.get("/api/sessions/:id", (req, res) => {
  const id = sessionIdSchema.safeParse(req.params.id)
  const sesion = id.success ? sesiones.get(id.data) : undefined
  if (!sesion) {
    res.status(404).json({ ok: false, error: "sesión no encontrada" })
    return
  }
  res.json({ ok: true, data: { historial: sesion.historial, tokensUsados: sesion.tokensUsados, creada: sesion.creada } })
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

app.listen(PORT, () => {
  console.log(`[server] escuchando en http://localhost:${PORT}`)
})
