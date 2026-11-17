import { promises as fs } from "node:fs"
import path from "node:path"
import { z } from "zod"
import {
  clasificacionSchema,
  comercialSchema,
  correoSchema,
  type Comercial,
  type Correo,
  type EntradaHistorial,
  type MensajeProcesado,
} from "./esquemas.js"
import {
  agregarLinea,
  buzonDir,
  comercialesPath,
  escribirJson,
  existeArchivo,
  historialPath,
  leerJson,
  leerTexto,
  mensajeDir,
  procesadosPath,
} from "./rutas.js"

/** Ids de los mensajes del buzón, en orden (msg-001, msg-002…): el orden de llegada. */
export async function listarIdsMensajes(directory: string): Promise<string[]> {
  const entradas = await fs.readdir(buzonDir(directory), { withFileTypes: true })
  return entradas
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

export async function leerCorreo(directory: string, mensajeId: string): Promise<Correo> {
  const ruta = path.join(mensajeDir(directory, mensajeId), "correo.json")
  if (!(await existeArchivo(ruta))) throw new Error(`no existe el mensaje "${mensajeId}" en el buzón`)
  const parseo = correoSchema.safeParse(await leerJson(ruta, `el correo ${mensajeId}`))
  if (!parseo.success) throw new Error(`el correo ${mensajeId} no tiene el formato esperado`)
  return parseo.data
}

/** Ruta absoluta de un adjunto. Valida el nombre para que no apunte fuera de la carpeta del mensaje. */
export function rutaAdjunto(directory: string, mensajeId: string, adjunto: string): string {
  if (adjunto !== path.basename(adjunto)) throw new Error(`nombre de adjunto inválido: "${adjunto}"`)
  return path.join(mensajeDir(directory, mensajeId), adjunto)
}

export async function leerAdjunto(directory: string, mensajeId: string, adjunto: string): Promise<string> {
  return leerTexto(rutaAdjunto(directory, mensajeId, adjunto), `el adjunto ${adjunto} de ${mensajeId}`)
}

export async function cargarComerciales(directory: string): Promise<Comercial[]> {
  const parseo = z.array(comercialSchema).safeParse(await leerJson(comercialesPath(directory), "la lista de comerciales"))
  if (!parseo.success) throw new Error("comerciales.json no tiene el formato esperado")
  return parseo.data
}

/** HU-3: el remitente se resuelve por email; desconocido -> null, que se reporta pero no bloquea. */
export function resolverComercial(comerciales: Comercial[], email: string): Comercial | null {
  const buscado = email.trim().toLowerCase()
  return comerciales.find((c) => c.email.toLowerCase() === buscado) ?? null
}

const procesadoSchema = z.object({
  mensaje_id: z.string(),
  clasificacion: clasificacionSchema,
  id_contrato: z.string().nullable(),
  motivo: z.string().nullable(),
  ts: z.string(),
})

export async function leerProcesados(directory: string): Promise<MensajeProcesado[]> {
  const ruta = procesadosPath(directory)
  if (!(await existeArchivo(ruta))) return []
  const parseo = z.array(procesadoSchema).safeParse(await leerJson(ruta, "el registro de mensajes procesados"))
  if (!parseo.success) throw new Error("out/procesados.json no tiene el formato esperado")
  return parseo.data
}

/** Marca un mensaje como procesado. Si ya estaba (reproceso), reemplaza su entrada en vez de duplicarla. */
export async function marcarProcesado(directory: string, entrada: MensajeProcesado): Promise<void> {
  const actuales = (await leerProcesados(directory)).filter((p) => p.mensaje_id !== entrada.mensaje_id)
  await escribirJson(procesadosPath(directory), [...actuales, entrada])
}

export async function agregarHistorial(directory: string, entrada: EntradaHistorial): Promise<void> {
  await agregarLinea(historialPath(directory), JSON.stringify(entrada))
}
