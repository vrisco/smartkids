/**
 * Pipeline de generación de contenido (OFFLINE / batch), spec-driven y multi-tipo.
 *
 * Flujo: leer spec -> generar (Claude API o mock) -> validar (Zod + self-check del
 * modelo unificado) -> empaquetar (SQL + JSON versionado) -> publicar en D1.
 *
 * Uso:
 *   pnpm --filter @smartkids/content-gen run generate -- --spec ./spec.json
 *   pnpm --filter @smartkids/content-gen run generate -- --mock            # sin coste, contenido de muestra
 *
 * La spec (JSON) describe QUÉ generar; ver DEFAULT_SPEC más abajo. Publicar el .sql:
 *   pnpm --filter @smartkids/api exec wrangler d1 execute smartkids --local --file=<ruta al .sql>
 */
import { z } from "zod";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ExerciseSchema,
  ExerciseTypeSchema,
  toStoredPayload,
  validateExercise,
  type Exercise,
  type ExerciseType,
} from "@smartkids/shared";

/* ---------- Spec ---------- */

const LocaleTextSpec = z.record(z.string(), z.string());

const SpecSchema = z.object({
  subjectId: z.string(),
  subjectName: LocaleTextSpec.optional(), // si el subject aún no existe, se crea
  gradeBand: z.string(),
  skillId: z.string(),
  skillName: LocaleTextSpec,
  language: z.string().default("es"),
  types: z.array(ExerciseTypeSchema).min(1),
  count: z.number().int().min(1).max(60).default(20),
  packageId: z.string(),
  version: z.string().default("1.0.0"),
  ownerId: z.string().nullable().optional(), // null/ausente = contenido global (catálogo)
  instructions: z.string().optional(), // guía pedagógica libre del usuario
  createdAt: z.string().default("2026-07-12T00:00:00Z"),
});
type Spec = z.infer<typeof SpecSchema>;

const DEFAULT_SPEC: Spec = SpecSchema.parse({
  subjectId: "math",
  gradeBand: "ESO-5",
  skillId: "MATH.ESO5.MIX.DEMO",
  skillName: { es: "Repaso variado", en: "Mixed practice" },
  language: "es",
  types: ["multiple_choice", "numeric", "true_false", "fill_in_blank", "ordering", "matching", "step_problem"],
  count: 7,
  packageId: "pkg_math_eso5_mix_demo_v1",
  version: "1.0.0",
});

function loadSpec(): Spec {
  const idx = process.argv.indexOf("--spec");
  if (idx >= 0 && process.argv[idx + 1]) {
    const raw = JSON.parse(readFileSync(process.argv[idx + 1]!, "utf8"));
    return SpecSchema.parse(raw);
  }
  return DEFAULT_SPEC;
}

const USE_MOCK = process.argv.includes("--mock") || !process.env.ANTHROPIC_API_KEY;

/* ---------- Generación: mock (muestras por tipo) ---------- */

function mockByType(type: ExerciseType, spec: Spec): Record<string, unknown> {
  const base = {
    exerciseId: "x",
    packageId: spec.packageId,
    language: spec.language,
    skillId: spec.skillId,
    difficulty: { level: "easy" as const, numeric: 0.3 },
    feedback: { correct: "Muy bien.", incorrect: "Revisa el procedimiento.", solution: "Solucion paso a paso." },
  };
  switch (type) {
    case "multiple_choice":
      return { ...base, type, stem: "Cuanto es 3/4 - 1/4?", options: [
        { id: "a", text: "1/2", isCorrect: true },
        { id: "b", text: "1/4", isCorrect: false },
        { id: "c", text: "2/4", isCorrect: false },
        { id: "d", text: "3/8", isCorrect: false },
      ] };
    case "numeric":
      return { ...base, type, stem: "Cuanto es 12 x 8?", answer: { value: 96, tolerance: 0 } };
    case "true_false":
      return { ...base, type, stem: "El numero 17 es primo.", answer: { value: true } };
    case "fill_in_blank":
      return { ...base, type, stem: "La capital de Francia es {{1}}.", blanks: [{ accept: ["Paris"], placeholder: "ciudad" }] };
    case "ordering":
      return { ...base, type, stem: "Ordena de menor a mayor.", items: [
        { id: "p", text: "3" }, { id: "q", text: "1" }, { id: "r", text: "2" },
      ], correctOrder: ["q", "r", "p"] };
    case "matching":
      return { ...base, type, stem: "Empareja cada operacion con su resultado.", left: [
        { id: "l1", text: "2 x 3" }, { id: "l2", text: "4 + 5" },
      ], right: [ { id: "r1", text: "6" }, { id: "r2", text: "9" } ], correctPairs: [
        { leftId: "l1", rightId: "r1" }, { leftId: "l2", rightId: "r2" },
      ] };
    case "step_problem":
      return { ...base, type, stem: "Un tren recorre 120 km en 2 horas.", steps: [
        { id: "s1", prompt: "Velocidad media (km/h)?", kind: "numeric", answer: { value: 60, tolerance: 0 } },
        { id: "s2", prompt: "Como se llama esa magnitud?", kind: "short_text", accept: ["velocidad"] },
      ] };
  }
}

