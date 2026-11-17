import type { ToolCallDisplay } from "./types"

function formatearArgumentos(argumentos: unknown): string {
  try {
    return JSON.stringify(argumentos)
  } catch {
    return String(argumentos)
  }
}

export function ToolCallCard({ toolCall }: { toolCall: ToolCallDisplay }) {
  return (
    <div className={`tool-call ${toolCall.ok ? "tool-call--ok" : "tool-call--error"}`}>
      <div className="tool-call__cabecera">
        <span className="tool-call__icono">{toolCall.ok ? "✓" : "✕"}</span>
        <span className="tool-call__nombre">{toolCall.nombre}</span>
      </div>
      <div className="tool-call__args">{formatearArgumentos(toolCall.argumentos)}</div>
      <div className="tool-call__resumen">{toolCall.resumen}</div>
    </div>
  )
}
