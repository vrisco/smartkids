/**
 * Pruebas de la lógica PURA de la impresión (sin React ni navegador):
 *   pnpm --filter @smartkids/web run test
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Exercise } from "@smartkids/shared";

import { ageBand, answerStyle, blankWidthMm, profileFor, workFor } from "../src/components/print/profiles.ts";
import { examPoints, suggestedMinutes } from "../src/components/print/scoring.ts";
import { addHistory, clearHistory, makeVersionB, mulberry32, readHistory, selectQuestions, toPaper, type Pickable } from "../src/components/print/select.ts";
import { cssString, pageCss, safeFileName } from "../src/components/print/page.ts";
import { answerText, exercisesToCards, exercisesToRememberDoc, exercisesToWorkedDoc, type AnswerLabels } from "../src/components/print/fromExercises.ts";

/* ---------- Fábricas de ejercicios ---------- */
let n = 0;
const base = (level: "easy" | "medium" | "hard" = "medium") => ({
  exerciseId: `e${++n}`,
  packageId: "p",
  skillId: "s",
  schemaVersion: "1.0.0",
  language: "es",
  difficulty: { level, numeric: level === "easy" ? 0.2 : level === "medium" ? 0.5 : 0.8 },
});
const numeric = (level?: "easy" | "medium" | "hard", theory = "Suma las unidades."): Exercise =>
  ({ ...base(level), type: "numeric", stem: "Calcula 12 + 30", answer: { value: 42, tolerance: 0 }, feedback: { correct: "", incorrect: "", solution: "12 + 30 = 42", theory } }) as Exercise;
const mc = (level?: "easy" | "medium" | "hard"): Exercise =>
  ({
    ...base(level),
    type: "multiple_choice",
    stem: "¿Cuánto es 2 + 2?",
    options: [
      { id: "a", text: "4", isCorrect: true },
      { id: "b", text: "5", isCorrect: false },
      { id: "c", text: "3", isCorrect: false },
    ],
  }) as Exercise;
const steps = (k: number): Exercise =>
  ({ ...base("hard"), type: "step_problem", stem: "Problema", steps: Array.from({ length: k }, (_, i) => ({ id: `s${i}`, prompt: "?", kind: "numeric", answer: { value: i, tolerance: 0 } })) }) as Exercise;
const matching = (): Exercise =>
  ({
    ...base(),
    type: "matching",
    stem: "Une",
    left: [
      { id: "l1", text: "cow" },
      { id: "l2", text: "dog" },
    ],
    right: [
      { id: "r1", text: "vaca" },
      { id: "r2", text: "perro" },
    ],
    correctPairs: [
      { leftId: "l1", rightId: "r1" },
      { leftId: "l2", rightId: "r2" },
    ],
  }) as Exercise;
const column = (): Exercise => ({ ...base(), type: "column_operation", stem: "Calcula: 386 × 412", operation: "multiply", operands: [386, 412] }) as Exercise;

const pick = (ex: Exercise, i: number, module?: number): Pickable => ({ templateId: `t${i}`, exercise: ex, ...(module !== undefined ? { module: { skillId: `m${module}`, title: `M${module}`, index: module } } : {}) });

/* ---------- Perfiles ---------- */

