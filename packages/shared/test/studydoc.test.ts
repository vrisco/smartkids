/**
 * Pruebas del documento de estudio («Apuntes»): esquema, self-check, versión para el niño y corpus.
 *   pnpm --filter @smartkids/shared run test
 *
 * Las fixtures de test/fixtures/studydocs/ son, además, las plantillas que usa la skill de contenido:
 * si una deja de validar, la skill tendría un mal ejemplo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  StudyDocSchema,
  StudyDocEnvelopeSchema,
  validateStudyDoc,
  lintStudyDoc,
  redactStudyDocForChild,
  studyDocStats,
  studyDocBytes,
  utf8Bytes,
  STUDY_DOC_LIMITS,
  type StudyDoc,
} from "../src/studydoc.ts";
import { STUDY_DOC_KINDS, subjectFamily, REQUEST_OUTPUTS, DEFAULT_REQUEST_OUTPUTS } from "../src/catalog.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures", "studydocs");
const fixtureFiles = readdirSync(fixturesDir).filter((f) => f.endsWith(".json"));
const load = (f: string): StudyDoc => StudyDocSchema.parse(JSON.parse(readFileSync(join(fixturesDir, f), "utf8")));
/** Copia mutable de una fixture para fabricar casos negativos. */
const clone = (f: string): StudyDoc => JSON.parse(JSON.stringify(load(f))) as StudyDoc;

function reason(doc: unknown): string {
  const p = StudyDocSchema.safeParse(doc);
  if (!p.success) return `zod: ${p.error.issues[0]?.message}`;
  const v = validateStudyDoc(p.data);
  return v.ok ? "ok" : v.reason;
}

/* ---------- fixtures ---------- */

describe("fixtures de documentos", () => {
  it("hay una de cada tipo de documento", () => {
    const kinds = new Set(fixtureFiles.map((f) => f.split(".")[0]));
    for (const k of STUDY_DOC_KINDS) assert.ok(kinds.has(k), `falta la fixture de ${k}`);
  });

  for (const f of fixtureFiles) {
    it(`${f} valida y su tipo coincide con el nombre`, () => {
      const doc = load(f);
      assert.equal(doc.kind, f.split(".")[0]);
      assert.equal(reason(doc), "ok");
      assert.ok(Array.isArray(lintStudyDoc(doc)));
      const s = studyDocStats(doc);
      assert.equal(s.blocks, doc.blocks.length);
      assert.ok(s.words > 0);
    });
  }

  it("las estadísticas cuentan tarjetas, preguntas, entradas y eventos", () => {
    assert.equal(studyDocStats(load("flashcards.ingles.json")).cards, 12);
    assert.equal(studyDocStats(load("reading.lengua.json")).questions, 5);
    assert.equal(studyDocStats(load("glossary.naturales.json")).entries, 9);
    assert.equal(studyDocStats(load("timeline.sociales.json")).events, 6);
  });

  it("el envoltorio de import valida", () => {
    const env = StudyDocEnvelopeSchema.safeParse({
      id: "doc_summary_3f9a1c2e",
      ownerId: "par_x",
      subjectId: "math",
      gradeBand: "PRI-6",
      body: load("summary.math.json"),
    });
    assert.ok(env.success);
    assert.equal(StudyDocEnvelopeSchema.safeParse({ id: "x", ownerId: null, subjectId: "Math!", gradeBand: "PRI-6", body: {} }).success, false);
  });
});

/* ---------- self-check: un caso negativo por regla ---------- */

