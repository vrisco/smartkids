/**
 * Pruebas de la corrección (lógica PURA, sin base de datos).
 *
 * Se ejecutan con el runner de Node, sin dependencias nuevas:
 *   pnpm --filter @smartkids/shared run test
 *
 * El caso que motivó este fichero: normalizeText borraba el punto y la coma en
 * CUALQUIER posición, así que "1.5" y "15" se normalizaban a la misma cadena y la
 * plataforma daba por bueno "15" cuando la respuesta era "1,5".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeText, grade, redactForClient, validateExercise } from "../src/grading.ts";
import { ExerciseSchema, FillInBlankSchema } from "../src/exercise.ts";

/* ---------- normalizeText ---------- */

describe("normalizeText", () => {
  it("conserva el separador decimal (el fallo que motivó estas pruebas)", () => {
    assert.equal(normalizeText("1.5"), "1.5");
    assert.equal(normalizeText("1,5"), "1,5");
    assert.notEqual(normalizeText("1.5"), normalizeText("15"));
    assert.notEqual(normalizeText("0,25"), normalizeText("025"));
  });

  it("quita la puntuación de frase solo al final", () => {
    assert.equal(normalizeText("multiplicación."), "multiplicacion");
    assert.equal(normalizeText("es 7,"), "es 7");
    assert.equal(normalizeText("¿cuál? ¡sí!"), "cual si");
  });

  it("normaliza mayúsculas, tildes y espacios", () => {
    assert.equal(normalizeText("  Múltiplo   COMÚN "), "multiplo comun");
    assert.equal(normalizeText("3 / 4"), "3 / 4");
  });

  it("respeta las opciones explícitas", () => {
    assert.equal(normalizeText("Área", { caseSensitive: true, accentSensitive: true }), "Área");
    assert.equal(normalizeText("fin.", { trimPunctuation: false }), "fin.");
  });
});

/* ---------- fill_in_blank ---------- */

function blanks(accept: string[]) {
  return FillInBlankSchema.parse({
    exerciseId: "ex_test",
    packageId: "pkg_test",
    skillId: "SK.TEST",
    language: "es",
    stem: "El resultado es {{1}}",
    difficulty: { level: "easy", numeric: 0.3 },
    type: "fill_in_blank",
    blanks: [{ accept }],
  });
}
const answer = (v: string) => ({ type: "fill_in_blank", values: [v] }) as const;

describe("fill_in_blank", () => {
  it("NO acepta 15 cuando la respuesta es 1.5", () => {
    const ex = blanks(["1.5"]);
    assert.equal(grade(ex, answer("15")).correct, false);
    assert.equal(grade(ex, answer("1.5")).correct, true);
  });

  it("acepta la coma decimal como equivalente al punto", () => {
    assert.equal(grade(blanks(["1.5"]), answer("1,5")).correct, true);
    assert.equal(grade(blanks(["1,5"]), answer("1.5")).correct, true);
  });

  it("acepta el separador de millares español", () => {
    const ex = blanks(["1500"]);
    assert.equal(grade(ex, answer("1.500")).correct, true);
    assert.equal(grade(ex, answer("1500")).correct, true);
  });

  it("una respuesta en blanco o solo puntuación nunca es correcta", () => {
    const ex = blanks(["."]);
    assert.equal(grade(ex, answer("")).correct, false);
    assert.equal(grade(ex, answer("  ")).correct, false);
  });

  it("sigue aceptando texto con tilde y variantes", () => {
    const ex = blanks(["multiplicación", "multiplicar", "producto"]);
    assert.equal(grade(ex, answer("Multiplicacion")).correct, true);
    assert.equal(grade(ex, answer("producto.")).correct, true);
    assert.equal(grade(ex, answer("suma")).correct, false);
  });

  it("sigue aceptando las variantes de notación del contenido publicado", () => {
    const ex = blanks(["3x^2", "3x2"]);
    assert.equal(grade(ex, answer("3x^2")).correct, true);
    assert.equal(grade(ex, answer("3x2")).correct, true);
    const frac = blanks(["3/4", "3 / 4"]);
    assert.equal(grade(frac, answer("3/4")).correct, true);
  });
});

/* ---------- multiple_select ("marca todas las correctas") ---------- */

function multi(correct: string[], ids = ["a", "b", "c", "d"]) {
  return ExerciseSchema.parse({
    exerciseId: "ex_ms",
    packageId: "pkg_test",
    skillId: "SK.TEST",
    language: "es",
    stem: "Marca los números pares",
    difficulty: { level: "easy", numeric: 0.3 },
    type: "multiple_select",
    options: ids.map((id) => ({ id, text: id.toUpperCase(), isCorrect: correct.includes(id) })),
  });
}
const sel = (optionIds: string[]) => ({ type: "multiple_select" as const, optionIds });

describe("multiple_select", () => {
  it("acierta solo con el conjunto exacto, sin importar el orden", () => {
    const ex = multi(["a", "c"]);
    assert.equal(grade(ex, sel(["c", "a"])).correct, true);
    assert.equal(grade(ex, sel(["a"])).correct, false); // se queda corto
    assert.equal(grade(ex, sel(["a", "b", "c"])).correct, false); // marca de más
    assert.equal(grade(ex, sel(["a", "b", "c", "d"])).correct, false); // marcar todo no es un atajo
    assert.equal(grade(ex, sel([])).correct, false);
  });

  it("el self-check exige al menos una correcta y al menos un distractor", () => {
    assert.equal(validateExercise(multi(["a", "b"])).ok, true);
    assert.equal(validateExercise(multi([])).ok, false);
    assert.equal(validateExercise(multi(["a", "b", "c", "d"])).ok, false);
    assert.equal(validateExercise(multi(["a"], ["a", "a", "b"])).ok, false);
  });

  it("la redacción para el cliente no filtra cuáles son correctas", () => {
    const render = redactForClient(multi(["a", "c"]));
    assert.equal(render.type, "multiple_select");
    assert.equal(JSON.stringify(render).includes("isCorrect"), false);
  });
});

/* ---------- corpus de regresión: el contenido publicado debe seguir siendo válido ---------- */

describe("corpus publicado", () => {
  it("los ejercicios de content/ pasan validateExercise", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "content");
    if (!existsSync(root)) return; // el paquete se puede usar fuera del monorepo

    let total = 0;
    const fallos: string[] = [];
    for (const curso of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const dir = join(root, curso.name);
      for (const f of readdirSync(dir).filter((n) => n.endsWith(".json") && n !== "course.json")) {
        const mod = JSON.parse(readFileSync(join(dir, f), "utf8")) as { skill?: { id?: string }; exercises?: unknown[] };
        for (const [i, raw] of (mod.exercises ?? []).entries()) {
          total++;
          // El builder inyecta los campos de contexto; aquí los rellenamos igual para poder validar.
          const parsed = ExerciseSchema.safeParse({
            exerciseId: `${f}_${i}`,
            packageId: "pkg_test",
            skillId: mod.skill?.id ?? "SK.TEST",
            language: "es",
            ...(raw as object),
          });
          if (!parsed.success) {
            fallos.push(`${curso.name}/${f} #${i}: no cumple el esquema — ${parsed.error.issues[0]?.message}`);
            continue;
          }
          const v = validateExercise(parsed.data);
          if (!v.ok) fallos.push(`${curso.name}/${f} #${i}: ${v.reason}`);
        }
      }
    }
    assert.ok(total > 0, "no se encontró ningún ejercicio en content/");
    assert.deepEqual(fallos, [], `ejercicios inválidos:\n${fallos.join("\n")}`);
  });
});