describe("perfiles por materia y edad", () => {
  it("familia de la materia (sociales antes que ciencias)", () => {
    assert.equal(profileFor("math", "PRI-5").family, "math");
    assert.equal(profileFor("Ciencias sociales", "PRI-5").family, "social");
    assert.equal(profileFor("Ciencias naturales", "PRI-5").family, "science");
    assert.equal(profileFor("ingles", "ESO-1").family, "foreign");
    assert.equal(profileFor("lengua", "PRI-2").family, "language");
    assert.equal(profileFor("Música", "PRI-2").family, "generic");
  });

  it("tramos de edad y pauta", () => {
    assert.equal(ageBand("PRI-1"), "early");
    assert.equal(ageBand("PRI-4"), "mid");
    assert.equal(ageBand("PRI-6"), "upper");
    assert.equal(ageBand("ESO-3"), "secondary");
    assert.equal(ageBand("ESO-5"), "upper"); // valor antiguo = sin definir
    assert.equal(profileFor("lengua", "PRI-1").line, "montessori");
    assert.equal(profileFor("lengua", "PRI-3").line, "double");
    assert.ok(profileFor("math", "PRI-1").fontPt > profileFor("math", "ESO-2").fontPt);
  });

  it("notación: matemáticas sí, lengua e idiomas no", () => {
    assert.equal(profileFor("math", "PRI-5").mathNotation, true);
    assert.equal(profileFor("lengua", "PRI-5").mathNotation, false);
    assert.equal(profileFor("ingles", "PRI-5").mathNotation, false);
  });

  it("espacio de trabajo: cuadrícula en mates (más alta si es difícil), nada en lengua", () => {
    const m = profileFor("math", "PRI-5");
    const easy = workFor(numeric("easy"), m, { workSpace: true, compact: false });
    const hard = workFor(numeric("hard"), m, { workSpace: true, compact: false });
    assert.equal(easy?.kind, "grid");
    assert.ok(hard && easy && hard.kind === "grid" && easy.kind === "grid" && hard.heightMm > easy.heightMm);
    assert.equal(workFor(steps(2), m, { workSpace: true, compact: false })?.kind, "problem");
    assert.equal(workFor(numeric("hard"), profileFor("lengua", "PRI-5"), { workSpace: true, compact: false }), null);
    assert.equal(workFor(numeric("hard"), m, { workSpace: false, compact: false }), null);
    const compact = workFor(numeric("hard"), m, { workSpace: true, compact: true });
    assert.ok(compact?.kind === "grid" && hard?.kind === "grid" && compact.heightMm < hard.heightMm);
  });

  it("respuesta: recuadro en mates, línea en lengua", () => {
    assert.equal(answerStyle(numeric(), profileFor("math", "PRI-5")).kind, "box");
    assert.equal(answerStyle(numeric(), profileFor("lengua", "PRI-5")).kind, "line");
  });

  it("los huecos no chivan la longitud exacta", () => {
    assert.equal(blankWidthMm(["sí"]), 22);
    assert.equal(blankWidthMm(["bombilla"]), 35);
    assert.equal(blankWidthMm(["una respuesta bastante larga"]), 55);
  });
});

/* ---------- Puntuación ---------- */

describe("examen sobre 10", () => {
  const sum = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) * 100) / 100;
  it("una sola pregunta vale 10", () => assert.deepEqual(examPoints([numeric()]), [10]));
  it("los puntos suman exactamente 10 y van de 0,25 en 0,25", () => {
    const rng = mulberry32(7);
    for (let trial = 0; trial < 50; trial++) {
      const exs = Array.from({ length: 1 + Math.floor(rng() * 30) }, () => {
        const r = rng();
        return r < 0.3 ? numeric("easy") : r < 0.6 ? mc("medium") : r < 0.8 ? steps(3) : matching();
      });
      const pts = examPoints(exs);
      assert.equal(sum(pts), 10, `ensayo ${trial}: ${pts.join(", ")}`);
      for (const p of pts) {
        assert.ok(p >= 0.25);
        assert.equal(Math.round(p * 4), p * 4);
      }
    }
  });
  it("las difíciles valen más que las fáciles", () => {
    const [easy, hard] = examPoints([numeric("easy"), numeric("hard")]);
    assert.ok(hard! > easy!);
  });
  it("tiempo sugerido: múltiplo de 5, mínimo 10, más para los pequeños", () => {
    const exs = [numeric(), mc(), steps(3), column()];
    const upper = suggestedMinutes(exs, "upper");
    assert.equal(upper % 5, 0);
    assert.ok(upper >= 10);
    assert.ok(suggestedMinutes(exs, "early") >= upper);
  });
});