function generateMock(spec: Spec): unknown[] {
  return spec.types.map((t) => mockByType(t, spec));
}

/* ---------- Generación: Claude API ---------- */

async function generateWithClaude(spec: Spec): Promise<unknown[]> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
  const client = new Anthropic();

  const Batch = z.object({ exercises: z.array(ExerciseSchema).min(spec.count) });
  const prompt = `Eres un generador de ejercicios educativos para España (currículo LOMLOE).
Genera ${spec.count} ejercicios para la asignatura "${spec.subjectId}", nivel "${spec.gradeBand}", del tema/skill "${spec.skillId}".
Idioma: "${spec.language}". Reparte los ejercicios entre estos tipos: ${spec.types.join(", ")}.
${spec.instructions ? `Instrucciones específicas del profesor: ${spec.instructions}` : ""}

Reglas OBLIGATORIAS:
- Usa skillId="${spec.skillId}", packageId="${spec.packageId}", language="${spec.language}" en todos.
- Cada ejercicio del tipo indicado en su campo "type".
- multiple_choice: 4 opciones, EXACTAMENTE una con isCorrect:true; los distractores deben reflejar ERRORES TÍPICOS del alumno, no aleatorios; ninguno equivalente a la solución.
- numeric: answer.value correcto; usa tolerance>0 solo si la respuesta es decimal.
- fill_in_blank: marca los huecos en el "stem" con {{1}}, {{2}}... y da en cada hueco la lista de respuestas aceptadas (incluye variantes válidas).
- true_false: answer.value booleano correcto.
- ordering: "items" con ids y "correctOrder" con esos ids en el orden correcto.
- matching: "left", "right" y "correctPairs" (cada left emparejado una vez).
- step_problem: "steps" en orden, cada uno numeric o short_text con su respuesta.
- feedback.correct y feedback.incorrect breves; feedback.solution con la solución trabajada. Sin apóstrofos ni comillas raras.
- difficulty.level en easy/medium/hard y difficulty.numeric entre 0 y 1, con variedad.
- Las respuestas deben ser CORRECTAS. Revisa la aritmética/los datos.`;

  const res = await client.messages.parse({
    model: "claude-opus-4-8",
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    output_config: { format: zodOutputFormat(Batch) },
    messages: [{ role: "user", content: prompt }],
  });
  return res.parsed_output?.exercises ?? [];
}

/* ---------- Validación ---------- */

