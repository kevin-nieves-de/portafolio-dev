import type { z } from "zod"

export interface ToolContext {
  /** Raíz del proyecto. Todas las rutas se resuelven desde aquí, nunca absolutas. */
  directory: string
  sessionId: string
}

export type ToolArgsShape = Record<string, z.ZodTypeAny>

export interface ToolDefinition<Args extends ToolArgsShape = ToolArgsShape> {
  description: string
  args: Args
  execute(args: { [K in keyof Args]: z.infer<Args[K]> }, ctx: ToolContext): Promise<string>
}

export type ToolModule = Record<string, ToolDefinition>
