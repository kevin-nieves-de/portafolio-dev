import type { Contrato } from "./esquemas.js"
import { buscarFechas, buscarMesSinDia, buscarPlazoEnMeses, fechaIso, finDePlazo } from "./fechas.js"
import { inferirPais, NIT_PERIFERIA, normalizarIdentificador, type Pais, type TipoIdentificador } from "./identificadores.js"
import { buscarMontos, esMonedaSoportada, monedaPorPalabra, type Moneda } from "./montos.js"
import { capitalizarRazonSocial, normalizar, truncar } from "./normalizar.js"

/**
 * Extracción determinista (HU-2, P0) del texto de un contrato a la sección 7.2. Cada campo trae su
 * confianza; lo que el texto no dice queda en `null` con confianza 0, nunca se inventa.
 *
 * Escala de confianza usada (documentada en SOLUCION.md §5):
 *  - 0.95  el texto lo dice literalmente en su cláusula y una segunda señal lo confirma
 *  - 0.85-0.9  literal en su cláusula, sin segunda señal
 *  - 0.8   inferido por una regla de negocio segura (moneda por país, póliza condicional)
 *  - 0.5-0.6  derivado de una suposición (fecha de firma sin día, valor por demanda) -> revisión
 */

type Campo<T> = { valor: T | null; confianza: number }
const AUSENTE = { valor: null, confianza: 0 } as const

const MONEDA_POR_PAIS: Record<Pais, Moneda> = { CO: "COP", EC: "USD", PE: "PEN", PA: "USD", HN: "HNL" }

export interface ContextoExtraccion {
  /** Fecha de envío del correo (ISO con hora). Acota una firma sin día: no pudo firmarse después. */
  fechaCorreo: string
}

export function clasificarDocumento(texto: string): Contrato["tipo_documento"] {
  const encabezado = normalizar(texto.trim().split("\n")[0] ?? "")
  if (/^otrosi\b/.test(encabezado)) return "otrosi"
  if (/\bcontrato\b/.test(encabezado) && /\bentre\b/.test(normalizar(texto))) return "contrato"
  return "otro"
}

export function extraerContrato(texto: string, contexto: ContextoExtraccion): Contrato {
  if (texto.trim() === "") throw new Error("el adjunto está vacío, no hay texto que extraer")

  const tipo = clasificarDocumento(texto)
  const observaciones: string[] = []
  const vacio = contratoVacio(tipo, observaciones)
  if (tipo === "otro") {
    observaciones.push("el documento no es un contrato ni un otrosí (no tiene encabezado de contrato ni partes)")
    return vacio
  }

  const parrafos = dividirParrafos(texto)
  const parte = extraerContratante(texto)
  const pais = parte ? paisDeParte(parte, observaciones) : AUSENTE
  const { valor, moneda, indeterminado } = extraerValor(buscarClausula(parrafos, "valor"), pais.valor, observaciones)
  const fechas = extraerPlazo(buscarClausula(parrafos, "plazo"), parrafos, contexto, observaciones)

  if (!parte) observaciones.push("no se identificó al CONTRATANTE (razón social con NIT/RUC/RTN distinto al de Periferia)")

  const base: Contrato = {
    ...vacio,
    id_contrato: extraerIdContrato(texto, observaciones),
    cliente: parte ? { valor: capitalizarRazonSocial(parte.nombre), confianza: parte.confianza } : AUSENTE,
    nit_cliente: parte ? { valor: parte.nit, confianza: parte.confianza } : AUSENTE,
    pais,
    valor,
    valor_indeterminado: indeterminado,
    moneda,
    fecha_inicio: fechas.inicio,
    fecha_fin: fechas.fin,
  }
  // Un otrosí solo trae lo que modifica: objeto y pólizas se heredan del maestro, no se extraen.
  if (tipo === "otrosi") return base

  const poliza = extraerPoliza(parrafos, observaciones)
  return {
    ...base,
    objeto: extraerObjeto(buscarClausula(parrafos, "objeto"), observaciones),
    requiere_poliza: poliza.requiere,
    tipo_poliza: poliza.tipos,
  }
}

function contratoVacio(tipo: Contrato["tipo_documento"], observaciones: string[]): Contrato {
  return {
    tipo_documento: tipo,
    id_contrato: AUSENTE,
    cliente: AUSENTE,
    nit_cliente: AUSENTE,
    pais: AUSENTE,
    objeto: AUSENTE,
    valor: AUSENTE,
    valor_indeterminado: false,
    moneda: AUSENTE,
    fecha_inicio: AUSENTE,
    fecha_fin: AUSENTE,
    requiere_poliza: AUSENTE,
    tipo_poliza: AUSENTE,
    observaciones,
  }
}

