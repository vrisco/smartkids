/**
 * Pipeline de generación de contenido (OFFLINE / batch) — ESQUELETO.
 *
 * Flujo: generar (Claude) -> validar (Zod + SymPy) -> empaquetar (semver) -> publicar (D1).
 * M1 sólo deja el andamiaje; la generación real con la Claude API llega más adelante.
 */
import { ExerciseSchema } from "@smartkids/shared";

function main(): void {
  console.log("smartkids · content-gen (esqueleto).");
  console.log("Tipos de ejercicio soportados por el esquema:", ExerciseSchema.options.length);
  console.log("Pendiente: generación con Claude API + validación SymPy + empaquetado.");
}

main();
