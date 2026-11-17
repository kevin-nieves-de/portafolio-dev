import { cargarComerciales, leerCorreo, resolverComercial } from "./buzon.js"
import { buscarAdjuntoDeContrato } from "./documento.js"
import {
  CAMPOS_CON_CONFIANZA,
  UMBRAL_CONFIANZA,
  type CampoConConfianza,
  type Clasificacion,
  type Contrato,
  type Correo,
  type FilaMaestro,
} from "./esquemas.js"
import { extraerContrato } from "./extraccion.js"
import { buscarPorId, buscarPorNit, leerMaestro } from "./maestro.js"
import { similitudTexto } from "./similitud.js"

/** RN2: similitud mínima de `objeto` para tratar como el mismo contrato uno sin id coincidente. */
export const UMBRAL_SIMILITUD_OBJETO = 0.9

/**
 * Campos que un documento puede cambiar en una fila existente. `cliente` y `objeto` no se
 * sobrescriben: el maestro guarda su redacción canónica y el texto del contrato es más largo.
 * `nit_cliente` y `pais` son identidad: si difieren es un conflicto, no una actualización.
 */
export const CAMPOS_ACTUALIZABLES = ["valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza"] as const
type CampoActualizable = (typeof CAMPOS_ACTUALIZABLES)[number]
const CAMPOS_IDENTIDAD = ["nit_cliente", "pais"] as const

export type Diferencias = Partial<Record<CampoActualizable, { maestro: unknown; documento: unknown }>>

export interface ComercialResuelto {
  email: string
  nombre: string | null
  registrado: boolean
}

/** Lo que devuelve `contratos_validar` (HU-3). */
export interface ResultadoValidacion {
  clasificacion: Clasificacion
  id_contrato_existente: string | null
  requiere_revision: string[]
  /** Por qué cada campo de `requiere_revision` está ahí, para mostrárselo al humano. */
  motivos_revision: Record<string, string>
  diferencias: Diferencias | null
  comercial: ComercialResuelto
  motivo: string | null
  avisos: string[]
}

/** Contexto interno que `registrar` reutiliza para no releer ni reextraer. */
export interface Evaluacion {
  resultado: ResultadoValidacion
  correo: Correo
  adjunto: { nombre: string; texto: string } | null
  existente: FilaMaestro | null
  filas: FilaMaestro[]
}

/**
 * Clasifica un contrato según RN1-RN5. Nunca confía en la clasificación ni en los valores del
 * modelo: vuelve a leer el buzón, reextrae el documento y compara. Un valor que el modelo cambió
 * respecto al documento entra a `requiere_revision` (CA2: solo el humano puede cambiar un valor).
 */
export async function evaluarContrato(directory: string, mensajeId: string, contrato: Contrato): Promise<Evaluacion> {
  const correo = await leerCorreo(directory, mensajeId)
  const comercial = await resolverRemitente(directory, correo.de)
  const avisos = comercial.registrado
    ? []
    : [`remitente no registrado en comerciales.json (${correo.de}): se reporta, no bloquea`]
  const filas = await leerMaestro(directory)

  const rechazo = (motivo: string): Evaluacion => ({
    resultado: { ...resultadoBase(comercial, avisos), clasificacion: "rechazado", motivo },
    correo,
    adjunto: null,
    existente: null,
    filas,
  })

  const adjunto = await buscarAdjuntoDeContrato(directory, correo)
  if (adjunto.estado !== "encontrado") return rechazo(adjunto.motivo)

  const extraido = extraerContrato(adjunto.texto, { fechaCorreo: correo.fecha })
  const motivoRN4 = motivoDeRechazo(extraido)
  if (motivoRN4) return rechazo(motivoRN4)

  const existente = buscarExistente(filas, contrato)
  const contexto = { correo, adjunto: { nombre: adjunto.nombre, texto: adjunto.texto }, existente, filas }

  if (extraido.tipo_documento === "otrosi" && !existente) {
    return rechazo(`otrosí de un contrato que no está en el maestro (${contrato.id_contrato.valor ?? "sin número"})`)
  }

  const diferencias = existente ? calcularDiferencias(existente, contrato) : null
  const clasificacion = clasificar(existente, diferencias, extraido.tipo_documento === "otrosi")
  if (clasificacion === "duplicado") {
    const motivo = `mismo id, valor y fechas que ${existente?.id_contrato ?? ""} en el maestro (RN1): no se escribe nada`
    return { resultado: { ...resultadoBase(comercial, avisos), clasificacion, id_contrato_existente: existente?.id_contrato ?? null, motivo }, ...contexto }
  }

  const motivos = motivosDeRevision(contrato, extraido, existente, clasificacion)
  return {
    resultado: {
      ...resultadoBase(comercial, avisos),
      clasificacion,
      id_contrato_existente: existente?.id_contrato ?? null,
      requiere_revision: Object.keys(motivos),
      motivos_revision: motivos,
      diferencias: diferencias && Object.keys(diferencias).length > 0 ? diferencias : null,
    },
    ...contexto,
  }
}

function resultadoBase(comercial: ComercialResuelto, avisos: string[]): ResultadoValidacion {
  return {
    clasificacion: "rechazado",
    id_contrato_existente: null,
    requiere_revision: [],
    motivos_revision: {},
    diferencias: null,
    comercial,
    motivo: null,
    avisos,
  }
}