function dividirParrafos(texto: string): string[] {
  return texto
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
}

/**
 * Párrafo de una cláusula por su nombre: "SEGUNDA. VALOR. …" en un contrato o
 * "Modificar la cláusula SEGUNDA (VALOR) …" en un otrosí. Buscar dentro de la cláusula, y no en
 * todo el texto, evita confundir el umbral de una póliza con el valor o su vigencia con el plazo.
 */
function buscarClausula(parrafos: string[], nombre: string): string | null {
  const encabezado = new RegExp(`^[a-z]+\\.\\s+${nombre}\\.`)
  const referencia = new RegExp(`\\(${nombre}\\)`)
  return parrafos.find((p) => encabezado.test(normalizar(p)) || referencia.test(normalizar(p))) ?? null
}

function extraerIdContrato(texto: string, observaciones: string[]): Campo<string> {
  const encabezado = texto.trim().split("\n")[0] ?? ""
  const enEncabezado = /CONTRATO\b.*?\bNo\.?\s*([A-Z]{1,6}-[A-Z0-9-]+)/i.exec(encabezado)
  if (enEncabezado?.[1]) return { valor: enEncabezado[1].toUpperCase(), confianza: 0.95 }

  const enCuerpo = /contrato\s+No\.?\s*([A-Z]{1,6}-[A-Z0-9-]+)/i.exec(texto)
  if (enCuerpo?.[1]) {
    observaciones.push("el número de contrato no está en el encabezado, se tomó del cuerpo")
    return { valor: enCuerpo[1].toUpperCase(), confianza: 0.7 }
  }
  observaciones.push("el documento no trae número de contrato: al registrar se asigna AUTO-<año>-<secuencia>")
  return AUSENTE
}

interface ParteContratante {
  nombre: string
  tipoId: TipoIdentificador
  nit: string
  /** Texto de la comparecencia de esta parte (domicilio, rol), sin las demás partes. */
  bloque: string
  confianza: number
}

