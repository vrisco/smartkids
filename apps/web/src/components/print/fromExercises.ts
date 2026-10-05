// Material de estudio que sale de los EJERCICIOS ya publicados, sin generar nada nuevo: tarjetas de memoria
// (enunciado / respuesta), ejemplos resueltos (enunciado + cómo se hace + respuesta) y la hoja «Recuerda»
// con las teorías distintas del banco. Puro (sin React): lo que depende del idioma llega en `labels`.
import type { Exercise as FullExercise, ViewableStudyDoc, ViewableStudyBlock } from "@smartkids/shared";

export interface AnswerLabels {
  yes: string;
  no: string;
  /** Solución en texto de una cuenta en columna o una factorización (ColumnOps). */
  opText: (ex: Extract<FullExercise, { type: "column_operation" | "prime_factorization" }>) => string;
  /** Separador decimal del idioma ("," en castellano). */
  decimal?: string;
}

const num = (v: number, L: AnswerLabels) => String(v).replace(".", L.decimal ?? ",");

export interface Card {
  front: string;
  back: string;
}

/** Enunciado sin los marcadores de hueco (`{{1}}` -> `____`). */
export const plainStem = (stem: string) => stem.replace(/\{\{\d+\}\}/g, "____");

/** La respuesta correcta en una línea de texto (notación de MathText). */
export function answerText(ex: FullExercise, L: AnswerLabels): string {
  switch (ex.type) {
    case "multiple_choice":
    case "multiple_select":
      return ex.options
        .filter((o) => o.isCorrect)
        .map((o) => o.text)
        .join(" · ");
    case "true_false":
      return ex.answer.value ? L.yes : L.no;
    case "numeric":
      return `${num(ex.answer.value, L)}${ex.answer.unit ? " " + ex.answer.unit : ""}`;
    case "fill_in_blank":
      return ex.blanks.map((b) => b.accept[0] ?? "").join(" · ");
    case "ordering":
      return ex.correctOrder.map((id) => ex.items.find((it) => it.id === id)?.text ?? id).join(" → ");
    case "matching":
      return ex.correctPairs
        .map((p) => `${ex.left.find((l) => l.id === p.leftId)?.text ?? p.leftId} – ${ex.right.find((r) => r.id === p.rightId)?.text ?? p.rightId}`)
        .join(" · ");
    case "step_problem":
      return ex.steps
        .map((s, i) => `${String.fromCharCode(97 + i)}) ${s.kind === "numeric" ? `${num(s.answer.value, L)}${s.answer.unit ? " " + s.answer.unit : ""}` : (s.accept[0] ?? "")}`)
        .join(" · ");
    case "column_operation":
    case "prime_factorization":
      return L.opText(ex);
  }
}

/** Tarjetas de memoria: enunciado delante, respuesta detrás. Unir parejas da una tarjeta por pareja. */
export function exercisesToCards(exs: readonly FullExercise[], L: AnswerLabels): Card[] {
  const out: Card[] = [];
  for (const ex of exs) {
    if (ex.type === "matching") {
      for (const p of ex.correctPairs) {
        const front = ex.left.find((l) => l.id === p.leftId)?.text;
        const back = ex.right.find((r) => r.id === p.rightId)?.text;
        if (front && back) out.push({ front, back });
      }
      continue;
    }
    // Un problema por pasos lleva sus preguntas en el anverso (si no, la respuesta no se entiende).
    const front =
      ex.type === "step_problem"
        ? [plainStem(ex.stem), ...ex.steps.map((s, i) => `${String.fromCharCode(97 + i)}) ${s.prompt}`)].join("\n")
        : plainStem(ex.stem);
    out.push({ front, back: answerText(ex, L) });
  }
  return out;
}

export interface ExerciseGroup {
  title: string | null;
  exercises: readonly FullExercise[];
}

/** Clave para no repetir la misma teoría con otras mayúsculas o espacios. */
const theoryKey = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 60);

/** Hoja «Recuerda»: las teorías DISTINTAS del banco (lo que se enseña al fallar), agrupadas por módulo. */
export function exercisesToRememberDoc(groups: readonly ExerciseGroup[], title: string, language = "es"): ViewableStudyDoc {
  const seen = new Set<string>();
  const blocks: ViewableStudyBlock[] = [];
  for (const g of groups) {
    const items: string[] = [];
    for (const ex of g.exercises) {
      const th = ex.feedback?.theory?.trim();
      if (!th || seen.has(theoryKey(th))) continue;
      seen.add(theoryKey(th));
      items.push(th);
    }
    if (items.length === 0) continue;
    if (g.title) blocks.push({ type: "heading", level: 2, text: g.title });
    blocks.push({ type: "callout", variant: "remember", items });
  }
  return { schemaVersion: 1, kind: "cheatsheet", title, language, print: { columns: 2 }, blocks };
}

/** Ejemplos resueltos: cada ejercicio con cómo se resuelve (la solución del banco) y su respuesta. */
export function exercisesToWorkedDoc(groups: readonly ExerciseGroup[], title: string, L: AnswerLabels, language = "es"): ViewableStudyDoc {
  const blocks: ViewableStudyBlock[] = [];
  for (const g of groups) {
    if (g.exercises.length === 0) continue;
    if (g.title) blocks.push({ type: "heading", level: 2, text: g.title });
    for (const ex of g.exercises) {
      const answer = answerText(ex, L);
      const steps = [ex.feedback?.solution, ex.feedback?.theory].filter((s): s is string => Boolean(s?.trim())).map((text) => ({ text }));
      blocks.push({
        type: "worked_example",
        statement: plainStem(ex.stem),
        ...(ex.figure ? { figure: ex.figure } : {}),
        ...(ex.type === "column_operation"
          ? { operation: { type: "column_operation" as const, operation: ex.operation, operands: ex.operands, ...(ex.decimals !== undefined ? { decimals: ex.decimals } : {}) } }
          : ex.type === "prime_factorization"
            ? { operation: { type: "prime_factorization" as const, number: ex.number } }
            : {}),
        steps: steps.length > 0 ? steps : [{ text: answer }],
        answer,
      });
    }
  }
  return { schemaVersion: 1, kind: "worked_examples", title, language, blocks };
}
