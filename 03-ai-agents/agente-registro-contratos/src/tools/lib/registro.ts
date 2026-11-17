import path from "node:path"
import { agregarHistorial, leerProcesados, marcarProcesado } from "./buzon.js"
import { filaMaestroSchema, type Contrato, type EntradaHistorial, type FilaMaestro } from "./esquemas.js"
import { numeroOtrosi } from "./extraccion.js"
import { escribirMaestro, siguienteIdAutomatico } from "./maestro.js"
import { slugCliente } from "./normalizar.js"
import { copiarArchivo, mensajeDir, rutaRelativa, sharepointDir } from "./rutas.js"
import { CAMPOS_ACTUALIZABLES, evaluarContrato, type ComercialResuelto, type Evaluacion } from "./validacion.js"

export interface ResultadoRegistro {
  id_contrato: string
  accion: "insercion" | "actualizacion"
  /** Relativa a out/sharepoint/, igual que la columna `ruta_sharepoint`. */
  ruta_archivo: string
  cambios: EntradaHistorial["cambios"]
  estado_poliza: FilaMaestro["estado_poliza"]
}

/**
 * HU-4. Revalida desde cero (no confía en un `validar` previo del modelo) y solo escribe si
 * `requiere_revision` está vacío o `confirmado = true` (RN5). Orden de escritura: archivo, maestro,
 * historial, procesados; así un fallo a mitad nunca deja una fila apuntando a un archivo inexistente.
 */
export async function registrarContrato(
  directory: string,
  mensajeId: string,
  contrato: Contrato,
  confirmado: boolean,
): Promise<ResultadoRegistro> {
  const previo = (await leerProcesados(directory)).find((p) => p.mensaje_id === mensajeId)
  if (previo) {
    throw new Error(`el mensaje ${mensajeId} ya fue procesado (${previo.clasificacion}${previo.id_contrato ? ` ${previo.id_contrato}` : ""})`)
  }

  const evaluacion = await evaluarContrato(directory, mensajeId, contrato)
  const { resultado } = evaluacion
  if (resultado.clasificacion === "duplicado" || resultado.clasificacion === "rechazado") {
    throw new Error(`no se registra: ${resultado.clasificacion} (${resultado.motivo ?? "sin motivo"})`)
  }
  if (resultado.requiere_revision.length > 0 && !confirmado) {
    const detalle = resultado.requiere_revision.map((c) => `${c}: ${resultado.motivos_revision[c] ?? ""}`).join("; ")
    throw new Error(`requiere revisión: ${detalle}. Confirma los valores con el usuario y vuelve a llamar con confirmado=true`)
  }

  const confirmados = confirmado ? resultado.requiere_revision : []
  const registro =
    resultado.clasificacion === "nuevo"
      ? await insertar(directory, evaluacion, contrato, resultado.comercial)
      : await actualizar(directory, evaluacion, contrato)

  await agregarHistorial(directory, {
    ts: new Date().toISOString(),
    id_contrato: registro.id_contrato,
    accion: registro.accion,
    cambios: registro.cambios,
    mensaje_id: mensajeId,
    fecha_recepcion: evaluacion.correo.fecha.slice(0, 10),
    confirmados_por_humano: confirmados,
  })
  await marcarProcesado(directory, {
    mensaje_id: mensajeId,
    clasificacion: resultado.clasificacion,
    id_contrato: registro.id_contrato,
    motivo: null,
    ts: new Date().toISOString(),
  })
  return registro
}

async function insertar(
  directory: string,
  { correo, adjunto, filas }: Evaluacion,
  contrato: Contrato,
  comercial: ComercialResuelto,
): Promise<ResultadoRegistro> {
  const datos = exigirValores(contrato)
  const id = contrato.id_contrato.valor ?? siguienteIdAutomatico(filas, Number(datos.fecha_inicio.slice(0, 4)))
  const ruta = await archivar(directory, correo.id, adjunto, { anio: datos.fecha_inicio.slice(0, 4), cliente: datos.cliente, nombre: id })

  const fila = validarFila({
    id_contrato: id,
    ...datos,
    valor: contrato.valor_indeterminado ? 0 : datos.valor,
    tipo_poliza: datos.requiere_poliza ? (contrato.tipo_poliza.valor ?? "") : "",
    estado_poliza: datos.requiere_poliza ? "pendiente" : "no_aplica",
    comercial: comercial.nombre ?? `no registrado: ${comercial.email}`,
    ruta_sharepoint: ruta,
    // Fecha de recepción en el buzón: determinista para la demo y auditable contra el correo.
    fecha_registro: correo.fecha.slice(0, 10),
    fuente: "buzon",
  })
  await escribirMaestro(directory, [...filas, fila])

  const cambios = Object.fromEntries(Object.entries(fila).map(([campo, valor]) => [campo, { antes: null, despues: valor }]))
  return { id_contrato: id, accion: "insercion", ruta_archivo: ruta, cambios, estado_poliza: fila.estado_poliza }
}

