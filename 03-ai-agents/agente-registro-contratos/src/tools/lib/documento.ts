import path from "node:path"
import { leerAdjunto } from "./buzon.js"
import type { Contrato, Correo } from "./esquemas.js"
import { clasificarDocumento } from "./extraccion.js"

/** Formatos cuyo texto se puede leer hoy. PDF nativo es P1 (`contratos_leer_pdf`), aún no implementado. */
const EXTENSIONES_LEGIBLES = new Set([".txt"])

export type ResultadoAdjunto =
  | { estado: "encontrado"; nombre: string; texto: string; tipo: Exclude<Contrato["tipo_documento"], "otro"> }
  /** Se leyó todo y nada es un contrato: RN4, se rechaza. */
  | { estado: "ninguno"; motivo: string }
  /** Hay adjuntos que no se pueden leer: no se rechaza a ciegas, lo revisa un humano. */
  | { estado: "no_legible"; motivo: string }

/** El primer adjunto del correo que sea un contrato o un otrosí, decidido por su contenido y no por su nombre. */
export async function buscarAdjuntoDeContrato(directory: string, correo: Correo): Promise<ResultadoAdjunto> {
  if (correo.adjuntos.length === 0) return { estado: "ninguno", motivo: "el correo no trae adjuntos" }

  const noLegibles: string[] = []
  const otros: string[] = []
  for (const nombre of correo.adjuntos) {
    if (!EXTENSIONES_LEGIBLES.has(path.extname(nombre).toLowerCase())) {
      noLegibles.push(nombre)
      continue
    }
    const texto = await leerAdjunto(directory, correo.id, nombre)
    const tipo = clasificarDocumento(texto)
    if (tipo !== "otro") return { estado: "encontrado", nombre, texto, tipo }
    otros.push(nombre)
  }

  if (noLegibles.length > 0) {
    return {
      estado: "no_legible",
      motivo: `adjuntos en formato no soportado (${noLegibles.join(", ")}): requiere revisión manual`,
    }
  }
  return { estado: "ninguno", motivo: `ningún adjunto es un contrato ni un otrosí (${otros.join(", ")})` }
}