describe("validateStudyDoc", () => {
  it("rechaza emojis", () => {
    const d = clone("summary.math.json");
    d.title = "Múltiplos \u{1F600}";
    assert.match(reason(d), /sin emojis/);
  });

  it("acepta flechas y símbolos que no son emoji", () => {
    const d = clone("summary.math.json");
    d.blocks.push({ type: "paragraph", text: "Ida ↔ vuelta © 2026" });
    assert.equal(reason(d), "ok");
  });

  it("exige `$` y `**` equilibrados, y admite el dólar escapado", () => {
    const d = clone("summary.math.json");
    d.blocks.push({ type: "paragraph", text: "Cuesta 5 \\$ y $2 + 2" });
    assert.match(reason(d), /\$` sin cerrar/);
    const e = clone("summary.math.json");
    e.blocks.push({ type: "paragraph", text: "Cuesta 5 \\$ en total." });
    assert.equal(reason(e), "ok");
    const g = clone("summary.math.json");
    g.blocks.push({ type: "paragraph", text: "Esto es **importante" });
    assert.match(reason(g), /\*\*` sin cerrar/);
  });

  it("tabla: cada fila con tantas celdas como la cabecera", () => {
    const d = clone("summary.math.json");
    d.blocks.push({ type: "table", header: ["a", "b"], rows: [["1", "2"], ["3"]] });
    assert.match(reason(d), /tiene 1 celdas y la cabecera 2/);
  });

  it("esquema: profundidad máxima", () => {
    const d = clone("concept_map.naturales.json");
    d.blocks.push({ type: "tree", layout: "braces", root: { label: "1", children: [{ label: "2", children: [{ label: "3", children: [{ label: "4", children: [{ label: "5" }] }] }] }] } });
    assert.match(reason(d), /niveles/);
  });

  it("preguntas: ids únicos, correct en rango, opciones únicas y huecos = respuestas", () => {
    const dup = clone("reading.lengua.json");
    dup.blocks.push({ type: "questions", items: [{ kind: "true_false", id: "r1", prompt: "Otra", correct: true }] });
    assert.match(reason(dup), /repetido/);
    const rango = clone("reading.lengua.json");
    rango.blocks.push({ type: "questions", items: [{ kind: "choice", id: "x1", prompt: "¿?", options: ["a", "b"], correct: 2 }] });
    assert.match(reason(rango), /fuera de rango/);
    const opts = clone("reading.lengua.json");
    opts.blocks.push({ type: "questions", items: [{ kind: "choice", id: "x2", prompt: "¿?", options: ["a", "a"], correct: 0 }] });
    assert.match(reason(opts), /opciones repetidas/);
    const huecos = clone("reading.lengua.json");
    huecos.blocks.push({ type: "questions", items: [{ kind: "fill", id: "x3", prompt: "{{1}} y {{2}}", answers: ["a"] }] });
    assert.match(reason(huecos), /2 huecos y 1 respuestas/);
    const orden = clone("reading.lengua.json");
    orden.blocks.push({ type: "questions", items: [{ kind: "fill", id: "x4", prompt: "{{2}} y {{1}}", answers: ["a", "b"] }] });
    assert.match(reason(orden), /numerados/);
  });

  it("línea del tiempo: sortKey en todos o en ninguno, y ordenado", () => {
    const parcial = clone("timeline.sociales.json");
    parcial.blocks.push({ type: "timeline", events: [{ when: "1", sortKey: 1, title: "a" }, { when: "2", title: "b" }] });
    assert.match(reason(parcial), /todos deben llevarlo/);
    const desorden = clone("timeline.sociales.json");
    desorden.blocks.push({ type: "timeline", events: [{ when: "2", sortKey: 2, title: "a" }, { when: "1", sortKey: 1, title: "b" }] });
    assert.match(reason(desorden), /desordenado/);
  });

  it("rúbrica con los mismos niveles en todos los criterios", () => {
    const d = clone("writing.lengua.json");
    d.blocks.push({
      type: "rubric",
      criteria: [
        { name: "A", levels: [{ label: "1", descriptor: "x" }, { label: "2", descriptor: "y" }] },
        { name: "B", levels: [{ label: "1", descriptor: "x" }, { label: "2", descriptor: "y" }, { label: "3", descriptor: "z" }] },
      ],
    });
    assert.match(reason(d), /mismos niveles/);
  });

  it("recuadro sin contenido", () => {
    const d = clone("summary.math.json");
    d.blocks.push({ type: "callout", variant: "tip" });
    assert.match(reason(d), /texto o lista/);
  });

  it("mínimos por tipo de documento", () => {
    const pocas = clone("flashcards.ingles.json");
    const b = pocas.blocks[0];
    if (b?.type === "flashcards") b.cards = b.cards.slice(0, 3);
    assert.match(reason(pocas), /al menos 6 tarjetas/);
    const lectura = clone("reading.lengua.json");
    lectura.blocks = lectura.blocks.filter((x) => x.type !== "passage");
    assert.match(reason(lectura), /passage/);
    const resumen = clone("summary.math.json");
    resumen.blocks = resumen.blocks.filter((x) => x.type !== "heading");
    assert.match(reason(resumen), /título/);
  });

  it("SVG peligroso o con colores de emoji fuera", () => {
    const d = clone("concept_map.naturales.json");
    d.blocks.push({ type: "figure", svg: '<svg xmlns="http://www.w3.org/2000/svg"><a href="https://x.y"><circle r="2"/></a></svg>', alt: "círculo" });
    assert.match(reason(d), /no permitidos/);
  });

  it("cuenta del ejemplo resuelto con el mismo chequeo que los ejercicios", () => {
    const d = clone("worked_examples.math.json");
    d.blocks.push({
      type: "worked_example",
      statement: "Resta",
      operation: { type: "column_operation", operation: "add", operands: [1, 2, 3, 4, 5] },
      steps: [{ text: "x" }],
      answer: "y",
    });
    assert.notEqual(reason(d), "ok");
  });

  it("tope de tamaño", () => {
    const d = clone("summary.math.json");
    const largo = "palabra ".repeat(450).trim();
    for (let i = 0; i < 40; i++) d.blocks.push({ type: "paragraph", text: largo });
    assert.ok(studyDocBytes(d) > STUDY_DOC_LIMITS.maxBytes);
    assert.match(reason(d), /bytes/);
  });

  it("utf8Bytes cuenta como TextEncoder", () => {
    for (const s of ["abc", "ñandú", "↔", "\u{1F600}", "日本"]) assert.equal(utf8Bytes(s), new TextEncoder().encode(s).length);
  });
});

