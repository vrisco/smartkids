// Banco de pruebas de la impresión (SOLO desarrollo: lo carga print-demo.html, que no entra en la build).
// Pinta una ficha, un examen, tarjetas o un documento con datos de ejemplo, sin API, para revisarlos en
// pantalla o sacar el PDF con Chrome sin interfaz (scripts/print-check.mjs). Parámetros de la URL:
//   view=sheet|doc|cards|worked|remember  subject=math|lengua|ingles|sociales|naturales  grade=PRI-5
//   mode=practice|exam|review|drill  compact=1  versions=1  key=explained  sheets=2  paper=letter
//   doc=<fixture sin .json>  screen=1 (documento en pantalla)  layout=fold (tarjetas)  dark=1
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "../i18n";
import i18n from "../i18n";
import "../styles/tokens.css";
import "../styles/global.css";
import "../styles/app.css";
import "../styles/auth.css";
import "../styles/print.css";
import "../styles/studydoc.css";
import type { Exercise, StudyDoc } from "@smartkids/shared";
import { decimalSep, operationSolutionText } from "../components/ColumnOps";
import { exercisesToCards, exercisesToRememberDoc, exercisesToWorkedDoc, type AnswerLabels } from "../components/print/fromExercises";
import { notationOf } from "../components/print/ExercisePaper";
import { pageCss } from "../components/print/page";
import { fontPtFor, profileFor } from "../components/print/profiles";
import { examPoints, suggestedMinutes } from "../components/print/scoring";
import { makeVersionB, mulberry32, selectQuestions, sheetCode, toPaper, type Pickable } from "../components/print/select";
import { Booklet, CardsPaper, type SheetMode, type SheetSpec } from "../components/print/sheets";
import { StudyDocView } from "../components/studydoc/StudyDocView";

const q = new URLSearchParams(location.search);
const p = (k: string, d = "") => q.get(k) ?? d;

/* ---------- Ejercicios de ejemplo ---------- */

const courseMods = import.meta.glob("../../../../content/math-pri6-calculo/0*.json", { eager: true, import: "default" }) as Record<
  string,
  { skill: { id: string; name: { es: string } }; exercises: Record<string, unknown>[] }
>;
const docFixtures = import.meta.glob("../../../../packages/shared/test/fixtures/studydocs/*.json", { eager: true, import: "default" }) as Record<string, StudyDoc>;
const courseDocs = import.meta.glob("../../../../content/*/docs/*.json", { eager: true, import: "default" }) as Record<string, { doc: StudyDoc }>;

let seq = 0;
const ctx = (skill: string) => ({ exerciseId: `demo_${++seq}`, packageId: "pkg_demo", skillId: skill, schemaVersion: "1.0.0", language: "es" });
const lv = (level: "easy" | "medium" | "hard") => ({ level, numeric: level === "easy" ? 0.2 : level === "medium" ? 0.5 : 0.8 });
const fb = (solution: string, theory: string) => ({ correct: "Bien", incorrect: "Casi", solution, theory });

const MATH_EXTRA: Exercise[] = [
  { ...ctx("DEMO.MATH"), type: "numeric", stem: "Calcula 3/4 + 1/6", difficulty: lv("medium"), answer: { value: 0.9167, tolerance: 0.001 }, feedback: fb("Común denominador 12: 9/12 + 2/12 = 11/12.", "Para sumar fracciones de distinto denominador, primero se pasan a común denominador.") },
  { ...ctx("DEMO.MATH"), type: "fill_in_blank", stem: "m.c.m.(4, 6) = {{1}}", difficulty: lv("easy"), blanks: [{ accept: ["12"] }], feedback: fb("Múltiplos de 4: 4, 8, 12. Múltiplos de 6: 6, 12.", "El m.c.m. es el menor múltiplo común.") },
  {
    ...ctx("DEMO.MATH"),
    type: "step_problem",
    stem: "Dos autobuses salen juntos a las 8:00. Uno pasa cada 12 minutos y otro cada 18.",
    difficulty: lv("hard"),
    steps: [
      { id: "a", prompt: "¿Cada cuántos minutos coinciden?", kind: "numeric", answer: { value: 36, tolerance: 0, unit: "min" } },
      { id: "b", prompt: "¿Cuántas veces coinciden hasta las 11:00?", kind: "numeric", answer: { value: 5, tolerance: 0 } },
    ],
    feedback: fb("m.c.m.(12, 18) = 36; 180 : 36 = 5.", "Si algo se repite y buscamos cuándo coincide, es un m.c.m."),
  },
  {
    ...ctx("DEMO.MATH"),
    type: "multiple_choice",
    stem: "¿Cuál es el M.C.D. de 16 y 24?",
    difficulty: lv("medium"),
    options: [
      { id: "a", text: "8", isCorrect: true },
      { id: "b", text: "4", isCorrect: false },
      { id: "c", text: "48", isCorrect: false },
    ],
    feedback: fb("Divisores comunes: 1, 2, 4, 8. El mayor es 8.", "El M.C.D. es el mayor divisor común."),
  },
  { ...ctx("DEMO.MATH"), type: "true_false", stem: "El 1 es un número primo.", difficulty: lv("easy"), answer: { value: false }, feedback: fb("Solo tiene un divisor.", "Un primo tiene exactamente dos divisores.") },
  {
    ...ctx("DEMO.MATH"),
    type: "matching",
    stem: "Une cada número con su descomposición.",
    difficulty: lv("medium"),
    left: [
      { id: "l1", text: "12" },
      { id: "l2", text: "18" },
      { id: "l3", text: "20" },
    ],
    right: [
      { id: "r1", text: "2^2 · 3" },
      { id: "r2", text: "2 · 3^2" },
      { id: "r3", text: "2^2 · 5" },
    ],
    correctPairs: [
      { leftId: "l1", rightId: "r1" },
      { leftId: "l2", rightId: "r2" },
      { leftId: "l3", rightId: "r3" },
    ],
    feedback: fb("Haz la escalera de cada número.", "Factorizar es escribir el número como producto de primos."),
  },
] as Exercise[];

