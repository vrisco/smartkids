// Selección de preguntas para el papel. Puro (sin React): azar con SEMILLA (la versión B y la clave salen
// de la misma tirada), reparto por dificultad y por tipo, versión B con preguntas distintas y el historial
// de lo ya impreso para no repetir.
import type { Exercise as FullExercise } from "@smartkids/shared";

export type Level = "easy" | "medium" | "hard";
export const LEVELS: Level[] = ["easy", "medium", "hard"];
/** Reparto objetivo de dificultad (30 % fácil, 50 % media, 20 % difícil) entre los niveles marcados. */
const MIX: Record<Level, number> = { easy: 0.3, medium: 0.5, hard: 0.2 };

/** Generador pseudoaleatorio con semilla (mulberry32): misma semilla, misma ficha. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Código corto de una hoja (en la cabecera y en su clave, para no mezclar soluciones de versiones). */
export function sheetCode(rng: () => number): string {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 4 }, () => abc[Math.floor(rng() * abc.length)]).join("");
}

/** Lo mínimo que hace falta para elegir: el ejercicio y, si viene de un path/curso, su módulo. */
export interface Pickable {
  templateId: string;
  exercise: FullExercise;
  module?: { skillId: string; title: string; index: number };
  failCount?: number;
}

export interface SelectOptions {
  n: number;
  types: string[];
  levels: Level[];
  rng: () => number;
  /** Ya impresas hace poco: se usan solo si no hay suficientes nuevas. */
  avoid?: Set<string>;
  /** Fuera del todo (p. ej. las de otra ficha del mismo cuadernillo). */
  exclude?: Set<string>;
  order: "difficulty" | "fails" | "module";
}

/** Por turnos entre tipos (para que salgan todos los marcados), del montón ya barajado. */
function roundRobin<T extends Pickable>(items: T[], n: number): T[] {
  const byType = new Map<string, T[]>();
  for (const it of items) byType.set(it.exercise.type, [...(byType.get(it.exercise.type) ?? []), it]);
  const queues = [...byType.values()];
  const out: T[] = [];
  while (out.length < n && queues.some((q) => q.length > 0)) {
    for (const q of queues) {
      const it = q.shift();
      if (it && out.length < n) out.push(it);
    }
  }
  return out;
}

/**
 * Elige `n` preguntas: primero las no impresas recientemente, repartiendo la dificultad según MIX entre los
 * niveles marcados (lo que falte en un nivel lo completan los otros) y, dentro de cada nivel, por turnos
 * entre tipos. Después ordena (de fácil a difícil, por fallos o por módulo).
 */
export function selectQuestions<T extends Pickable>(pool: readonly T[], o: SelectOptions): T[] {
  const ok = pool.filter((it) => o.types.includes(it.exercise.type) && o.levels.includes(it.exercise.difficulty.level) && !o.exclude?.has(it.templateId));
  const avoid = o.avoid ?? new Set<string>();
  const fresh = shuffle(
    ok.filter((it) => !avoid.has(it.templateId)),
    o.rng,
  );
  const stale = shuffle(
    ok.filter((it) => avoid.has(it.templateId)),
    o.rng,
  );
  const n = Math.min(o.n, ok.length);

  const share = o.levels.reduce((s, l) => s + MIX[l], 0) || 1;
  const want = new Map<Level, number>(o.levels.map((l) => [l, Math.round((n * MIX[l]) / share)]));
  const picked: T[] = [];
  const used = new Set<string>();
  const take = (items: T[], k: number) => {
    for (const it of roundRobin(
      items.filter((x) => !used.has(x.templateId)),
      Math.min(k, n - picked.length),
    )) {
      picked.push(it);
      used.add(it.templateId);
    }
  };
  const byLevel = (items: T[]) => {
    for (const l of o.levels) {
      const have = picked.filter((x) => x.exercise.difficulty.level === l).length;
      take(
        items.filter((it) => it.exercise.difficulty.level === l),
        Math.max(0, (want.get(l) ?? 0) - have),
      );
    }
  };
  // Lo NUEVO manda sobre el reparto de dificultad: primero las nuevas con el reparto, luego las nuevas de
  // cualquier nivel y solo al final las ya impresas (también con el reparto, y si falta, de cualquiera).
  byLevel(fresh);
  take(fresh, n);
  byLevel(stale);
  take(stale, n);
  const out = picked.slice(0, n);

  if (o.order === "fails") return out.sort((a, b) => (b.failCount ?? 0) - (a.failCount ?? 0));
  if (o.order === "module")
    return out.sort((a, b) => (a.module?.index ?? 0) - (b.module?.index ?? 0) || a.exercise.difficulty.numeric - b.exercise.difficulty.numeric);
  return out.sort((a, b) => a.exercise.difficulty.numeric - b.exercise.difficulty.numeric);
}

