import { z } from "zod"
import * as herramientasContratos from "../tools/contratos.js"
import type { ToolArgsShape, ToolDefinition } from "../tools/types.js"

export interface HerramientaRegistrada {
  nombre: string
  definicion: ToolDefinition
  esquemaZod: z.ZodObject<ToolArgsShape>
}

/** Cada export de src/tools/contratos.ts se expone al modelo como `contratos_<export>`. */
export function construirRegistroHerramientas(): HerramientaRegistrada[] {
  const modulo = herramientasContratos as unknown as Record<string, ToolDefinition>
  return Object.entries(modulo).map(([nombreExport, definicion]) => ({
    nombre: `contratos_${nombreExport}`,
    definicion,
    esquemaZod: z.object(definicion.args),
  }))
}