/* ---------- Selección ---------- */

describe("selección de preguntas", () => {
  const pool = [
    ...Array.from({ length: 12 }, (_, i) => pick(numeric(["easy", "medium", "hard"][i % 3] as "easy"), i, i % 2)),
    ...Array.from({ length: 12 }, (_, i) => pick(mc(["easy", "medium", "hard"][i % 3] as "easy"), 100 + i, i % 2)),
  ];
  const opts = (seed: number) => ({ n: 10, types: ["numeric", "multiple_choice"], levels: ["easy", "medium", "hard"] as ("easy" | "medium" | "hard")[], rng: mulberry32(seed), order: "difficulty" as const });

  it("elige n distintas, de los tipos y niveles marcados", () => {
    const out = selectQuestions(pool, opts(1));
    assert.equal(out.length, 10);
    assert.equal(new Set(out.map((x) => x.templateId)).size, 10);
    assert.ok(out.some((x) => x.exercise.type === "numeric") && out.some((x) => x.exercise.type === "multiple_choice"));
    const onlyEasy = selectQuestions(pool, { ...opts(2), levels: ["easy"] });
    assert.ok(onlyEasy.every((x) => x.exercise.difficulty.level === "easy"));
  });

  it("misma semilla, misma ficha", () => {
    assert.deepEqual(
      selectQuestions(pool, opts(42)).map((x) => x.templateId),
      selectQuestions(pool, opts(42)).map((x) => x.templateId),
    );
  });

  it("prefiere las no impresas y respeta las excluidas", () => {
    const avoid = new Set(pool.slice(0, 14).map((x) => x.templateId));
    const out = selectQuestions(pool, { ...opts(3), avoid });
    assert.ok(out.every((x) => !avoid.has(x.templateId)));
    const exclude = new Set(pool.slice(0, 20).map((x) => x.templateId));
    const rest = selectQuestions(pool, { ...opts(4), exclude });
    assert.ok(rest.every((x) => !exclude.has(x.templateId)));
    assert.equal(rest.length, 4);
  });

  it("versión B: distinta de la A y con el mismo tipo y nivel (y módulo si queda)", () => {
    const a = selectQuestions(pool, opts(5));
    const { items: b, reused } = makeVersionB(a, pool, mulberry32(6));
    assert.equal(reused, 0);
    const aIds = new Set(a.map((x) => x.templateId));
    assert.equal(new Set(b.map((x) => x.templateId)).size, b.length);
    b.forEach((x, i) => {
      assert.ok(!aIds.has(x.templateId));
      assert.equal(x.exercise.type, a[i]!.exercise.type);
    });
    // Con banco de sobra, también el mismo nivel y el mismo módulo.
    const big = [...pool, ...pool.map((x) => ({ ...x, templateId: x.templateId + "b" })), ...pool.map((x) => ({ ...x, templateId: x.templateId + "c" }))];
    const a2 = selectQuestions(big, { ...opts(8), n: 6 });
    makeVersionB(a2, big, mulberry32(9)).items.forEach((x, i) => {
      assert.equal(x.exercise.difficulty.level, a2[i]!.exercise.difficulty.level);
      assert.equal(x.module?.index, a2[i]!.module?.index);
    });
    // Sin preguntas de sobra, repite (y lo cuenta).
    assert.ok(makeVersionB(a, a, mulberry32(7)).reused === a.length);
  });

  it("presentación barajada: el orden a ordenar nunca sale ya resuelto", () => {
    const ord = { ...base(), type: "ordering", stem: "Ordena", items: [{ id: "1", text: "a" }, { id: "2", text: "b" }], correctOrder: ["1", "2"] } as Exercise;
    for (let s = 0; s < 20; s++) {
      const q = toPaper(pick(ord, 1), mulberry32(s));
      assert.notDeepEqual(q.shown.map((x) => x.id), ["1", "2"]);
    }
  });
});