const LENGUA: Exercise[] = [
  { ...ctx("DEMO.LEN"), type: "fill_in_blank", stem: "La palabra «camión» es {{1}} porque su sílaba tónica es la última.", difficulty: lv("easy"), blanks: [{ accept: ["aguda"] }], feedback: fb("ca-MIÓN: tónica la última.", "Agudas: tónica en la última sílaba.") },
  {
    ...ctx("DEMO.LEN"),
    type: "multiple_choice",
    stem: "¿Qué palabra está bien escrita?",
    difficulty: lv("medium"),
    options: [
      { id: "a", text: "árbol", isCorrect: true },
      { id: "b", text: "arból", isCorrect: false },
      { id: "c", text: "arbol", isCorrect: false },
    ],
    feedback: fb("Llana terminada en -l: lleva tilde.", "Las llanas llevan tilde si NO terminan en vocal, -n o -s."),
  },
  { ...ctx("DEMO.LEN"), type: "true_false", stem: "«Tú» lleva tilde cuando es pronombre personal y/o sujeto de la oración.", difficulty: lv("medium"), answer: { value: true }, feedback: fb("Tú (pronombre) / tu (posesivo).", "Tilde diacrítica.") },
  {
    ...ctx("DEMO.LEN"),
    type: "fill_in_blank",
    stem: "Explica con tus palabras qué es una palabra esdrújula.",
    difficulty: lv("hard"),
    blanks: [{ accept: ["la que tiene la sílaba tónica en la antepenúltima sílaba y siempre lleva tilde"] }],
    feedback: fb("Ejemplo: pá-ja-ro.", "Las esdrújulas llevan tilde siempre."),
  },
  {
    ...ctx("DEMO.LEN"),
    type: "ordering",
    stem: "Ordena las palabras para formar una oración.",
    difficulty: lv("easy"),
    items: [
      { id: "1", text: "El" },
      { id: "2", text: "perro" },
      { id: "3", text: "ladra" },
    ],
    correctOrder: ["1", "2", "3"],
    feedback: fb("Sujeto + verbo.", "La oración tiene sujeto y predicado."),
  },
  {
    ...ctx("DEMO.LEN"),
    type: "step_problem",
    stem: "Analiza la oración «Marta come manzanas».",
    difficulty: lv("hard"),
    steps: [
      { id: "s", prompt: "¿Cuál es el sujeto?", kind: "short_text", accept: ["Marta"] },
      { id: "v", prompt: "¿Cuál es el verbo?", kind: "short_text", accept: ["come"] },
    ],
    feedback: fb("Quién come: Marta.", "El sujeto concuerda con el verbo."),
  },
] as Exercise[];

const INGLES: Exercise[] = [
  {
    ...ctx("DEMO.EN"),
    language: "en",
    type: "matching",
    stem: "Match each word with its meaning.",
    difficulty: lv("easy"),
    left: [
      { id: "l1", text: "cow" },
      { id: "l2", text: "horse" },
      { id: "l3", text: "duck" },
    ],
    right: [
      { id: "r1", text: "vaca" },
      { id: "r2", text: "caballo" },
      { id: "r3", text: "pato" },
    ],
    correctPairs: [
      { leftId: "l1", rightId: "r1" },
      { leftId: "l2", rightId: "r2" },
      { leftId: "l3", rightId: "r3" },
    ],
    feedback: fb("cow = vaca...", "Farm animals."),
  },
  { ...ctx("DEMO.EN"), language: "en", type: "fill_in_blank", stem: "I {{1}} a student. She {{2}} my friend.", difficulty: lv("easy"), blanks: [{ accept: ["am"] }, { accept: ["is"] }], feedback: fb("I am / she is.", "Verb to be.") },
  {
    ...ctx("DEMO.EN"),
    language: "en",
    type: "multiple_choice",
    stem: "Choose the right answer: «I ___ football on Mondays.»",
    difficulty: lv("medium"),
    options: [
      { id: "a", text: "play", isCorrect: true },
      { id: "b", text: "plays", isCorrect: false },
      { id: "c", text: "playing", isCorrect: false },
    ],
    feedback: fb("With I: play.", "Present simple: -s only with he/she/it."),
  },
] as Exercise[];

