// Puntuación de un examen en papel y tiempo sugerido. Puro (sin React).
import type { Exercise as FullExercise } from "@smartkids/shared";
import type { AgeBand } from "./profiles.ts";

/** ¿Tiene varias partes que corregir? (varios huecos, pasos, parejas o ítems a ordenar). */
function multiPart(ex: FullExercise): boolean {
  switch (ex.type) {
    case "fill_in_blank":
      return ex.blanks.length > 1;
    case "step_problem":
      return ex.steps.length > 1;
    case "matching":
      return ex.correctPairs.length > 2;
    case "ordering":
      return ex.items.length > 3;
    case "multiple_select":
      return true;
    default:
      return false;
  }
}

const WEIGHT = { easy: 1, medium: 1.5, hard: 2 } as const;
const round4 = (x: number) => Math.round(x * 4) / 4;

/**
 * Puntos de cada pregunta, en múltiplos de 0,25, que suman EXACTAMENTE 10: peso por dificultad (+0,5 si
 * tiene varias partes), normalizado y redondeado; el descuadre del redondeo va a la pregunta más pesada.
 */
export function examPoints(exs: readonly FullExercise[]): number[] {
  if (exs.length === 0) return [];
  const w = exs.map((ex) => WEIGHT[ex.difficulty.level] + (multiPart(ex) ? 0.5 : 0));
  const total = w.reduce((s, x) => s + x, 0);
  const pts = w.map((x) => Math.max(0.25, round4((x / total) * 10)));
  const diff = round4(10 - pts.reduce((s, x) => s + x, 0));
  if (diff !== 0) {
    // Ajusta en la más pesada sin dejarla por debajo de 0,25 (si hace falta, reparte en varias).
    let rest = diff;
    const order = pts.map((_, i) => i).sort((a, b) => pts[b]! - pts[a]!);
    for (const i of order) {
      if (rest === 0) break;
      const next = Math.max(0.25, round4(pts[i]! + rest));
      rest = round4(rest - (next - pts[i]!));
      pts[i] = next;
    }
  }
  return pts;
}

/** Segundos aproximados que necesita un niño de 5.º-6.º para cada tipo de pregunta. */
function seconds(ex: FullExercise): number {
  switch (ex.type) {
    case "multiple_choice":
      return 45;
    case "multiple_select":
      return 60;
    case "true_false":
      return 25;
    case "numeric":
      return 90;
    case "fill_in_blank":
      return Math.max(30, 30 * ex.blanks.length);
    case "ordering":
      return 20 + 10 * ex.items.length;
    case "matching":
      return 20 + 15 * ex.correctPairs.length;
    case "step_problem":
      return 60 * ex.steps.length;
    case "column_operation":
      return 60 + 15 * ex.operands.reduce((s, n) => s + String(n).replace(/\D/g, "").length, 0);
    case "prime_factorization":
      return 150;
  }
}

const AGE_FACTOR: Record<AgeBand, number> = { early: 1.6, mid: 1.3, upper: 1, secondary: 0.9 };

/** Tiempo sugerido en minutos (múltiplo de 5, mínimo 10). */
export function suggestedMinutes(exs: readonly FullExercise[], age: AgeBand): number {
  const s = exs.reduce((sum, ex) => sum + seconds(ex), 0) * AGE_FACTOR[age];
  return Math.max(10, Math.ceil(s / 60 / 5) * 5);
}

/** «1,25» o «1.25» según el idioma. */
export function formatPoints(p: number, lang: string): string {
  return lang.startsWith("en") ? String(p) : String(p).replace(".", ",");
}