/**
 * Versión B: para cada pregunta de la A, otra sin usar que mida lo mismo: mismo tipo, nivel y módulo; si no
 * hay, mismo tipo y nivel; si no, mismo tipo. Si no queda ninguna, repite la de la A (con otra presentación)
 * y lo cuenta en `reused`.
 */
export function makeVersionB<T extends Pickable>(a: readonly T[], pool: readonly T[], rng: () => number): { items: T[]; reused: number } {
  const taken = new Set(a.map((x) => x.templateId));
  const free = shuffle(
    pool.filter((x) => !taken.has(x.templateId)),
    rng,
  );
  const sameType = (x: T, q: T) => x.exercise.type === q.exercise.type;
  const sameLevel = (x: T, q: T) => sameType(x, q) && x.exercise.difficulty.level === q.exercise.difficulty.level;
  const sameAll = (x: T, q: T) => sameLevel(x, q) && (x.module?.index ?? -1) === (q.module?.index ?? -1);
  let reused = 0;
  const items = a.map((q) => {
    for (const match of [sameAll, sameLevel, sameType]) {
      const i = free.findIndex((x) => match(x, q));
      if (i >= 0) return free.splice(i, 1)[0]!;
    }
    reused++;
    return q;
  });
  return { items, reused };
}

/* ---------- Presentación en papel ---------- */

export interface PaperItem {
  id: string;
  text: string;
}
/** Pregunta lista para el papel: el ejercicio + su presentación barajada (opciones, ítems a ordenar o
 *  columna derecha de las parejas). La clave usa ESTA presentación para dar las letras. */
export interface PaperQuestion<T extends Pickable = Pickable> {
  item: T;
  ex: FullExercise;
  shown: PaperItem[];
}

export function toPaper<T extends Pickable>(item: T, rng: () => number): PaperQuestion<T> {
  const ex = item.exercise;
  switch (ex.type) {
    case "multiple_choice":
    case "multiple_select":
      return { item, ex, shown: shuffle(ex.options, rng) };
    case "ordering": {
      let shown = shuffle(ex.items, rng);
      // Que no salga ya ordenado (con 2 ítems pasa la mitad de las veces): unos intentos y, si aun así sale
      // resuelto, se rota (con ids distintos, una rotación nunca deja el orden igual).
      const solved = () => shown.every((x, k) => x.id === ex.correctOrder[k]);
      for (let i = 0; i < 5 && solved(); i++) shown = shuffle(ex.items, rng);
      if (solved() && shown.length > 1) shown = [...shown.slice(1), shown[0]!];
      return { item, ex, shown };
    }
    case "matching":
      return { item, ex, shown: shuffle(ex.right, rng) };
    default:
      return { item, ex, shown: [] };
  }
}

/* ---------- Historial de lo impreso (por fuente, en este dispositivo) ---------- */

const HIST_PREFIX = "sk_print_hist:";
const HIST_JOBS = 10;
const HIST_IDS = 400;

/** Ids impresos recientemente para una fuente. Sin localStorage (modo privado, cuota...) = vacío. */
export function readHistory(sourceKey: string): Set<string> {
  try {
    const raw = localStorage.getItem(HIST_PREFIX + sourceKey);
    const jobs = raw ? (JSON.parse(raw) as { ts: number; ids: string[] }[]) : [];
    return new Set(jobs.flatMap((j) => j.ids));
  } catch {
    return new Set();
  }
}

export function addHistory(sourceKey: string, ids: string[]): void {
  try {
    const raw = localStorage.getItem(HIST_PREFIX + sourceKey);
    const jobs = raw ? (JSON.parse(raw) as { ts: number; ids: string[] }[]) : [];
    jobs.push({ ts: Date.now(), ids: [...new Set(ids)] });
    let kept = jobs.slice(-HIST_JOBS);
    while (kept.length > 1 && kept.reduce((s, j) => s + j.ids.length, 0) > HIST_IDS) kept = kept.slice(1);
    localStorage.setItem(HIST_PREFIX + sourceKey, JSON.stringify(kept));
  } catch {
    /* sin almacenamiento: el historial es solo una comodidad */
  }
}

export function clearHistory(sourceKey: string): void {
  try {
    localStorage.removeItem(HIST_PREFIX + sourceKey);
  } catch {
    /* nada */
  }
}
