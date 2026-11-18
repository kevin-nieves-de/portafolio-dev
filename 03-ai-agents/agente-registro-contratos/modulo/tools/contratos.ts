/**
 * Herramientas del módulo reutilizable (PRD §9.4). No es una copia: reexporta exactamente las
 * herramientas de la aplicación (src/tools/contratos.ts), importables sin el servidor HTTP.
 * Cada export es una herramienta `{ description, args, execute }`; el nombre que ve el modelo
 * es `contratos_<export>`.
 */
export * from "../../src/tools/contratos.js"