/* ---------- versión para el niño ---------- */

describe("redactStudyDocForChild", () => {
  it("el texto del dictado no llega nunca, ni con respuestas", () => {
    const doc = load("dictation.ingles.json");
    for (const answers of [true, false]) {
      const view = redactStudyDocForChild(doc, { answers });
      const json = JSON.stringify(view);
      assert.ok(!json.includes("twenty-four"), "se coló el texto del dictado");
      assert.ok(!json.includes("short groups"), "se coló el consejo de ritmo");
      const b = view.blocks.find((x) => x.type === "dictation");
      assert.equal(b?.type === "dictation" ? b.lines : 0, 10);
    }
  });

  it("sin respuestas quita soluciones y texto modelo; con respuestas los deja", () => {
    const lectura = load("reading.lengua.json");
    const sin = JSON.stringify(redactStudyDocForChild(lectura, { answers: false }));
    assert.ok(!sin.includes("Porque su abuelo"), "respuesta abierta visible");
    assert.ok(!sin.includes('"correct"'), "correct visible");
    assert.ok(!sin.includes('"answers"'), "huecos resueltos visibles");
    const con = JSON.stringify(redactStudyDocForChild(lectura, { answers: true }));
    assert.ok(con.includes("Porque su abuelo"));

    const carta = load("writing.lengua.json");
    assert.ok(!JSON.stringify(redactStudyDocForChild(carta, { answers: false })).includes("Querida Laura"));
    assert.ok(JSON.stringify(redactStudyDocForChild(carta, { answers: true })).includes("Querida Laura"));
  });

  it("deja los ejemplos resueltos y el reverso de las tarjetas (son el contenido)", () => {
    const view = JSON.stringify(redactStudyDocForChild(load("worked_examples.math.json"), { answers: false }));
    assert.ok(view.includes("11,9"));
    assert.ok(JSON.stringify(redactStudyDocForChild(load("flashcards.ingles.json"), { answers: false })).includes("vaca"));
  });

  it("no modifica el documento original", () => {
    const doc = load("reading.lengua.json");
    const antes = JSON.stringify(doc);
    redactStudyDocForChild(doc, { answers: false });
    assert.equal(JSON.stringify(doc), antes);
  });
});

/* ---------- catálogo ---------- */

describe("catálogo", () => {
  it("familia de cada materia (sociales antes que ciencias)", () => {
    assert.equal(subjectFamily("math"), "math");
    assert.equal(subjectFamily("Matemáticas"), "math");
    assert.equal(subjectFamily("lengua"), "language");
    assert.equal(subjectFamily("Lengua castellana y literatura"), "language");
    assert.equal(subjectFamily("ingles"), "foreign");
    assert.equal(subjectFamily("Inglés"), "foreign");
    assert.equal(subjectFamily("naturales"), "science");
    assert.equal(subjectFamily("Ciencias naturales"), "science");
    assert.equal(subjectFamily("Ciencias sociales"), "social");
    assert.equal(subjectFamily("Historia de España"), "social");
    assert.equal(subjectFamily("Música"), "generic");
    assert.equal(subjectFamily(null), "generic");
  });

  it("salidas de una solicitud", () => {
    assert.equal(REQUEST_OUTPUTS[0], "exercises");
    for (const o of DEFAULT_REQUEST_OUTPUTS) assert.ok((REQUEST_OUTPUTS as readonly string[]).includes(o));
  });
});

/* ---------- corpus de cursos fijos (Vía C): content/<curso>/docs/NN-<slug>.<kind>.json ---------- */

describe("corpus de documentos de content/", () => {
  it("los documentos de los cursos fijos validan y su tipo coincide con el nombre", () => {
    const root = join(here, "..", "..", "..", "content");
    if (!existsSync(root)) return;
    const fallos: string[] = [];
    for (const curso of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const dir = join(root, curso.name, "docs");
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
        const m = /^\d{2}-[a-z0-9-]+\.([a-z_]+)\.json$/.exec(f);
        if (!m) {
          fallos.push(`${curso.name}/docs/${f}: el nombre debe ser NN-<slug>.<tipo>.json`);
          continue;
        }
        const file = JSON.parse(readFileSync(join(dir, f), "utf8")) as { doc?: unknown };
        const r = reason(file.doc);
        if (r !== "ok") fallos.push(`${curso.name}/docs/${f}: ${r}`);
        else if ((file.doc as { kind: string }).kind !== m[1]) fallos.push(`${curso.name}/docs/${f}: el tipo del nombre no coincide con doc.kind`);
      }
    }
    assert.deepEqual(fallos, []);
  });
});