const SOCIALES: Exercise[] = [
  {
    ...ctx("DEMO.SOC"),
    type: "ordering",
    stem: "Ordena de más antiguo a más reciente.",
    difficulty: lv("medium"),
    items: [
      { id: "a", text: "Llegada de los musulmanes (711)" },
      { id: "b", text: "Fin del Imperio romano de Occidente (476)" },
      { id: "c", text: "Conquista de Granada (1492)" },
    ],
    correctOrder: ["b", "a", "c"],
    feedback: fb("476, 711, 1492.", "La Edad Media va del 476 al 1492."),
  },
  { ...ctx("DEMO.SOC"), type: "fill_in_blank", stem: "¿Por qué fue importante la batalla de las Navas de Tolosa?", difficulty: lv("hard"), blanks: [{ accept: ["porque abrió el sur de la península a los reinos cristianos"] }], feedback: fb("1212.", "Batalla decisiva de la Reconquista.") },
  { ...ctx("DEMO.SOC"), type: "true_false", stem: "La Edad Media termina en 1492.", difficulty: lv("easy"), answer: { value: true }, feedback: fb("Con la llegada de Colón a América.", "Fin de la Edad Media: 1492.") },
] as Exercise[];

function mathCourse(): Pickable[] {
  const out: Pickable[] = [];
  Object.keys(courseMods)
    .sort()
    .forEach((path, mi) => {
      const mod = courseMods[path]!;
      mod.exercises.forEach((raw, i) => {
        const ex = { ...ctx(mod.skill.id), ...raw, exerciseId: `${mod.skill.id}_${i}` } as unknown as Exercise;
        out.push({ templateId: `${mod.skill.id}_${i}`, exercise: ex, module: { skillId: mod.skill.id, title: mod.skill.name.es, index: mi } });
      });
    });
  MATH_EXTRA.forEach((ex, i) => out.push({ templateId: `extra_${i}`, exercise: ex, module: { skillId: "DEMO.MATH", title: "Múltiplos y divisores", index: 9 } }));
  return out;
}

const POOLS: Record<string, () => Pickable[]> = {
  math: mathCourse,
  lengua: () => LENGUA.map((ex, i) => ({ templateId: `len_${i}`, exercise: ex, failCount: (i % 3) + 1 })),
  ingles: () => INGLES.map((ex, i) => ({ templateId: `en_${i}`, exercise: ex })),
  sociales: () => SOCIALES.map((ex, i) => ({ templateId: `soc_${i}`, exercise: ex })),
  naturales: () => [...MATH_EXTRA.slice(0, 2), ...SOCIALES.slice(2)].map((ex, i) => ({ templateId: `nat_${i}`, exercise: ex })),
};

/* ---------- Composición ---------- */

