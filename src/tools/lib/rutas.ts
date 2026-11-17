import { promises as fs } from "node:fs"
import path from "node:path"

/**
 * Todas las rutas del reto salen de aquí, resueltas desde `directory` (raíz del proyecto).
 * fixtures/ es de solo lectura (RN6); todo lo que se escribe va a out/.
 */

export function fixturesDir(directory: string): string {
  return path.join(directory, "fixtures", "reto-02")
}

export function buzonDir(directory: string): string {
  return path.join(fixturesDir(directory), "buzon")
}

const ID_MENSAJE_VALIDO = /^[A-Za-z0-9_-]+$/

/** Rechaza ids con "/" o ".." para que un argumento del modelo no pueda salirse del buzón. */
export function mensajeDir(directory: string, mensajeId: string): string {
  if (!ID_MENSAJE_VALIDO.test(mensajeId)) {
    throw new Error(`id de mensaje inválido: "${mensajeId}"`)
  }
  return path.join(buzonDir(directory), mensajeId)
}

export function maestroFixturePath(directory: string): string {
  return path.join(fixturesDir(directory), "maestro-contratos.csv")
}

export function comercialesPath(directory: string): string {
  return path.join(fixturesDir(directory), "comerciales.json")
}

export function outDir(directory: string): string {
  return path.join(directory, "out")
}

/** Simula la biblioteca de SharePoint. Las rutas guardadas en el maestro son relativas a esta carpeta. */
export function sharepointDir(directory: string): string {
  return path.join(outDir(directory), "sharepoint")
}

export function maestroOutPath(directory: string): string {
  return path.join(sharepointDir(directory), "maestro-contratos.csv")
}

export function historialPath(directory: string): string {
  return path.join(sharepointDir(directory), "historial.jsonl")
}

export function procesadosPath(directory: string): string {
  return path.join(outDir(directory), "procesados.json")
}

export function alertasPath(directory: string): string {
  return path.join(outDir(directory), "alertas.md")
}

/** Convierte una ruta absoluta en relativa a `base`, siempre con "/" (así queda en el CSV en cualquier SO). */
export function rutaRelativa(base: string, absoluta: string): string {
  return path.relative(base, absoluta).split(path.sep).join("/")
}

export async function existeArchivo(ruta: string): Promise<boolean> {
  try {
    return (await fs.stat(ruta)).isFile()
  } catch {
    return false
  }
}

export async function existeDirectorio(ruta: string): Promise<boolean> {
  try {
    return (await fs.stat(ruta)).isDirectory()
  } catch {
    return false
  }
}

export async function ensureDir(ruta: string): Promise<void> {
  await fs.mkdir(ruta, { recursive: true })
}

/** Lee un archivo de texto. Traduce el error de E/S a un mensaje legible, sin traza cruda (HU-6). */
export async function leerTexto(ruta: string, descripcion: string): Promise<string> {
  try {
    return await fs.readFile(ruta, "utf-8")
  } catch {
    throw new Error(`no se encontró ${descripcion} (${path.basename(ruta)})`)
  }
}

export async function leerJson(ruta: string, descripcion: string): Promise<unknown> {
  const contenido = await leerTexto(ruta, descripcion)
  try {
    return JSON.parse(contenido) as unknown
  } catch {
    throw new Error(`${descripcion} está corrupto o mal formado (${path.basename(ruta)})`)
  }
}

export async function escribirJson(ruta: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(ruta))
  await fs.writeFile(ruta, JSON.stringify(data, null, 2) + "\n", "utf-8")
}

export async function escribirTexto(ruta: string, contenido: string): Promise<void> {
  await ensureDir(path.dirname(ruta))
  await fs.writeFile(ruta, contenido, "utf-8")
}

export async function agregarLinea(ruta: string, linea: string): Promise<void> {
  await ensureDir(path.dirname(ruta))
  await fs.appendFile(ruta, linea + "\n", "utf-8")
}

export async function copiarArchivo(origen: string, destino: string): Promise<void> {
  await ensureDir(path.dirname(destino))
  await fs.copyFile(origen, destino)
}
