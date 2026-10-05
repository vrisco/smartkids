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
 *     docs/              -> OPCIONAL: documentos de estudio («Apuntes») del curso
 *       NN-<slug>.<tipo>.json -> { id?, module?, position?, childAnswers?, doc: StudyDoc }
 *                              (<tipo> = doc.kind; `module` = fichero del módulo al que pertenece)
 *
 * Uso (desde la raíz del monorepo):
 *   pnpm --filter @smartkids/content-gen run build:course -- --course content/math-eso2-operaciones
 *
 * Publicar el .sql resultante:
 *   pnpm --filter @smartkids/api exec wrangler d1 execute smartkids --local  --file="tools/content-gen/out/<courseId>.sql"
 *   pnpm --filter @smartkids/api exec wrangler d1 execute smartkids --remote --file="tools/content-gen/out/<courseId>.sql"
 */
import { z } from "zod";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  CHILD_ANSWERS_DEFAULT,
  ExerciseSchema,
  StudyDocSchema,
  canonicalStudyDocJson,
  lintStudyDoc,
  studyDocBytes,
  studyDocStats,
  toStoredPayload,
  validateExercise,
  validateStudyDoc,
  type Exercise,
  type StudyDoc,
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

/** Documento de estudio del curso: `content/<curso>/docs/NN-<slug>.<tipo>.json`. */
const CourseDocFileSchema = z.object({
  /** Por defecto `doc_<courseId>_<nombre del fichero>`. */
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$/).optional(),
  /** Fichero del módulo al que pertenece («03-division-entera.json»); sin él, es del curso entero. */
  module: z.string().optional(),
  position: z.number().int().min(0).optional(),
  childAnswers: z.boolean().optional(),
  doc: z.unknown(),
});
const DOC_FILE_RE = /^(\d{2})-[a-z0-9-]+\.([a-z_]+)\.json$/;
/** D1 rechaza sentencias de más de 100 KB. */
const MAX_STATEMENT_BYTES = 100_000;

interface BuiltDoc {
  id: string;
  doc: StudyDoc;
  skillId: string | null;
  moduleIndex: number | null;
  position: number;
  childAnswers: boolean;
  hash: string;
}

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

  const docs = loadDocs(courseDir, course, built);
  // Con la carpeta docs/ (aunque esté vacía) se retiran los documentos del curso que ya no están en ella.
  const sql = buildSql(course, built, docs, existsSync(join(courseDir, "docs")));
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

/** Carga y valida los documentos de estudio de `docs/` (si existe). Un documento inválido aborta sin SQL. */
function loadDocs(courseDir: string, course: Course, mods: BuiltModule[]): BuiltDoc[] {
  const dir = join(courseDir, "docs");
  if (!existsSync(dir)) return [];
  const out: BuiltDoc[] = [];
  const ids = new Set<string>();
  let bad = 0;
  const moduleFiles = course.modules.map((m) => m.file);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const m = DOC_FILE_RE.exec(file);
    if (!m) {
      bad++;
      console.log(`  x [docs/${file}] el nombre debe ser NN-<slug>.<tipo>.json`);
      continue;
    }
    const f = CourseDocFileSchema.safeParse(JSON.parse(readFileSync(join(dir, file), "utf8")));
    if (!f.success) {
      bad++;
      console.log(`  x [docs/${file}] ${f.error.issues[0]?.message} (${f.error.issues[0]?.path.join(".")})`);
      continue;
    }
    const p = StudyDocSchema.safeParse(f.data.doc);
    if (!p.success) {
      bad++;
      console.log(`  x [docs/${file}] ${p.error.issues[0]?.message} (doc.${p.error.issues[0]?.path.join(".")})`);
      continue;
    }
    const doc = p.data;
    if (doc.kind !== m[2]) {
      bad++;
      console.log(`  x [docs/${file}] el tipo del nombre (${m[2]}) no coincide con doc.kind (${doc.kind})`);
      continue;
    }
    const v = validateStudyDoc(doc);
    if (!v.ok) {
      bad++;
      console.log(`  x [docs/${file}] ${v.reason}`);
      continue;
    }
    let skillId: string | null = null;
    let moduleIndex: number | null = null;
    if (f.data.module) {
      const mi = moduleFiles.indexOf(f.data.module);
      if (mi < 0) {
        bad++;
        console.log(`  x [docs/${file}] module "${f.data.module}" no está en course.json`);
        continue;
      }
      skillId = mods[mi]!.skillId;
      moduleIndex = mi;
    }
    const id = f.data.id ?? `doc_${course.courseId}_${file.replace(/\.json$/, "")}`;
    if (ids.has(id)) {
      bad++;
      console.log(`  x [docs/${file}] id repetido: ${id}`);
      continue;
    }
    ids.add(id);
    for (const w of lintStudyDoc(doc)) console.log(`  ! [docs/${file}] ${w}`);
    out.push({
      id,
      doc,
      skillId,
      moduleIndex,
      position: f.data.position ?? Number(m[1]),
      childAnswers: f.data.childAnswers ?? CHILD_ANSWERS_DEFAULT[doc.kind],
      hash: createHash("sha256").update(canonicalStudyDocJson(doc)).digest("hex"),
    });
    console.log(`  docs/${file}: ok (${doc.kind}, ${studyDocBytes(doc)} bytes)`);
  }
  if (bad > 0) {
    console.error(`Hay ${bad} documento(s) inválido(s); corrígelos antes de publicar. No se escribe SQL.`);
    process.exit(1);
  }
  return out;
}

