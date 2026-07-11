/**
 * Pipeline de generación de contenido (OFFLINE / batch).
 *
 * Flujo: generar (Claude API o mock) -> validar (Zod + comprobación matemática
 * independiente) -> empaquetar (SQL + JSON versionado) -> publicar en D1.
 *
 * Uso:
 *   pnpm --filter @smartkids/content-gen run generate            # usa Claude si hay ANTHROPIC_API_KEY, si no mock
 *   pnpm --filter @smartkids/content-gen run generate -- --mock  # fuerza el modo mock (determinista, sin coste)
 *
 * Publicar el paquete en la D1 local:
 *   pnpm --filter @smartkids/api exec wrangler d1 execute smartkids --local --file=<ruta al .sql generado>
 */
import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/* ---------- Configuración del lote ---------- */

const SUBJECT_ID = "math";
const GRADE_BAND = "ESO-5";
const SKILL_ID = "MATH.ESO5.FRAC.SUB"; // "Restar fracciones" (sin contenido en el seed)
const LANGUAGE = "es";
const PACKAGE_ID = "pkg_math_eso5_sub_v1";
const PACKAGE_VERSION = "1.0.0";
const CONTENT_VERSION = "1.0.0";
const CREATED_AT = "2026-07-11T00:00:00Z"; // fijo → SQL reproducible

const USE_MOCK = process.argv.includes("--mock") || !process.env.ANTHROPIC_API_KEY;

/* ---------- Esquema (Zod) ---------- */

const OptionSchema = z.object({
  id: z.string(),
  text: z.string(),
  isCorrect: z.boolean(),
});

const RawExerciseSchema = z.object({
  skillId: z.string(),
  type: z.literal("multiple_choice"),
  language: z.string(),
  stem: z.string(),
  options: z.array(OptionSchema).min(3),
  feedback: z.object({ correct: z.string(), incorrect: z.string() }),
  difficulty: z.object({
    level: z.enum(["easy", "medium", "hard"]),
    numeric: z.number(),
  }),
});

type RawExercise = z.infer<typeof RawExerciseSchema>;

/* ---------- Aritmética de fracciones (validación independiente) ---------- */

type Frac = { n: number; d: number };

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a || 1;
}

