/**
 * Builder de CURSOS FIJOS (versionados en el repo).
 *
 * A diferencia de generate.ts (que genera contenido nuevo con Claude/mock), este
 * script NO genera nada: toma un curso ya redactado a mano en `content/<curso>/`
 * (la fuente de verdad, editable para evolucionarlo), valida CADA ejercicio con el
 * modelo unificado (`ExerciseSchema` + `validateExercise`) y emite UN `.sql`
 * idempotente que crea/actualiza: subject + curso + skills (con su cadena de
 * prerequisitos) + paquetes + plantillas. Re-ejecutable sin duplicar.
 *
 * Estructura esperada de un curso:
 *   content/<curso>/
 *     course.json        -> metadatos + lista ORDENADA de módulos (ver CourseSchema)
 *     01-....json        -> { skill: {...}, exercises: [ ...Exercise sin campos de contexto... ] }
 *     02-....json
 *     ...
 *
 * Uso (desde la raíz del monorepo):
 *   pnpm --filter @smartkids/content-gen run build:course -- --course content/math-eso2-operaciones
 *
 * Publicar el .sql resultante:
 *   pnpm --filter @smartkids/api exec wrangler d1 execute smartkids --local  --file="tools/content-gen/out/<courseId>.sql"
 *   pnpm --filter @smartkids/api exec wrangler d1 execute smartkids --remote --file="tools/content-gen/out/<courseId>.sql"
 */
import { z } from "zod";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  ExerciseSchema,
  toStoredPayload,
  validateExercise,
  type Exercise,
} from "@smartkids/shared";

/* ---------- Esquemas de los ficheros de curso ---------- */

const LocaleTextSpec = z.record(z.string(), z.string());

const CourseSchema = z.object({
  subjectId: z.string(),
  subjectName: LocaleTextSpec.optional(), // se crea el subject si no existe
  gradeBand: z.string(),
  courseId: z.string(),
  courseName: LocaleTextSpec,
  language: z.string().default("es"),
  version: z.string().default("1.0.0"),
  modules: z.array(z.object({ file: z.string() })).min(1),
});
type Course = z.infer<typeof CourseSchema>;

const ModuleSchema = z.object({
  skill: z.object({
    id: z.string(),
    name: LocaleTextSpec,
    difficultyBase: z.number().min(0).max(1).default(0.4),
    coinsPerCorrect: z.number().int().positive().nullable().optional(),
  }),
  // Los ejercicios NO llevan los campos de contexto (exerciseId, packageId, skillId,
  // language): los inyecta este builder. Sí llevan type + stem + difficulty + feedback
  // + los campos específicos de su tipo.
  exercises: z.array(z.record(z.string(), z.unknown())).min(1),
});

/* ---------- SQL helpers ---------- */

function sqlStr(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}
function sqlVal(s: string | null | undefined): string {
  return s === null || s === undefined ? "NULL" : sqlStr(s);
}
function packageIdFor(skillId: string): string {
  return "pkg_" + skillId.toLowerCase().replace(/[^a-z0-9]+/g, "_") + "_v1";
}

/* ---------- Carga + validación ---------- */

interface BuiltModule {
  skillId: string;
  name: Record<string, string>;
  difficultyBase: number;
  coinsPerCorrect: number | null;
  position: number;
  packageId: string;
  exercises: Exercise[];
}

function loadArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function main(): void {
  const courseArg = loadArg("--course");
  if (!courseArg) {
    console.error("Falta --course <ruta a la carpeta del curso>");
    process.exit(1);
  }
  // Resuelve la carpeta del curso: absoluta, relativa al cwd, o relativa a la raíz del
  // monorepo (pnpm --filter fija el cwd en tools/content-gen, dos niveles por debajo).
  const candidates = isAbsolute(courseArg)
    ? [courseArg]
    : [resolve(process.cwd(), courseArg), resolve(process.cwd(), "..", "..", courseArg)];
  const courseDir = candidates.find((c) => existsSync(join(c, "course.json"))) ?? candidates[0]!;
  const course: Course = CourseSchema.parse(
    JSON.parse(readFileSync(join(courseDir, "course.json"), "utf8")),
  );

  console.log(`smartkids · build:course — ${course.courseId} (${course.modules.length} módulos)`);

  const built: BuiltModule[] = [];
  let totalOk = 0;
  let totalBad = 0;

  course.modules.forEach((mod, mi) => {
    const raw = JSON.parse(readFileSync(join(courseDir, mod.file), "utf8"));
    const parsed = ModuleSchema.parse(raw);
    const skillId = parsed.skill.id;
    const packageId = packageIdFor(skillId);
    const valid: Exercise[] = [];
    const seen = new Set<string>();

    parsed.exercises.forEach((item, ei) => {
      const merged = {
        ...item,
        exerciseId: `${packageId}_${ei + 1}`,
        packageId,
        skillId,
        language: course.language,
        schemaVersion: "1.0.0",
      };
      const p = ExerciseSchema.safeParse(merged);
      if (!p.success) {
        totalBad += 1;
        console.log(`  x [${mod.file} #${ei + 1}] estructura: ${p.error.issues[0]?.message ?? "?"} (${p.error.issues[0]?.path.join(".")})`);
        return;
      }
      const ex = p.data;
      const key = `${ex.type}:${ex.stem.replace(/\s+/g, "")}`;
      if (seen.has(key)) {
        totalBad += 1;
        console.log(`  x [${mod.file} #${ei + 1}] duplicado: "${ex.stem}"`);
        return;
      }
      const v = validateExercise(ex);
      if (!v.ok) {
        totalBad += 1;
        console.log(`  x [${mod.file} #${ei + 1}] "${ex.stem.slice(0, 40)}" — ${v.reason}`);
        return;
      }
      seen.add(key);
      valid.push(ex);
    });

    totalOk += valid.length;
    console.log(`  ${mod.file}: ${valid.length} ok (skill ${skillId})`);
    built.push({
      skillId,
      name: parsed.skill.name,
      difficultyBase: parsed.skill.difficultyBase,
      coinsPerCorrect: parsed.skill.coinsPerCorrect ?? null,
      position: mi + 1,
      packageId,
      exercises: valid,
    });
  });

  console.log(`\nTotal: ${totalOk} válidos · ${totalBad} rechazados`);
  if (totalBad > 0) {
    console.error("Hay ejercicios inválidos; corrígelos antes de publicar. No se escribe SQL.");
    process.exit(1);
  }

  const sql = buildSql(course, built);
  const outDir = join(process.cwd(), "out");
  mkdirSync(outDir, { recursive: true });
  const sqlPath = join(outDir, `${course.courseId}.sql`);
  writeFileSync(sqlPath, sql);

  console.log(`\nSQL escrito:\n  ${sqlPath}`);
  console.log(`\nPublicar en la D1 local:`);
  console.log(`  pnpm --filter @smartkids/api exec wrangler d1 execute smartkids --local --file="${sqlPath}"`);
  console.log(`Publicar en PRODUCCIÓN (datos reales):`);
  console.log(`  pnpm --filter @smartkids/api exec wrangler d1 execute smartkids --remote --file="${sqlPath}"`);
}

/* ---------- Emisión de SQL (idempotente, acotado a los ids del curso) ---------- */