async function resolverRemitente(directory: string, email: string): Promise<ComercialResuelto> {
  const comercial = resolverComercial(await cargarComerciales(directory), email)
  return { email, nombre: comercial?.nombre ?? null, registrado: comercial !== null }
}

/** RN4: texto sin partes ni objeto identificables (un otrosí necesita al menos el contrato que modifica). */
function motivoDeRechazo(extraido: Contrato): string | null {
  if (extraido.tipo_documento === "otrosi") {
    return extraido.id_contrato.valor ? null : "otrosí sin número del contrato que modifica"
  }
  if (!extraido.cliente.valor || !extraido.nit_cliente.valor) return "no se identifican las partes del contrato"
  if (!extraido.objeto.valor) return "no se identifica el objeto del contrato"
  return null
}

/** Por id; si no hay id coincidente, mismo `nit_cliente` con `objeto` similar ≥ 0.9 (RN2, riesgo §10). */
function buscarExistente(filas: FilaMaestro[], contrato: Contrato): FilaMaestro | null {
  const id = contrato.id_contrato.valor
  const porId = id ? buscarPorId(filas, id) : undefined
  if (porId) return porId

  const nit = contrato.nit_cliente.valor
  const objeto = contrato.objeto.valor
  if (!nit || !objeto) return null
  return buscarPorNit(filas, nit).find((f) => similitudTexto(f.objeto, objeto) >= UMBRAL_SIMILITUD_OBJETO) ?? null
}

/** Campos que el documento trae (no null) y que difieren de la fila. Un null en un otrosí significa "sin cambio". */
function calcularDiferencias(fila: FilaMaestro, contrato: Contrato): Diferencias {
  const diferencias: Diferencias = {}
  for (const campo of CAMPOS_ACTUALIZABLES) {
    const documento = contrato[campo].valor
    if (documento !== null && documento !== fila[campo]) {
      diferencias[campo] = { maestro: fila[campo], documento }
    }
  }
  return diferencias
}

/** Los tres campos con los que RN1 decide si un contrato reenviado es duplicado. */
const CAMPOS_RN1 = ["valor", "fecha_inicio", "fecha_fin"] as const

/**
 * RN3 nuevo: no hay fila. RN1 duplicado: coinciden valor, fecha_inicio y fecha_fin (un null del
 * documento cuenta como coincidencia: no dice nada distinto); el resto no cuenta. RN2 actualización:
 * alguno de esos tres difiere, o es un otrosí que cambia cualquier campo (un otrosí que no cambia
 * nada es uno ya aplicado: duplicado).
 */
function clasificar(existente: FilaMaestro | null, diferencias: Diferencias | null, esOtrosi: boolean): Clasificacion {
  if (!existente || !diferencias) return "nuevo"
  const relevantes = esOtrosi ? Object.keys(diferencias) : CAMPOS_RN1.filter((c) => c in diferencias)
  return relevantes.length === 0 ? "duplicado" : "actualizacion"
}

function motivosDeRevision(
  contrato: Contrato,
  extraido: Contrato,
  existente: FilaMaestro | null,
  clasificacion: Clasificacion,
): Record<string, string> {
  const motivos: Record<string, string> = {}
  const esOtrosi = extraido.tipo_documento === "otrosi"

  for (const campo of CAMPOS_CON_CONFIANZA) {
    const { valor, confianza } = contrato[campo]
    // En un otrosí, null = "no modifica este campo"; en uno nuevo sin número se asigna AUTO-<año>-<n>.
    const nullEsperado = valor === null && (esOtrosi || (campo === "id_contrato" && clasificacion === "nuevo"))
    if (!nullEsperado && confianza < UMBRAL_CONFIANZA) {
      motivos[campo] = valor === null ? "el documento no trae este dato" : `confianza ${confianza} < ${UMBRAL_CONFIANZA}`
    }
  }

  for (const campo of camposModificados(contrato, extraido)) {
    motivos[campo] = `difiere de lo que dice el documento (${JSON.stringify(valorDe(extraido, campo))}); solo el humano puede cambiarlo`
  }

  if (existente) {
    for (const campo of CAMPOS_IDENTIDAD) {
      const documento = contrato[campo].valor
      if (documento !== null && documento !== existente[campo]) {
        motivos[campo] = `conflicto con el maestro: ${existente.id_contrato} tiene ${existente[campo]}`
      }
    }
  }
  return motivos
}

type CampoComparable = CampoConConfianza | "valor_indeterminado" | "tipo_documento"

function valorDe(contrato: Contrato, campo: CampoComparable): unknown {
  if (campo === "valor_indeterminado" || campo === "tipo_documento") return contrato[campo]
  return contrato[campo].valor
}

/** Campos en que lo recibido del modelo no coincide con la extracción determinista del documento. */
export function camposModificados(recibido: Contrato, extraido: Contrato): CampoComparable[] {
  const campos: CampoComparable[] = [...CAMPOS_CON_CONFIANZA, "valor_indeterminado", "tipo_documento"]
  return campos.filter((c) => JSON.stringify(valorDe(recibido, c)) !== JSON.stringify(valorDe(extraido, c)))
}
