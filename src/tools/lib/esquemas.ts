import { z } from "zod"
import { esFechaIsoValida } from "./fechas.js"
import { PAISES } from "./identificadores.js"
import { MONEDAS } from "./montos.js"

export const UMBRAL_CONFIANZA = 0.8

export const fechaIsoSchema = z.string().refine(esFechaIsoValida, { message: "fecha inválida, se espera YYYY-MM-DD real" })
export const paisSchema = z.enum(PAISES)
export const monedaSchema = z.enum(MONEDAS)
export const estadoPolizaSchema = z.enum(["vigente", "pendiente", "vencida", "no_aplica"])
export const fuenteSchema = z.enum(["buzon", "manual", "migracion"])

/**
 * Un campo extraído: el valor (o `null` si el texto no lo trae, HU-2) y la confianza en [0, 1].
 * Campo ausente = `{ valor: null, confianza: 0 }`, nunca un valor inventado.
 */
function campo<T extends z.ZodTypeAny>(valor: T, descripcion: string) {
  return z
    .object({
      valor: valor.nullable().describe("Valor extraído, o null si el texto no lo trae"),
      confianza: z.number().min(0).max(1).describe("Confianza de la extracción en [0, 1]; < 0.8 exige revisión humana"),
    })
    .describe(descripcion)
}

/**
 * Esquema de la sección 7.2 con confianza por campo. Es la salida de `contratos_extraer` y la
 * entrada de `contratos_validar` / `contratos_registrar`: el modelo lo devuelve tal cual o con los
 * valores que el humano confirmó, y la herramienta lo vuelve a validar antes de escribir.
 */
export const contratoSchema = z.object({
  tipo_documento: z
    .enum(["contrato", "otrosi"])
    .describe('"otrosi" si el documento modifica un contrato existente; sus campos no mencionados quedan en null'),
  id_contrato: campo(z.string().min(1), "Número del contrato tal como aparece (en un otrosí, el del contrato que modifica)"),
  cliente: campo(z.string().min(1), "Razón social de la contraparte (EL CONTRATANTE), nunca Periferia"),
  nit_cliente: campo(z.string().regex(/^\d+$/), "Identificador tributario del cliente sin puntos ni dígito de verificación"),
  pais: campo(paisSchema, "País del cliente"),
  objeto: campo(z.string().min(1).max(200), "Objeto del contrato, máximo 200 caracteres"),
  valor: campo(z.number().nonnegative(), "Valor total sin separadores; 0 si es por demanda"),
  valor_indeterminado: z.boolean().describe("true si el contrato es por demanda y no tiene valor total"),
  moneda: campo(monedaSchema, "Moneda del valor"),
  fecha_inicio: campo(fechaIsoSchema, "Fecha de inicio YYYY-MM-DD"),
  fecha_fin: campo(fechaIsoSchema, "Fecha de fin YYYY-MM-DD, puede venir de un plazo en meses"),
  requiere_poliza: campo(z.boolean(), "Si el contrato exige constituir póliza"),
  tipo_poliza: campo(z.string(), 'Tipos de póliza separados por ";" (ej. "cumplimiento;calidad"), vacío si no aplica'),
})
export type Contrato = z.infer<typeof contratoSchema>

/** Nombres de los campos con `{ valor, confianza }`, para recorrerlos sin repetir la lista. */
export const CAMPOS_CON_CONFIANZA = [
  "id_contrato",
  "cliente",
  "nit_cliente",
  "pais",
  "objeto",
  "valor",
  "moneda",
  "fecha_inicio",
  "fecha_fin",
  "requiere_poliza",
  "tipo_poliza",
] as const satisfies ReadonlyArray<keyof Contrato>
export type CampoConConfianza = (typeof CAMPOS_CON_CONFIANZA)[number]

/** Una fila del maestro ya tipada (sección 7.2). */
export const filaMaestroSchema = z.object({
  id_contrato: z.string().min(1),
  cliente: z.string().min(1),
  nit_cliente: z.string().regex(/^\d+$/),
  pais: paisSchema,
  objeto: z.string().max(200),
  valor: z.number().nonnegative(),
  moneda: monedaSchema,
  fecha_inicio: fechaIsoSchema,
  fecha_fin: fechaIsoSchema,
  requiere_poliza: z.boolean(),
  tipo_poliza: z.string(),
  estado_poliza: estadoPolizaSchema,
  comercial: z.string(),
  ruta_sharepoint: z.string(),
  fecha_registro: fechaIsoSchema,
  fuente: fuenteSchema,
})
export type FilaMaestro = z.infer<typeof filaMaestroSchema>

/** Orden de columnas del CSV; coincide con el encabezado del fixture. */
export const COLUMNAS_MAESTRO = Object.keys(filaMaestroSchema.shape) as Array<keyof FilaMaestro>

export const correoSchema = z.object({
  id: z.string().min(1),
  de: z.string().min(1),
  para: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  cuerpo: z.string(),
  adjuntos: z.array(z.string()),
})
export type Correo = z.infer<typeof correoSchema>

export const comercialSchema = z.object({
  email: z.string().min(1),
  nombre: z.string().min(1),
  region: z.string(),
})
export type Comercial = z.infer<typeof comercialSchema>

export const clasificacionSchema = z.enum(["nuevo", "actualizacion", "duplicado", "rechazado"])
export type Clasificacion = z.infer<typeof clasificacionSchema>

/** Línea de out/sharepoint/historial.jsonl (HU-4). */
export interface EntradaHistorial {
  ts: string
  id_contrato: string
  accion: "insercion" | "actualizacion"
  cambios: Record<string, { antes: unknown; despues: unknown }>
  mensaje_id: string
}

/** Entrada de out/procesados.json: el mensaje ya no aparece en `leer_buzon` (HU-1). */
export interface MensajeProcesado {
  mensaje_id: string
  clasificacion: Clasificacion
  id_contrato: string | null
  motivo: string | null
  ts: string
}