function buildSql(course: Course, mods: BuiltModule[]): string {
  const createdAt = new Date().toISOString();
  const L: string[] = [];
  L.push(`-- Curso fijo: ${course.courseId} · ${mods.length} módulos · ${mods.reduce((n, m) => n + m.exercises.length, 0)} ejercicios`);
  L.push(`-- Generado por build:course. NO editar a mano: edita content/ y re-ejecuta.`);

  // Subject (crea o actualiza el nombre).
  if (course.subjectName) {
    L.push(
      `INSERT INTO subjects (id, name_i18n) VALUES (${sqlStr(course.subjectId)}, ${sqlStr(JSON.stringify(course.subjectName))}) ` +
        `ON CONFLICT(id) DO UPDATE SET name_i18n=excluded.name_i18n;`,
    );
  }

  // Curso (crea o actualiza; NO toca las asignaciones child_courses existentes).
  L.push(
    `INSERT INTO courses (id, subject_id, grade_band, name_i18n) VALUES (` +
      `${sqlStr(course.courseId)}, ${sqlStr(course.subjectId)}, ${sqlStr(course.gradeBand)}, ${sqlStr(JSON.stringify(course.courseName))}) ` +
      `ON CONFLICT(id) DO UPDATE SET subject_id=excluded.subject_id, grade_band=excluded.grade_band, name_i18n=excluded.name_i18n;`,
  );

  const skillIds = mods.map((m) => sqlStr(m.skillId)).join(", ");

  // Limpia los prerequisitos previos de ESTE curso (se reconstruyen abajo).
  L.push(`DELETE FROM skill_prerequisites WHERE skill_id IN (${skillIds});`);

  // Skills (crea o actualiza). owner_id NULL = catálogo global.
  for (const m of mods) {
    L.push(
      `INSERT INTO skills (id, subject_id, grade_band, name_i18n, difficulty_base, position, owner_id, coins_per_correct, module_index) VALUES (` +
        `${sqlStr(m.skillId)}, ${sqlStr(course.subjectId)}, ${sqlStr(course.gradeBand)}, ${sqlStr(JSON.stringify(m.name))}, ` +
        `${m.difficultyBase}, ${m.position}, NULL, ${m.coinsPerCorrect === null ? "NULL" : m.coinsPerCorrect}, 0) ` +
        `ON CONFLICT(id) DO UPDATE SET subject_id=excluded.subject_id, grade_band=excluded.grade_band, name_i18n=excluded.name_i18n, ` +
        `difficulty_base=excluded.difficulty_base, position=excluded.position, owner_id=NULL, coins_per_correct=excluded.coins_per_correct;`,
    );
  }

  // Cadena de prerequisitos: cada módulo requiere el anterior (desbloqueo progresivo).
  for (let i = 1; i < mods.length; i++) {
    L.push(
      `INSERT OR IGNORE INTO skill_prerequisites (skill_id, prerequisite_id) VALUES (${sqlStr(mods[i]!.skillId)}, ${sqlStr(mods[i - 1]!.skillId)});`,
    );
  }

  // Paquetes + plantillas: se reemplazan por completo (permite evolucionar el contenido).
  for (const m of mods) {
    L.push(`DELETE FROM exercise_templates WHERE package_id=${sqlStr(m.packageId)};`);
    L.push(`DELETE FROM content_packages WHERE id=${sqlStr(m.packageId)};`);
    L.push(
      `INSERT INTO content_packages (id, subject_id, grade_band, version, status, owner_id, created_at) VALUES (` +
        `${sqlStr(m.packageId)}, ${sqlStr(course.subjectId)}, ${sqlStr(course.gradeBand)}, ${sqlStr(course.version)}, 'published', NULL, ${sqlStr(createdAt)});`,
    );
    m.exercises.forEach((ex, idx) => {
      const id = `${m.packageId}_${idx + 1}`;
      const payload = JSON.stringify(toStoredPayload(ex));
      L.push(
        `INSERT INTO exercise_templates (id, package_id, skill_id, type, language, content_version, stem, payload, difficulty_numeric, difficulty_level) VALUES (` +
          `${sqlStr(id)}, ${sqlStr(m.packageId)}, ${sqlStr(m.skillId)}, ${sqlStr(ex.type)}, ${sqlStr(course.language)}, ${sqlStr(course.version)}, ` +
          `${sqlStr(ex.stem)}, ${sqlStr(payload)}, ${ex.difficulty.numeric}, ${sqlStr(ex.difficulty.level)});`,
      );
    });
  }

  return L.join("\n") + "\n";
}

main();