function Demo(): { node: ReactNode; landscape?: boolean } {
  const subject = p("subject", "math");
  const grade = p("grade", "PRI-6");
  const profile = profileFor(subject, grade);
  const font = fontPtFor(profile, "auto");
  const labels: AnswerLabels = {
    yes: i18n.t("session.true"),
    no: i18n.t("session.false"),
    opText: (ex) => operationSolutionText(ex, decimalSep(i18n.language), i18n.t("session.remainder").toLowerCase()),
    decimal: decimalSep(i18n.language),
  };
  const view = p("view", "sheet");
  const pool = (POOLS[subject] ?? POOLS.math!)();

  if (view === "doc") {
    const name = p("doc", "summary.math");
    const doc =
      Object.entries(docFixtures).find(([k]) => k.endsWith(`/${name}.json`))?.[1] ??
      Object.entries(courseDocs).find(([k]) => k.endsWith(`/${name}.json`))?.[1]?.doc;
    if (!doc) return { node: <p>No encuentro el documento «{name}».</p> };
    const prof = profileFor(name.split(".")[1] ?? subject, grade);
    if (p("screen") === "1") return { node: <StudyDocView doc={doc} medium="screen" profile={prof} reveal={p("reveal") === "1"} /> };
    return {
      node: <StudyDocView doc={doc} medium="paper" profile={prof} fontPt={fontPtFor(prof, "auto")} cardsLayout={p("layout") === "fold" ? "fold" : "duplex"} kicker={doc.subtitle} />,
      landscape: doc.print?.orientation === "landscape",
    };
  }
  const rng = mulberry32(12345);
  if (view === "cards") {
    const picked = selectQuestions(pool, { n: 16, types: pool.map((x) => x.exercise.type), levels: ["easy", "medium", "hard"], rng, order: "module" });
    return {
      node: (
        <CardsPaper
          title="Tarjetas de prueba"
          cards={exercisesToCards(picked.map((x) => x.exercise), labels)}
          layout={p("layout") === "fold" ? "fold" : "duplex"}
          frontNotation={notationOf(profile)}
          backNotation={notationOf(profile)}
        />
      ),
    };
  }
  if (view === "worked" || view === "remember") {
    const groups = [...new Set(pool.map((x) => x.module?.index ?? 0))].map((m) => ({
      title: pool.find((x) => (x.module?.index ?? 0) === m)?.module?.title ?? null,
      exercises: pool.filter((x) => (x.module?.index ?? 0) === m).slice(0, view === "worked" ? 2 : 50).map((x) => x.exercise),
    }));
    const doc = view === "worked" ? exercisesToWorkedDoc(groups, "Ejemplos resueltos", labels) : exercisesToRememberDoc(groups, "Recuerda");
    return { node: <StudyDocView doc={doc} medium="paper" profile={profile} notation={notationOf(profile)} fontPt={font} /> };
  }

  const mode = p("mode", "practice") as SheetMode;
  const nSheets = Number(p("sheets", "1"));
  const versions = p("versions") === "1";
  const n = Number(p("n", mode === "drill" ? "16" : "12"));
  const usable = mode === "drill" ? pool.filter((x) => x.exercise.type === "column_operation" || x.exercise.type === "prime_factorization") : pool;
  const used = new Set<string>();
  const specs: SheetSpec[] = [];
  for (let i = 0; i < nSheets; i++) {
    const picked = selectQuestions(usable, {
      n,
      types: [...new Set(usable.map((x) => x.exercise.type))],
      levels: ["easy", "medium", "hard"],
      rng,
      exclude: used,
      order: mode === "review" ? "fails" : "module",
    });
    picked.forEach((x) => used.add(x.templateId));
    const variants = [{ items: picked, v: versions ? "A" : undefined }];
    if (versions) variants.push({ items: makeVersionB(picked, usable, rng).items, v: "B" });
    for (const v of variants) {
      const groups = new Map<number, Pickable[]>();
      for (const it of v.items) groups.set(it.module?.index ?? 0, [...(groups.get(it.module?.index ?? 0) ?? []), it]);
      const sections = [...groups.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, list]) => ({ title: groups.size > 1 ? (list[0]?.module?.title ?? null) : null, profile, questions: list.map((it) => toPaper(it, rng)) }));
      const flat = sections.flatMap((s) => s.questions.map((qq) => qq.ex));
      specs.push({
        title: `Ficha de prueba${nSheets > 1 ? ` · ${i + 1}` : ""}`,
        kicker: mode,
        meta: [grade, subject],
        mode,
        sections,
        workSpace: p("work", "1") === "1",
        compact: p("compact") === "1",
        fontPt: font,
        points: mode === "exam" ? examPoints(flat) : undefined,
        minutes: mode === "exam" ? suggestedMinutes(flat, profile.age) : undefined,
        code: sheetCode(rng),
        version: v.v,
        remember: mode === "review",
      });
    }
  }
  return { node: <Booklet sheets={specs} keyStyle={p("key") === "explained" ? "explained" : "simple"} includeKey={p("nokey") !== "1"} keysTogether={p("together", "1") === "1"} /> };
}

if (p("dark") === "1") document.documentElement.setAttribute("data-theme", "dark");
const { node, landscape } = Demo();
const screen = p("screen") === "1";
if (screen) {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <div className="app-body" style={{ padding: "1rem" }}>
        {node}
      </div>
    </StrictMode>,
  );
} else {
  // Como en la app (PrintShell): la hoja, hija DIRECTA de body; el CSS de impresión oculta todo lo demás.
  document.documentElement.classList.add("ws-printing");
  const host = document.createElement("div");
  host.className = "ws-print-root";
  host.style.display = "block"; // visible también en pantalla, para revisarla en el navegador
  document.body.appendChild(host);
  createRoot(host).render(
    <StrictMode>
      <style>{pageCss({ fileName: "demo", paper: p("paper") === "letter" ? "letter" : "A4", landscape, headerText: "Demo de impresión" })}</style>
      {node}
    </StrictMode>,
  );
}
