import { promises as fs } from "node:fs"
import { parsearCsv, serializarCsv } from "./csv.js"
import { COLUMNAS_MAESTRO, filaMaestroSchema, type FilaMaestro } from "./esquemas.js"
import { copiarArchivo, existeArchivo, leerTexto, maestroFixturePath, maestroOutPath, escribirTexto } from "./rutas.js"

/**
 * RN6: el fixture es de solo lectura. La primera vez que se necesita el maestro se copia a
 * out/sharepoint/ y desde ahí se lee y escribe. Devuelve la ruta de la copia.
 */
export async function inicializarMaestro(directory: string): Promise<string> {
  const destino = maestroOutPath(directory)
  if (!(await existeArchivo(destino))) {
    await copiarArchivo(maestroFixturePath(directory), destino)
  }
  return destino
}

export async function leerMaestro(directory: string): Promise<FilaMaestro[]> {
  const ruta = await inicializarMaestro(directory)
  const [encabezado, ...filas] = parsearCsv(await leerTexto(ruta, "el maestro de contratos"))
  if (!encabezado) return []
  validarEncabezado(encabezado)

  return filas.map((celdas, i) => {
    const registro = Object.fromEntries(encabezado.map((col, j) => [col, celdas[j] ?? ""]))
    const parseo = filaMaestroSchema.safeParse({
      ...registro,
      valor: Number(registro.valor),
      requiere_poliza: registro.requiere_poliza === "true",
    })
    if (!parseo.success) {
      const detalle = parseo.error.issues.map((e) => `${e.path.map(String).join(".")}: ${e.message}`).join("; ")
      // +2: la fila 1 es el encabezado y las filas del CSV se cuentan desde 1.
      throw new Error(`el maestro tiene una fila inválida (línea ${i + 2}): ${detalle}`)
    }
    return parseo.data
  })
}

function validarEncabezado(encabezado: string[]): void {
  const esperado = COLUMNAS_MAESTRO.join(",")
  if (encabezado.join(",") !== esperado) {
    throw new Error(`el encabezado del maestro no coincide con el esquema 7.2 (se esperaba: ${esperado})`)
  }
}

/** Reescribe el maestro completo. Se escribe a un temporal y se renombra para no dejarlo a medias. */
export async function escribirMaestro(directory: string, filas: FilaMaestro[]): Promise<void> {
  const ruta = maestroOutPath(directory)
  const celdas = filas.map((fila) => COLUMNAS_MAESTRO.map((col) => String(fila[col])))
  const temporal = `${ruta}.tmp`
  await escribirTexto(temporal, serializarCsv([[...COLUMNAS_MAESTRO], ...celdas]))
  await fs.rename(temporal, ruta)
}

export function buscarPorId(filas: FilaMaestro[], idContrato: string): FilaMaestro | undefined {
  const buscado = idContrato.trim().toUpperCase()
  return filas.find((f) => f.id_contrato.toUpperCase() === buscado)
}

/** RN2 / riesgo §10: el dedupe por cliente va por `nit_cliente`, no por nombre. */
export function buscarPorNit(filas: FilaMaestro[], nitCliente: string): FilaMaestro[] {
  return filas.filter((f) => f.nit_cliente === nitCliente)
}

/** Siguiente id automático `AUTO-<año>-<secuencia>` (sección 7.2) cuando el documento no trae número. */
export function siguienteIdAutomatico(filas: FilaMaestro[], anio: number): string {
  const prefijo = `AUTO-${anio}-`
  const usados = filas
    .filter((f) => f.id_contrato.startsWith(prefijo))
    .map((f) => Number(f.id_contrato.slice(prefijo.length)))
    .filter(Number.isFinite)
  const siguiente = Math.max(0, ...usados) + 1
  return `${prefijo}${String(siguiente).padStart(3, "0")}`
}