function reduceFrac(n: number, d: number): Frac {
  if (d < 0) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

function evalStem(stem: string): Frac | null {
  const m = /(\d+)\s*\/\s*(\d+)\s*([+\-])\s*(\d+)\s*\/\s*(\d+)/.exec(stem);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const op = m[3];
  const c = Number(m[4]);
  const d = Number(m[5]);
  if (b === 0 || d === 0) return null;
  const num = op === "+" ? a * d + c * b : a * d - c * b;
  return reduceFrac(num, b * d);
}

function fracFromText(text: string): Frac | null {
  const f = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(text);
  if (f) return Number(f[2]) === 0 ? null : reduceFrac(Number(f[1]), Number(f[2]));
  const w = /^\s*(\d+)\s*$/.exec(text);
  if (w) return reduceFrac(Number(w[1]), 1);
  return null;
}

function sameFrac(a: Frac, b: Frac): boolean {
  return a.n === b.n && a.d === b.d;
}

/* ---------- Validación por capas ---------- */

type Verdict = { ok: true } | { ok: false; reason: string };

function validate(ex: RawExercise): Verdict {
  const correct = ex.options.filter((o) => o.isCorrect);
  if (correct.length !== 1) return { ok: false, reason: `debe haber 1 correcta, hay ${correct.length}` };

  const expected = evalStem(ex.stem);
  if (!expected) return { ok: false, reason: "no se pudo resolver el enunciado (requiere revisión humana)" };

  const correctFrac = fracFromText(correct[0]!.text);
  if (!correctFrac) return { ok: false, reason: `opción correcta no es fracción: "${correct[0]!.text}"` };
  if (!sameFrac(correctFrac, expected))
    return { ok: false, reason: `clave incorrecta: dice ${correct[0]!.text}, la solución es ${expected.n}/${expected.d}` };

  // Ningún distractor puede equivaler a la solución.
  for (const o of ex.options) {
    if (o.isCorrect) continue;
    const f = fracFromText(o.text);
    if (f && sameFrac(f, expected)) return { ok: false, reason: `distractor equivale a la solución: "${o.text}"` };
  }
  return { ok: true };
}

/* ---------- Generación ---------- */

function generateMock(): RawExercise[] {
  const make = (stem: string, level: "easy" | "medium" | "hard", numeric: number, opts: [string, boolean][]): RawExercise => ({
    skillId: SKILL_ID,
    type: "multiple_choice",
    language: LANGUAGE,
    stem,
    options: opts.map(([text, isCorrect], i) => ({ id: String.fromCharCode(97 + i), text, isCorrect })),
    feedback: {
      correct: "Con igual denominador, resta los numeradores y simplifica.",
      incorrect: "Iguala denominadores y resta solo los numeradores.",
    },
    difficulty: { level, numeric },
  });

  return [
    make("3/4 - 1/4 = ?", "easy", 0.3, [["1/2", true], ["1/4", false], ["3/8", false], ["2/3", false]]),
    make("5/6 - 1/6 = ?", "easy", 0.35, [["2/3", true], ["1/6", false], ["5/6", false], ["1/2", false]]),
    make("7/8 - 3/8 = ?", "medium", 0.5, [["1/2", true], ["3/8", false], ["5/8", false], ["1/4", false]]),
    make("1/2 - 1/3 = ?", "medium", 0.55, [["1/6", true], ["1/3", false], ["2/5", false], ["1/5", false]]),
  ];
}

async function generateWithClaude(count: number): Promise<RawExercise[]> {
  // Import dinámico: el modo mock nunca carga el SDK.
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
  const client = new Anthropic();

  const Batch = z.object({ exercises: z.array(RawExerciseSchema).min(count) });
  const prompt = `Genera ${count} ejercicios de matemáticas para España, ${GRADE_BAND} (LOMLOE), sobre la RESTA de fracciones.
- skillId: "${SKILL_ID}", type: "multiple_choice", language: "${LANGUAGE}".
- Enunciado ("stem") con la forma "a/b - c/d = ?" (usa "/" para fracciones).
- 4 opciones; exactamente UNA correcta (isCorrect:true). Los distractores deben ser plausibles y NINGUNO puede equivaler a la solución correcta.
- feedback.correct y feedback.incorrect en español, sin apóstrofos.
- difficulty.level entre easy/medium/hard y difficulty.numeric entre 0 y 1.`;

  const res = await client.messages.parse({
    model: "claude-opus-4-8",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { format: zodOutputFormat(Batch) },
    messages: [{ role: "user", content: prompt }],
  });
  return res.parsed_output?.exercises ?? [];
}

/* ---------- Empaquetado (SQL + JSON) ---------- */

function sqlStr(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

function buildSql(valid: RawExercise[]): string {
  const lines: string[] = [];
  lines.push(`-- Paquete generado: ${PACKAGE_ID} (${valid.length} ejercicios)`);
  lines.push(`DELETE FROM exercise_templates WHERE package_id='${PACKAGE_ID}';`);
  lines.push(`DELETE FROM content_packages WHERE id='${PACKAGE_ID}';`);
  lines.push(
    `INSERT INTO content_packages (id, subject_id, grade_band, version, status, created_at) VALUES ` +
      `('${PACKAGE_ID}', '${SUBJECT_ID}', '${GRADE_BAND}', '${PACKAGE_VERSION}', 'published', '${CREATED_AT}');`,
  );
  valid.forEach((ex, i) => {
    const id = `tpl_gen_sub_${i + 1}`;
    const payload = JSON.stringify({ options: ex.options, feedback: ex.feedback });
    lines.push(
      `INSERT INTO exercise_templates (id, package_id, skill_id, type, language, content_version, stem, payload, difficulty_numeric, difficulty_level) VALUES (` +
        `${sqlStr(id)}, ${sqlStr(PACKAGE_ID)}, ${sqlStr(ex.skillId)}, ${sqlStr(ex.type)}, ${sqlStr(ex.language)}, ${sqlStr(CONTENT_VERSION)}, ` +
        `${sqlStr(ex.stem)}, ${sqlStr(payload)}, ${ex.difficulty.numeric}, ${sqlStr(ex.difficulty.level)});`,
    );
  });
  return lines.join("\n") + "\n";
}

/* ---------- Main ---------- */

async function main(): Promise<void> {
  console.log(`smartkids · content-gen — modo ${USE_MOCK ? "MOCK (determinista)" : "Claude API (claude-opus-4-8)"}`);

  const raw = USE_MOCK ? generateMock() : await generateWithClaude(4);
  console.log(`Generados: ${raw.length}`);

  const valid: RawExercise[] = [];
  const seen = new Set<string>();
  let rejected = 0;

  for (const item of raw) {
    const parsed = RawExerciseSchema.safeParse(item);
    if (!parsed.success) {
      rejected++;
      console.log(`  ✗ estructura inválida: ${parsed.error.issues[0]?.message ?? "?"}`);
      continue;
    }
    const ex = parsed.data;
    const key = ex.stem.replace(/\s+/g, "");
    if (seen.has(key)) {
      rejected++;
      console.log(`  ✗ duplicado: "${ex.stem}"`);
      continue;
    }
    const v = validate(ex);
    if (!v.ok) {
      rejected++;
      console.log(`  ✗ "${ex.stem}" — ${v.reason}`);
      continue;
    }
    seen.add(key);
    valid.push(ex);
    console.log(`  ✓ "${ex.stem}"`);
  }

  console.log(`Validados: ${valid.length} · Rechazados: ${rejected}`);
  if (valid.length === 0) {
    console.log("No hay ejercicios válidos; no se genera paquete.");
    return;
  }

  const outDir = join(process.cwd(), "out");
  mkdirSync(outDir, { recursive: true });

  const pkg = {
    packageId: PACKAGE_ID,
    version: PACKAGE_VERSION,
    subjectId: SUBJECT_ID,
    gradeBand: GRADE_BAND,
    status: "published",
    createdAt: CREATED_AT,
    exercises: valid,
  };
  const jsonPath = join(outDir, `${PACKAGE_ID}.json`);
  const sqlPath = join(outDir, `${PACKAGE_ID}.sql`);
  writeFileSync(jsonPath, JSON.stringify(pkg, null, 2) + "\n");
  writeFileSync(sqlPath, buildSql(valid));

  console.log(`\nPaquete escrito:\n  ${jsonPath}\n  ${sqlPath}`);
  console.log(`\nPara publicar en la D1 local:`);
  console.log(`  pnpm --filter @smartkids/api exec wrangler d1 execute smartkids --local --file="${sqlPath}"`);
}

await main();