/* ---------- Emisión de SQL (idempotente, acotado a los ids del curso) ---------- */

function buildSql(course: Course, mods: BuiltModule[], docs: BuiltDoc[], docsDir: boolean): string {
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

  // Paquetes + plantillas: UPSERT por id, NUNCA delete+insert.
  // `attempts` y `coin_awards` referencian exercise_templates con clave ajena sin ON DELETE,
  // así que borrar las plantillas hacía fallar la republicación en cuanto un niño había
  // respondido un solo ejercicio: evolucionar el contenido era imposible en producción.
  for (const m of mods) {
    L.push(
      `INSERT INTO content_packages (id, subject_id, grade_band, version, status, owner_id, created_at) VALUES (` +
        `${sqlStr(m.packageId)}, ${sqlStr(course.subjectId)}, ${sqlStr(course.gradeBand)}, ${sqlStr(course.version)}, 'published', NULL, ${sqlStr(createdAt)}) ` +
        `ON CONFLICT(id) DO UPDATE SET subject_id=excluded.subject_id, grade_band=excluded.grade_band, ` +
        `version=excluded.version, status='published', owner_id=NULL;`,
    );
    // Se retira TODO el paquete ANTES de los upserts; cada INSERT ... ON CONFLICT reactiva
    // (retired=0) lo que sí viene en el lote. Evita un NOT IN con la lista completa de ids.
    L.push(`UPDATE exercise_templates SET retired=1 WHERE package_id=${sqlStr(m.packageId)};`);
    m.exercises.forEach((ex, idx) => {
      const id = `${m.packageId}_${idx + 1}`;
      const payload = JSON.stringify(toStoredPayload(ex));
      // El id es POSICIONAL, así que reeditar un ejercicio reutiliza el id y `coin_awards` seguiría
      // diciendo "ya cobrado": el niño resolvería contenido NUEVO por cero monedas. Si el contenido
      // cambia, se borra el registro de cobro. (Si el JSON difiere solo en formato, el efecto es que
      // se puede volver a cobrar: preferimos ese error al de trabajar gratis.)
      // Por lo mismo, los avisos de «pregunta mal» (exercise_reports) hablaban de la versión anterior.
      for (const tabla of ["coin_awards", "exercise_reports"]) {
        L.push(
          `DELETE FROM ${tabla} WHERE exercise_template_id=${sqlStr(id)} AND EXISTS (` +
            `SELECT 1 FROM exercise_templates t WHERE t.id=${sqlStr(id)} ` +
            `AND (t.stem<>${sqlStr(ex.stem)} OR t.payload<>${sqlStr(payload)}));`,
        );
      }
      // `hidden` queda FUERA del SET a propósito: es curación manual del tutor.
      L.push(
        `INSERT INTO exercise_templates (id, package_id, skill_id, type, language, content_version, stem, payload, difficulty_numeric, difficulty_level, retired) VALUES (` +
          `${sqlStr(id)}, ${sqlStr(m.packageId)}, ${sqlStr(m.skillId)}, ${sqlStr(ex.type)}, ${sqlStr(course.language)}, ${sqlStr(course.version)}, ` +
          `${sqlStr(ex.stem)}, ${sqlStr(payload)}, ${ex.difficulty.numeric}, ${sqlStr(ex.difficulty.level)}, 0) ` +
          `ON CONFLICT(id) DO UPDATE SET package_id=excluded.package_id, skill_id=excluded.skill_id, type=excluded.type, ` +
          `language=excluded.language, content_version=excluded.content_version, stem=excluded.stem, payload=excluded.payload, ` +
          `difficulty_numeric=excluded.difficulty_numeric, difficulty_level=excluded.difficulty_level, retired=0;`,
      );
    });
  }

  // Documentos de estudio del curso: GLOBALES (owner_id NULL), los ve el niño con un curso de esta
  // asignatura+nivel. Se retiran todos los del curso y cada UPSERT reactiva el suyo (lo que ya no está en
  // docs/ queda retirado). La versión solo sube si cambia el contenido; `child_answers` y `hidden` quedan
  // fuera del SET, y el WHERE impide convertir en global un documento PRIVADO que comparta id.
  if (docsDir) {
    L.push(`UPDATE study_docs SET retired=1 WHERE course_id=${sqlStr(course.courseId)} AND owner_id IS NULL;`);
    for (const d of docs) {
      const stmt =
        `INSERT INTO study_docs (id, kind, owner_id, subject_id, grade_band, title, language, body, stats, bytes, version, content_hash, ` +
        `skill_id, path_id, course_id, module_index, position, request_id, child_answers, hidden, retired, created_at, updated_at) VALUES (` +
        `${sqlStr(d.id)}, ${sqlStr(d.doc.kind)}, NULL, ${sqlStr(course.subjectId)}, ${sqlStr(course.gradeBand)}, ${sqlStr(d.doc.title)}, ` +
        `${sqlStr(d.doc.language)}, ${sqlStr(JSON.stringify(d.doc))}, ${sqlStr(JSON.stringify(studyDocStats(d.doc)))}, ${studyDocBytes(d.doc)}, 1, ` +
        `${sqlStr(d.hash)}, ${sqlVal(d.skillId)}, NULL, ${sqlStr(course.courseId)}, ${d.moduleIndex === null ? "NULL" : d.moduleIndex}, ${d.position}, ` +
        `NULL, ${d.childAnswers ? 1 : 0}, 0, 0, ${sqlStr(createdAt)}, ${sqlStr(createdAt)}) ` +
        `ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, subject_id=excluded.subject_id, grade_band=excluded.grade_band, ` +
        `title=excluded.title, language=excluded.language, body=excluded.body, stats=excluded.stats, bytes=excluded.bytes, ` +
        `skill_id=excluded.skill_id, course_id=excluded.course_id, module_index=excluded.module_index, position=excluded.position, retired=0, ` +
        `version=CASE WHEN study_docs.content_hash<>excluded.content_hash THEN study_docs.version+1 ELSE study_docs.version END, ` +
        `updated_at=CASE WHEN study_docs.content_hash<>excluded.content_hash THEN excluded.updated_at ELSE study_docs.updated_at END, ` +
        `content_hash=excluded.content_hash WHERE study_docs.owner_id IS NULL;`;
      const bytes = Buffer.byteLength(stmt, "utf8");
      if (bytes > MAX_STATEMENT_BYTES) {
        console.error(`El documento ${d.id} genera una sentencia de ${bytes} bytes (D1 admite ${MAX_STATEMENT_BYTES}). Divídelo.`);
        process.exit(1);
      }
      L.push(stmt);
    }
  }

  return L.join("\n") + "\n";
}

main();