/** "INDUSTRIAS DELTA S.A.S., identificada con NIT 890.900.111-4" / "DISTRIBUIDORA CARIBE S.A.S., NIT 800.222.333-9" */
const PATRON_PARTE =
  /([A-ZÁÉÍÓÚÑÜ0-9][A-ZÁÉÍÓÚÑÜ0-9 .&'-]*?),\s*(?:identificad[ao]\s+con\s+)?(NIT|RUC|RTN)\s*(?:No\.?\s*)?(\d[\d.\s-]*\d)/gu

/**
 * El cliente es la parte que NO es Periferia. El NIT de Periferia aparece en todos los contratos,
 * así que se descarta por identificador (no por nombre, que puede variar). Confianza alta solo si
 * su comparecencia lo nombra EL CONTRATANTE.
 */
function extraerContratante(texto: string): ParteContratante | null {
  const partes = [...texto.matchAll(PATRON_PARTE)]
  for (const [i, m] of partes.entries()) {
    const tipoId = m[2] as TipoIdentificador
    const nit = normalizarIdentificador(tipoId, m[3] ?? "")
    if (nit === NIT_PERIFERIA) continue
    const fin = partes[i + 1]?.index ?? m.index + 400
    const bloque = texto.slice(m.index, fin)
    const esContratante = /CONTRATANTE/.test(bloque)
    return { nombre: (m[1] ?? "").trim(), tipoId, nit, bloque, confianza: esContratante ? 0.95 : 0.7 }
  }
  return null
}

function paisDeParte(parte: ParteContratante, observaciones: string[]): Campo<Pais> {
  const inferido = inferirPais(parte.tipoId, parte.nit, parte.bloque)
  if (inferido.confianza < 0.8) {
    observaciones.push(`el país (${inferido.pais}) se infirió con poca certeza del ${parte.tipoId} y el domicilio`)
  }
  return { valor: inferido.pais, confianza: inferido.confianza }
}

function extraerObjeto(clausula: string | null, observaciones: string[]): Campo<string> {
  if (!clausula) {
    observaciones.push("no se encontró la cláusula OBJETO")
    return AUSENTE
  }
  const sinEncabezado = clausula
    .replace(/^\S+\.\s+OBJETO\.\s*/i, "")
    .replace(/^EL CONTRATISTA\s+(se obliga a|prestará)\s+/i, "")
  const capitalizado = sinEncabezado.charAt(0).toUpperCase() + sinEncabezado.slice(1)
  const objeto = truncar(capitalizado, 200)
  if (objeto.length < capitalizado.trim().length) {
    observaciones.push("el objeto supera 200 caracteres y se recortó")
    return { valor: objeto, confianza: 0.85 }
  }
  return { valor: objeto, confianza: 0.9 }
}

const PATRON_VALOR_INDETERMINADO = /no tiene (un )?valor determinado|valor indeterminado|por demanda|segun (las )?tarifas/

function extraerValor(
  clausula: string | null,
  pais: Pais | null,
  observaciones: string[],
): { valor: Campo<number>; moneda: Campo<Moneda>; indeterminado: boolean } {
  if (!clausula) {
    return { valor: AUSENTE, moneda: AUSENTE, indeterminado: false }
  }

  if (PATRON_VALOR_INDETERMINADO.test(normalizar(clausula))) {
    observaciones.push("contrato por demanda sin valor total: se propone valor 0 (valor_indeterminado), debe confirmarse")
    const moneda = monedaInferida(clausula, pais, observaciones)
    return { valor: { valor: 0, confianza: 0.5 }, moneda, indeterminado: true }
  }

  const monto = buscarMontos(clausula)[0]
  if (!monto) {
    observaciones.push("la cláusula VALOR no trae una cifra con código de moneda")
    return { valor: AUSENTE, moneda: monedaInferida(clausula, pais, observaciones), indeterminado: false }
  }
  if (!esMonedaSoportada(monto.codigo)) {
    throw new Error(`moneda desconocida "${monto.codigo}": el maestro solo admite COP, USD, PEN, PAB y HNL`)
  }
  const confirmadaEnLetras = monedaPorPalabra(clausula) === monto.codigo
  const confianza = confirmadaEnLetras ? 0.95 : 0.85
  return {
    valor: { valor: monto.valor, confianza },
    moneda: { valor: monto.codigo, confianza },
    indeterminado: false,
  }
}

function monedaInferida(clausula: string, pais: Pais | null, observaciones: string[]): Campo<Moneda> {
  const porPalabra = monedaPorPalabra(clausula)
  if (porPalabra) return { valor: porPalabra, confianza: 0.85 }
  if (pais) {
    observaciones.push(`moneda inferida del país del cliente (${pais} -> ${MONEDA_POR_PAIS[pais]})`)
    return { valor: MONEDA_POR_PAIS[pais], confianza: 0.8 }
  }
  return AUSENTE
}

function extraerPlazo(
  clausula: string | null,
  parrafos: string[],
  contexto: ContextoExtraccion,
  observaciones: string[],
): { inicio: Campo<string>; fin: Campo<string> } {
  if (!clausula) {
    observaciones.push("no se encontró la cláusula PLAZO")
    return { inicio: AUSENTE, fin: AUSENTE }
  }
  const fechas = buscarFechas(clausula)
  const meses = buscarPlazoEnMeses(clausula)

  const [primera, segunda] = fechas
  if (primera && segunda) {
    if (meses !== null && finDePlazo(primera.iso, meses) !== segunda.iso) {
      observaciones.push(`el plazo dice ${meses} meses pero las fechas no cuadran (${primera.iso} a ${segunda.iso})`)
      return { inicio: { valor: primera.iso, confianza: 0.95 }, fin: { valor: segunda.iso, confianza: 0.6 } }
    }
    return { inicio: { valor: primera.iso, confianza: 0.95 }, fin: { valor: segunda.iso, confianza: 0.95 } }
  }

  if (primera) {
    // Otrosí: "se extiende hasta el …" solo fija el fin; el inicio se hereda del maestro.
    if (/\bhasta\b/.test(normalizar(clausula)) && !/\bdesde\b/.test(normalizar(clausula))) {
      return { inicio: AUSENTE, fin: { valor: primera.iso, confianza: 0.95 } }
    }
    if (meses === null) {
      observaciones.push("el plazo trae fecha de inicio pero no fecha fin ni duración")
      return { inicio: { valor: primera.iso, confianza: 0.95 }, fin: AUSENTE }
    }
    observaciones.push(`fecha fin calculada: inicio + ${meses} meses - 1 día`)
    return { inicio: { valor: primera.iso, confianza: 0.95 }, fin: { valor: finDePlazo(primera.iso, meses), confianza: 0.85 } }
  }

  if (meses !== null && /firma/.test(normalizar(clausula))) {
    return plazoDesdeFirma(meses, parrafos, contexto, observaciones)
  }
  observaciones.push("la cláusula PLAZO no trae fechas reconocibles")
  return { inicio: AUSENTE, fin: AUSENTE }
}

/**
 * "N meses contados a partir de la fecha de su firma". El día de la firma no cuenta (el plazo
 * corre desde el día siguiente). Si la firma no trae día ("en el mes de agosto de 2026"), se toma
 * como cota la fecha de envío del correo cuando cae en ese mes (no pudo firmarse después de
 * enviarse), o el último día del mes si no. Ambas fechas quedan con confianza baja: son propuestas.
 */
function plazoDesdeFirma(
  meses: number,
  parrafos: string[],
  contexto: ContextoExtraccion,
  observaciones: string[],
): { inicio: Campo<string>; fin: Campo<string> } {
  const parrafoFirma = parrafos.find((p) => /se firma|firma en|para constancia/.test(normalizar(p))) ?? ""
  const fechaFirma = buscarFechas(parrafoFirma)[0]?.iso ?? null
  const mesFirma = fechaFirma ? null : buscarMesSinDia(parrafoFirma)

  // Firma con día: el único supuesto es el cómputo desde el día siguiente (0.8). Sin día, la fecha
  // de firma misma es una suposición: inicio 0.6 y fin 0.5 (el fin acumula ambas suposiciones).
  let firma: string | null = fechaFirma
  let confianzaInicio = 0.8
  let confianzaFin = 0.8
  if (!firma && mesFirma) {
    firma = cotaDeFirma(mesFirma.anio, mesFirma.mes, contexto.fechaCorreo)
    confianzaInicio = 0.6
    confianzaFin = 0.5
    observaciones.push(
      `la firma no indica el día (solo ${String(mesFirma.mes).padStart(2, "0")}/${mesFirma.anio}); se asume ${firma} como fecha de firma`,
    )
  }
  if (!firma) {
    observaciones.push("el plazo corre desde la firma, pero la fecha de firma no aparece en el documento")
    return { inicio: AUSENTE, fin: AUSENTE }
  }
  const inicio = sumarDias(firma, 1)
  observaciones.push(`plazo de ${meses} meses contado desde el día siguiente a la firma: ${inicio} a ${finDePlazo(inicio, meses)}`)
  return {
    inicio: { valor: inicio, confianza: confianzaInicio },
    fin: { valor: finDePlazo(inicio, meses), confianza: confianzaFin },
  }
}

function cotaDeFirma(anio: number, mes: number, fechaCorreo: string): string {
  const correo = fechaCorreo.slice(0, 10)
  const ultimoDiaMes = new Date(Date.UTC(anio, mes, 0)).getUTCDate()
  const finDeMes = fechaIso(anio, mes, ultimoDiaMes)
  return correo.startsWith(`${anio}-${String(mes).padStart(2, "0")}-`) ? correo : finDeMes
}

function sumarDias(iso: string, dias: number): string {
  const fecha = new Date(`${iso}T00:00:00Z`)
  fecha.setUTCDate(fecha.getUTCDate() + dias)
  return fecha.toISOString().slice(0, 10)
}

/** Tipos de póliza reconocidos -> nombre canónico usado en la columna `tipo_poliza` del maestro. */
const TIPOS_POLIZA: Array<[RegExp, string]> = [
  [/cumplimiento/, "cumplimiento"],
  [/calidad/, "calidad"],
  [/responsabilidad civil/, "responsabilidad_civil"],
  [/salarios|prestaciones sociales/, "salarios_prestaciones"],
  [/anticipo|buen manejo/, "anticipo"],
  [/estabilidad/, "estabilidad"],
]
const PATRON_CONDICION = /cuyo valor supere|en caso de que|siempre que|cuando el valor|si el valor/

function extraerPoliza(parrafos: string[], observaciones: string[]): { requiere: Campo<boolean>; tipos: Campo<string> } {
  const clausula = parrafos.find((p) => /\bpolizas?\b/.test(normalizar(p)))
  if (!clausula) {
    return { requiere: { valor: false, confianza: 0.9 }, tipos: { valor: "", confianza: 0.9 } }
  }
  const normalizada = normalizar(clausula)
  const tipos = TIPOS_POLIZA.filter(([patron]) => patron.test(normalizada)).map(([, nombre]) => nombre)
  const tiposCampo: Campo<string> = tipos.length > 0 ? { valor: tipos.join(";"), confianza: 0.9 } : { valor: "", confianza: 0.5 }

  if (PATRON_CONDICION.test(normalizada)) {
    observaciones.push("la póliza es condicional (solo para ciertas órdenes): se marca requiere_poliza para hacerle seguimiento")
    return { requiere: { valor: true, confianza: 0.8 }, tipos: tiposCampo }
  }
  return { requiere: { valor: true, confianza: 0.95 }, tipos: tiposCampo }
}

/** "OTROSÍ No. 1 AL CONTRATO…" -> "1". Se usa para nombrar el archivo del otrosí junto al contrato. */
export function numeroOtrosi(texto: string): string | null {
  return /^OTROS[IÍ]\s+No\.?\s*(\d+)/i.exec(texto.trim())?.[1] ?? null
}
