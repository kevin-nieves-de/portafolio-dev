import { normalizar } from "./normalizar.js"

export const PAISES = ["CO", "EC", "PE", "PA", "HN"] as const
export type Pais = (typeof PAISES)[number]

export type TipoIdentificador = "NIT" | "RUC" | "RTN"

/** NIT de Periferia sin dígito de verificación: aparece en todo contrato y nunca es el cliente. */
export const NIT_PERIFERIA = "900123456"

/**
 * Identificador tributario sin puntos, espacios ni dígito de verificación (columna `nit_cliente`).
 * NIT "890.900.111-4" -> "890900111". El RUC de Panamá se escribe "155612345-2-2019": se conserva
 * el primer bloque, que es como lo guarda el maestro. El RTN hondureño a veces viene con guiones
 * de agrupación ("0801-1999-5123456"), que no son DV y se quitan.
 */
export function normalizarIdentificador(tipo: TipoIdentificador, crudo: string): string {
  const sinPuntos = crudo.replace(/[.\s]/g, "")
  const base = tipo === "RTN" ? sinPuntos.replace(/-/g, "") : (sinPuntos.split("-")[0] ?? "")
  if (!/^\d+$/.test(base)) throw new Error(`identificador tributario inválido: "${crudo}"`)
  return base
}

export interface PaisInferido {
  pais: Pais
  confianza: number
}

/** Palabras del domicilio que confirman el país inferido del identificador. */
const PISTAS_PAIS: Array<[Pais, RegExp]> = [
  ["CO", /\b(colombia|bogota|medellin|cali|barranquilla|cartagena|bucaramanga)\b/],
  ["EC", /\b(ecuador|quito|guayaquil|cuenca)\b/],
  ["PE", /\b(peru|lima|arequipa|trujillo)\b/],
  ["PA", /\b(panama)\b/],
  ["HN", /\b(honduras|tegucigalpa|san pedro sula)\b/],
]

/**
 * País del cliente a partir del tipo de identificador (NIT solo existe en CO, RTN solo en HN) y,
 * para RUC, de su longitud (EC 13 dígitos, PE 11; PA no tiene longitud fija). El domicilio del
 * contratante sube o baja la confianza; `textoDomicilio` debe ser solo el bloque del CONTRATANTE,
 * no el contrato entero, porque Periferia siempre aparece domiciliada en Medellín.
 */
export function inferirPais(tipo: TipoIdentificador, numero: string, textoDomicilio: string): PaisInferido {
  const porIdentificador = paisPorIdentificador(tipo, numero)
  const normalizado = normalizar(textoDomicilio)
  const porDomicilio = PISTAS_PAIS.find(([, patron]) => patron.test(normalizado))?.[0] ?? null

  if (porIdentificador && porDomicilio) {
    return porIdentificador.pais === porDomicilio
      ? { pais: porIdentificador.pais, confianza: 0.98 }
      : { pais: porIdentificador.pais, confianza: 0.5 }
  }
  if (porIdentificador) return porIdentificador
  if (porDomicilio) return { pais: porDomicilio, confianza: 0.7 }
  throw new Error(`no se pudo inferir el país del identificador ${tipo} ${numero}`)
}

function paisPorIdentificador(tipo: TipoIdentificador, numero: string): PaisInferido | null {
  if (tipo === "NIT") return { pais: "CO", confianza: 0.9 }
  if (tipo === "RTN") return { pais: "HN", confianza: 0.9 }
  if (numero.length === 13) return { pais: "EC", confianza: 0.85 }
  if (numero.length === 11) return { pais: "PE", confianza: 0.85 }
  return null
}