function normalizeAndValidate(raw: unknown[], spec: Spec): Exercise[] {
  const valid: Exercise[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  let i = 0;
  for (const item of raw) {
    i += 1;
    // Fijamos los campos de contexto (no confiamos en los que invente el modelo).
    const merged = {
      ...(item as Record<string, unknown>),
      exerciseId: `${spec.packageId}_${i}`,
      packageId: spec.packageId,
      skillId: spec.skillId,
      language: spec.language,
    };
    const parsed = ExerciseSchema.safeParse(merged);
    if (!parsed.success) {
      rejected += 1;
      console.log(`  x estructura inválida: ${parsed.error.issues[0]?.message ?? "?"}`);
      continue;
    }
    const ex = parsed.data;
    const key = `${ex.type}:${ex.stem.replace(/\s+/g, "")}`;
    if (seen.has(key)) {
      rejected += 1;
      console.log(`  x duplicado: "${ex.stem}"`);
      continue;
    }
    const v = validateExercise(ex);
    if (!v.ok) {
      rejected += 1;
      console.log(`  x "${ex.stem}" — ${v.reason}`);
      continue;
    }
    seen.add(key);
    valid.push(ex);
    console.log(`  ok [${ex.type}] "${ex.stem.slice(0, 48)}"`);
  }
  console.log(`Validados: ${valid.length} · Rechazados: ${rejected}`);
  return valid;
}

/* ---------- Empaquetado (SQL + JSON) ---------- */

function sqlStr(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}
function sqlVal(s: string | null | undefined): string {
  return s === null || s === undefined ? "NULL" : sqlStr(s);
}

function buildSql(valid: Exercise[], spec: Spec): string {
  const L: string[] = [];
  L.push(`-- Paquete: ${spec.packageId} (${valid.length} ejercicios, tipos: ${[...new Set(valid.map((e) => e.type))].join(", ")})`);
  if (spec.subjectName) {
    L.push(`INSERT OR IGNORE INTO subjects (id, name_i18n) VALUES (${sqlStr(spec.subjectId)}, ${sqlStr(JSON.stringify(spec.subjectName))});`);
  }
  L.push(
    `INSERT OR IGNORE INTO skills (id, subject_id, grade_band, name_i18n, difficulty_base, position, owner_id) VALUES (` +
      `${sqlStr(spec.skillId)}, ${sqlStr(spec.subjectId)}, ${sqlStr(spec.gradeBand)}, ${sqlStr(JSON.stringify(spec.skillName))}, 0.4, 0, ${sqlVal(spec.ownerId ?? null)});`,
  );
  L.push(`DELETE FROM exercise_templates WHERE package_id=${sqlStr(spec.packageId)};`);
  L.push(`DELETE FROM content_packages WHERE id=${sqlStr(spec.packageId)};`);
  L.push(
    `INSERT INTO content_packages (id, subject_id, grade_band, version, status, owner_id, created_at) VALUES (` +
      `${sqlStr(spec.packageId)}, ${sqlStr(spec.subjectId)}, ${sqlStr(spec.gradeBand)}, ${sqlStr(spec.version)}, 'published', ${sqlVal(spec.ownerId ?? null)}, ${sqlStr(spec.createdAt)});`,
  );
  valid.forEach((ex, idx) => {
    const id = `${spec.packageId}_${idx + 1}`;
    const payload = JSON.stringify(toStoredPayload(ex));
    L.push(
      `INSERT INTO exercise_templates (id, package_id, skill_id, type, language, content_version, stem, payload, difficulty_numeric, difficulty_level) VALUES (` +
        `${sqlStr(id)}, ${sqlStr(spec.packageId)}, ${sqlStr(spec.skillId)}, ${sqlStr(ex.type)}, ${sqlStr(spec.language)}, ${sqlStr(spec.version)}, ` +
        `${sqlStr(ex.stem)}, ${sqlStr(payload)}, ${ex.difficulty.numeric}, ${sqlStr(ex.difficulty.level)});`,
    );
  });
  return L.join("\n") + "\n";
}

/* ---------- Main ---------- */

async function main(): Promise<void> {
  const spec = loadSpec();
  console.log(`smartkids · content-gen — ${USE_MOCK ? "MOCK" : "Claude (claude-opus-4-8)"} · skill ${spec.skillId} · tipos [${spec.types.join(", ")}]`);

  const raw = USE_MOCK ? generateMock(spec) : await generateWithClaude(spec);
  console.log(`Generados: ${raw.length}`);

  const valid = normalizeAndValidate(raw, spec);
  if (valid.length === 0) {
    console.log("No hay ejercicios válidos; no se genera paquete.");
    return;
  }

  const outDir = join(process.cwd(), "out");
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, `${spec.packageId}.json`);
  const sqlPath = join(outDir, `${spec.packageId}.sql`);
  writeFileSync(jsonPath, JSON.stringify({ spec, exercises: valid }, null, 2) + "\n");
  writeFileSync(sqlPath, buildSql(valid, spec));

  console.log(`\nPaquete escrito:\n  ${jsonPath}\n  ${sqlPath}`);
  console.log(`\nPublicar en la D1 local:`);
  console.log(`  pnpm --filter @smartkids/api exec wrangler d1 execute smartkids --local --file="${sqlPath}"`);
  console.log(`Publicar en PRODUCCIÓN (cuidado, datos reales):`);
  console.log(`  pnpm --filter @smartkids/api exec wrangler d1 execute smartkids --remote --file="${sqlPath}"`);
}

await main();