async function actualizar(directory: string, evaluacion: Evaluacion, contrato: Contrato): Promise<ResultadoRegistro> {
  const { correo, adjunto, existente, filas } = evaluacion
  if (!existente) throw new Error("no se encontró la fila a actualizar en el maestro")

  const nueva: FilaMaestro = { ...existente }
  const cambios: EntradaHistorial["cambios"] = {}
  for (const campo of CAMPOS_ACTUALIZABLES) {
    const valor = contrato[campo].valor
    if (valor !== null && valor !== existente[campo]) {
      Object.assign(nueva, { [campo]: valor })
      cambios[campo] = { antes: existente[campo], despues: valor }
    }
  }
  // Si el plazo se extiende y el contrato exige pólizas, estas deben ampliarse: vuelven a pendiente
  // para que aparezcan en las alertas hasta que la analista confirme la nueva vigencia.
  if (cambios.fecha_fin && nueva.requiere_poliza && nueva.estado_poliza === "vigente") {
    nueva.estado_poliza = "pendiente"
    cambios.estado_poliza = { antes: "vigente", despues: "pendiente" }
  }

  const sufijo = numeroOtrosi(adjunto?.texto ?? "")
  const ruta = await archivar(directory, correo.id, adjunto, {
    anio: existente.fecha_inicio.slice(0, 4),
    cliente: existente.cliente,
    nombre: sufijo ? `${existente.id_contrato}-otrosi-${sufijo}` : `${existente.id_contrato}-${correo.id}`,
  })

  const fila = validarFila(nueva)
  await escribirMaestro(
    directory,
    filas.map((f) => (f.id_contrato === existente.id_contrato ? fila : f)),
  )
  return { id_contrato: existente.id_contrato, accion: "actualizacion", ruta_archivo: ruta, cambios, estado_poliza: fila.estado_poliza }
}

/**
 * Copia el documento a Contratos/<año_inicio>/<cliente-slug>/<nombre>.<ext> dentro de out/sharepoint
 * y devuelve la ruta relativa a esa carpeta (como en la columna `ruta_sharepoint` del fixture).
 */
async function archivar(
  directory: string,
  mensajeId: string,
  adjunto: Evaluacion["adjunto"],
  destino: { anio: string; cliente: string; nombre: string },
): Promise<string> {
  if (!adjunto) throw new Error("no hay documento que archivar")
  const extension = path.extname(adjunto.nombre)
  const absoluta = path.join(sharepointDir(directory), "Contratos", destino.anio, slugCliente(destino.cliente), destino.nombre + extension)
  await copiarArchivo(path.join(mensajeDir(directory, mensajeId), adjunto.nombre), absoluta)
  return rutaRelativa(sharepointDir(directory), absoluta)
}

type DatosObligatorios = Pick<
  FilaMaestro,
  "cliente" | "nit_cliente" | "pais" | "objeto" | "valor" | "moneda" | "fecha_inicio" | "fecha_fin" | "requiere_poliza"
>

/** Un contrato nuevo no entra al maestro con huecos, ni siquiera confirmado: el humano debe dar el valor. */
function exigirValores(contrato: Contrato): DatosObligatorios {
  const { cliente, nit_cliente, pais, objeto, valor, moneda, fecha_inicio, fecha_fin, requiere_poliza } = contrato
  const datos = {
    cliente: cliente.valor,
    nit_cliente: nit_cliente.valor,
    pais: pais.valor,
    objeto: objeto.valor,
    valor: valor.valor,
    moneda: moneda.valor,
    fecha_inicio: fecha_inicio.valor,
    fecha_fin: fecha_fin.valor,
    requiere_poliza: requiere_poliza.valor,
  }
  const faltantes = Object.entries(datos)
    .filter(([, v]) => v === null)
    .map(([campo]) => campo)
  if (faltantes.length > 0) throw new Error(`faltan valores para registrar: ${faltantes.join(", ")}`)
  return datos as DatosObligatorios
}

function validarFila(fila: FilaMaestro): FilaMaestro {
  const parseo = filaMaestroSchema.safeParse(fila)
  if (!parseo.success) {
    const detalle = parseo.error.issues.map((e) => `${e.path.map(String).join(".")}: ${e.message}`).join("; ")
    throw new Error(`la fila no cumple el esquema del maestro: ${detalle}`)
  }
  if (parseo.data.fecha_fin < parseo.data.fecha_inicio) {
    throw new Error(`fecha_fin (${parseo.data.fecha_fin}) es anterior a fecha_inicio (${parseo.data.fecha_inicio})`)
  }
  return parseo.data
}
