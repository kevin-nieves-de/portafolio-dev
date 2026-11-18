import type { ToolCallDisplay } from "./types"

/**
 * Una llamada a herramienta tal como la ejecutó el backend (CA4). Los argumentos de
 * `validar`/`registrar` traen el contrato completo, así que se muestra primero lo que
 * identifica la llamada (mensaje, fecha, confirmado) y el JSON completo queda plegado.
 */
export function ToolCallCard({ toolCall }: { toolCall: ToolCallDisplay }) {
  const resumen = resumirArgumentos(toolCall.argumentos)
  return (
    <div className={`tool-call ${toolCall.ok ? "tool-call--ok" : "tool-call--error"}`}>
      <div className="tool-call__cabecera">
        <span className="tool-call__icono" aria-label={toolCall.ok ? "correcta" : "con error"}>
          {toolCall.ok ? "✓" : "✕"}
        </span>
        <span className="tool-call__nombre">{toolCall.nombre}</span>
        {resumen && <span className="tool-call__clave">{resumen}</span>}
      </div>
      <div className="tool-call__resumen">{toolCall.resumen}</div>
      <details className="tool-call__detalle">
        <summary>argumentos</summary>
        <pre>{formatear(toolCall.argumentos)}</pre>
      </details>
    </div>
  )
}

function resumirArgumentos(argumentos: unknown): string {
  if (typeof argumentos !== "object" || argumentos === null) return ""
  const partes: string[] = []
  for (const [clave, valor] of Object.entries(argumentos)) {
    if (clave === "mensaje_id" || clave === "hoy") partes.push(String(valor))
    if (clave === "confirmado" && valor === true) partes.push("confirmado")
  }
  return partes.join(" · ")
}

function formatear(argumentos: unknown): string {
  try {
    return JSON.stringify(argumentos, null, 2)
  } catch {
    return String(argumentos)
  }
}