/* ---------- Historial ---------- */

describe("historial de lo impreso", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });
  it("guarda, lee y olvida", () => {
    addHistory("skill:x", ["a", "b"]);
    addHistory("skill:x", ["c"]);
    assert.deepEqual([...readHistory("skill:x")].sort(), ["a", "b", "c"]);
    clearHistory("skill:x");
    assert.equal(readHistory("skill:x").size, 0);
  });
  it("tiene tope de ids", () => {
    for (let j = 0; j < 30; j++) addHistory("skill:y", Array.from({ length: 50 }, (_, i) => `${j}-${i}`));
    assert.ok(readHistory("skill:y").size <= 400);
  });
  it("sin localStorage no rompe", () => {
    (globalThis as { localStorage?: unknown }).localStorage = undefined;
    assert.equal(readHistory("z").size, 0);
    addHistory("z", ["a"]);
  });
});

/* ---------- @page y nombre del PDF ---------- */

describe("página", () => {
  it("el título no puede inyectar CSS", () => {
    const s = cssString('Hola"} body { display:none } /*');
    assert.ok(!s.slice(1, -1).includes('"'));
    assert.ok(!s.includes("}"));
    assert.ok(pageCss({ fileName: "x", headerText: 'a"}' }).startsWith("@page {"));
  });
  it("tamaño y orientación", () => {
    assert.match(pageCss({ fileName: "x", paper: "letter", landscape: true }), /size: letter landscape/);
    assert.match(pageCss({ fileName: "x" }), /size: A4;/);
    assert.ok(!pageCss({ fileName: "x", pageNumbers: false }).includes("counter(page)"));
  });
  it("nombre de fichero seguro", () => {
    assert.equal(safeFileName('Mates: 1/2 "test"'), "Mates 1 2 test");
    assert.equal(safeFileName("   "), "smartkids");
  });
});

/* ---------- Material a partir de los ejercicios ---------- */

describe("material desde los ejercicios", () => {
  const L: AnswerLabels = { yes: "Verdadero", no: "Falso", opText: () => "159032" };
  it("tarjetas: una por pareja al unir, y la respuesta detrás", () => {
    const cards = exercisesToCards([matching(), numeric(), column()], L);
    assert.equal(cards.length, 4);
    assert.deepEqual(cards[0], { front: "cow", back: "vaca" });
    assert.equal(cards[2]!.back, "42");
    assert.equal(cards[3]!.back, "159032");
  });
  it("la respuesta numérica lleva la coma del idioma", () => {
    const ex = { ...numeric(), answer: { value: 0.75, unit: "m" } } as Exercise;
    assert.equal(answerText(ex, L), "0,75 m");
    assert.equal(answerText(ex, { ...L, decimal: "." }), "0.75 m");
  });
  it("hoja «Recuerda»: teorías sin repetir, por módulo", () => {
    const doc = exercisesToRememberDoc(
      [
        { title: "M1", exercises: [numeric(undefined, "Regla A."), numeric(undefined, "regla a.  "), numeric(undefined, "Regla B.")] },
        { title: "M2", exercises: [numeric(undefined, "Regla C.")] },
      ],
      "Recuerda",
    );
    const callouts = doc.blocks.filter((b) => b.type === "callout");
    assert.equal(callouts.length, 2);
    assert.equal(callouts[0]!.type === "callout" ? callouts[0]!.items?.length : 0, 2);
  });
  it("ejemplos resueltos: con la cuenta para pintarla resuelta", () => {
    const doc = exercisesToWorkedDoc([{ title: null, exercises: [column(), numeric()] }], "Ejemplos", L);
    const w = doc.blocks.filter((b) => b.type === "worked_example");
    assert.equal(w.length, 2);
    assert.ok(w[0]!.type === "worked_example" && w[0]!.operation?.type === "column_operation");
  });
});
