import { useEffect, useRef, useState } from "react"
import "./App.css"
import { Markdown } from "./Markdown"
import { ToolCallCard } from "./ToolCallCard"
import type { ChatMessage, RespuestaChat, RespuestaHealth } from "./types"

function idUnico(): string {
  return crypto.randomUUID()
}

const MENSAJE_BIENVENIDA: ChatMessage = {
  id: idUnico(),
  role: "assistant",
  text: "Hola, soy el agente de registro de contratos vigentes de Periferia. Leo el buzón, registro lo que esté limpio, te pido confirmación campo por campo de lo dudoso y genero el reporte de alertas. Puedes empezar con uno de los ejemplos de abajo.",
}

/** Atajos de la demo (PRD §11): solo llenan el campo de texto; el usuario decide enviarlos. */
const EJEMPLOS: Array<{ etiqueta: string; texto: string }> = [
  {
    etiqueta: "Procesar el buzón",
    texto:
      "Procesa el buzón de contratos con fecha de hoy 2026-09-03. Registra lo que esté limpio, muéstrame lo que requiere revisión campo por campo y termina con el reporte de alertas. No registres nada dudoso sin preguntarme.",
  },
  { etiqueta: "Confirmar msg-006", texto: "Confirmo para msg-006 el valor 0, la fecha inicio 2026-09-01 y la fecha fin 2027-08-31." },
  { etiqueta: "Solo alertas", texto: "Genera el reporte de alertas con fecha de hoy 2026-09-03." },
]

export function App() {
  const [sessionId] = useState(idUnico)
  const [claveAcceso, setClaveAcceso] = useState("")
  const [salud, setSalud] = useState<RespuestaHealth | null>(null)
  const [mensajes, setMensajes] = useState<ChatMessage[]>([MENSAJE_BIENVENIDA])
  const [entrada, setEntrada] = useState("")
  const [pensando, setPensando] = useState(false)
  const finRef = useRef<HTMLDivElement>(null)
  const entradaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((data: RespuestaHealth) => setSalud(data))
      .catch(() => setSalud(null))
  }, [])

  useEffect(() => {
    finRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [mensajes, pensando])

  function usarEjemplo(texto: string) {
    setEntrada(texto)
    entradaRef.current?.focus()
  }

  async function enviar() {
    const texto = entrada.trim()
    if (!texto || pensando) return

    setMensajes((prev) => [...prev, { id: idUnico(), role: "user", text: texto }])
    setEntrada("")
    setPensando(true)

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (claveAcceso.trim()) headers["x-access-key"] = claveAcceso.trim()

      const respuesta = await fetch("/api/chat", {
        method: "POST",
        headers,
        body: JSON.stringify({ sessionId, message: texto }),
      })

      if (respuesta.status === 401) throw new Error("la clave de acceso no es válida; escríbela en el campo de arriba")
      if (!respuesta.ok) throw new Error(`el servidor respondió ${respuesta.status}`)

      const data = (await respuesta.json()) as RespuestaChat
      setMensajes((prev) => [
        ...prev,
        {
          id: idUnico(),
          role: "assistant",
          text: data.reply,
          toolCalls: data.toolCalls,
          needsConfirmation: data.needsConfirmation,
        },
      ])
    } catch (err) {
      const mensaje = err instanceof Error ? err.message : "error desconocido"
      setMensajes((prev) => [
        ...prev,
        { id: idUnico(), role: "assistant", text: `No se pudo contactar al agente: ${mensaje}`, isError: true },
      ])
    } finally {
      setPensando(false)
    }
  }

  function manejarTecla(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void enviar()
    }
  }

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <h1>Registro de Contratos</h1>
          <p className="app__subtitulo">Agente conversacional — Periferia IT Group</p>
        </div>
        <div className="app__header-derecha">
          <span className={`estado-salud ${salud ? "estado-salud--ok" : "estado-salud--error"}`}>
            {salud ? `${salud.provider} · ${salud.model}` : "backend no disponible"}
          </span>
          {salud?.accessKeyRequired && (
            <input
              className="clave-acceso"
              type="password"
              autoComplete="off"
              placeholder="Clave de acceso"
              aria-label="Clave de acceso"
              value={claveAcceso}
              onChange={(e) => setClaveAcceso(e.target.value)}
            />
          )}
        </div>
      </header>

      <main className="chat" aria-live="polite">
        {mensajes.map((m) => (
          <div key={m.id} className={`mensaje mensaje--${m.role} ${m.needsConfirmation ? "mensaje--confirmacion" : ""}`}>
            {m.needsConfirmation && <div className="badge-confirmacion">⚠ Requiere tu confirmación explícita</div>}
            <div className={`burbuja ${m.isError ? "burbuja--error" : ""}`}>
              {m.role === "assistant" && !m.isError ? <Markdown texto={m.text} /> : m.text}
            </div>
            {m.toolCalls && m.toolCalls.length > 0 && (
              <div className="tool-calls">
                <div className="tool-calls__titulo">{m.toolCalls.length} llamadas a herramientas</div>
                {m.toolCalls.map((tc, i) => (
                  <ToolCallCard key={`${m.id}-${i}`} toolCall={tc} />
                ))}
              </div>
            )}
          </div>
        ))}
        {pensando && (
          <div className="mensaje mensaje--assistant">
            <div className="burbuja burbuja--pensando">Pensando… procesar el buzón completo puede tardar un par de minutos.</div>
          </div>
        )}
        <div ref={finRef} />
      </main>

      <footer className="app__footer">
        <div className="ejemplos">
          {EJEMPLOS.map((ej) => (
            <button key={ej.etiqueta} type="button" className="ejemplo" onClick={() => usarEjemplo(ej.texto)} disabled={pensando}>
              {ej.etiqueta}
            </button>
          ))}
        </div>
        <div className="app__entrada">
          <textarea
            ref={entradaRef}
            className="entrada"
            value={entrada}
            onChange={(e) => setEntrada(e.target.value)}
            onKeyDown={manejarTecla}
            placeholder="Escribe tu mensaje (Enter para enviar, Shift+Enter para salto de línea)"
            aria-label="Mensaje para el agente"
            maxLength={4000}
            rows={2}
          />
          <button className="boton-enviar" onClick={() => void enviar()} disabled={pensando || !entrada.trim()}>
            Enviar
          </button>
        </div>
      </footer>
    </div>
  )
}

export default App
