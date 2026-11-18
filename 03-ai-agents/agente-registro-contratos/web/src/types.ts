export interface ToolCallDisplay {
  nombre: string
  argumentos: unknown
  ok: boolean
  resumen: string
}

export interface ChatMessage {
  id: string
  role: "user" | "assistant" | "system"
  text: string
  toolCalls?: ToolCallDisplay[]
  needsConfirmation?: boolean
  isError?: boolean
}

export interface RespuestaChat {
  reply: string
  toolCalls: ToolCallDisplay[]
  needsConfirmation: boolean
}

export interface RespuestaHealth {
  ok: boolean
  provider: string
  model: string
  accessKeyRequired: boolean
}
