import { Hono } from "hono";
import type { Context } from "hono";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { getDb, schema } from "./db";
import {
  clearAttempts,
  consumeAuthToken,
  createAuthToken,
  createChildSession,
  createSession,
  currentChildId,
  currentParentId,
  destroyChildSession,
  destroySession,
  hashSecret,
  ownsProfile,
  rateLimited,
  recordAttempt,
  setChildCookie,
  setSessionCookie,
  verifySecret,
} from "./auth";
import { devLinksEnabled, emailLayout, sendEmail } from "./email";
import { sendPush } from "./webpush";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import {
  AnswerSchema,
  ExerciseSchema,
  ExerciseTypeSchema,
  canonicalAnswer,
  exerciseFromRow,
  grade,
  redactForClient,
  shuffleRender,
  toStoredPayload,
  validateExercise,
  type Exercise,
} from "@smartkids/shared";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  UPLOADS?: R2Bucket;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_DEV_LINKS?: string;
  CONTENT_IMPORT_TOKEN?: string; // token de máquina para el import de contenido (pipeline/skill)
  VAPID_PUBLIC?: string; // clave pública VAPID (base64url, para el cliente)
  VAPID_PRIVATE_JWK?: string; // clave privada VAPID como JWK (SECRETO)
  VAPID_SUBJECT?: string; // sub del JWT VAPID (URL o mailto:)
  WEBAUTHN_ORIGINS?: string; // orígenes válidos para passkeys, separados por comas (dev: http://localhost:5173)
}

const {
  subjects,
  skills,
  skillProgress,
  exerciseTemplates,
  contentPackages,
  parentAccounts,
  childProfiles,
  wallets,
  walletLedger,
  attempts,
  rewards,
  redemptions,
  courses,
  childCourses,
  childRewards,
  childSkills,
  contentRequests,
  contentRequestAssets,
  coinAwards,
  exerciseReports,
  pushSubscriptions,
  webauthnCredentials,
  webauthnFlows,
} = schema;

const COINS_PER_CORRECT = 10;
const POLICY_VERSION = "2026-08-provisional"; // versión del aviso de privacidad aceptada al dar de alta un niño (RGPD)
const GOAL_PERIODS = ["week", "month", "quarter", "semester", "year"]; // ventanas rodantes de objetivo
const VERIFY_TTL = 24 * 60 * 60 * 1000;
const RESET_TTL = 60 * 60 * 1000;
const INVITE_TTL = 7 * 24 * 60 * 60 * 1000; // invitación de tutor: 7 días
const ADMIN_RESET_TTL = 24 * 60 * 60 * 1000; // reset iniciado por admin: 24 h
const USERNAME_RE = /^[a-z0-9._-]{3,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = Context<{ Bindings: Env }>;
type DB = ReturnType<typeof getDb>;

const app = new Hono<{ Bindings: Env }>();

/**
 * Cabeceras comunes de la API. OJO: aquí NO hay middleware de autorización a propósito;
 * cada handler llama a su guard a mano (ver apps/api/CLAUDE.md). Este `use` solo pone
 * cabeceras, así que añadirlo no cambia quién puede entrar a dónde.
 */
app.use("/api/*", async (c, next) => {
  await next();
  // Las respuestas de la API no se cachean nunca, ni en el navegador ni en el service worker.
  c.header("Cache-Control", "no-store");
});

/**
 * Manejo central de errores. Antes no había ninguno: un cuerpo JSON malformado o un fallo
 * de D1 salían como un 500 mudo, sin rastro y sin forma de correlacionar la queja de un
 * tutor con nada. El `cf-ray` identifica la petición en los logs de Cloudflare, así que no
 * inventamos otro identificador.
 */
app.onError((err, c) => {
  const requestId = c.req.header("cf-ray") ?? crypto.randomUUID();
  // Cuerpo ilegible: es culpa del cliente, no un fallo del servidor.
  if (err instanceof SyntaxError) {
    return c.json({ error: "invalid_body", message: "El cuerpo de la petición no es JSON válido.", requestId }, 400);
  }
  console.error(`[${requestId}] ${c.req.method} ${new URL(c.req.url).pathname}`, err);
  // El mensaje del error NUNCA se devuelve al cliente: puede llevar SQL, rutas internas
  // o datos de otro usuario. El detalle vive en el log, referenciado por requestId.
  return c.json({ error: "internal", message: "Algo ha fallado por nuestra parte. Inténtalo de nuevo.", requestId }, 500);
});

app.get("/api/health", (c) => c.json({ ok: true, service: "smartkids-api", ts: new Date().toISOString() }));

/* ================= Helpers de autorización ================= */

async function requireParent(c: Ctx, db: DB): Promise<string | Response> {
  const parentId = await currentParentId(c, db);
  if (!parentId) return c.json({ error: "unauthorized" }, 401);
  return parentId;
}

async function requireAdmin(c: Ctx, db: DB): Promise<string | Response> {
  const parentId = await currentParentId(c, db);
  if (!parentId) return c.json({ error: "unauthorized" }, 401);
  const [p] = await db.select({ role: parentAccounts.role }).from(parentAccounts).where(eq(parentAccounts.id, parentId)).limit(1);
  if (!p || p.role !== "admin") return c.json({ error: "forbidden" }, 403);
  return parentId;
}

/** Autoriza el acceso a un perfil de niño: el propio niño (su sesión) o el tutor dueño. */
async function childOrOwner(c: Ctx, db: DB, childId: string): Promise<string | Response> {
  const kid = await currentChildId(c, db);
  const parentId = await currentParentId(c, db);
  if (!kid && !parentId) return c.json({ error: "unauthorized" }, 401);
  if (kid && kid === childId) return childId;
  if (parentId && (await ownsProfile(db, parentId, childId))) return childId;
  return c.json({ error: "forbidden" }, 403);
}

async function hasCourse(db: DB, childId: string, courseId: string): Promise<boolean> {
  const [row] = await db
    .select({ c: childCourses.courseId })
    .from(childCourses)
    .where(and(eq(childCourses.childId, childId), eq(childCourses.courseId, courseId)))
    .limit(1);
  return Boolean(row);
}

function childCoursesOf(db: DB, childId: string) {
  return db
    .select({ id: courses.id, subjectId: courses.subjectId, gradeBand: courses.gradeBand, nameI18n: courses.nameI18n })
    .from(childCourses)
    .innerJoin(courses, eq(courses.id, childCourses.courseId))
    .where(eq(childCourses.childId, childId));
}

/** ¿El niño puede practicar este skill? Debe tener un curso cuya asignatura+nivel coincida con la del skill. */
async function childCanAttemptSkill(db: DB, childId: string, skillId: string): Promise<boolean> {
  const [sk] = await db
    .select({ subjectId: skills.subjectId, gradeBand: skills.gradeBand, ownerId: skills.ownerId })
    .from(skills)
    .where(eq(skills.id, skillId))
    .limit(1);
  if (!sk) return false;
  if (sk.ownerId) {
    // Skill PRIVADO: el dueño debe estar en el hogar del niño Y el niño tenerlo asignado.
    const [child] = await db.select({ parentId: childProfiles.parentId }).from(childProfiles).where(eq(childProfiles.id, childId)).limit(1);
    if (!child) return false;
    const household = await householdIds(db, child.parentId);
    if (!household.includes(sk.ownerId)) return false;
    const [grant] = await db
      .select({ s: childSkills.skillId })
      .from(childSkills)
      .where(and(eq(childSkills.childId, childId), eq(childSkills.skillId, skillId)))
      .limit(1);
    return Boolean(grant);
  }
  // Skill GLOBAL: acceso por curso (asignatura+nivel).
  const [row] = await db
    .select({ c: childCourses.courseId })
    .from(childCourses)
    .innerJoin(courses, eq(courses.id, childCourses.courseId))
    .where(and(eq(childCourses.childId, childId), eq(courses.subjectId, sk.subjectId), eq(courses.gradeBand, sk.gradeBand)))
    .limit(1);
  return Boolean(row);
}

/** Borra un niño y todo lo suyo (cursos, sesión, progreso, monedero, intentos, canjes). */
async function deleteChildCascade(db: DB, childId: string): Promise<void> {
  await db.delete(childCourses).where(eq(childCourses.childId, childId));
  await db.delete(childRewards).where(eq(childRewards.childId, childId));
  await db.delete(schema.childSessions).where(eq(schema.childSessions.childId, childId));
  await db.delete(redemptions).where(eq(redemptions.profileId, childId));
  await db.delete(walletLedger).where(eq(walletLedger.profileId, childId));
  await db.delete(wallets).where(eq(wallets.profileId, childId));
  await db.delete(attempts).where(eq(attempts.profileId, childId));
  await db.delete(skillProgress).where(eq(skillProgress.profileId, childId));
  // Estas también referencian al niño (FK sin ON DELETE): sin vaciarlas, el borrado del niño falla.
  await db.delete(coinAwards).where(eq(coinAwards.profileId, childId));
  await db.delete(exerciseReports).where(eq(exerciseReports.profileId, childId));
  await db.delete(childSkills).where(eq(childSkills.childId, childId));
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.ownerId, childId));
  await db.update(contentRequests).set({ childId: null }).where(eq(contentRequests.childId, childId));
  await db.delete(childProfiles).where(eq(childProfiles.id, childId));
}

/** Borra un skill PRIVADO con su paquete, plantillas y todo lo que las referencia. */
async function deletePrivateSkillCascade(db: DB, skillId: string, household: string[]): Promise<void> {
  const pkgRows = await db.selectDistinct({ pkg: exerciseTemplates.packageId }).from(exerciseTemplates).where(eq(exerciseTemplates.skillId, skillId));
  // Sin ON DELETE cascade: hay que respetar el orden de las FKs (coin_awards antes que las plantillas).
  await db.delete(attempts).where(eq(attempts.skillId, skillId));
  await db.delete(skillProgress).where(eq(skillProgress.skillId, skillId));
  await db.delete(childSkills).where(eq(childSkills.skillId, skillId));
  // Subconsulta, NO una lista de ids: con bancos grandes (y las plantillas retiradas que se acumulan
  // al republicar) la lista superaba el límite de variables ligadas de D1 y el borrado daba 500.
  const plantillasDelSkill = db.select({ id: exerciseTemplates.id }).from(exerciseTemplates).where(eq(exerciseTemplates.skillId, skillId));
  await db.delete(coinAwards).where(inArray(coinAwards.exerciseTemplateId, plantillasDelSkill));
  await db.delete(exerciseReports).where(inArray(exerciseReports.exerciseTemplateId, plantillasDelSkill));
  await db.delete(exerciseTemplates).where(eq(exerciseTemplates.skillId, skillId));
  await db.update(contentRequests).set({ skillId: null, packageId: null }).where(eq(contentRequests.skillId, skillId));
  for (const { pkg } of pkgRows) {
    const [rem] = await db.select({ n: sql<number>`count(*)` }).from(exerciseTemplates).where(eq(exerciseTemplates.packageId, pkg));
    if ((rem?.n ?? 0) === 0) await db.delete(contentPackages).where(and(eq(contentPackages.id, pkg), inArray(contentPackages.ownerId, household)));
  }
  await db.delete(skills).where(eq(skills.id, skillId));
}

/** Borra una solicitud de contenido, sus metadatos de fichero y los objetos en R2 que ya nadie usa
 *  (una copia regenerada comparte los objetos de su original). */
async function deleteContentRequestCascade(env: Env, db: DB, reqId: string): Promise<void> {
  const assets = await db.select({ r2Key: contentRequestAssets.r2Key }).from(contentRequestAssets).where(eq(contentRequestAssets.requestId, reqId));
  await db.delete(contentRequestAssets).where(eq(contentRequestAssets.requestId, reqId));
  await db.delete(contentRequests).where(eq(contentRequests.id, reqId));
  for (const key of new Set(assets.map((as) => as.r2Key))) await deleteR2IfUnreferenced(env, db, key);
}

/** Borra una recompensa y sus asignaciones (child_rewards) y canjes (redemptions). */
async function deleteRewardCascade(db: DB, rewardId: string): Promise<void> {
  await db.delete(childRewards).where(eq(childRewards.rewardId, rewardId));
  await db.delete(redemptions).where(eq(redemptions.rewardId, rewardId));
  await db.delete(rewards).where(eq(rewards.id, rewardId));
}

/** IDs del "hogar": el propio tutor y su cónyuge, SOLO si el vínculo es simétrico (igual que ownsProfile). */
async function householdIds(db: DB, parentId: string): Promise<string[]> {
  const [p] = await db.select({ spouseId: parentAccounts.spouseId }).from(parentAccounts).where(eq(parentAccounts.id, parentId)).limit(1);
  if (!p?.spouseId) return [parentId];
  const [s] = await db.select({ spouseId: parentAccounts.spouseId }).from(parentAccounts).where(eq(parentAccounts.id, p.spouseId)).limit(1);
  return s?.spouseId === parentId ? [parentId, p.spouseId] : [parentId];
}

/** Acota un valor a un entero en [lo, hi], con defecto si no es número. */
function clampInt(v: unknown, lo: number, hi: number, def: number): number {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
}

/* ---------- Curso escolar del niño (LOMLOE) ---------- */

/** Códigos de curso escolar: Primaria 1-6, ESO 1-4, Bachillerato 1-2 (mismo formato que courses.grade_band).
 *  Un valor fuera de la lista (p. ej. el "ESO-5" que se fijaba antes a todos) cuenta como "sin definir". */
const GRADE_BAND_RE = /^(PRI-[1-6]|ESO-[1-4]|BACH-[12])$/;
function parseGradeBand(v: unknown): string | null {
  const g = String(v ?? "").trim().toUpperCase();
  return GRADE_BAND_RE.test(g) ? g : null;
}

/** Compañeros (mascotas) válidos del niño. Misma lista que MASCOT_KEYS en apps/web/src/components/Mascot.tsx. */
const MASCOTS = new Set(["orbi", "redpanda", "fox", "cat", "bunny", "panda", "penguin"]);
function parseMascot(v: unknown): string | null {
  const m = String(v ?? "").trim();
  return MASCOTS.has(m) ? m : null;
}

/** Curso escolar válido de un niño (o null si no está definido). */
async function childGradeBand(db: DB, childId: string | null): Promise<string | null> {
  if (!childId) return null;
  const [ch] = await db.select({ gradeBand: childProfiles.gradeBand }).from(childProfiles).where(eq(childProfiles.id, childId)).limit(1);
  return parseGradeBand(ch?.gradeBand);
}

/* ---------- Config de generación de contenido (Vía B) ---------- */

/** Preguntas que puede pedir el tutor. Se GENERAN un 50 % más (GENERATION_EXTRA) para que cada
 *  tanda del curso salga distinta: el banco es mayor que lo que el niño ve en una pasada. */
const REQ_MAX_QUESTIONS = 200;
const GENERATION_EXTRA = 1.5;
/** Preguntas por misión (sesión del niño). null en el skill = SESSION_LENGTH_DEFAULT. */
const SESSION_LENGTH_DEFAULT = 5;
const SESSION_LENGTH_MIN = 3;
const SESSION_LENGTH_MAX = 30;
const EXERCISE_TYPES: readonly string[] = ExerciseTypeSchema.options;

/** Lista de tipos de ejercicio pedidos ("a,b,c" o campo repetido). Vacía o inválida = null (= variados). */
function parseQuestionTypes(v: unknown): string[] | null {
  const raw = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x ?? "").split(","));
  const out = [...new Set(raw.map((x) => x.trim()).filter((x) => EXERCISE_TYPES.includes(x)))];
  return out.length > 0 ? out : null;
}

/** Ejemplos o guía de ejercicios que da el tutor (texto libre). Sirven de MODELO para parte del banco, no lo limitan. */
const REQ_EXAMPLES_MAX = 4000;
function parseExamples(v: unknown): string {
  return String(v ?? "").trim().slice(0, REQ_EXAMPLES_MAX);
}

/** Nº de ejercicios a GENERAR para una solicitud: lo pedido + el 50 % de variedad. */
function targetExercises(numQuestions: number | null): number {
  return Math.ceil((numQuestions ?? 20) * GENERATION_EXTRA);
}

type RequestRow = typeof contentRequests.$inferSelect;

/** Config de generación del multipart del formulario del tutor; lo que no venga se hereda de `prev`. */
function requestConfigFromForm(form: Record<string, unknown>, prev?: RequestRow) {
  const has = (k: string) => form[k] !== undefined && form[k] !== "";
  return {
    numQuestions: has("numQuestions") ? clampInt(form["numQuestions"], 5, REQ_MAX_QUESTIONS, 20) : (prev?.numQuestions ?? null),
    pointsPerCorrect: has("pointsPerCorrect") ? clampInt(form["pointsPerCorrect"], 1, 50, 10) : (prev?.pointsPerCorrect ?? null),
    modules: has("modules") ? clampInt(form["modules"], 1, 6, 1) : (prev?.modules ?? null),
    sessionLength: has("sessionLength")
      ? clampInt(form["sessionLength"], SESSION_LENGTH_MIN, SESSION_LENGTH_MAX, SESSION_LENGTH_DEFAULT)
      : (prev?.sessionLength ?? null),
    // Presente pero vacío = "variados" (null); ausente = se conserva lo que hubiera.
    questionTypes: form["questionTypes"] !== undefined ? parseQuestionTypes(form["questionTypes"]) : (prev?.questionTypes ?? null),
    examples: form["examples"] !== undefined ? parseExamples(form["examples"]) : (prev?.examples ?? ""),
  };
}

/**
 * Skills PRIVADOS publicados por una solicitud: el que apunta `skill_id` y todos los módulos de su
 * path (por convención `path_<requestId>`, o el path del propio `skill_id`). Es lo que una
 * regeneración EN SITIO debe reutilizar o retirar.
 */
async function requestSkills(db: DB, req: RequestRow) {
  const pathIds = [`path_${req.id}`];
  if (req.skillId) {
    const [sk] = await db.select({ pathId: skills.pathId }).from(skills).where(eq(skills.id, req.skillId)).limit(1);
    if (sk?.pathId) pathIds.push(sk.pathId);
  }
  const household = await householdIds(db, req.ownerId);
  const deLaSolicitud = or(inArray(skills.pathId, pathIds), req.skillId ? eq(skills.id, req.skillId) : undefined);
  const rows = await db
    .select({ id: skills.id, nameI18n: skills.nameI18n, pathId: skills.pathId, pathName: skills.pathName, moduleIndex: skills.moduleIndex, sessionLength: skills.sessionLength })
    .from(skills)
    .where(and(isNotNull(skills.ownerId), inArray(skills.ownerId, household), deLaSolicitud))
    .orderBy(asc(skills.moduleIndex));
  const out: Array<(typeof rows)[number] & { packageIds: string[]; exercises: number }> = [];
  for (const r of rows) {
    const pk = await db
      .select({ pkg: exerciseTemplates.packageId, n: sql<number>`count(*)` })
      .from(exerciseTemplates)
      .where(and(eq(exerciseTemplates.skillId, r.id), eq(exerciseTemplates.retired, false)))
      .groupBy(exerciseTemplates.packageId);
    out.push({ ...r, packageIds: pk.map((p) => p.pkg), exercises: pk.reduce((acc, p) => acc + (p.n ?? 0), 0) });
  }
  return out;
}

/** Borra un objeto de R2 SOLO si ya ninguna fila de fichero lo referencia: las copias de una
 *  solicitud regenerada comparten los objetos del original en vez de duplicarlos. */
async function deleteR2IfUnreferenced(env: Env, db: DB, r2Key: string): Promise<void> {
  if (!env.UPLOADS) return;
  const [ref] = await db.select({ n: sql<number>`count(*)` }).from(contentRequestAssets).where(eq(contentRequestAssets.r2Key, r2Key));
  if ((ref?.n ?? 0) > 0) return;
  try {
    await env.UPLOADS.delete(r2Key);
  } catch {
    /* el objeto pudo no existir; seguimos */
  }
}

/** Año de nacimiento válido (entre hace 100 años y este año) o null. */
function parseBirthYear(v: unknown): number | null {
  const n = parseInt(String(v ?? ""), 10);
  const y = new Date().getUTCFullYear();
  return Number.isFinite(n) && n >= y - 100 && n <= y ? n : null;
}

/** Inicio (ISO) de la ventana rodante: week=7d, month=30d, quarter=90d, semester=180d, year=365d; resto='all' (epoch). */
function periodStartIso(period: string | null | undefined): string {
  const now = Date.now();
  const d = 86400000;
  if (period === "week") return new Date(now - 7 * d).toISOString();
  if (period === "month") return new Date(now - 30 * d).toISOString();
  if (period === "quarter") return new Date(now - 90 * d).toISOString();
  if (period === "semester") return new Date(now - 180 * d).toISOString();
  if (period === "year") return new Date(now - 365 * d).toISOString();
  return new Date(0).toISOString();
}

/** Puntos GANADOS EN EJERCICIOS por el niño desde una fecha (no cuentan reembolsos ni otros ajustes). */
async function earnedSince(db: DB, profileId: string, sinceIso: string): Promise<number> {
  const [row] = await db
    .select({ s: sql<number>`coalesce(sum(${walletLedger.delta}), 0)` })
    .from(walletLedger)
    .where(and(eq(walletLedger.profileId, profileId), gte(walletLedger.ts, sinceIso), like(walletLedger.reason, "exercise:%")));
  return Number(row?.s ?? 0);
}

/** Nº de canjes de una recompensa por el niño desde una fecha. */
async function redemptionsSince(db: DB, profileId: string, rewardId: string, sinceIso: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(redemptions)
    .where(and(eq(redemptions.profileId, profileId), eq(redemptions.rewardId, rewardId), gte(redemptions.ts, sinceIso)));
  return Number(row?.n ?? 0);
}

/* ================= Auth tutor / admin ================= */

async function issueVerification(c: Ctx, db: DB, parentId: string, email: string): Promise<string | null> {
  const token = await createAuthToken(db, parentId, "verify", VERIFY_TTL);
  const url = `${new URL(c.req.url).origin}/verify?token=${token}`;
  await sendEmail(c.env, email, "Verifica tu email · smartkids", emailLayout("Verifica tu email", "Confirma tu email para tu cuenta de tutor.", { url, label: "Verificar email" }));
  return devLinksEnabled(c.env) ? url : null;
}

/** Invitación a un tutor recién creado: enlace para que fije su propia contraseña (reutiliza el flujo reset). */
async function issueInvite(c: Ctx, db: DB, parentId: string, email: string): Promise<string | null> {
  const token = await createAuthToken(db, parentId, "reset", INVITE_TTL);
  const url = `${new URL(c.req.url).origin}/reset?token=${token}`;
  await sendEmail(
    c.env,
    email,
    "Te damos la bienvenida a smartkids · crea tu contraseña",
    emailLayout(
      "Te han dado de alta como tutor",
      "Un administrador te ha creado una cuenta de tutor en smartkids. Crea tu contraseña para entrar. El enlace caduca en 7 días.",
      { url, label: "Crear mi contraseña" },
    ),
  );
  return devLinksEnabled(c.env) ? url : null;
}

/** Reset de contraseña iniciado por el admin: enlace de un solo uso para que el tutor fije una nueva. */
async function issueReset(c: Ctx, db: DB, parentId: string, email: string): Promise<string | null> {
  const token = await createAuthToken(db, parentId, "reset", ADMIN_RESET_TTL);
  const url = `${new URL(c.req.url).origin}/reset?token=${token}`;
  await sendEmail(
    c.env,
    email,
    "Restablece tu contraseña · smartkids",
    emailLayout(
      "Restablece tu contraseña",
      "Un administrador ha solicitado restablecer tu contraseña. Elige una nueva. El enlace caduca en 24 horas.",
      { url, label: "Restablecer contraseña" },
    ),
  );
  return devLinksEnabled(c.env) ? url : null;
}

app.post("/api/auth/login", async (c) => {
  const db = getDb(c.env.DB);
  const body = await c.req.json<{ email?: string; password?: string }>();
  const email = body.email?.trim().toLowerCase() ?? "";
  const ip = c.req.header("cf-connecting-ip") ?? "local";
  const idIp = `login:ip:${ip}`;
  const idEmail = `login:email:${email}`;
  if ((await rateLimited(db, idIp)) || (await rateLimited(db, idEmail)))
    return c.json({ error: "rate_limited", message: "Demasiados intentos. Espera unos minutos." }, 429);
  const [p] = await db.select().from(parentAccounts).where(eq(parentAccounts.email, email)).limit(1);
  if (!p || !(await verifySecret(body.password ?? "", p.passwordHash))) {
    await recordAttempt(db, idIp);
    await recordAttempt(db, idEmail);
    return c.json({ error: "invalid_credentials", message: "Email o contraseña incorrectos." }, 401);
  }
  await clearAttempts(db, idIp);
  await clearAttempts(db, idEmail);
  setSessionCookie(c, await createSession(db, p.id));
  return c.json({ parent: { id: p.id, email: p.email, role: p.role, emailVerified: p.emailVerified } });
});

app.post("/api/auth/logout", async (c) => {
  await destroySession(c, getDb(c.env.DB));
  return c.json({ ok: true });
});

app.get("/api/auth/me", async (c) => {
  const db = getDb(c.env.DB);
  const parentId = await currentParentId(c, db);
  if (!parentId) return c.json({ error: "unauthorized" }, 401);
  const [p] = await db.select().from(parentAccounts).where(eq(parentAccounts.id, parentId)).limit(1);
  if (!p) return c.json({ error: "unauthorized" }, 401);
  const ids = await householdIds(db, parentId);
  const children = await db
    .select({
      id: childProfiles.id,
      displayName: childProfiles.displayName,
      username: childProfiles.username,
      avatar: childProfiles.avatar,
      mascot: childProfiles.mascot,
      gradeBand: childProfiles.gradeBand,
      birthYear: childProfiles.birthYear,
    })
    .from(childProfiles)
    .where(inArray(childProfiles.parentId, ids));
  let spouse: { id: string; email: string; emailVerified: boolean } | null = null;
  if (p.spouseId) {
    const [s] = await db
      .select({ id: parentAccounts.id, email: parentAccounts.email, emailVerified: parentAccounts.emailVerified })
      .from(parentAccounts)
      .where(eq(parentAccounts.id, p.spouseId))
      .limit(1);
    if (s) spouse = { id: s.id, email: s.email, emailVerified: s.emailVerified };
  }
  // Invitación de cónyuge entrante (alguien me invitó) y saliente (yo invité, pendiente de aceptar).
  let spouseInviteIn: { fromEmail: string } | null = null;
  if (p.spousePendingFrom) {
    const [inv] = await db.select({ email: parentAccounts.email }).from(parentAccounts).where(eq(parentAccounts.id, p.spousePendingFrom)).limit(1);
    if (inv) spouseInviteIn = { fromEmail: inv.email };
  }
  let spouseInviteOut: { toEmail: string } | null = null;
  if (!spouse) {
    const [out] = await db.select({ email: parentAccounts.email }).from(parentAccounts).where(eq(parentAccounts.spousePendingFrom, parentId)).limit(1);
    if (out) spouseInviteOut = { toEmail: out.email };
  }
  return c.json({ parent: { id: p.id, email: p.email, role: p.role, emailVerified: p.emailVerified }, spouse, spouseInviteIn, spouseInviteOut, children });
});

app.post("/api/auth/verify", async (c) => {
  const db = getDb(c.env.DB);
  const { token } = await c.req.json<{ token?: string }>();
  if (!token) return c.json({ error: "invalid" }, 400);
  const parentId = await consumeAuthToken(db, token, "verify");
  if (!parentId) return c.json({ error: "invalid_token", message: "Enlace inválido o caducado." }, 400);
  await db.update(parentAccounts).set({ emailVerified: true }).where(eq(parentAccounts.id, parentId));
  return c.json({ ok: true });
});

app.post("/api/auth/resend-verification", async (c) => {
  const db = getDb(c.env.DB);
  const parentId = await currentParentId(c, db);
  if (!parentId) return c.json({ error: "unauthorized" }, 401);
  const [p] = await db.select().from(parentAccounts).where(eq(parentAccounts.id, parentId)).limit(1);
  if (!p) return c.json({ error: "unauthorized" }, 401);
  if (p.emailVerified) return c.json({ ok: true, alreadyVerified: true });
  const devLink = await issueVerification(c, db, p.id, p.email);
  return c.json({ ok: true, ...(devLink ? { devLink } : {}) });
});

app.post("/api/auth/forgot", async (c) => {
  const db = getDb(c.env.DB);
  const email = (await c.req.json<{ email?: string }>()).email?.trim().toLowerCase() ?? "";
  const ip = c.req.header("cf-connecting-ip") ?? "local";
  if (await rateLimited(db, `forgot:ip:${ip}`))
    return c.json({ error: "rate_limited", message: "Demasiadas solicitudes. Espera unos minutos." }, 429);
  await recordAttempt(db, `forgot:ip:${ip}`);
  let devLink: string | null = null;
  if (email) {
    const [p] = await db.select().from(parentAccounts).where(eq(parentAccounts.email, email)).limit(1);
    if (p) {
      const token = await createAuthToken(db, p.id, "reset", RESET_TTL);
      const url = `${new URL(c.req.url).origin}/reset?token=${token}`;
      await sendEmail(c.env, email, "Recupera tu contraseña · smartkids", emailLayout("Recupera tu contraseña", "Elige una nueva contraseña. El enlace caduca en 1 hora.", { url, label: "Cambiar contraseña" }));
      if (devLinksEnabled(c.env)) devLink = url;
    }
  }
  return c.json({ ok: true, ...(devLink ? { devLink } : {}) });
});

app.post("/api/auth/reset", async (c) => {
  const db = getDb(c.env.DB);
  const { token, password } = await c.req.json<{ token?: string; password?: string }>();
  if (!token || !password || password.length < 6) return c.json({ error: "invalid", message: "Contraseña de 6+ caracteres." }, 400);
  const parentId = await consumeAuthToken(db, token, "reset");
  if (!parentId) return c.json({ error: "invalid_token", message: "Enlace inválido o caducado." }, 400);
  // Al fijar la contraseña vía enlace de email (reset o invitación) damos el email por verificado.
  await db.update(parentAccounts).set({ passwordHash: await hashSecret(password), emailVerified: true }).where(eq(parentAccounts.id, parentId));
  await db.delete(schema.sessions).where(eq(schema.sessions.parentId, parentId));
  return c.json({ ok: true });
});

app.post("/api/auth/change-password", async (c) => {
  const db = getDb(c.env.DB);
  const parentId = await currentParentId(c, db);
  if (!parentId) return c.json({ error: "unauthorized" }, 401);
  const { currentPassword, newPassword } = await c.req.json<{ currentPassword?: string; newPassword?: string }>();
  if (!newPassword || newPassword.length < 6) return c.json({ error: "invalid", message: "La nueva contraseña debe tener 6+ caracteres." }, 400);
  const [p] = await db.select().from(parentAccounts).where(eq(parentAccounts.id, parentId)).limit(1);
  if (!p || !(await verifySecret(currentPassword ?? "", p.passwordHash)))
    return c.json({ error: "invalid_credentials", message: "La contraseña actual no es correcta." }, 401);
  await db.update(parentAccounts).set({ passwordHash: await hashSecret(newPassword) }).where(eq(parentAccounts.id, parentId));
  return c.json({ ok: true });
});

/* ================= Admin: gestión de tutores ================= */

app.post("/api/admin/tutors", async (c) => {
  const db = getDb(c.env.DB);
  const a = await requireAdmin(c, db);
  if (typeof a !== "string") return a;
  const body = await c.req.json<{ email?: string }>();
  const email = body.email?.trim().toLowerCase();
  if (!email || !email.includes("@"))
    return c.json({ error: "invalid", message: "Introduce un email válido." }, 400);
  const [ex] = await db
    .select({ id: parentAccounts.id, role: parentAccounts.role, emailVerified: parentAccounts.emailVerified })
    .from(parentAccounts)
    .where(eq(parentAccounts.email, email))
    .limit(1);
  if (ex) {
    // Idempotente: si es un tutor aún pendiente (sin contraseña fijada), reenvía la invitación.
    // Cualquier otra cuenta (admin, o tutor ya verificado) es un email realmente en uso.
    if (ex.role === "tutor" && !ex.emailVerified) {
      const link = await issueInvite(c, db, ex.id, email);
      return c.json({ tutor: { id: ex.id, email }, reinvited: true, ...(link ? { devLink: link } : {}) });
    }
    return c.json({ error: "email_taken", message: "Ese email ya existe." }, 409);
  }
  const id = `par_${crypto.randomUUID()}`;
  // Contraseña aleatoria inservible: el tutor fijará la suya con el enlace del email de invitación.
  await db.insert(parentAccounts).values({
    id,
    email,
    passwordHash: await hashSecret(`${crypto.randomUUID()}${crypto.randomUUID()}`),
    role: "tutor",
    emailVerified: false,
    createdAt: new Date().toISOString(),
  });
  const devLink = await issueInvite(c, db, id, email);
  return c.json({ tutor: { id, email }, ...(devLink ? { devLink } : {}) });
});

app.get("/api/admin/tutors", async (c) => {
  const db = getDb(c.env.DB);
  const a = await requireAdmin(c, db);
  if (typeof a !== "string") return a;
  const rows = await db
    .select({ id: parentAccounts.id, email: parentAccounts.email, emailVerified: parentAccounts.emailVerified, createdAt: parentAccounts.createdAt })
    .from(parentAccounts)
    .where(eq(parentAccounts.role, "tutor"));
  return c.json(rows);
});

app.post("/api/admin/tutors/:id/reset-password", async (c) => {
  const db = getDb(c.env.DB);
  const a = await requireAdmin(c, db);
  if (typeof a !== "string") return a;
  const id = c.req.param("id");
  const [t] = await db.select({ role: parentAccounts.role, email: parentAccounts.email }).from(parentAccounts).where(eq(parentAccounts.id, id)).limit(1);
  if (!t || t.role !== "tutor") return c.json({ error: "not_found" }, 404);
  await db.delete(schema.sessions).where(eq(schema.sessions.parentId, id)); // cierra sesiones activas del tutor
  const devLink = await issueReset(c, db, id, t.email);
  return c.json({ ok: true, ...(devLink ? { devLink } : {}) });
});

app.delete("/api/admin/tutors/:id", async (c) => {
  const db = getDb(c.env.DB);
  const a = await requireAdmin(c, db);
  if (typeof a !== "string") return a;
  const id = c.req.param("id");
  const [t] = await db.select({ role: parentAccounts.role, spouseId: parentAccounts.spouseId }).from(parentAccounts).where(eq(parentAccounts.id, id)).limit(1);
  if (!t || t.role !== "tutor") return c.json({ error: "not_found" }, 404);
  if (t.spouseId) {
    // Tiene cónyuge: los niños, las recompensas Y EL CONTENIDO A MEDIDA sobreviven.
    // Reasignar solo los niños dejaba el contenido privado con un owner_id ya borrado: como las
    // lecturas revalidan que el dueño siga en el hogar, se volvía invisible e injugable, y el
    // tutor superviviente tampoco podía borrarlo desde la UI.
    await db.update(childProfiles).set({ parentId: t.spouseId }).where(eq(childProfiles.parentId, id));
    await db.update(rewards).set({ ownerId: t.spouseId }).where(eq(rewards.ownerId, id));
    await db.update(skills).set({ ownerId: t.spouseId }).where(eq(skills.ownerId, id));
    await db.update(contentPackages).set({ ownerId: t.spouseId }).where(eq(contentPackages.ownerId, id));
    await db.update(contentRequests).set({ ownerId: t.spouseId }).where(eq(contentRequests.ownerId, id));
    await db.update(parentAccounts).set({ spouseId: null }).where(eq(parentAccounts.id, t.spouseId));
  } else {
    // Sin cónyuge: se borra todo lo suyo. El orden importa (FKs sin ON DELETE).
    const kids = await db.select({ id: childProfiles.id }).from(childProfiles).where(eq(childProfiles.parentId, id));
    for (const k of kids) await deleteChildCascade(db, k.id);
    const rw = await db.select({ id: rewards.id }).from(rewards).where(eq(rewards.ownerId, id));
    for (const r of rw) await deleteRewardCascade(db, r.id);
    const sk = await db.select({ id: skills.id }).from(skills).where(eq(skills.ownerId, id));
    for (const k of sk) await deletePrivateSkillCascade(db, k.id, [id]);
    // content_requests.owner_id es NOT NULL con FK: sin esto el borrado del tutor fallaba por
    // clave ajena DESPUÉS de haber destruido su hogar, dejando la cuenta viva y el estado roto.
    const reqs = await db.select({ id: contentRequests.id }).from(contentRequests).where(eq(contentRequests.ownerId, id));
    for (const r of reqs) await deleteContentRequestCascade(c.env, db, r.id);
  }
  // Limpia cualquier invitación de cónyuge pendiente que apuntara a este tutor.
  await db.update(parentAccounts).set({ spousePendingFrom: null }).where(eq(parentAccounts.spousePendingFrom, id));
  await db.delete(schema.authTokens).where(eq(schema.authTokens.parentId, id));
  await db.delete(schema.sessions).where(eq(schema.sessions.parentId, id));
  await db.delete(webauthnCredentials).where(eq(webauthnCredentials.parentId, id));
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.ownerId, id));

  // Chequeo previo: si algo sigue apuntando al tutor, abortamos con 409 en vez de descubrirlo
  // a mitad del DELETE final (la cascada no es atómica: fallar aquí deja el hogar destruido).
  const pendientes: string[] = [];
  const [nKids] = await db.select({ n: sql<number>`count(*)` }).from(childProfiles).where(eq(childProfiles.parentId, id));
  if (Number(nKids?.n ?? 0) > 0) pendientes.push("child_profiles");
  const [nRw] = await db.select({ n: sql<number>`count(*)` }).from(rewards).where(eq(rewards.ownerId, id));
  if (Number(nRw?.n ?? 0) > 0) pendientes.push("rewards");
  const [nSk] = await db.select({ n: sql<number>`count(*)` }).from(skills).where(eq(skills.ownerId, id));
  if (Number(nSk?.n ?? 0) > 0) pendientes.push("skills");
  const [nPkg] = await db.select({ n: sql<number>`count(*)` }).from(contentPackages).where(eq(contentPackages.ownerId, id));
  if (Number(nPkg?.n ?? 0) > 0) pendientes.push("content_packages");
  const [nReq] = await db.select({ n: sql<number>`count(*)` }).from(contentRequests).where(eq(contentRequests.ownerId, id));
  if (Number(nReq?.n ?? 0) > 0) pendientes.push("content_requests");
  if (pendientes.length > 0) return c.json({ error: "referencias_pendientes", tablas: pendientes }, 409);

  await db.delete(parentAccounts).where(eq(parentAccounts.id, id));
  return c.json({ ok: true });
});

/* ================= Cursos ================= */

app.get("/api/courses", async (c) => {
  const db = getDb(c.env.DB);
  const a = await requireParent(c, db);
  if (typeof a !== "string") return a;
  return c.json(await db.select().from(courses));
});

/* ================= Tutor: cónyuge (co-tutor que comparte los niños) ================= */
// Vinculación con consentimiento BILATERAL: invitar deja la invitación PENDIENTE (sin acceso);
// el invitado la acepta/rechaza desde su panel. El vínculo se escribe simétrico y atómico.

/** Aviso de invitación de cónyuge. Si el invitado aún no tiene cuenta activa, incluye enlace para crearla. */
async function issueSpouseInvite(
  c: Ctx,
  db: DB,
  inviterEmail: string,
  invitee: { id: string; email: string; verified: boolean },
): Promise<string | null> {
  if (!invitee.verified) {
    const token = await createAuthToken(db, invitee.id, "reset", INVITE_TTL);
    const url = `${new URL(c.req.url).origin}/reset?token=${token}`;
    await sendEmail(
      c.env,
      invitee.email,
      "Te invitan como co-tutor · smartkids",
      emailLayout(
        "Te invitan a compartir la gestión",
        `${inviterEmail} te ha invitado a co-gestionar vuestros niños en smartkids. Crea tu contraseña y, al entrar, acepta la invitación.`,
        { url, label: "Crear mi contraseña" },
      ),
    );
    return devLinksEnabled(c.env) ? url : null;
  }
  await sendEmail(
    c.env,
    invitee.email,
    "Te invitan como co-tutor · smartkids",
    emailLayout(
      "Te invitan a compartir la gestión",
      `${inviterEmail} te ha invitado a co-gestionar vuestros niños en smartkids. Entra en tu cuenta y acepta o rechaza la invitación.`,
      { url: `${new URL(c.req.url).origin}/`, label: "Ir a smartkids" },
    ),
  );
  return null;
}

app.post("/api/tutor/spouse", async (c) => {
  const db = getDb(c.env.DB);
  const parentId = await requireParent(c, db);
  if (typeof parentId !== "string") return parentId;
  const [me] = await db.select().from(parentAccounts).where(eq(parentAccounts.id, parentId)).limit(1);
  if (!me || me.role !== "tutor") return c.json({ error: "forbidden" }, 403);
  if (me.spouseId) return c.json({ error: "already_linked", message: "Ya tienes un cónyuge vinculado." }, 409);
  if (await rateLimited(db, `spouse:${parentId}`)) return c.json({ error: "rate_limited", message: "Demasiados intentos. Prueba más tarde." }, 429);
  const body = await c.req.json<{ email?: string }>();
  const email = body.email?.trim().toLowerCase();
  if (!email || !email.includes("@")) return c.json({ error: "invalid", message: "Introduce un email válido." }, 400);
  if (email === me.email) return c.json({ error: "invalid", message: "Ese es tu propio email." }, 400);
  await recordAttempt(db, `spouse:${parentId}`);
  let invitee: { id: string; email: string; verified: boolean };
  const [ex] = await db.select().from(parentAccounts).where(eq(parentAccounts.email, email)).limit(1);
  if (ex) {
    if (ex.role !== "tutor") return c.json({ error: "invalid", message: "Ese email no se puede invitar." }, 409);
    if (ex.spouseId) return c.json({ error: "invalid", message: "Ese tutor ya tiene un cónyuge." }, 409);
    invitee = { id: ex.id, email: ex.email, verified: ex.emailVerified };
  } else {
    const nid = `par_${crypto.randomUUID()}`;
    await db.insert(parentAccounts).values({
      id: nid,
      email,
      passwordHash: await hashSecret(`${crypto.randomUUID()}${crypto.randomUUID()}`),
      role: "tutor",
      emailVerified: false,
      createdAt: new Date().toISOString(),
    });
    invitee = { id: nid, email, verified: false };
  }
  // Un único invitado pendiente por invitador: limpia invitaciones salientes previas (evita carreras y estados obsoletos).
  await db.update(parentAccounts).set({ spousePendingFrom: null }).where(eq(parentAccounts.spousePendingFrom, parentId));
  // Solo marca la invitación PENDIENTE en el lado del invitado: sin vínculo ni acceso hasta que acepte.
  await db.update(parentAccounts).set({ spousePendingFrom: parentId }).where(eq(parentAccounts.id, invitee.id));
  const devLink = await issueSpouseInvite(c, db, me.email, invitee);
  return c.json({ ok: true, pending: true, invitee: { email: invitee.email }, ...(devLink ? { devLink } : {}) });
});

app.post("/api/tutor/spouse/accept", async (c) => {
  const db = getDb(c.env.DB);
  const parentId = await requireParent(c, db);
  if (typeof parentId !== "string") return parentId;
  const [me] = await db
    .select({ spouseId: parentAccounts.spouseId, pending: parentAccounts.spousePendingFrom })
    .from(parentAccounts)
    .where(eq(parentAccounts.id, parentId))
    .limit(1);
  if (!me?.pending) return c.json({ error: "no_invite", message: "No tienes ninguna invitación pendiente." }, 404);
  if (me.spouseId) return c.json({ error: "already_linked", message: "Ya tienes un cónyuge." }, 409);
  const inviter = me.pending;
  const [a] = await db.select({ spouseId: parentAccounts.spouseId }).from(parentAccounts).where(eq(parentAccounts.id, inviter)).limit(1);
  if (!a || a.spouseId) {
    await db.update(parentAccounts).set({ spousePendingFrom: null }).where(eq(parentAccounts.id, parentId));
    return c.json({ error: "gone", message: "La invitación ya no es válida." }, 409);
  }
  // Vínculo simétrico, atómico y condicional (no piso vínculos ya existentes).
  await db.batch([
    db.update(parentAccounts).set({ spouseId: inviter, spousePendingFrom: null }).where(and(eq(parentAccounts.id, parentId), isNull(parentAccounts.spouseId))),
    db.update(parentAccounts).set({ spouseId: parentId }).where(and(eq(parentAccounts.id, inviter), isNull(parentAccounts.spouseId))),
  ]);
  // Verifica que quedó SIMÉTRICO; si una carrera dejó un lado sin escribir, deshaz el lado colgante y aborta
  // (sin tocar vínculos legítimos de terceros).
  const [meAfter] = await db.select({ spouseId: parentAccounts.spouseId }).from(parentAccounts).where(eq(parentAccounts.id, parentId)).limit(1);
  const [aAfter] = await db.select({ spouseId: parentAccounts.spouseId }).from(parentAccounts).where(eq(parentAccounts.id, inviter)).limit(1);
  if (meAfter?.spouseId !== inviter || aAfter?.spouseId !== parentId) {
    if (meAfter?.spouseId === inviter) await db.update(parentAccounts).set({ spouseId: null }).where(eq(parentAccounts.id, parentId));
    if (aAfter?.spouseId === parentId) await db.update(parentAccounts).set({ spouseId: null }).where(eq(parentAccounts.id, inviter));
    return c.json({ error: "conflict", message: "No se pudo completar la vinculación. Inténtalo de nuevo." }, 409);
  }
  return c.json({ ok: true });
});

app.post("/api/tutor/spouse/reject", async (c) => {
  const db = getDb(c.env.DB);
  const parentId = await requireParent(c, db);
  if (typeof parentId !== "string") return parentId;
  await db.update(parentAccounts).set({ spousePendingFrom: null }).where(eq(parentAccounts.id, parentId));
  return c.json({ ok: true });
});

// Cancela la invitación SALIENTE pendiente (para poder invitar a otra dirección).
app.delete("/api/tutor/spouse/invite", async (c) => {
  const db = getDb(c.env.DB);
  const parentId = await requireParent(c, db);
  if (typeof parentId !== "string") return parentId;
  // Limpia el puntero en el lado del invitado (solo filas que apuntan a MÍ; no toca a terceros).
  await db.update(parentAccounts).set({ spousePendingFrom: null }).where(eq(parentAccounts.spousePendingFrom, parentId));
  return c.json({ ok: true });
});

// Reenvía el correo de la invitación SALIENTE pendiente (mismo invitado, nuevo enlace si aún no tiene contraseña).
app.post("/api/tutor/spouse/resend", async (c) => {
  const db = getDb(c.env.DB);
  const parentId = await requireParent(c, db);
  if (typeof parentId !== "string") return parentId;
  const [me] = await db.select().from(parentAccounts).where(eq(parentAccounts.id, parentId)).limit(1);
  if (!me || me.role !== "tutor") return c.json({ error: "forbidden" }, 403);
  if (await rateLimited(db, `spouse:${parentId}`)) return c.json({ error: "rate_limited", message: "Demasiados intentos. Prueba más tarde." }, 429);
  const [inv] = await db.select().from(parentAccounts).where(eq(parentAccounts.spousePendingFrom, parentId)).limit(1);
  if (!inv) return c.json({ error: "invalid", message: "No hay ninguna invitación pendiente." }, 404);
  await recordAttempt(db, `spouse:${parentId}`);
  const devLink = await issueSpouseInvite(c, db, me.email, { id: inv.id, email: inv.email, verified: inv.emailVerified });
  return c.json({ ok: true, invitee: { email: inv.email }, ...(devLink ? { devLink } : {}) });
});

app.delete("/api/tutor/spouse", async (c) => {
  const db = getDb(c.env.DB);
  const parentId = await requireParent(c, db);
  if (typeof parentId !== "string") return parentId;
  const [me] = await db.select({ spouseId: parentAccounts.spouseId }).from(parentAccounts).where(eq(parentAccounts.id, parentId)).limit(1);
  if (!me?.spouseId) return c.json({ ok: true });
  const other = me.spouseId;
  const [o] = await db.select({ spouseId: parentAccounts.spouseId }).from(parentAccounts).where(eq(parentAccounts.id, other)).limit(1);
  await db.update(parentAccounts).set({ spouseId: null }).where(eq(parentAccounts.id, parentId));
  // Solo desvincula el otro lado si de verdad apunta a mí (no corrompas el vínculo de un tercero).
  if (o?.spouseId === parentId) await db.update(parentAccounts).set({ spouseId: null }).where(eq(parentAccounts.id, other));
  // Barre asignaciones cruzadas (recompensas Y contenido privado) entre los dos hogares que se separan.
  const aKids = (await db.select({ id: childProfiles.id }).from(childProfiles).where(eq(childProfiles.parentId, parentId))).map((k) => k.id);
  const bKids = (await db.select({ id: childProfiles.id }).from(childProfiles).where(eq(childProfiles.parentId, other))).map((k) => k.id);
  const aRewards = (await db.select({ id: rewards.id }).from(rewards).where(eq(rewards.ownerId, parentId))).map((r) => r.id);
  const bRewards = (await db.select({ id: rewards.id }).from(rewards).where(eq(rewards.ownerId, other))).map((r) => r.id);
  if (aKids.length && bRewards.length) await db.delete(childRewards).where(and(inArray(childRewards.childId, aKids), inArray(childRewards.rewardId, bRewards)));
  if (bKids.length && aRewards.length) await db.delete(childRewards).where(and(inArray(childRewards.childId, bKids), inArray(childRewards.rewardId, aRewards)));
  const aSkills = (await db.select({ id: skills.id }).from(skills).where(eq(skills.ownerId, parentId))).map((s) => s.id);
  const bSkills = (await db.select({ id: skills.id }).from(skills).where(eq(skills.ownerId, other))).map((s) => s.id);
  if (aKids.length && bSkills.length) await db.delete(childSkills).where(and(inArray(childSkills.childId, aKids), inArray(childSkills.skillId, bSkills)));
  if (bKids.length && aSkills.length) await db.delete(childSkills).where(and(inArray(childSkills.childId, bKids), inArray(childSkills.skillId, aSkills)));
  return c.json({ ok: true });
});

/* ================= Tutor: gestión de niños ================= */

app.post("/api/profiles", async (c) => {
  const db = getDb(c.env.DB);
  const parentId = await requireParent(c, db);
  if (typeof parentId !== "string") return parentId;
  const body = await c.req.json<{ displayName?: string; username?: string; avatar?: string; mascot?: string; gradeBand?: string; pin?: string; courseIds?: string[]; birthYear?: number; consent?: boolean }>();
  const displayName = body.displayName?.trim();
  const username = body.username?.trim().toLowerCase();
  const pin = String(body.pin ?? "");
  if (!displayName || !username || !USERNAME_RE.test(username) || pin.length < 4)
    return c.json({ error: "invalid", message: "Nombre, usuario (3+ car. a-z0-9._-) y PIN (4+ díg.) requeridos." }, 400);
  // Consentimiento del tutor para tratar los datos del menor (RGPD): obligatorio al dar de alta.
  if (body.consent !== true) return c.json({ error: "consent_required", message: "Debes confirmar el consentimiento para tratar los datos del menor." }, 400);
  const birthYear = parseBirthYear(body.birthYear);
  const [ex] = await db.select({ id: childProfiles.id }).from(childProfiles).where(eq(childProfiles.username, username)).limit(1);
  if (ex) return c.json({ error: "username_taken", message: "Ese usuario ya existe." }, 409);
  const id = `kid_${crypto.randomUUID()}`;
  await db.insert(childProfiles).values({
    id,
    parentId,
    displayName,
    avatar: body.avatar ?? "orbi",
    mascot: parseMascot(body.mascot) ?? "orbi",
    gradeBand: parseGradeBand(body.gradeBand) ?? "", // "" = sin definir (el tutor lo puede fijar luego)
    loginPinHash: await hashSecret(pin),
    username,
    preferredLocale: "es",
    region: "ES",
    birthYear,
    consentAt: new Date().toISOString(),
    consentVersion: POLICY_VERSION,
  });
  await db.insert(wallets).values({ profileId: id, balance: 0 });
  const requested = (body.courseIds ?? []).filter(Boolean);
  if (requested.length) {
    const valid = new Set((await db.select({ id: courses.id }).from(courses)).map((v) => v.id));
    for (const cid of requested) if (valid.has(cid)) await db.insert(childCourses).values({ childId: id, courseId: cid });
  }
  return c.json({ profile: { id, displayName, username, avatar: body.avatar ?? "orbi", mascot: parseMascot(body.mascot) ?? "orbi", gradeBand: parseGradeBand(body.gradeBand) ?? "" } });
});

app.post("/api/profiles/:id/update", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const parentId = await requireParent(c, db);
  if (typeof parentId !== "string") return parentId;
  if (!(await ownsProfile(db, parentId, id))) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json<{ displayName?: string; avatar?: string; mascot?: string; pin?: string; username?: string; birthYear?: number; gradeBand?: string }>();
  const patch: { displayName?: string; avatar?: string; mascot?: string; loginPinHash?: string; username?: string; birthYear?: number; gradeBand?: string } = {};
  if (body.displayName?.trim()) patch.displayName = body.displayName.trim();
  if (body.avatar) patch.avatar = body.avatar;
  if (body.mascot !== undefined) {
    const m = parseMascot(body.mascot);
    if (!m) return c.json({ error: "invalid", message: "Compañero inválido." }, 400);
    patch.mascot = m;
  }
  if (body.pin != null && String(body.pin).length >= 4) patch.loginPinHash = await hashSecret(String(body.pin));
  if (body.birthYear !== undefined) {
    const by = parseBirthYear(body.birthYear);
    if (by !== null) patch.birthYear = by;
  }
  if (body.gradeBand !== undefined) {
    const g = parseGradeBand(body.gradeBand);
    if (!g) return c.json({ error: "invalid", message: "Curso escolar inválido." }, 400);
    patch.gradeBand = g;
  }
  if (body.username?.trim()) {
    const u = body.username.trim().toLowerCase();
    if (!USERNAME_RE.test(u)) return c.json({ error: "invalid", message: "Usuario inválido." }, 400);
    const [dup] = await db.select({ id: childProfiles.id }).from(childProfiles).where(eq(childProfiles.username, u)).limit(1);
    if (dup && dup.id !== id) return c.json({ error: "username_taken", message: "Ese usuario ya existe." }, 409);
    patch.username = u;
  }
  if (Object.keys(patch).length === 0) return c.json({ error: "invalid", message: "Nada que actualizar." }, 400);
  await db.update(childProfiles).set(patch).where(eq(childProfiles.id, id));
  const [p] = await db.select().from(childProfiles).where(eq(childProfiles.id, id)).limit(1);
  return c.json({ profile: { id: p!.id, displayName: p!.displayName, username: p!.username, avatar: p!.avatar, mascot: p!.mascot, gradeBand: p!.gradeBand } });
});

app.delete("/api/profiles/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const parentId = await requireParent(c, db);
  if (typeof parentId !== "string") return parentId;
  if (!(await ownsProfile(db, parentId, id))) return c.json({ error: "forbidden" }, 403);
  await deleteChildCascade(db, id);
  return c.json({ ok: true });
});

app.post("/api/profiles/:id/courses", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const parentId = await requireParent(c, db);
  if (typeof parentId !== "string") return parentId;
  if (!(await ownsProfile(db, parentId, id))) return c.json({ error: "forbidden" }, 403);
  const { courseIds } = await c.req.json<{ courseIds?: string[] }>();
  const valid = new Set((await db.select({ id: courses.id }).from(courses)).map((v) => v.id));
  const ids = (courseIds ?? []).filter((x) => valid.has(x));
  await db.delete(childCourses).where(eq(childCourses.childId, id));
  for (const cid of ids) await db.insert(childCourses).values({ childId: id, courseId: cid });
  return c.json({ ok: true, courseIds: ids });
});

app.get("/api/profiles/:id/courses", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const a = await childOrOwner(c, db, id);
  if (typeof a !== "string") return a;
  return c.json(await childCoursesOf(db, id));
});

app.get("/api/profiles/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const a = await childOrOwner(c, db, id);
  if (typeof a !== "string") return a;
  // Columnas EXPLÍCITAS: un select() entero devolvía también login_pin_hash, y un PBKDF2 sobre
  // un PIN de cuatro cifras se agota offline en segundos. Nunca sirvas la fila completa.
  const [profile] = await db
    .select({
      id: childProfiles.id,
      parentId: childProfiles.parentId,
      displayName: childProfiles.displayName,
      username: childProfiles.username,
      avatar: childProfiles.avatar,
      mascot: childProfiles.mascot,
      gradeBand: childProfiles.gradeBand,
      birthYear: childProfiles.birthYear,
      preferredLocale: childProfiles.preferredLocale,
      region: childProfiles.region,
      timezone: childProfiles.timezone,
    })
    .from(childProfiles)
    .where(eq(childProfiles.id, id))
    .limit(1);
  if (!profile) return c.json({ error: "profile not found" }, 404);
  const [wallet] = await db.select({ balance: wallets.balance }).from(wallets).where(eq(wallets.profileId, id)).limit(1);
  return c.json({ profile, balance: wallet?.balance ?? 0 });
});

/* ================= Auth NIÑO (usuario + PIN) ================= */

app.post("/api/child/login", async (c) => {
  const db = getDb(c.env.DB);
  const body = await c.req.json<{ username?: string; pin?: string }>();
  const username = body.username?.trim().toLowerCase() ?? "";
  const ip = c.req.header("cf-connecting-ip") ?? "local";
  const idIp = `childlogin:ip:${ip}`;
  const idU = `childlogin:user:${username}`;
  if ((await rateLimited(db, idIp)) || (await rateLimited(db, idU)))
    return c.json({ error: "rate_limited", message: "Demasiados intentos. Espera unos minutos." }, 429);
  const [kid] = await db.select().from(childProfiles).where(eq(childProfiles.username, username)).limit(1);
  if (!kid || !kid.loginPinHash || !(await verifySecret(String(body.pin ?? ""), kid.loginPinHash))) {
    await recordAttempt(db, idIp);
    await recordAttempt(db, idU);
    return c.json({ error: "invalid_credentials", message: "Usuario o PIN incorrectos." }, 401);
  }
  await clearAttempts(db, idIp);
  await clearAttempts(db, idU);
  setChildCookie(c, await createChildSession(db, kid.id));
  const crs = await childCoursesOf(db, kid.id);
  return c.json({ child: { id: kid.id, displayName: kid.displayName, avatar: kid.avatar, mascot: kid.mascot, gradeBand: kid.gradeBand }, courses: crs });
});

app.post("/api/child/logout", async (c) => {
  await destroyChildSession(c, getDb(c.env.DB));
  return c.json({ ok: true });
});

app.get("/api/child/me", async (c) => {
  const db = getDb(c.env.DB);
  const kid = await currentChildId(c, db);
  if (!kid) return c.json({ error: "unauthorized" }, 401);
  const [child] = await db.select().from(childProfiles).where(eq(childProfiles.id, kid)).limit(1);
  if (!child) return c.json({ error: "unauthorized" }, 401);
  // Zona horaria del dispositivo: se persiste para que la racha "hoy" sea consistente también en la vista del tutor.
  const tz = safeTz(c.req.query("tz"));
  if (c.req.query("tz") && tz !== child.timezone) {
    await db.update(childProfiles).set({ timezone: tz }).where(eq(childProfiles.id, kid));
  }
  const streak = await computeStreak(db, kid, tz, true);
  const [wallet] = await db.select().from(wallets).where(eq(wallets.profileId, kid)).limit(1);
  const crs = await childCoursesOf(db, kid);
  // Contenido a medida (skills PRIVADOS asignados): se ofrecen como "cursos" independientes jugables directamente.
  // El dueño del skill privado debe seguir en el hogar del niño (defensa aunque quede un grant huérfano).
  const household = await householdIds(db, child.parentId);
  const privRows = await db
    .select({ id: skills.id, nameI18n: skills.nameI18n, pathId: skills.pathId, pathName: skills.pathName, moduleIndex: skills.moduleIndex })
    .from(childSkills)
    .innerJoin(skills, eq(skills.id, childSkills.skillId))
    .where(and(eq(childSkills.childId, kid), isNotNull(skills.ownerId), inArray(skills.ownerId, household)))
    .orderBy(asc(skills.moduleIndex));
  const customContent: Array<{ skillId: string; nameI18n: unknown; exercises: number; pathId: string | null; pathName: unknown; moduleIndex: number }> = [];
  for (const s of privRows) {
    const [cnt] = await db
      .select({ n: sql<number>`count(*)` })
      .from(exerciseTemplates)
      .where(and(eq(exerciseTemplates.skillId, s.id), eq(exerciseTemplates.retired, false), eq(exerciseTemplates.hidden, false)));
    customContent.push({ skillId: s.id, nameI18n: s.nameI18n, exercises: cnt?.n ?? 0, pathId: s.pathId, pathName: s.pathName, moduleIndex: s.moduleIndex });
  }
  return c.json({ child: { id: child.id, displayName: child.displayName, avatar: child.avatar, mascot: child.mascot, gradeBand: child.gradeBand }, balance: wallet?.balance ?? 0, streak, courses: crs, customContent });
});

// El propio niño elige su compañero de viaje (el tutor también puede fijarlo desde la ficha del niño).
app.post("/api/child/mascot", async (c) => {
  const db = getDb(c.env.DB);
  const kid = await currentChildId(c, db);
  if (!kid) return c.json({ error: "unauthorized" }, 401);
  const { mascot } = await c.req.json<{ mascot?: string }>();
  const m = parseMascot(mascot);
  if (!m) return c.json({ error: "invalid", message: "Compañero inválido." }, 400);
  await db.update(childProfiles).set({ mascot: m }).where(eq(childProfiles.id, kid));
  return c.json({ ok: true, mascot: m });
});

/* ================= Progreso del niño por curso / ficha / path y repaso de fallos ================= */

/** Preguntas que pide una tanda de "Repasar fallos". */
const REPASO_TOP = 10;

type ProgresoAmbito = {
  attempts: number;
  correct: number;
  accuracyPct: number;
  avgMs: number | null; // media por respuesta (recortadas a RT_TOPE_MS)
  trend: "up" | "down" | "flat" | null; // últimas 20 respuestas frente a las 20 anteriores
  pending: number; // ejercicios pendientes de corregir (vigentes y visibles)
  seen: number; // ejercicios vigentes distintos que ya ha respondido
  mastered?: number; // solo cursos: temas dominados
  totalSkills?: number; // solo cursos: temas del curso
};

/**
 * Progreso del niño por ÁMBITO jugable: `course:<id>` (skills globales de un curso suyo), `skill:<id>`
 * (ficha o módulo privado asignado) y `path:<id>` (todos los módulos de un path). Solo ámbitos a los que
 * tiene acceso HOY (cursos asignados; privados con grant y dueño en su hogar). Devuelve además, por
 * ámbito, los ejercicios pendientes ordenados para el repaso: los que más falla primero.
 */
async function progresoDelNino(db: DB, kid: string): Promise<{ scopes: Record<string, ProgresoAmbito>; pendientes: Map<string, string[]> }> {
  const scopes: Record<string, ProgresoAmbito> = {};
  const pendientes = new Map<string, string[]>();
  const [child] = await db.select({ parentId: childProfiles.parentId }).from(childProfiles).where(eq(childProfiles.id, kid)).limit(1);
  if (!child) return { scopes, pendientes };
  const crs = await childCoursesOf(db, kid);
  const household = await householdIds(db, child.parentId);
  const priv = await db
    .select({ id: skills.id, pathId: skills.pathId, subjectId: skills.subjectId, gradeBand: skills.gradeBand })
    .from(childSkills)
    .innerJoin(skills, eq(skills.id, childSkills.skillId))
    .where(and(eq(childSkills.childId, kid), isNotNull(skills.ownerId), inArray(skills.ownerId, household)));
  const privById = new Map(priv.map((p) => [p.id, p]));
  // Cursos del niño con la misma asignatura+nivel: la galaxia de un curso también pinta esos privados.
  const cursosDe = (subjectId: string, gradeBand: string) =>
    crs.filter((co) => co.subjectId === subjectId && co.gradeBand === gradeBand).map((co) => `course:${co.id}`);

  // Los 5000 intentos más recientes, en orden cronológico, con la vigencia de su plantilla.
  const rows = (
    await db
      .select({
        skillId: attempts.skillId,
        tid: attempts.exerciseTemplateId,
        correct: attempts.correct,
        rt: attempts.responseTimeMs,
        ts: attempts.ts,
        hidden: exerciseTemplates.hidden,
        retired: exerciseTemplates.retired,
      })
      .from(attempts)
      .innerJoin(exerciseTemplates, eq(exerciseTemplates.id, attempts.exerciseTemplateId))
      .where(eq(attempts.profileId, kid))
      .orderBy(desc(attempts.ts))
      .limit(5000)
  ).reverse();

  // Skill -> ámbitos. Los globales van al curso por asignatura+nivel (en tandas: D1 limita los parámetros).
  const ambitosDe = new Map<string, string[]>();
  const globales = [...new Set(rows.map((r) => r.skillId))].filter((id) => !privById.has(id));
  for (let i = 0; i < globales.length; i += 50) {
    const meta = await db
      .select({ id: skills.id, subjectId: skills.subjectId, gradeBand: skills.gradeBand, ownerId: skills.ownerId })
      .from(skills)
      .where(inArray(skills.id, globales.slice(i, i + 50)));
    for (const m of meta) {
      if (m.ownerId) continue; // privado sin acceso: no cuenta en ningún ámbito
      ambitosDe.set(m.id, cursosDe(m.subjectId, m.gradeBand));
    }
  }
  for (const [id, p] of privById) {
    ambitosDe.set(id, [`skill:${id}`, ...(p.pathId ? [`path:${p.pathId}`] : []), ...cursosDe(p.subjectId, p.gradeBand)]);
  }

  type Acc = { n: number; ok: number; rtSum: number; rtN: number; seq: boolean[]; tpl: Map<string, { fails: number; lastFail: string | null; lastOk: string | null; visible: boolean }> };
  const accs = new Map<string, Acc>();
  for (const r of rows) {
    const rt = rtUtil(r.rt);
    for (const key of ambitosDe.get(r.skillId) ?? []) {
      const g: Acc = accs.get(key) ?? { n: 0, ok: 0, rtSum: 0, rtN: 0, seq: [], tpl: new Map() };
      g.n++;
      if (r.correct) g.ok++;
      if (rt !== null) {
        g.rtSum += rt;
        g.rtN++;
      }
      g.seq.push(Boolean(r.correct));
      const t = g.tpl.get(r.tid) ?? { fails: 0, lastFail: null, lastOk: null, visible: !r.hidden && !r.retired };
      if (r.correct) t.lastOk = r.ts;
      else {
        t.fails++;
        t.lastFail = r.ts;
      }
      g.tpl.set(r.tid, t);
      accs.set(key, g);
    }
  }

  const pct = (bs: boolean[]) => (bs.filter(Boolean).length / bs.length) * 100;
  for (const [key, g] of accs) {
    const recent = g.seq.slice(-20);
    const prev = g.seq.slice(-40, -20);
    const diff = prev.length >= 10 ? pct(recent) - pct(prev) : null;
    const pend = [...g.tpl.entries()]
      .filter(([, t]) => t.visible && esPendiente(t.lastFail, t.lastOk))
      .sort((a, b) => b[1].fails - a[1].fails || ((b[1].lastFail ?? "") > (a[1].lastFail ?? "") ? 1 : -1));
    pendientes.set(key, pend.map(([id]) => id));
    scopes[key] = {
      attempts: g.n,
      correct: g.ok,
      accuracyPct: Math.round((g.ok / g.n) * 100),
      avgMs: g.rtN ? Math.round(g.rtSum / g.rtN) : null,
      trend: diff === null ? null : diff >= 5 ? "up" : diff <= -5 ? "down" : "flat",
      pending: pend.length,
      seen: [...g.tpl.values()].filter((t) => t.visible).length,
    };
  }

  // Cursos: avance en temas dominados (también sin intentos, para que el niño vea cuánto le queda).
  if (crs.length) {
    const mastered = new Set(
      (
        await db
          .select({ skillId: skillProgress.skillId })
          .from(skillProgress)
          .where(and(eq(skillProgress.profileId, kid), eq(skillProgress.status, "mastered")))
      ).map((r) => r.skillId),
    );
    for (const co of crs) {
      // Los temas que pinta su galaxia: globales del curso + privados asignados de la misma asignatura+nivel.
      const courseSkills = [
        ...(await db
          .select({ id: skills.id })
          .from(skills)
          .where(and(eq(skills.subjectId, co.subjectId), eq(skills.gradeBand, co.gradeBand), isNull(skills.ownerId)))),
        ...priv.filter((p) => p.subjectId === co.subjectId && p.gradeBand === co.gradeBand),
      ];
      const key = `course:${co.id}`;
      const base = scopes[key] ?? { attempts: 0, correct: 0, accuracyPct: 0, avgMs: null, trend: null, pending: 0, seen: 0 };
      scopes[key] = { ...base, totalSkills: courseSkills.length, mastered: courseSkills.filter((sk) => mastered.has(sk.id)).length };
    }
  }
  return { scopes, pendientes };
}

// El niño ve cómo va en cada curso, ficha y path: aciertos, tendencia, tiempo por pregunta y avance.
app.get("/api/child/progress", async (c) => {
  const db = getDb(c.env.DB);
  const kid = await currentChildId(c, db);
  if (!kid) return c.json({ error: "unauthorized" }, 401);
  const { scopes } = await progresoDelNino(db, kid);
  return c.json({ scopes, reviewTop: REPASO_TOP });
});

// "Repasar fallos": el top de ejercicios PENDIENTES de un ámbito (`course:<id>`, `skill:<id>` o
// `path:<id>`), los que más falla primero. Un ámbito al que el niño no tiene acceso sale vacío, y cada
// ejercicio se vuelve a validar al servirlo (`/api/session/next?exercise=`).
app.get("/api/child/review", async (c) => {
  const db = getDb(c.env.DB);
  const kid = await currentChildId(c, db);
  if (!kid) return c.json({ error: "unauthorized" }, 401);
  const { pendientes } = await progresoDelNino(db, kid);
  return c.json({ ids: (pendientes.get(c.req.query("scope") ?? "") ?? []).slice(0, REPASO_TOP) });
});

/* ================= Estadísticas / seguimiento ================= */

const SESSION_GAP_MS = 20 * 60 * 1000; // hueco que separa una "sesión" de la siguiente al reconstruirlas
// Tope de una respuesta en las medias y el top de lentitud: si el niño deja la app abierta con una pregunta
// en pantalla, ese intento registraría minutos y dominaría cualquier media.
const RT_TOPE_MS = 5 * 60 * 1000;
/**
 * ¿Ejercicio PENDIENTE? Lo falló y aún no lo ha acertado en OTRA tanda (más de SESSION_GAP_MS después del
 * último fallo). Acertarlo en el repaso de la misma misión, con la solución recién vista, no lo salda.
 */
function esPendiente(lastFailTs: string | null | undefined, lastOkTs: string | null | undefined): boolean {
  if (!lastFailTs) return false;
  return !lastOkTs || Date.parse(lastOkTs) - Date.parse(lastFailTs) <= SESSION_GAP_MS;
}
/** Tiempo de respuesta útil para estadísticas (recortado a RT_TOPE_MS), o null si no se midió. */
function rtUtil(rt: number | null): number | null {
  return typeof rt === "number" && rt > 0 ? Math.min(rt, RT_TOPE_MS) : null;
}
const DEFAULT_TZ = "Europe/Madrid"; // zona por defecto si el cliente no manda una válida

/** yyyy-mm-dd del instante `ms` en la zona IANA `tz` (con horario de verano); cae a UTC si la zona no es válida. */
function dayInTz(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}
/** Día calendario anterior a un yyyy-mm-dd (decremento puro, sin husos). */
function prevDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
}
/** Valida (best-effort) una zona IANA; devuelve la zona o el defecto. */
function safeTz(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
}

/**
 * Racha actual = días consecutivos (en la zona del niño) con al menos un intento, hasta hoy.
 * "Hoy" es de gracia: no haber practicado aún hoy no rompe la racha (se cuenta desde ayer).
 * Un Escudo (streak_freeze canjeado y sin consumir) cubre automáticamente UN día perdido; al
 * consumirse se fija `consumed_for` con el día cubierto, de modo que recalcular es estable.
 * Con `consume=false` calcula sin persistir (para vistas de solo lectura).
 */
async function computeStreak(db: DB, profileId: string, tz: string, consume: boolean): Promise<number> {
  const sinceIso = new Date(Date.now() - 420 * 86400000).toISOString();
  const rows = await db
    .select({ ts: attempts.ts })
    .from(attempts)
    .where(and(eq(attempts.profileId, profileId), gte(attempts.ts, sinceIso)))
    .orderBy(desc(attempts.ts))
    .limit(5000);
  if (rows.length === 0) return 0;
  const active = new Set(rows.map((r) => dayInTz(Date.parse(r.ts), tz)));

  // Escudos del niño: los ya consumidos aportan su día cubierto; los libres pueden gastarse.
  const freezeRows = await db
    .select({ id: redemptions.id, consumedAt: redemptions.consumedAt, consumedFor: redemptions.consumedFor })
    .from(redemptions)
    .innerJoin(rewards, eq(rewards.id, redemptions.rewardId))
    .where(and(eq(redemptions.profileId, profileId), eq(rewards.type, "streak_freeze"), eq(redemptions.status, "applied")));
  const coveredDays = new Set(freezeRows.filter((f) => f.consumedFor).map((f) => f.consumedFor as string));
  const availableFreezes = freezeRows.filter((f) => !f.consumedAt).map((f) => f.id);

  const today = dayInTz(Date.now(), tz);
  let day = active.has(today) || coveredDays.has(today) ? today : prevDay(today); // gracia para "hoy"
  let streak = 0;
  let used = 0;
  const toConsume: Array<{ id: string; day: string }> = [];
  while (true) {
    if (active.has(day) || coveredDays.has(day)) {
      streak++;
    } else if (used < availableFreezes.length) {
      toConsume.push({ id: availableFreezes[used]!, day });
      used++;
      streak++;
    } else {
      break;
    }
    day = prevDay(day);
  }
  if (consume && toConsume.length) {
    const nowIso = new Date().toISOString();
    for (const c of toConsume) {
      await db
        .update(redemptions)
        .set({ consumedAt: nowIso, consumedFor: c.day })
        .where(and(eq(redemptions.id, c.id), isNull(redemptions.consumedAt)));
    }
  }
  return streak;
}

// Agrega el progreso de un perfil desde attempts + wallet_ledger + skill_progress.
// No hay tabla de sesiones: se RECONSTRUYEN agrupando los intentos por huecos de tiempo.
async function computeProfileStats(db: DB, profileId: string, tz: string, opts: { slowest?: boolean } = {}) {
  const now = Date.now();
  // Los 5000 intentos MÁS RECIENTES, en orden cronológico (con asc + limit se quedaban los más antiguos
  // y un niño muy activo dejaba de ver sus últimas sesiones).
  const attemptRows = (
    await db
      .select({ skillId: attempts.skillId, tid: attempts.exerciseTemplateId, correct: attempts.correct, rt: attempts.responseTimeMs, ts: attempts.ts })
      .from(attempts)
      .where(eq(attempts.profileId, profileId))
      .orderBy(desc(attempts.ts))
      .limit(5000)
  ).reverse();
  const ledgerRows = await db
    .select({ delta: walletLedger.delta, reason: walletLedger.reason, ts: walletLedger.ts })
    .from(walletLedger)
    .where(eq(walletLedger.profileId, profileId));
  const [wallet] = await db.select({ balance: wallets.balance }).from(wallets).where(eq(wallets.profileId, profileId)).limit(1);
  const progressRows = await db
    .select({ skillId: skillProgress.skillId, mastery: skillProgress.masteryScore, status: skillProgress.status })
    .from(skillProgress)
    .where(eq(skillProgress.profileId, profileId));
  const progById = new Map(progressRows.map((p) => [p.skillId, p]));

  const skillIds = [...new Set(attemptRows.map((a) => a.skillId))];
  const nameById = new Map<string, unknown>();
  if (skillIds.length) {
    const srows = await db.select({ id: skills.id, name: skills.nameI18n }).from(skills).where(inArray(skills.id, skillIds));
    for (const s of srows) nameById.set(s.id, s.name);
  }

  const isExercise = (r: string) => r.startsWith("exercise:");
  const isRedeem = (r: string) => r.startsWith("redeem:");
  const total = attemptRows.length;
  const correct = attemptRows.filter((a) => a.correct).length;
  const timed = attemptRows.map((a) => rtUtil(a.rt)).filter((rt): rt is number => rt !== null);
  const avgTimeMs = timed.length ? Math.round(timed.reduce((s, rt) => s + rt, 0) / timed.length) : null;
  const activeDays = new Set(attemptRows.map((a) => a.ts.slice(0, 10))).size;
  const sumEarnedSince = (fromMs: number) =>
    ledgerRows.filter((l) => isExercise(l.reason) && Date.parse(l.ts) >= fromMs).reduce((s, l) => s + l.delta, 0);
  const pointsEarned = ledgerRows.filter((l) => isExercise(l.reason)).reduce((s, l) => s + l.delta, 0);
  const pointsSpent = ledgerRows.filter((l) => isRedeem(l.reason)).reduce((s, l) => s - l.delta, 0);

  // Por skill
  const bySkill = new Map<string, { attempts: number; correct: number; rtSum: number; rtN: number }>();
  for (const a of attemptRows) {
    const g = bySkill.get(a.skillId) ?? { attempts: 0, correct: 0, rtSum: 0, rtN: 0 };
    g.attempts++;
    if (a.correct) g.correct++;
    const rt = rtUtil(a.rt);
    if (rt !== null) {
      g.rtSum += rt;
      g.rtN++;
    }
    bySkill.set(a.skillId, g);
  }
  const perSkill = [...bySkill.entries()]
    .map(([id, g]) => ({
      skillId: id,
      name: nameById.get(id) ?? { es: id },
      attempts: g.attempts,
      correct: g.correct,
      accuracyPct: g.attempts ? Math.round((g.correct / g.attempts) * 100) : 0,
      avgTimeMs: g.rtN ? Math.round(g.rtSum / g.rtN) : null,
      mastery: progById.get(id)?.mastery ?? null,
      status: progById.get(id)?.status ?? null,
    }))
    .sort((a, b) => b.attempts - a.attempts);

  // Sesiones reconstruidas (hueco > SESSION_GAP_MS = nueva sesión). Dentro de una sesión, la PRIMERA
  // respuesta a cada ejercicio es la "primera vuelta" (count/correct/wrong); volver a uno fallado antes en
  // la misma sesión es REPASO: la sesión de repaso de la misión o una misión siguiente que lo vuelve a servir.
  // Así se ve si repasó lo fallado (`retried`) y cuánto corrigió (`fixed`), también en el histórico antiguo.
  const exLedger = ledgerRows.filter((l) => isExercise(l.reason)).map((l) => ({ t: Date.parse(l.ts), d: l.delta }));
  const sessions: Array<{
    start: string;
    end: string;
    count: number;
    correct: number;
    wrong: number;
    answers: number;
    failed: number;
    retried: number;
    fixed: number;
    skills: unknown[];
    timeMs: number;
    avgMs: number | null;
    durationMs: number;
    points: number;
  }> = [];
  type Visto = { failed: boolean; retried: boolean; fixed: boolean };
  let cur: { startT: number; endT: number; answers: number; first: number; firstOk: number; rtSum: number; rtN: number; seen: Map<string, Visto>; skills: Map<string, number> } | null = null;
  const flush = () => {
    if (!cur) return;
    const g = cur;
    const points = exLedger.filter((l) => l.t >= g.startT - 1000 && l.t <= g.endT + 1000).reduce((s, l) => s + l.d, 0);
    const failed = [...g.seen.values()].filter((v) => v.failed);
    sessions.push({
      start: new Date(g.startT).toISOString(),
      end: new Date(g.endT).toISOString(),
      count: g.first,
      correct: g.firstOk,
      wrong: g.first - g.firstOk,
      answers: g.answers,
      failed: failed.length,
      retried: failed.filter((v) => v.retried).length,
      fixed: failed.filter((v) => v.fixed).length,
      // Temas practicados, el más trabajado primero.
      skills: [...g.skills.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([id]) => nameById.get(id) ?? { es: id }),
      timeMs: g.rtSum, // tiempo contestando (suma de respuestas)
      avgMs: g.rtN ? Math.round(g.rtSum / g.rtN) : null, // media por respuesta
      durationMs: g.endT - g.startT, // lo que duró la tanda: de la primera pregunta en pantalla a la última respuesta
      points,
    });
    cur = null;
  };
  for (const a of attemptRows) {
    const t = Date.parse(a.ts);
    if (cur && t - cur.endT > SESSION_GAP_MS) flush();
    const rt = rtUtil(a.rt);
    // El intento se guarda al RESPONDER: la tanda empezó cuando la primera pregunta apareció en pantalla.
    if (!cur) cur = { startT: t - (rt ?? 0), endT: t, answers: 0, first: 0, firstOk: 0, rtSum: 0, rtN: 0, seen: new Map(), skills: new Map() };
    cur.endT = t;
    cur.answers++;
    cur.skills.set(a.skillId, (cur.skills.get(a.skillId) ?? 0) + 1);
    if (rt !== null) {
      cur.rtSum += rt;
      cur.rtN++;
    }
    const visto = cur.seen.get(a.tid);
    if (!visto) {
      cur.seen.set(a.tid, { failed: !a.correct, retried: false, fixed: false });
      cur.first++;
      if (a.correct) cur.firstOk++;
    } else if (visto.failed) {
      visto.retried = true;
      if (a.correct) visto.fixed = true;
    }
  }
  flush();
  sessions.reverse();

  // Actividad últimos 14 días (para el mini-gráfico)
  const attemptsByDay = new Map<string, { attempts: number; correct: number }>();
  for (const a of attemptRows) {
    const k = a.ts.slice(0, 10);
    const g = attemptsByDay.get(k) ?? { attempts: 0, correct: 0 };
    g.attempts++;
    if (a.correct) g.correct++;
    attemptsByDay.set(k, g);
  }
  const pointsByDay = new Map<string, number>();
  for (const l of ledgerRows) if (isExercise(l.reason)) pointsByDay.set(l.ts.slice(0, 10), (pointsByDay.get(l.ts.slice(0, 10)) ?? 0) + l.delta);
  const activity: Array<{ date: string; attempts: number; correct: number; points: number }> = [];
  for (let i = 13; i >= 0; i--) {
    const k = new Date(now - i * 86400000).toISOString().slice(0, 10);
    const g = attemptsByDay.get(k);
    activity.push({ date: k, attempts: g?.attempts ?? 0, correct: g?.correct ?? 0, points: pointsByDay.get(k) ?? 0 });
  }

  const streak = await computeStreak(db, profileId, tz, false);

  // Preguntas en las que más tarda (media de sus respuestas, recortadas a RT_TOPE_MS). Solo lo pide el tutor.
  const slowest: Array<{ templateId: string; stem: string; skillName: unknown; avgMs: number; maxMs: number; attempts: number; correct: number }> = [];
  if (opts.slowest) {
    const byTpl = new Map<string, { skillId: string; n: number; sum: number; max: number; ok: number }>();
    for (const a of attemptRows) {
      const rt = rtUtil(a.rt);
      if (rt === null) continue;
      const g = byTpl.get(a.tid) ?? { skillId: a.skillId, n: 0, sum: 0, max: 0, ok: 0 };
      g.n++;
      g.sum += rt;
      g.max = Math.max(g.max, rt);
      if (a.correct) g.ok++;
      byTpl.set(a.tid, g);
    }
    const top = [...byTpl.entries()].sort((x, y) => y[1].sum / y[1].n - x[1].sum / x[1].n).slice(0, SLOWEST_TOP);
    if (top.length) {
      const stems = await db
        .select({ id: exerciseTemplates.id, stem: exerciseTemplates.stem })
        .from(exerciseTemplates)
        .where(inArray(exerciseTemplates.id, top.map(([id]) => id)));
      const stemById = new Map(stems.map((r) => [r.id, r.stem]));
      for (const [id, g] of top) {
        const stem = stemById.get(id);
        if (stem === undefined) continue;
        slowest.push({
          templateId: id,
          stem,
          skillName: nameById.get(g.skillId) ?? { es: g.skillId },
          avgMs: Math.round(g.sum / g.n),
          maxMs: g.max,
          attempts: g.n,
          correct: g.ok,
        });
      }
    }
  }

  // Cobertura por curso asignado: skills GLOBALES del curso (asignatura+nivel) vs el progreso del niño.
  // Muestra lo que FALTA (temas sin empezar), no solo lo hecho.
  const courseList = await childCoursesOf(db, profileId);
  const coverage: Array<{ courseId: string; name: unknown; total: number; started: number; mastered: number; notStarted: number }> = [];
  for (const co of courseList) {
    const courseSkills = await db
      .select({ id: skills.id })
      .from(skills)
      .where(and(eq(skills.subjectId, co.subjectId), eq(skills.gradeBand, co.gradeBand), isNull(skills.ownerId)));
    let started = 0;
    let mastered = 0;
    for (const s of courseSkills) {
      const p = progById.get(s.id);
      if (p) {
        started++;
        if (p.status === "mastered") mastered++;
      }
    }
    coverage.push({ courseId: co.id, name: co.nameI18n, total: courseSkills.length, started, mastered, notStarted: courseSkills.length - started });
  }

  return {
    overview: {
      attempts: total,
      correct,
      accuracyPct: total ? Math.round((correct / total) * 100) : 0,
      avgTimeMs,
      balance: wallet?.balance ?? 0,
      pointsEarned,
      pointsSpent,
      earned7d: sumEarnedSince(now - 7 * 86400000),
      earned30d: sumEarnedSince(now - 30 * 86400000),
      activeDays,
      streak,
      lastActivity: attemptRows.length ? attemptRows[attemptRows.length - 1]!.ts : null,
    },
    perSkill,
    sessions: sessions.slice(0, 30),
    activity,
    coverage,
    slowest,
  };
}

/** Cuántas preguntas lista el top de lentitud del tutor. */
const SLOWEST_TOP = 8;

// El niño ve SUS propias estadísticas.
app.get("/api/child/stats", async (c) => {
  const db = getDb(c.env.DB);
  const kid = await currentChildId(c, db);
  if (!kid) return c.json({ error: "unauthorized" }, 401);
  const tz = safeTz(c.req.query("tz"));
  return c.json(await computeProfileStats(db, kid, tz));
});

// El tutor ve las estadísticas de un niño de su hogar (usa la zona horaria persistida del niño).
app.get("/api/tutor/children/:id/stats", async (c) => {
  const db = getDb(c.env.DB);
  const a = await requireParent(c, db);
  if (typeof a !== "string") return a;
  const childId = c.req.param("id");
  if (!(await ownsProfile(db, a, childId))) return c.json({ error: "forbidden" }, 403);
  const [ch] = await db.select({ tz: childProfiles.timezone }).from(childProfiles).where(eq(childProfiles.id, childId)).limit(1);
  return c.json(await computeProfileStats(db, childId, safeTz(ch?.tz), { slowest: true }));
});

// El tutor da o quita puntos del monedero de un niño de su hogar (premiar/corregir fuera de la app).
// El movimiento se registra con reason "adjust:*" → NO cuenta como puntos ganados en ejercicios (no infla objetivos).
app.post("/api/tutor/children/:id/wallet", async (c) => {
  const db = getDb(c.env.DB);
  const parentId = await requireParent(c, db);
  if (typeof parentId !== "string") return parentId;
  const childId = c.req.param("id");
  if (!(await ownsProfile(db, parentId, childId))) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json<{ delta?: number; reason?: string }>();
  const delta = Math.trunc(Number(body?.delta ?? 0));
  if (!Number.isFinite(delta) || delta === 0) return c.json({ error: "invalid", message: "Indica cuántos puntos dar o quitar." }, 400);
  if (Math.abs(delta) > 100000) return c.json({ error: "invalid", message: "Cantidad fuera de rango." }, 400);
  const now = new Date().toISOString();
  await db.insert(wallets).values({ profileId: childId, balance: 0 }).onConflictDoNothing();
  let applied = delta;
  if (delta < 0) {
    // Nunca por debajo de 0: se descuenta como mucho el saldo disponible.
    const [w] = await db.select({ balance: wallets.balance }).from(wallets).where(eq(wallets.profileId, childId)).limit(1);
    applied = -Math.min(w?.balance ?? 0, -delta);
  }
  if (applied !== 0) {
    await db.update(wallets).set({ balance: sql`${wallets.balance} + ${applied}` }).where(eq(wallets.profileId, childId));
    const note = (body?.reason ?? "").trim().slice(0, 80);
    await db.insert(walletLedger).values({ id: crypto.randomUUID(), profileId: childId, delta: applied, reason: `adjust:${note || "tutor"}`, ts: now });
  }
  const [w2] = await db.select({ balance: wallets.balance }).from(wallets).where(eq(wallets.profileId, childId)).limit(1);
  return c.json({ ok: true, balance: w2?.balance ?? 0, applied });
});

// Exportación RGPD (derecho de acceso/portabilidad, arts. 15/20): todos los datos del niño en un JSON descargable.
// No incluye el hash del PIN. El binario del material subido vive en R2 (aquí van solo los metadatos).
app.get("/api/tutor/children/:id/export", async (c) => {
  const db = getDb(c.env.DB);
  const parentId = await requireParent(c, db);
  if (typeof parentId !== "string") return parentId;
  const childId = c.req.param("id");
  if (!(await ownsProfile(db, parentId, childId))) return c.json({ error: "forbidden" }, 403);
  const [child] = await db.select().from(childProfiles).where(eq(childProfiles.id, childId)).limit(1);
  if (!child) return c.json({ error: "not_found" }, 404);
  const profile = {
    id: child.id,
    displayName: child.displayName,
    username: child.username,
    avatar: child.avatar,
    mascot: child.mascot,
    gradeBand: child.gradeBand,
    birthYear: child.birthYear,
    preferredLocale: child.preferredLocale,
    region: child.region,
    timezone: child.timezone,
    consentAt: child.consentAt,
    consentVersion: child.consentVersion,
  };
  const crs = await childCoursesOf(db, childId);
  const attemptRows = await db.select().from(attempts).where(eq(attempts.profileId, childId)).orderBy(asc(attempts.ts));
  const progress = await db.select().from(skillProgress).where(eq(skillProgress.profileId, childId));
  const [wallet] = await db.select({ balance: wallets.balance }).from(wallets).where(eq(wallets.profileId, childId)).limit(1);
  const ledger = await db.select().from(walletLedger).where(eq(walletLedger.profileId, childId)).orderBy(asc(walletLedger.ts));
  const reds = await db
    .select({ id: redemptions.id, rewardName: rewards.nameI18n, status: redemptions.status, ts: redemptions.ts })
    .from(redemptions)
    .innerJoin(rewards, eq(rewards.id, redemptions.rewardId))
    .where(eq(redemptions.profileId, childId))
    .orderBy(asc(redemptions.ts));
  const customSkills = await db
    .select({ id: skills.id, name: skills.nameI18n })
    .from(childSkills)
    .innerJoin(skills, eq(skills.id, childSkills.skillId))
    .where(eq(childSkills.childId, childId));
  const payload = {
    schema: "smartkids-child-export/1",
    exportedAt: new Date().toISOString(),
    profile,
    courses: crs,
    customSkills,
    wallet: { balance: wallet?.balance ?? 0, ledger },
    progress,
    attempts: attemptRows,
    redemptions: reds,
  };
  const safeName = (child.username || childId).replace(/[^a-z0-9._-]/gi, "_");
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="smartkids-${safeName}.json"`,
    },
  });
});

// Panel de mando del tutor: una fila por niño del hogar con sus métricas clave, en pocas consultas
// agregadas (no N modales). Convierte la lista muda de niños en un panel accionable.
app.get("/api/tutor/summary", async (c) => {
  const db = getDb(c.env.DB);
  const parentId = await requireParent(c, db);
  if (typeof parentId !== "string") return parentId;
  const ids = await householdIds(db, parentId);
  const kids = await db
    .select({ id: childProfiles.id, displayName: childProfiles.displayName, avatar: childProfiles.avatar, username: childProfiles.username, tz: childProfiles.timezone })
    .from(childProfiles)
    .where(inArray(childProfiles.parentId, ids));
  if (!kids.length) return c.json([]);
  const kidIds = kids.map((k) => k.id);

  const balRows = await db.select({ pid: wallets.profileId, balance: wallets.balance }).from(wallets).where(inArray(wallets.profileId, kidIds));
  const balById = new Map(balRows.map((r) => [r.pid, r.balance]));
  const attRows = await db
    .select({
      pid: attempts.profileId,
      n: sql<number>`count(*)`,
      ok: sql<number>`sum(case when ${attempts.correct} then 1 else 0 end)`,
      last: sql<string>`max(${attempts.ts})`,
    })
    .from(attempts)
    .where(inArray(attempts.profileId, kidIds))
    .groupBy(attempts.profileId);
  const attById = new Map(attRows.map((r) => [r.pid, r]));
  const courseRows = await db.select({ pid: childCourses.childId, n: sql<number>`count(*)` }).from(childCourses).where(inArray(childCourses.childId, kidIds)).groupBy(childCourses.childId);
  const courseById = new Map(courseRows.map((r) => [r.pid, Number(r.n)]));
  const customRows = await db.select({ pid: childSkills.childId, n: sql<number>`count(*)` }).from(childSkills).where(inArray(childSkills.childId, kidIds)).groupBy(childSkills.childId);
  const customById = new Map(customRows.map((r) => [r.pid, Number(r.n)]));
  const pendRows = await db
    .select({ pid: redemptions.profileId, n: sql<number>`count(*)` })
    .from(redemptions)
    .where(and(inArray(redemptions.profileId, kidIds), eq(redemptions.status, "pending")))
    .groupBy(redemptions.profileId);
  const pendById = new Map(pendRows.map((r) => [r.pid, Number(r.n)]));

  const out = [];
  for (const k of kids) {
    const a = attById.get(k.id);
    const n = a ? Number(a.n) : 0;
    const ok = a ? Number(a.ok) : 0;
    const streak = await computeStreak(db, k.id, safeTz(k.tz), false);
    out.push({
      id: k.id,
      displayName: k.displayName,
      avatar: k.avatar,
      username: k.username,
      balance: balById.get(k.id) ?? 0,
      courseCount: courseById.get(k.id) ?? 0,
      customCount: customById.get(k.id) ?? 0,
      attempts: n,
      accuracyPct: n ? Math.round((ok / n) * 100) : 0,
      streak,
      lastActivity: a?.last ?? null,
      pendingRedemptions: pendById.get(k.id) ?? 0,
    });
  }
  return c.json(out);
});

// Revisión de errores: los últimos ejercicios que el niño falló, con SU respuesta y la correcta.
// Da sentido pedagógico a la precisión (qué se falla, no solo cuánto).
app.get("/api/tutor/children/:id/mistakes", async (c) => {
  const db = getDb(c.env.DB);
  const parentId = await requireParent(c, db);
  if (typeof parentId !== "string") return parentId;
  const childId = c.req.param("id");
  if (!(await ownsProfile(db, parentId, childId))) return c.json({ error: "forbidden" }, 403);
  const rows = await db
    .select({ ts: attempts.ts, templateId: attempts.exerciseTemplateId, skillId: attempts.skillId, answer: attempts.answerGiven })
    .from(attempts)
    .where(and(eq(attempts.profileId, childId), eq(attempts.correct, false)))
    .orderBy(desc(attempts.ts))
    .limit(30);
  if (!rows.length) return c.json([]);
  const tplIds = [...new Set(rows.map((r) => r.templateId))];
  const tpls = await db.select().from(exerciseTemplates).where(inArray(exerciseTemplates.id, tplIds));
  const tplById = new Map(tpls.map((t) => [t.id, t]));
  const skillIds = [...new Set(rows.map((r) => r.skillId))];
  const srows = skillIds.length ? await db.select({ id: skills.id, name: skills.nameI18n }).from(skills).where(inArray(skills.id, skillIds)) : [];
  const nameById = new Map(srows.map((s) => [s.id, s.name]));
  const out: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    const tpl = tplById.get(r.templateId);
    if (!tpl) continue;
    let render: unknown = null;
    let correctAnswer: unknown = null;
    try {
      const exercise = exerciseFromRow({
        id: tpl.id, packageId: tpl.packageId, skillId: tpl.skillId, type: tpl.type, language: tpl.language,
        contentVersion: tpl.contentVersion, stem: tpl.stem, payload: tpl.payload,
        difficultyNumeric: tpl.difficultyNumeric, difficultyLevel: tpl.difficultyLevel,
      });
      render = redactForClient(exercise); // para que el cliente pueda mapear ids->texto en la respuesta
      correctAnswer = canonicalAnswer(exercise);
    } catch {
      /* plantilla no conforme: se muestra solo el enunciado */
    }
    out.push({ ts: r.ts, skillName: nameById.get(r.skillId) ?? { es: r.skillId }, stem: tpl.stem, type: tpl.type, render, given: r.answer ?? null, correctAnswer });
  }
  return c.json(out);
});

/* ================= Preguntas marcadas como erróneas ================= */

// Motivos que puede elegir el niño (y su texto para los emails, que van en español).
const REPORT_REASON_ES: Record<string, string> = {
  wrong_answer: "la respuesta correcta está mal",
  unclear: "no se entiende",
  other: "otro motivo",
};

/** Cierra los avisos ABIERTOS de un ejercicio (de cualquier niño, o solo de uno): se ocultó o se descartó. */
async function closeReports(db: DB, templateId: string, status: "hidden" | "dismissed", profileId?: string): Promise<void> {
  const conds = [eq(exerciseReports.exerciseTemplateId, templateId), eq(exerciseReports.status, "open")];
  if (profileId) conds.push(eq(exerciseReports.profileId, profileId));
  await db.update(exerciseReports).set({ status, resolvedAt: new Date().toISOString() }).where(and(...conds));
}

// Avisos abiertos de los niños del hogar, con el ejercicio (su respuesta vs la correcta) para decidir.
// Solo plantillas vigentes: si el contenido se republicó, la versión marcada ya no se sirve.
app.get("/api/tutor/reports", async (c) => {
  const db = getDb(c.env.DB);
  const parentId = await requireParent(c, db);
  if (typeof parentId !== "string") return parentId;
  const household = await householdIds(db, parentId);
  const kids = await db.select({ id: childProfiles.id, name: childProfiles.displayName }).from(childProfiles).where(inArray(childProfiles.parentId, household));
  if (!kids.length) return c.json([]);
  const nameByKid = new Map(kids.map((k) => [k.id, k.name]));
  const rows = await db
    .select({ r: exerciseReports, tpl: exerciseTemplates, skillName: skills.nameI18n, ownerId: skills.ownerId })
    .from(exerciseReports)
    .innerJoin(exerciseTemplates, eq(exerciseTemplates.id, exerciseReports.exerciseTemplateId))
    .innerJoin(skills, eq(skills.id, exerciseTemplates.skillId))
    .where(and(inArray(exerciseReports.profileId, kids.map((k) => k.id)), eq(exerciseReports.status, "open"), eq(exerciseTemplates.retired, false)))
    .orderBy(desc(exerciseReports.createdAt))
    .limit(50);
  const out: Array<Record<string, unknown>> = [];
  for (const { r, tpl, skillName, ownerId } of rows) {
    let render: unknown = null;
    let correctAnswer: unknown = null;
    let solution: string | null = null;
    try {
      const exercise = exerciseFromRow({
        id: tpl.id, packageId: tpl.packageId, skillId: tpl.skillId, type: tpl.type, language: tpl.language,
        contentVersion: tpl.contentVersion, stem: tpl.stem, payload: tpl.payload,
        difficultyNumeric: tpl.difficultyNumeric, difficultyLevel: tpl.difficultyLevel,
      });
      render = redactForClient(exercise); // para que el cliente pueda mapear ids->texto en las respuestas
      correctAnswer = canonicalAnswer(exercise);
      solution = exercise.feedback?.solution ?? null;
    } catch {
      /* plantilla no conforme: se muestra solo el enunciado */
    }
    out.push({
      profileId: r.profileId,
      childName: nameByKid.get(r.profileId) ?? "",
      templateId: tpl.id,
      skillName,
      stem: tpl.stem,
      type: tpl.type,
      render,
      given: r.answerGiven ?? null,
      wasCorrect: r.correct,
      correctAnswer,
      solution,
      reason: r.reason,
      createdAt: r.createdAt,
      // Solo el contenido PRIVADO del hogar se puede ocultar desde aquí; el global lo corrige el admin.
      canHide: Boolean(ownerId && household.includes(ownerId)),
    });
  }
  return c.json(out);
});

// El tutor atiende un aviso: 'hide' oculta la pregunta (solo contenido privado del hogar) y cierra todos
// sus avisos; 'dismiss' descarta el aviso de ese niño (la pregunta estaba bien).
app.post("/api/tutor/reports/:templateId/resolve", async (c) => {
  const db = getDb(c.env.DB);
  const parentId = await requireParent(c, db);
  if (typeof parentId !== "string") return parentId;
  const templateId = c.req.param("templateId");
  const body = await c.req.json<{ profileId?: string; action?: string }>().catch(() => null);
  if (!body?.profileId || (body.action !== "hide" && body.action !== "dismiss")) return c.json({ error: "invalid body" }, 400);
  if (!(await ownsProfile(db, parentId, body.profileId))) return c.json({ error: "forbidden" }, 403);
  if (body.action === "dismiss") {
    await closeReports(db, templateId, "dismissed", body.profileId);
    return c.json({ ok: true });
  }
  const [tpl] = await db.select({ skillId: exerciseTemplates.skillId }).from(exerciseTemplates).where(eq(exerciseTemplates.id, templateId)).limit(1);
  if (!tpl) return c.json({ error: "not_found" }, 404);
  const household = await householdIds(db, parentId);
  const [sk] = await db.select({ ownerId: skills.ownerId }).from(skills).where(eq(skills.id, tpl.skillId)).limit(1);
  if (!sk?.ownerId || !household.includes(sk.ownerId)) return c.json({ error: "forbidden" }, 403);
  await db.update(exerciseTemplates).set({ hidden: true }).where(eq(exerciseTemplates.id, templateId));
  await closeReports(db, templateId, "hidden");
  return c.json({ ok: true });
});

/* ================= Web Push ================= */

// Envía un push (sin payload) a todas las suscripciones de un dueño; limpia las caducadas.
async function notifyOwner(env: Env, db: DB, ownerId: string): Promise<void> {
  if (!env.VAPID_PRIVATE_JWK) return;
  const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.ownerId, ownerId));
  for (const s of subs) {
    const r = await sendPush(env, s.endpoint);
    if (r.gone) await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
  }
}

/** Avisa a los tutores del hogar de un canje pendiente por DOS vías: push (si hay) y email (Resend).
 *  El email cubre iOS, donde el push exige tener la PWA instalada; así el canje no queda colgado. */
async function notifyPendingRedemption(env: Env, db: DB, household: string[], childName: string, rewardName: string): Promise<void> {
  for (const pid of household) await notifyOwner(env, db, pid); // push (best-effort)
  const parents = await db.select({ email: parentAccounts.email }).from(parentAccounts).where(inArray(parentAccounts.id, household));
  if (!parents.length) return;
  const subject = `smartkids · ${childName} quiere canjear una recompensa`;
  const html = emailLayout(
    "Canje pendiente de aprobar",
    `<b>${childName}</b> ha pedido canjear <b>${rewardName}</b>. Entra en smartkids para aprobarlo o rechazarlo.`,
    { url: "https://app.smart-kids.uk", label: "Abrir smartkids" },
  );
  for (const p of parents) await sendEmail(env, p.email, subject, html);
}

/** Escapa texto escrito por un usuario antes de meterlo en el HTML de un email. */
function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

/** Avisa a los administradores (push + email) de que hay una solicitud de contenido por procesar.
 *  Sin esto la solicitud esperaba en 'uploaded' hasta que alguien ejecutase la skill por su cuenta. */
async function notifyAdminsContentRequest(env: Env, db: DB, title: string, numQuestions: number | null, regenerate: boolean): Promise<void> {
  const admins = await db.select({ id: parentAccounts.id, email: parentAccounts.email }).from(parentAccounts).where(eq(parentAccounts.role, "admin"));
  if (!admins.length) return;
  for (const ad of admins) await notifyOwner(env, db, ad.id); // push (best-effort)
  const nombre = escHtml(title || "(sin título)");
  const html = emailLayout(
    regenerate ? "Contenido a regenerar" : "Nueva solicitud de contenido",
    `Un tutor ha ${regenerate ? "pedido regenerar" : "enviado"} <b>${nombre}</b>: ${numQuestions ?? 20} preguntas pedidas, ` +
      `${targetExercises(numQuestions)} a generar. Procésala con <b>/smartkids_content</b>.`,
  );
  const subject = regenerate ? "smartkids · contenido a regenerar" : "smartkids · nueva solicitud de contenido";
  for (const ad of admins) await sendEmail(env, ad.email, subject, html);
}

// Clave pública VAPID para que el cliente se suscriba.
app.get("/api/push/key", (c) => c.json({ publicKey: c.env.VAPID_PUBLIC ?? null }));

// Guarda (upsert) la suscripción de push del usuario actual (tutor o niño).
app.post("/api/push/subscribe", async (c) => {
  const db = getDb(c.env.DB);
  const body = await c.req.json<{ endpoint?: string; keys?: { p256dh?: string; auth?: string } }>();
  if (!body?.endpoint || !body.keys?.p256dh || !body.keys?.auth) return c.json({ error: "invalid" }, 400);
  const kid = await currentChildId(c, db);
  let ownerType: string;
  let ownerId: string;
  if (kid) {
    ownerType = "child";
    ownerId = kid;
  } else {
    const p = await requireParent(c, db);
    if (typeof p !== "string") return p;
    ownerType = "parent";
    ownerId = p;
  }
  const now = new Date().toISOString();
  await db
    .insert(pushSubscriptions)
    .values({ id: crypto.randomUUID(), ownerType, ownerId, endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth, createdAt: now })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { ownerType, ownerId, p256dh: body.keys.p256dh, auth: body.keys.auth } });
  return c.json({ ok: true });
});

// Borra una suscripción de push (al desactivar en el dispositivo).
app.post("/api/push/unsubscribe", async (c) => {
  const db = getDb(c.env.DB);
  const body = await c.req.json<{ endpoint?: string }>();
  if (!body?.endpoint) return c.json({ error: "invalid" }, 400);
  // Resuelve el propietario igual que subscribe: sin esto cualquiera que conociera el endpoint
  // push de una familia podía desactivarle los avisos (era el único mutador sin guard).
  const kid = await currentChildId(c, db);
  let ownerId: string;
  if (kid) {
    ownerId = kid;
  } else {
    const p = await requireParent(c, db);
    if (typeof p !== "string") return p;
    ownerId = p;
  }
  await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.endpoint, body.endpoint), eq(pushSubscriptions.ownerId, ownerId)));
  return c.json({ ok: true });
});

/* ================= Passkeys (WebAuthn) — login biométrico del tutor ================= */

const WEBAUTHN_RP_NAME = "Smartkids";
const FLOW_TTL_MS = 5 * 60 * 1000;

/**
 * rpID y origen esperados de WebAuthn.
 *
 * NO se derivan de la cabecera `Origin` a secas: es el cliente quien la manda, y es justo el
 * valor que la verificación tiene que comprobar. Solo se acepta si está en una ALLOWLIST; si no,
 * se cae al origen real de la petición y la ceremonia fallará, que es lo que debe pasar.
 *
 * El rpID sale del origen ya validado, no de la URL de la petición: bajo `wrangler dev` con una
 * ruta `custom_domain`, el Worker recibe la URL de PRODUCCIÓN aunque se sirva en localhost, así
 * que derivarlo de ahí daba rpId "app.smart-kids.uk" a un navegador en localhost y el navegador
 * abortaba con SecurityError. En desarrollo: WEBAUTHN_ORIGINS=http://localhost:5173 en .dev.vars.
 */
function rpFromReq(c: Ctx): { rpID: string; origin: string } {
  const propio = new URL(c.req.url).origin;
  const permitidos = [propio, ...(c.env.WEBAUTHN_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean)];
  const enviado = c.req.header("origin");
  const origin = enviado && permitidos.includes(enviado) ? enviado : propio;
  let rpID: string;
  try {
    rpID = new URL(origin).hostname; // `Origin: null` (páginas sandboxed) no debe tumbar el handler
  } catch {
    rpID = new URL(propio).hostname;
  }
  return { rpID, origin };
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function bytesToB64url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function saveFlow(db: DB, kind: string, userId: string | null, challenge: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(webauthnFlows).values({ id, kind, userId, challenge, expiresAt: new Date(Date.now() + FLOW_TTL_MS).toISOString() });
  return id;
}
async function takeFlow(db: DB, id: string, kind: string): Promise<{ userId: string | null; challenge: string } | null> {
  const [f] = await db.select().from(webauthnFlows).where(eq(webauthnFlows.id, id)).limit(1);
  await db.delete(webauthnFlows).where(eq(webauthnFlows.id, id)); // un solo uso
  if (!f || f.kind !== kind || new Date(f.expiresAt).getTime() < Date.now()) return null;
  return { userId: f.userId, challenge: f.challenge };
}

// Registro (tutor logueado): opciones.
app.post("/api/auth/passkey/register/options", async (c) => {
  const db = getDb(c.env.DB);
  const a = await requireParent(c, db);
  if (typeof a !== "string") return a;
  const [parent] = await db.select({ email: parentAccounts.email }).from(parentAccounts).where(eq(parentAccounts.id, a)).limit(1);
  if (!parent) return c.json({ error: "not_found" }, 404);
  const existing = await db.select({ id: webauthnCredentials.id }).from(webauthnCredentials).where(eq(webauthnCredentials.parentId, a));
  const { rpID } = rpFromReq(c);
  const options = await generateRegistrationOptions({
    rpName: WEBAUTHN_RP_NAME,
    rpID,
    userName: parent.email,
    userID: new TextEncoder().encode(a) as Uint8Array<ArrayBuffer>,
    attestationType: "none",
    excludeCredentials: existing.map((e) => ({ id: e.id })),
    // authenticatorAttachment "platform" = SOLO el biométrico integrado (Face ID / Touch ID /
    // Windows Hello / huella Android). Sin esto, el navegador ofrece también QR y llave de seguridad.
    authenticatorSelection: { residentKey: "required", userVerification: "required", authenticatorAttachment: "platform" },
  });
  const flowId = await saveFlow(db, "reg", a, options.challenge);
  return c.json({ options, flowId });
});

// Registro: verifica y guarda la credencial.
app.post("/api/auth/passkey/register/verify", async (c) => {
  const db = getDb(c.env.DB);
  const a = await requireParent(c, db);
  if (typeof a !== "string") return a;
  const body = await c.req.json<{ flowId: string; response: RegistrationResponseJSON }>();
  const flow = await takeFlow(db, body.flowId, "reg");
  if (!flow || flow.userId !== a) return c.json({ error: "flow_expired" }, 400);
  const { rpID, origin } = rpFromReq(c);
  let verification;
  try {
    verification = await verifyRegistrationResponse({ response: body.response, expectedChallenge: flow.challenge, expectedOrigin: origin, expectedRPID: rpID });
  } catch {
    return c.json({ error: "verify_failed" }, 400);
  }
  if (!verification.verified || !verification.registrationInfo) return c.json({ error: "not_verified" }, 400);
  const { credential } = verification.registrationInfo;
  const pk = bytesToB64url(credential.publicKey);
  await db
    .insert(webauthnCredentials)
    .values({ id: credential.id, parentId: a, publicKey: pk, counter: credential.counter, transports: JSON.stringify(credential.transports ?? []), createdAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: webauthnCredentials.id, set: { publicKey: pk, counter: credential.counter } });
  return c.json({ ok: true });
});

// Login (sin sesión): opciones usernameless (passkeys descubribles).
app.post("/api/auth/passkey/login/options", async (c) => {
  const db = getDb(c.env.DB);
  const { rpID } = rpFromReq(c);
  const options = await generateAuthenticationOptions({ rpID, userVerification: "required" });
  const flowId = await saveFlow(db, "auth", null, options.challenge);
  return c.json({ options, flowId });
});

// Login: verifica la aserción, actualiza el contador y abre sesión.
app.post("/api/auth/passkey/login/verify", async (c) => {
  const db = getDb(c.env.DB);
  const body = await c.req.json<{ flowId: string; response: AuthenticationResponseJSON }>();
  const flow = await takeFlow(db, body.flowId, "auth");
  if (!flow) return c.json({ error: "flow_expired" }, 400);
  const [cred] = await db.select().from(webauthnCredentials).where(eq(webauthnCredentials.id, body.response.id)).limit(1);
  if (!cred) return c.json({ error: "unknown_credential" }, 400);
  const { rpID, origin } = rpFromReq(c);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: flow.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: { id: cred.id, publicKey: b64urlToBytes(cred.publicKey), counter: cred.counter, transports: JSON.parse(cred.transports ?? "[]") },
    });
  } catch {
    return c.json({ error: "verify_failed" }, 400);
  }
  if (!verification.verified) return c.json({ error: "not_verified" }, 400);
  await db.update(webauthnCredentials).set({ counter: verification.authenticationInfo.newCounter }).where(eq(webauthnCredentials.id, cred.id));
  const [parent] = await db.select().from(parentAccounts).where(eq(parentAccounts.id, cred.parentId)).limit(1);
  if (!parent) return c.json({ error: "not_found" }, 404);
  const token = await createSession(db, parent.id);
  setSessionCookie(c, token);
  return c.json({ parent: { id: parent.id, email: parent.email, role: parent.role, emailVerified: Boolean(parent.emailVerified) } });
});

// ¿Cuántas passkeys tiene el tutor actual? (para la UI de ajustes)
app.get("/api/auth/passkey/list", async (c) => {
  const db = getDb(c.env.DB);
  const a = await requireParent(c, db);
  if (typeof a !== "string") return a;
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(webauthnCredentials).where(eq(webauthnCredentials.parentId, a));
  return c.json({ count: row?.n ?? 0 });
});

// Borra todas las passkeys del tutor actual.
app.delete("/api/auth/passkey", async (c) => {
  const db = getDb(c.env.DB);
  const a = await requireParent(c, db);
  if (typeof a !== "string") return a;
  await db.delete(webauthnCredentials).where(eq(webauthnCredentials.parentId, a));
  return c.json({ ok: true });
});

/* ================= Datos de juego ================= */

app.get("/api/skills", async (c) => {
  const db = getDb(c.env.DB);
  const profileId = c.req.query("profile");
  const courseId = c.req.query("course");
  if (!profileId || !courseId) return c.json({ error: "invalid", message: "profile y course requeridos." }, 400);
  const a = await childOrOwner(c, db, profileId);
  if (typeof a !== "string") return a;
  if (!(await hasCourse(db, profileId, courseId))) return c.json({ error: "no_course_access" }, 403);
  const [course] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
  if (!course) return c.json({ error: "course not found" }, 404);
  const proj = {
    id: skills.id,
    position: skills.position,
    nameI18n: skills.nameI18n,
    gradeBand: skills.gradeBand,
    difficultyBase: skills.difficultyBase,
    status: skillProgress.status,
    masteryScore: skillProgress.masteryScore,
    totalAttempts: skillProgress.totalAttempts,
  };
  // Skills GLOBALES del curso (asignatura+nivel). Nunca los privados de otro hogar (owner_id IS NULL).
  const globalRows = await db
    .select(proj)
    .from(skills)
    .leftJoin(skillProgress, and(eq(skillProgress.skillId, skills.id), eq(skillProgress.profileId, profileId)))
    .where(and(eq(skills.subjectId, course.subjectId), eq(skills.gradeBand, course.gradeBand), isNull(skills.ownerId)))
    .orderBy(asc(skills.position));
  // Skills PRIVADOS del hogar asignados a este niño, en la misma asignatura+nivel.
  // Solo skills PRIVADOS (isNotNull) cuyo dueño siga en el hogar del niño (no basta el grant).
  const [skChild] = await db.select({ parentId: childProfiles.parentId }).from(childProfiles).where(eq(childProfiles.id, profileId)).limit(1);
  const household = skChild ? await householdIds(db, skChild.parentId) : [];
  const privateRows =
    household.length === 0
      ? []
      : await db
          .select(proj)
          .from(childSkills)
          .innerJoin(skills, eq(skills.id, childSkills.skillId))
          .leftJoin(skillProgress, and(eq(skillProgress.skillId, skills.id), eq(skillProgress.profileId, profileId)))
          .where(
            and(
              eq(childSkills.childId, profileId),
              isNotNull(skills.ownerId),
              inArray(skills.ownerId, household),
              eq(skills.subjectId, course.subjectId),
              eq(skills.gradeBand, course.gradeBand),
            ),
          )
          .orderBy(asc(skills.position));
  return c.json([...globalRows, ...privateRows]);
});

/* ================= Contenido: import (máquina/admin) + privado del hogar ================= */

type LocaleTextIn = Record<string, string>;

/** Autoriza al pipeline/skill (token de máquina) o a un admin con sesión. */
async function requireImporter(c: Ctx, db: DB): Promise<true | Response> {
  const auth = c.req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (c.env.CONTENT_IMPORT_TOKEN && token && token === c.env.CONTENT_IMPORT_TOKEN) return true;
  const admin = await requireAdmin(c, db);
  return typeof admin === "string" ? true : admin;
}

// Publica un paquete de contenido (global o privado) generado por el pipeline/skill.
app.post("/api/admin/content/import", async (c) => {
  const db = getDb(c.env.DB);
  const gate = await requireImporter(c, db);
  if (gate !== true) return gate;

  const body = await c.req.json<{
    subject?: { id: string; nameI18n: LocaleTextIn };
    skill?: {
      id: string;
      subjectId: string;
      gradeBand: string;
      nameI18n: LocaleTextIn;
      ownerId?: string | null;
      difficultyBase?: number;
      position?: number;
      coinsPerCorrect?: number | null;
      pathId?: string | null;
      pathName?: LocaleTextIn | null;
      moduleIndex?: number;
      sessionLength?: number | null;
    };
    package: { id: string; subjectId: string; gradeBand?: string | null; version: string; ownerId?: string | null };
    exercises: unknown[];
    assign?: { childIds: string[] };
    requestId?: string;
    /** Publicación TROCEADA de un paquete grande: posición del primer ejercicio de este lote (0 = primer lote).
     *  Solo el lote con offset 0 retira lo anterior; los siguientes solo añaden. */
    offset?: number;
    /** Regeneración EN SITIO: retira TODO el contenido previo del skill (de cualquier paquete), no solo el del paquete. */
    replaceSkillContent?: boolean;
    /** Solo en la llamada que CIERRA una regeneración: skills de la publicación anterior que ya no se usan (se borran). */
    retireSkillIds?: string[];
  }>();
  if (!body?.package?.id || !Array.isArray(body?.exercises)) return c.json({ error: "invalid body" }, 400);
  const offset = Math.max(0, Math.floor(Number(body.offset ?? 0)) || 0);

  // Validación estricta de TODOS los ejercicios con el modelo unificado + self-check.
  const parsed: Exercise[] = [];
  for (const raw of body.exercises) {
    const p = ExerciseSchema.safeParse(raw);
    if (!p.success) return c.json({ error: "invalid_exercise", detail: p.error.issues[0]?.message ?? "?" }, 400);
    const v = validateExercise(p.data);
    if (!v.ok) return c.json({ error: "invalid_exercise", detail: v.reason }, 400);
    parsed.push(p.data);
  }
  if (parsed.length === 0) return c.json({ error: "no_exercises" }, 400);

  const now = new Date().toISOString();

  if (body.subject) {
    await db.insert(subjects).values({ id: body.subject.id, nameI18n: body.subject.nameI18n }).onConflictDoNothing();
  }
  if (body.skill) {
    // Acota los puntos por acierto a un entero razonable (el import es privilegiado pero no de fiar ciegamente).
    const skillCoins = body.skill.coinsPerCorrect == null ? null : Math.max(1, Math.min(1000, Math.round(body.skill.coinsPerCorrect)));
    // Preguntas por misión: solo se toca si el lote la trae (la Vía A/C no la mandan y no deben pisar el ajuste del tutor).
    const sessionSet =
      body.skill.sessionLength === undefined
        ? {}
        : { sessionLength: body.skill.sessionLength == null ? null : clampInt(body.skill.sessionLength, SESSION_LENGTH_MIN, SESSION_LENGTH_MAX, SESSION_LENGTH_DEFAULT) };
    await db
      .insert(skills)
      .values({
        id: body.skill.id,
        subjectId: body.skill.subjectId,
        gradeBand: body.skill.gradeBand,
        nameI18n: body.skill.nameI18n,
        difficultyBase: body.skill.difficultyBase ?? 0.4,
        position: body.skill.position ?? 0,
        ownerId: body.skill.ownerId ?? null,
        coinsPerCorrect: skillCoins,
        pathId: body.skill.pathId ?? null,
        pathName: body.skill.pathName ?? null,
        moduleIndex: body.skill.moduleIndex ?? 0,
        ...sessionSet,
      })
      .onConflictDoUpdate({
        target: skills.id,
        set: {
          nameI18n: body.skill.nameI18n,
          coinsPerCorrect: skillCoins,
          pathId: body.skill.pathId ?? null,
          pathName: body.skill.pathName ?? null,
          moduleIndex: body.skill.moduleIndex ?? 0,
          ...sessionSet,
        },
      });
  }

  // Upsert del paquete (idempotente).
  await db
    .insert(contentPackages)
    .values({
      id: body.package.id,
      subjectId: body.package.subjectId,
      gradeBand: body.package.gradeBand ?? null,
      version: body.package.version,
      status: "published",
      ownerId: body.package.ownerId ?? null,
      createdAt: now,
    })
    .onConflictDoUpdate({ target: contentPackages.id, set: { version: body.package.version, ownerId: body.package.ownerId ?? null } });

  // Plantillas: UPSERT por id, NUNCA delete+insert. `attempts` y `coin_awards` referencian
  // exercise_templates con FK sin ON DELETE, así que borrarlas hacía imposible republicar un
  // paquete en cuanto UN niño había respondido un solo ejercicio (fallo de clave ajena → 500).
  // El PRIMER lote (offset 0) retira TODO el paquete antes de insertar; cada upsert reactiva lo
  // que sí viene (el objeto `campos` lleva retired:false). Así no hace falta un NOT IN con la lista
  // entera, que en un paquete grande superaría el límite de parámetros ligados de D1. Los lotes
  // siguientes de una publicación troceada (offset > 0) solo añaden.
  const targetSkillId = body.skill?.id ?? parsed[0]!.skillId;
  if (offset === 0) {
    await db.update(exerciseTemplates).set({ retired: true }).where(eq(exerciseTemplates.packageId, body.package.id));
    // Regeneración en sitio: lo anterior pudo vivir en OTRO paquete del mismo skill; también se retira.
    if (body.replaceSkillContent) await db.update(exerciseTemplates).set({ retired: true }).where(eq(exerciseTemplates.skillId, targetSkillId));
  }
  // Todo en `db.batch` por tandas: con cientos de ejercicios, una consulta por ejercicio agotaba las
  // subpeticiones y el tiempo de la invocación (plan Free: 1000 subpeticiones, 10 ms de CPU).
  const TANDA = 50; // <= 100 parámetros ligados por consulta en D1 (el IN de ids de abajo)
  for (let base = 0; base < parsed.length; base += TANDA) {
    const tanda = parsed.slice(base, base + TANDA);
    const ids = tanda.map((_, k) => `${body.package.id}_${offset + base + k + 1}`);
    // El id de plantilla es POSICIONAL (`<paquete>_<n>`), así que reeditar un ejercicio en sitio
    // reutiliza el id y `coin_awards` sigue diciendo "ya cobrado": el niño resolvería contenido
    // NUEVO por cero monedas. Si el contenido cambia, se borra el registro de cobro.
    const previas = await db
      .select({ id: exerciseTemplates.id, stem: exerciseTemplates.stem, payload: exerciseTemplates.payload })
      .from(exerciseTemplates)
      .where(inArray(exerciseTemplates.id, ids));
    const previaDe = new Map(previas.map((p) => [p.id, p]));
    const stmts: BatchItem<"sqlite">[] = [];
    tanda.forEach((ex, k) => {
      const id = ids[k]!;
      const campos = {
        skillId: ex.skillId,
        type: ex.type,
        language: ex.language,
        contentVersion: body.package.version,
        stem: ex.stem,
        payload: toStoredPayload(ex),
        difficultyNumeric: ex.difficulty.numeric,
        difficultyLevel: ex.difficulty.level,
        retired: false, // vuelve a estar en el lote: deja de estar retirada
      };
      stmts.push(
        db
          .insert(exerciseTemplates)
          .values({ id, packageId: body.package.id, ...campos })
          // `hidden` queda FUERA del SET a propósito: es curación manual del tutor y republicar
          // no debe deshacerla en silencio.
          .onConflictDoUpdate({ target: exerciseTemplates.id, set: campos }),
      );
      const previa = previaDe.get(id);
      const cambio = previa && (previa.stem !== campos.stem || JSON.stringify(previa.payload) !== JSON.stringify(campos.payload));
      if (cambio) {
        stmts.push(db.delete(coinAwards).where(eq(coinAwards.exerciseTemplateId, id)));
        // Los avisos de «pregunta mal» hablaban de la versión anterior: ya no aplican.
        stmts.push(db.delete(exerciseReports).where(eq(exerciseReports.exerciseTemplateId, id)));
      }
    });
    if (stmts.length > 0) await db.batch(stmts as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  }

  // Asignar el skill privado a los niños destino.
  const assigned = body.assign?.childIds ?? [];
  if (body.skill?.id && assigned.length > 0) {
    for (const childId of assigned) {
      await db.insert(childSkills).values({ childId, skillId: targetSkillId }).onConflictDoNothing();
    }
  }

  // Cierre de la solicitud (Vía B): marcar publicada + avisar al tutor por email.
  if (body.requestId) {
    const [req] = await db.select().from(contentRequests).where(eq(contentRequests.id, body.requestId)).limit(1);
    if (req) {
      // Regeneración: los skills de la publicación anterior que ya no se usan (p. ej. al pasar de 3
      // módulos a 2) se borran. Solo se aceptan skills que SEAN de esta solicitud y nunca el actual.
      const propios = await requestSkills(db, req);
      const propiosIds = new Set(propios.map((p) => p.id));
      const retirar = (body.retireSkillIds ?? []).filter((id) => propiosIds.has(id) && id !== targetSkillId);
      if (retirar.length > 0) {
        const hogar = await householdIds(db, req.ownerId);
        for (const id of retirar) await deletePrivateSkillCascade(db, id, hogar);
      }
      // Total de la solicitud (todos sus módulos, sin lo retirado), no solo el del último lote.
      const vivos = propios.map((p) => p.id).filter((id) => !retirar.includes(id));
      if (!vivos.includes(targetSkillId)) vivos.push(targetSkillId);
      const [cnt] = await db
        .select({ n: sql<number>`count(*)` })
        .from(exerciseTemplates)
        .where(and(inArray(exerciseTemplates.skillId, vivos), eq(exerciseTemplates.retired, false)));
      const exerciseCount = cnt?.n ?? parsed.length;
      await db
        .update(contentRequests)
        .set({ status: "published", skillId: targetSkillId, packageId: body.package.id, exerciseCount, publishedAt: now })
        .where(eq(contentRequests.id, body.requestId));
      const [owner] = await db.select({ email: parentAccounts.email }).from(parentAccounts).where(eq(parentAccounts.id, req.ownerId)).limit(1);
      if (owner) {
        await sendEmail(
          c.env,
          owner.email,
          "Tu contenido esta listo · smartkids",
          emailLayout("Contenido listo", `Ya hemos generado "${req.title}" (${exerciseCount} ejercicios). Entra para asignarlo o revisarlo.`, {
            url: "https://app.smart-kids.uk",
            label: "Abrir smartkids",
          }),
        );
        await db.update(contentRequests).set({ notifiedAt: new Date().toISOString() }).where(eq(contentRequests.id, body.requestId));
      }
      await notifyOwner(c.env, db, req.ownerId); // push al tutor: "contenido listo"
    }
  }

  return c.json({ ok: true, packageId: body.package.id, skillId: targetSkillId, exercises: parsed.length, offset, assigned: assigned.length });
});

// Contenido privado del hogar: lista de skills propios con conteo y niños asignados.
app.get("/api/tutor/content", async (c) => {
  const db = getDb(c.env.DB);
  const a = await requireParent(c, db);
  if (typeof a !== "string") return a;
  const household = await householdIds(db, a);
  const rows = await db
    .select({ id: skills.id, nameI18n: skills.nameI18n, subjectId: skills.subjectId, gradeBand: skills.gradeBand, pathId: skills.pathId, sessionLength: skills.sessionLength })
    .from(skills)
    .where(inArray(skills.ownerId, household));
  // Solicitud de la que sale cada skill (para ofrecer "Regenerar" desde el propio contenido).
  const reqs = await db.select({ id: contentRequests.id, skillId: contentRequests.skillId }).from(contentRequests).where(inArray(contentRequests.ownerId, household));
  const reqBySkill = new Map(reqs.filter((r) => r.skillId).map((r) => [r.skillId!, r.id]));
  const reqIds = new Set(reqs.map((r) => r.id));
  const reqByPath = new Map<string, string>();
  for (const s of rows) {
    const rid = reqBySkill.get(s.id);
    if (s.pathId && rid) reqByPath.set(s.pathId, rid);
  }
  const out: Array<Record<string, unknown>> = [];
  for (const s of rows) {
    // Solo lo VIGENTE: al republicar, lo retirado se queda en la tabla (lo referencian los intentos).
    const [cnt] = await db
      .select({ n: sql<number>`count(*)` })
      .from(exerciseTemplates)
      .where(and(eq(exerciseTemplates.skillId, s.id), eq(exerciseTemplates.retired, false)));
    const kids = await db.select({ childId: childSkills.childId }).from(childSkills).where(eq(childSkills.skillId, s.id));
    const byConvention = s.pathId?.startsWith("path_") && reqIds.has(s.pathId.slice(5)) ? s.pathId.slice(5) : null;
    const requestId = reqBySkill.get(s.id) ?? (s.pathId ? (reqByPath.get(s.pathId) ?? byConvention) : null);
    out.push({
      id: s.id,
      nameI18n: s.nameI18n,
      subjectId: s.subjectId,
      gradeBand: s.gradeBand,
      sessionLength: s.sessionLength ?? SESSION_LENGTH_DEFAULT,
      requestId,
      exercises: cnt?.n ?? 0,
      childIds: kids.map((k) => k.childId),
    });
  }
  return c.json(out);
});

// Ajustes de un skill PRIVADO del hogar que no requieren regenerar: preguntas por misión.
app.post("/api/tutor/skills/:skillId/settings", async (c) => {
  const db = getDb(c.env.DB);
  const a = await requireParent(c, db);
  if (typeof a !== "string") return a;
  const skillId = c.req.param("skillId");
  const household = await householdIds(db, a);
  const [sk] = await db.select({ ownerId: skills.ownerId }).from(skills).where(eq(skills.id, skillId)).limit(1);
  if (!sk || !sk.ownerId || !household.includes(sk.ownerId)) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json<{ sessionLength?: number }>().catch(() => ({}) as { sessionLength?: number });
  const sessionLength = clampInt(body.sessionLength, SESSION_LENGTH_MIN, SESSION_LENGTH_MAX, SESSION_LENGTH_DEFAULT);
  await db.update(skills).set({ sessionLength }).where(eq(skills.id, skillId));
  return c.json({ ok: true, sessionLength });
});

// Reasignar un skill privado del hogar a un conjunto de niños del hogar.
app.post("/api/tutor/skills/:skillId/assign", async (c) => {
  const db = getDb(c.env.DB);
  const a = await requireParent(c, db);
  if (typeof a !== "string") return a;
  const skillId = c.req.param("skillId");
  const { childIds } = await c.req.json<{ childIds: string[] }>();
  const household = await householdIds(db, a);
  const [sk] = await db.select({ ownerId: skills.ownerId }).from(skills).where(eq(skills.id, skillId)).limit(1);
  if (!sk || !sk.ownerId || !household.includes(sk.ownerId)) return c.json({ error: "forbidden" }, 403);
  const kids = await db.select({ id: childProfiles.id }).from(childProfiles).where(inArray(childProfiles.parentId, household));
  const allowed = new Set(kids.map((k) => k.id));
  const valid = (childIds ?? []).filter((id) => allowed.has(id));
  await db.delete(childSkills).where(eq(childSkills.skillId, skillId));
  for (const childId of valid) await db.insert(childSkills).values({ childId, skillId }).onConflictDoNothing();
  return c.json({ ok: true, childIds: valid });
});

// Preview del tutor: TODOS los ejercicios (incluidos los ocultos) de un skill privado del hogar, CON solución.
app.get("/api/tutor/skills/:skillId/exercises", async (c) => {
  const db = getDb(c.env.DB);
  const a = await requireParent(c, db);
  if (typeof a !== "string") return a;
  const skillId = c.req.param("skillId");
  const household = await householdIds(db, a);
  const [sk] = await db.select({ ownerId: skills.ownerId }).from(skills).where(eq(skills.id, skillId)).limit(1);
  if (!sk || !sk.ownerId || !household.includes(sk.ownerId)) return c.json({ error: "forbidden" }, 403);
  const rows = await db
    .select()
    .from(exerciseTemplates)
    .where(and(eq(exerciseTemplates.skillId, skillId), eq(exerciseTemplates.retired, false)));
  const out: Array<{ templateId: string; hidden: boolean; exercise: Exercise }> = [];
  for (const ex of rows) {
    try {
      const exercise = exerciseFromRow({
        id: ex.id,
        packageId: ex.packageId,
        skillId: ex.skillId,
        type: ex.type,
        language: ex.language,
        contentVersion: ex.contentVersion,
        stem: ex.stem,
        payload: ex.payload,
        difficultyNumeric: ex.difficultyNumeric,
        difficultyLevel: ex.difficultyLevel,
      });
      out.push({ templateId: ex.id, hidden: ex.hidden, exercise });
    } catch {
      /* plantilla no conforme al modelo: la omitimos del preview */
    }
  }
  return c.json(out);
});

// El tutor oculta/muestra un ejercicio de un skill privado del hogar (el niño solo recibe los visibles).
app.post("/api/tutor/exercises/:templateId/hidden", async (c) => {
  const db = getDb(c.env.DB);
  const a = await requireParent(c, db);
  if (typeof a !== "string") return a;
  const templateId = c.req.param("templateId");
  const { hidden } = await c.req.json<{ hidden: boolean }>();
  const [tpl] = await db.select({ skillId: exerciseTemplates.skillId }).from(exerciseTemplates).where(eq(exerciseTemplates.id, templateId)).limit(1);
  if (!tpl) return c.json({ error: "not_found" }, 404);
  const household = await householdIds(db, a);
  const [sk] = await db.select({ ownerId: skills.ownerId }).from(skills).where(eq(skills.id, tpl.skillId)).limit(1);
  if (!sk || !sk.ownerId || !household.includes(sk.ownerId)) return c.json({ error: "forbidden" }, 403);
  await db.update(exerciseTemplates).set({ hidden: Boolean(hidden) }).where(eq(exerciseTemplates.id, templateId));
  if (hidden) await closeReports(db, templateId, "hidden"); // ya no se sirve: sus avisos quedan atendidos
  return c.json({ ok: true, hidden: Boolean(hidden) });
});

// Borra un skill PRIVADO del hogar y todo su contenido (plantillas, paquete vacío, progreso, asignaciones).
app.delete("/api/tutor/skills/:skillId", async (c) => {
  const db = getDb(c.env.DB);
  const a = await requireParent(c, db);
  if (typeof a !== "string") return a;
  const skillId = c.req.param("skillId");
  const household = await householdIds(db, a);
  const [sk] = await db.select({ ownerId: skills.ownerId }).from(skills).where(eq(skills.id, skillId)).limit(1);
  if (!sk || !sk.ownerId || !household.includes(sk.ownerId)) return c.json({ error: "forbidden" }, 403);
  await deletePrivateSkillCascade(db, skillId, household);
  return c.json({ ok: true });
});

// Borra una solicitud de contenido del hogar y sus ficheros en R2. No borra el contenido ya publicado.
app.delete("/api/tutor/content-requests/:id", async (c) => {
  const db = getDb(c.env.DB);
  const a = await requireParent(c, db);
  if (typeof a !== "string") return a;
  const reqId = c.req.param("id");
  const household = await householdIds(db, a);
  const [req] = await db.select({ ownerId: contentRequests.ownerId }).from(contentRequests).where(eq(contentRequests.id, reqId)).limit(1);
  if (!req || !household.includes(req.ownerId)) return c.json({ error: "forbidden" }, 403);
  await deleteContentRequestCascade(c.env, db, reqId);
  return c.json({ ok: true });
});

// Solicitudes de contenido del hogar (Vía B) con su estado.
app.get("/api/tutor/content-requests", async (c) => {
  const db = getDb(c.env.DB);
  const a = await requireParent(c, db);
  if (typeof a !== "string") return a;
  const household = await householdIds(db, a);
  const rows = await db.select().from(contentRequests).where(inArray(contentRequests.ownerId, household)).orderBy(desc(contentRequests.createdAt));
  const out: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    const assets = await db
      .select({ id: contentRequestAssets.id, filename: contentRequestAssets.filename, kind: contentRequestAssets.kind, size: contentRequestAssets.size })
      .from(contentRequestAssets)
      .where(eq(contentRequestAssets.requestId, r.id));
    out.push({ ...r, assets });
  }
  return c.json(out);
});

/* ---------- Vía B: subida de material del tutor (R2) ---------- */

const UPLOAD_MAX_FILES = 6;
const UPLOAD_MAX_BYTES = 15 * 1024 * 1024; // 15 MB por fichero
const UPLOAD_KINDS: Record<string, "image" | "document"> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
  "image/gif": "image",
  "application/pdf": "document",
  "text/plain": "document",
  "text/markdown": "document",
};

// El tutor sube material (fotos/PDF/texto) + instrucciones -> crea una solicitud de contenido.
app.post("/api/tutor/content-requests", async (c) => {
  const db = getDb(c.env.DB);
  const a = await requireParent(c, db);
  if (typeof a !== "string") return a;
  if (!c.env.UPLOADS) return c.json({ error: "uploads_unavailable" }, 503);

  const form = await c.req.parseBody({ all: true });
  const title = String(form["title"] ?? "").trim();
  const instructions = String(form["instructions"] ?? "").trim();
  const childId = form["childId"] ? String(form["childId"]) : null;
  const subjectId = form["subjectId"] ? String(form["subjectId"]) : null;
  const cfg = requestConfigFromForm(form);

  const household = await householdIds(db, a);
  if (childId) {
    const [ch] = await db.select({ parentId: childProfiles.parentId }).from(childProfiles).where(eq(childProfiles.id, childId)).limit(1);
    if (!ch || !household.includes(ch.parentId)) return c.json({ error: "child_forbidden" }, 403);
  }

  const raw = form["files"];
  const files = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((f): f is File => f instanceof File);
  // Título opcional (la skill lo nombra con la info). Solo hace falta ALGO con lo que generar: fichero, descripción, ejemplos o al menos un título/tema.
  if (files.length === 0 && !instructions && !cfg.examples && !title) return c.json({ error: "empty_request", message: "Sube material o describe qué generar." }, 400);
  if (files.length > UPLOAD_MAX_FILES) return c.json({ error: "too_many_files" }, 400);
  for (const f of files) {
    if (!UPLOAD_KINDS[f.type]) return c.json({ error: "unsupported_type", detail: `${f.name}: ${f.type}` }, 400);
    if (f.size > UPLOAD_MAX_BYTES) return c.json({ error: "file_too_large", detail: f.name }, 400);
  }

  // Nivel del contenido: el que elija el tutor o, por defecto, el curso escolar del niño.
  const gradeBand = parseGradeBand(form["gradeBand"]) ?? (await childGradeBand(db, childId));
  const requestId = `creq_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await db.insert(contentRequests).values({ id: requestId, ownerId: a, childId, subjectId, gradeBand, title, instructions, ...cfg, status: "uploaded", createdAt: now });

  const stored: Array<{ id: string; filename: string; kind: string }> = [];
  for (const file of files) {
    const kind = UPLOAD_KINDS[file.type]!;
    const assetId = `asset_${crypto.randomUUID()}`;
    const key = `requests/${requestId}/${assetId}`;
    await c.env.UPLOADS.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
    await db.insert(contentRequestAssets).values({ id: assetId, requestId, r2Key: key, filename: file.name, contentType: file.type, kind, size: file.size, createdAt: now });
    stored.push({ id: assetId, filename: file.name, kind });
  }
  // El aviso no retiene la respuesta al tutor (y si falla, la solicitud ya está guardada).
  c.executionCtx.waitUntil(notifyAdminsContentRequest(c.env, db, title, cfg.numQuestions, false).catch(() => {}));
  return c.json({ ok: true, requestId, assets: stored });
});

// Editar una solicitud AÚN NO procesada (status 'uploaded'): cambia campos y/o AÑADE ficheros.
app.post("/api/tutor/content-requests/:id", async (c) => {
  const db = getDb(c.env.DB);
  const a = await requireParent(c, db);
  if (typeof a !== "string") return a;
  if (!c.env.UPLOADS) return c.json({ error: "uploads_unavailable" }, 503);
  const reqId = c.req.param("id");
  const household = await householdIds(db, a);
  const [req] = await db.select().from(contentRequests).where(eq(contentRequests.id, reqId)).limit(1);
  if (!req || !household.includes(req.ownerId)) return c.json({ error: "forbidden" }, 403);
  if (req.status !== "uploaded") return c.json({ error: "not_editable", message: "La solicitud ya se ha procesado." }, 409);

  const form = await c.req.parseBody({ all: true });
  const title = String(form["title"] ?? "").trim();
  const instructions = String(form["instructions"] ?? "").trim();
  const childId = form["childId"] ? String(form["childId"]) : null;
  const cfg = requestConfigFromForm(form, req);
  if (childId) {
    const [ch] = await db.select({ parentId: childProfiles.parentId }).from(childProfiles).where(eq(childProfiles.id, childId)).limit(1);
    if (!ch || !household.includes(ch.parentId)) return c.json({ error: "child_forbidden" }, 403);
  }

  const raw = form["files"];
  const newFiles = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((f): f is File => f instanceof File);
  const [cnt] = await db.select({ n: sql<number>`count(*)` }).from(contentRequestAssets).where(eq(contentRequestAssets.requestId, reqId));
  if ((cnt?.n ?? 0) + newFiles.length > UPLOAD_MAX_FILES) return c.json({ error: "too_many_files" }, 400);
  for (const f of newFiles) {
    if (!UPLOAD_KINDS[f.type]) return c.json({ error: "unsupported_type", detail: `${f.name}: ${f.type}` }, 400);
    if (f.size > UPLOAD_MAX_BYTES) return c.json({ error: "file_too_large", detail: f.name }, 400);
  }

  const now = new Date().toISOString();
  const gradeBand = form["gradeBand"] !== undefined ? (parseGradeBand(form["gradeBand"]) ?? (await childGradeBand(db, childId))) : req.gradeBand;
  await db.update(contentRequests).set({ title, instructions, childId, gradeBand, ...cfg }).where(eq(contentRequests.id, reqId));
  for (const file of newFiles) {
    const kind = UPLOAD_KINDS[file.type]!;
    const assetId = `asset_${crypto.randomUUID()}`;
    const key = `requests/${reqId}/${assetId}`;
    await c.env.UPLOADS.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
    await db.insert(contentRequestAssets).values({ id: assetId, requestId: reqId, r2Key: key, filename: file.name, contentType: file.type, kind, size: file.size, createdAt: now });
  }
  return c.json({ ok: true });
});

// Quitar un fichero de una solicitud aún no procesada.
app.delete("/api/tutor/content-requests/:id/assets/:assetId", async (c) => {
  const db = getDb(c.env.DB);
  const a = await requireParent(c, db);
  if (typeof a !== "string") return a;
  const reqId = c.req.param("id");
  const household = await householdIds(db, a);
  const [req] = await db.select({ ownerId: contentRequests.ownerId, status: contentRequests.status }).from(contentRequests).where(eq(contentRequests.id, reqId)).limit(1);
  if (!req || !household.includes(req.ownerId)) return c.json({ error: "forbidden" }, 403);
  if (req.status !== "uploaded") return c.json({ error: "not_editable" }, 409);
  const [asset] = await db
    .select()
    .from(contentRequestAssets)
    .where(and(eq(contentRequestAssets.id, c.req.param("assetId")), eq(contentRequestAssets.requestId, reqId)))
    .limit(1);
  if (!asset) return c.json({ error: "not_found" }, 404);
  await db.delete(contentRequestAssets).where(eq(contentRequestAssets.id, asset.id));
  await deleteR2IfUnreferenced(c.env, db, asset.r2Key); // puede compartirlo otra solicitud (copia regenerada)
  return c.json({ ok: true });
});

// Relanzar la generación de una solicitud YA procesada con otra configuración, SIN volver a subir el
// material (los ficheros siguen en R2):
//  - mode=replace: reabre la MISMA solicitud (vuelve a 'uploaded'). La skill republica sobre los
//    MISMOS skills (el niño conserva asignación y progreso) y retira el contenido anterior.
//  - mode=copy: crea una solicitud NUEVA que reutiliza los ficheros (mismos objetos de R2, sin
//    duplicarlos) y genera contenido aparte; el anterior se queda como está.
// Se pueden cambiar título/instrucciones/config y AÑADIR ficheros en la misma llamada.
app.post("/api/tutor/content-requests/:id/regenerate", async (c) => {
  const db = getDb(c.env.DB);
  const a = await requireParent(c, db);
  if (typeof a !== "string") return a;
  if (!c.env.UPLOADS) return c.json({ error: "uploads_unavailable" }, 503);
  const reqId = c.req.param("id");
  const household = await householdIds(db, a);
  const [req] = await db.select().from(contentRequests).where(eq(contentRequests.id, reqId)).limit(1);
  if (!req || !household.includes(req.ownerId)) return c.json({ error: "forbidden" }, 403);
  // Una pendiente se EDITA, no se regenera (aún no hay nada generado que relanzar).
  if (req.status === "uploaded" || req.status === "processing") return c.json({ error: "not_processed", message: "La solicitud aún no se ha procesado: edítala." }, 409);

  const form = await c.req.parseBody({ all: true });
  const mode = String(form["mode"] ?? "") === "copy" ? "copy" : "replace";
  const title = form["title"] !== undefined ? String(form["title"]).trim() : req.title;
  const instructions = form["instructions"] !== undefined ? String(form["instructions"]).trim() : req.instructions;
  const childId = form["childId"] ? String(form["childId"]) : req.childId;
  const cfg = requestConfigFromForm(form, req);
  const gradeBand = form["gradeBand"] !== undefined ? (parseGradeBand(form["gradeBand"]) ?? (await childGradeBand(db, childId))) : req.gradeBand;
  if (childId) {
    const [ch] = await db.select({ parentId: childProfiles.parentId }).from(childProfiles).where(eq(childProfiles.id, childId)).limit(1);
    if (!ch || !household.includes(ch.parentId)) return c.json({ error: "child_forbidden" }, 403);
  }
  const raw = form["files"];
  const newFiles = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((f): f is File => f instanceof File);
  const prevAssets = await db.select().from(contentRequestAssets).where(eq(contentRequestAssets.requestId, reqId));
  if (prevAssets.length + newFiles.length > UPLOAD_MAX_FILES) return c.json({ error: "too_many_files" }, 400);
  for (const f of newFiles) {
    if (!UPLOAD_KINDS[f.type]) return c.json({ error: "unsupported_type", detail: `${f.name}: ${f.type}` }, 400);
    if (f.size > UPLOAD_MAX_BYTES) return c.json({ error: "file_too_large", detail: f.name }, 400);
  }
  if (!title && !instructions && !cfg.examples && prevAssets.length + newFiles.length === 0) return c.json({ error: "empty_request", message: "Sube material o describe qué generar." }, 400);

  const now = new Date().toISOString();
  let targetId = reqId;
  if (mode === "replace") {
    // skill_id/package_id se CONSERVAN: son el puntero a la publicación que se va a sustituir.
    await db
      .update(contentRequests)
      .set({ title, instructions, childId, gradeBand, ...cfg, status: "uploaded", note: null, exerciseCount: null, publishedAt: null, notifiedAt: null })
      .where(eq(contentRequests.id, reqId));
  } else {
    targetId = `creq_${crypto.randomUUID()}`;
    await db.insert(contentRequests).values({
      id: targetId,
      ownerId: req.ownerId,
      childId,
      subjectId: req.subjectId,
      gradeBand,
      title,
      instructions,
      ...cfg,
      sourceRequestId: req.id,
      status: "uploaded",
      createdAt: now,
    });
    // Mismos objetos de R2 (sin copiar bytes); el borrado cuenta referencias (deleteR2IfUnreferenced).
    for (const as of prevAssets) {
      await db.insert(contentRequestAssets).values({ ...as, id: `asset_${crypto.randomUUID()}`, requestId: targetId, createdAt: now });
    }
  }
  for (const file of newFiles) {
    const kind = UPLOAD_KINDS[file.type]!;
    const assetId = `asset_${crypto.randomUUID()}`;
    const key = `requests/${targetId}/${assetId}`;
    await c.env.UPLOADS.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
    await db.insert(contentRequestAssets).values({ id: assetId, requestId: targetId, r2Key: key, filename: file.name, contentType: file.type, kind, size: file.size, createdAt: now });
  }
  c.executionCtx.waitUntil(notifyAdminsContentRequest(c.env, db, title, cfg.numQuestions, true).catch(() => {}));
  return c.json({ ok: true, requestId: targetId, mode });
});

// Máquina (skill/pipeline): lista de solicitudes con sus assets, filtrable por estado.
app.get("/api/admin/content-requests", async (c) => {
  const db = getDb(c.env.DB);
  const gate = await requireImporter(c, db);
  if (gate !== true) return gate;
  const status = c.req.query("status");
  const reqs = status
    ? await db.select().from(contentRequests).where(eq(contentRequests.status, status)).orderBy(desc(contentRequests.createdAt))
    : await db.select().from(contentRequests).orderBy(desc(contentRequests.createdAt));
  const out: Array<Record<string, unknown>> = [];
  for (const r of reqs) {
    const assets = await db
      .select({ id: contentRequestAssets.id, filename: contentRequestAssets.filename, contentType: contentRequestAssets.contentType, kind: contentRequestAssets.kind, size: contentRequestAssets.size })
      .from(contentRequestAssets)
      .where(eq(contentRequestAssets.requestId, r.id));
    // `targetExercises` = lo que hay que GENERAR (lo pedido + 50 % de variedad). `previousSkills` solo
    // viene en una regeneración EN SITIO (pendiente con publicación anterior): los skills a reutilizar.
    const previousSkills = r.status === "uploaded" && r.skillId ? await requestSkills(db, r) : [];
    // Contexto del niño destino para adaptar el nivel (sin datos personales: ni nombre ni edad).
    const child = r.childId
      ? { gradeBand: await childGradeBand(db, r.childId), courses: await childCoursesOf(db, r.childId) }
      : null;
    out.push({ ...r, targetExercises: targetExercises(r.numQuestions), regenerate: previousSkills.length > 0, previousSkills, child, assets });
  }
  return c.json(out);
});

// Máquina (skill/pipeline): descarga el binario de un asset desde R2.
app.get("/api/admin/content-requests/:id/assets/:assetId", async (c) => {
  const db = getDb(c.env.DB);
  const gate = await requireImporter(c, db);
  if (gate !== true) return gate;
  if (!c.env.UPLOADS) return c.json({ error: "uploads_unavailable" }, 503);
  const [asset] = await db
    .select()
    .from(contentRequestAssets)
    .where(and(eq(contentRequestAssets.id, c.req.param("assetId")), eq(contentRequestAssets.requestId, c.req.param("id"))))
    .limit(1);
  if (!asset) return c.json({ error: "not_found" }, 404);
  const obj = await c.env.UPLOADS.get(asset.r2Key);
  if (!obj) return c.json({ error: "not_found" }, 404);
  return new Response(obj.body, {
    headers: { "content-type": asset.contentType, "content-disposition": `inline; filename="${asset.filename}"` },
  });
});

// Arma el ejercicio que ve el cliente desde una fila de plantilla: redacta (sin solución), baraja la
// presentación y adjunta las pistas (andamiaje, seguro de enviar). Devuelve null si el payload no parsea.
function buildClientExercise(ex: typeof exerciseTemplates.$inferSelect) {
  let exercise: Exercise;
  try {
    exercise = exerciseFromRow({
      id: ex.id, packageId: ex.packageId, skillId: ex.skillId, type: ex.type, language: ex.language,
      contentVersion: ex.contentVersion, stem: ex.stem, payload: ex.payload,
      difficultyNumeric: ex.difficultyNumeric, difficultyLevel: ex.difficultyLevel,
    });
  } catch {
    return null;
  }
  const render = shuffleRender(redactForClient(exercise));
  return {
    id: ex.id,
    skillId: ex.skillId,
    type: exercise.type,
    stem: exercise.stem,
    figure: exercise.figure ?? null,
    hints: exercise.hints ?? null,
    contentVersion: ex.contentVersion,
    render,
  };
}

app.get("/api/session/next", async (c) => {
  const db = getDb(c.env.DB);
  const profileId = c.req.query("profile");
  if (!profileId) return c.json({ error: "invalid" }, 400);
  const a = await childOrOwner(c, db, profileId);
  if (typeof a !== "string") return a;

  // Reintentar / repaso dirigido a los fallos: servir un ejercicio CONCRETO por id.
  const forcedId = c.req.query("exercise");
  if (forcedId) {
    const [ex] = await db.select().from(exerciseTemplates).where(and(eq(exerciseTemplates.id, forcedId), eq(exerciseTemplates.hidden, false), eq(exerciseTemplates.retired, false))).limit(1);
    if (!ex) return c.json({ error: "no exercise found" }, 404);
    if (!(await childCanAttemptSkill(db, profileId, ex.skillId))) return c.json({ error: "no_course_access" }, 403);
    const out = buildClientExercise(ex);
    return out ? c.json(out) : c.json({ error: "no exercise found" }, 404);
  }

  // Sin default: apuntaba a un skill del seed de demo (MATH.ESO5.FRAC.ADD) que ni siquiera
  // existe en producción. Si el cliente no dice qué practicar, es un error suyo.
  const skillId = c.req.query("skill");
  if (!skillId) return c.json({ error: "invalid" }, 400);
  // El niño solo puede practicar skills de un curso al que tiene acceso.
  if (!(await childCanAttemptSkill(db, profileId, skillId))) return c.json({ error: "no_course_access" }, 403);

  // Banco LIGERO del skill: solo id + tipo, sin payload. Con bancos de cientos de ejercicios, traer
  // y parsear todos los payloads en cada pregunta se comía la CPU de la invocación.
  // Excluye las ocultas por el tutor y las retiradas al republicar: el niño no las recibe.
  const bank = await db
    .select({ id: exerciseTemplates.id, type: exerciseTemplates.type })
    .from(exerciseTemplates)
    .where(and(eq(exerciseTemplates.skillId, skillId), eq(exerciseTemplates.hidden, false), eq(exerciseTemplates.retired, false)))
    .limit(1000);
  if (bank.length === 0) return c.json({ error: "no exercise found" }, 404);
  const typeOf = new Map(bank.map((b) => [b.id, b.type]));

  // Lo ya servido en ESTA sesión, en orden (lo manda el cliente): no se repite y marca la variedad de tipos.
  const served = (c.req.query("exclude") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const servedSet = new Set(served);
  const typeCount = new Map<string, number>();
  for (const id of served) {
    const t = typeOf.get(id);
    if (t) typeCount.set(t, (typeCount.get(t) ?? 0) + 1);
  }
  const lastType = typeOf.get(served[served.length - 1] ?? "");

  // Historial del niño en este skill, por plantilla: nº de fallos, cuándo la vio por última vez y cuándo
  // la falló y la acertó por última vez.
  const hist = await db
    .select({
      tid: attempts.exerciseTemplateId,
      fails: sql<number>`sum(case when ${attempts.correct} = 1 then 0 else 1 end)`,
      lastTs: sql<string>`max(${attempts.ts})`,
      lastFailTs: sql<string | null>`max(case when ${attempts.correct} = 1 then null else ${attempts.ts} end)`,
      lastOkTs: sql<string | null>`max(case when ${attempts.correct} = 1 then ${attempts.ts} else null end)`,
    })
    .from(attempts)
    .where(and(eq(attempts.profileId, profileId), eq(attempts.skillId, skillId)))
    .groupBy(attempts.exerciseTemplateId);
  const histOf = new Map(hist.map((h) => [h.tid, h]));
  const recent = new Set([...hist].sort((x, y) => (x.lastTs < y.lastTs ? 1 : -1)).slice(0, 20).map((h) => h.tid));
  // Lo pendiente (ver esPendiente) sigue saliendo con prioridad hasta que lo acierte en otra tanda.
  const isDebt = (id: string) => {
    const h = histOf.get(id);
    return esPendiente(h?.lastFailTs, h?.lastOkTs);
  };

  // Selección ALEATORIA pero PRIORIZADA (nunca un orden fijo):
  //  1) Con probabilidad PRIORIDAD_FALLOS se sortea entre los ejercicios "pendientes" (fallados y aún
  //     sin acertar en otra tanda), con más peso cuantos más fallos acumula.
  //  2) Si no, entre el resto: lo fallado alguna vez pesa más que lo nuevo, y lo nuevo más que lo
  //     siempre acertado; lo visto hace poco descansa.
  //  En ambos casos se penaliza repetir tipo para que la misión alterne formatos.
  const variedad = (type: string) => Math.pow(0.6, typeCount.get(type) ?? 0) * (type === lastType ? 0.5 : 1);
  const pesoPendiente = (b: { id: string; type: string }) => (1 + Math.min(Number(histOf.get(b.id)?.fails ?? 1), 5)) * variedad(b.type);
  const pesoResto = (b: { id: string; type: string }) => {
    const h = histOf.get(b.id);
    let w = !h ? 2 : Number(h.fails) > 0 ? 3 : 1;
    if (recent.has(b.id)) w *= 0.15;
    return w * variedad(b.type);
  };
  let candidatos = bank.filter((b) => !servedSet.has(b.id));
  if (candidatos.length === 0) candidatos = [...bank]; // banco agotado en esta sesión: se permite repetir

  while (candidatos.length > 0) {
    const pendientes = candidatos.filter((b) => isDebt(b.id));
    const resto = candidatos.filter((b) => !isDebt(b.id));
    const usarPendientes = pendientes.length > 0 && (resto.length === 0 || Math.random() < PRIORIDAD_FALLOS);
    const elegido = usarPendientes ? sorteoPonderado(pendientes, pesoPendiente) : sorteoPonderado(resto, pesoResto);
    if (!elegido) break;
    const [row] = await db.select().from(exerciseTemplates).where(eq(exerciseTemplates.id, elegido.id)).limit(1);
    const out = row ? buildClientExercise(row) : null;
    if (out) {
      const [sk] = await db.select({ sessionLength: skills.sessionLength }).from(skills).where(eq(skills.id, skillId)).limit(1);
      // Nunca más preguntas por misión que ejercicios tiene el banco: la tanda repetiría preguntas.
      return c.json({ ...out, sessionLength: Math.min(sk?.sessionLength ?? SESSION_LENGTH_DEFAULT, bank.length) });
    }
    candidatos = candidatos.filter((b) => b.id !== elegido.id); // no parsea al modelo: se descarta
  }
  return c.json({ error: "no exercise found" }, 404);
});

/** Proporción de preguntas que salen de lo pendiente (fallado y sin acertar en otra tanda) mientras quede algo. */
const PRIORIDAD_FALLOS = 0.7;

/** Elige un elemento al azar con probabilidad proporcional a su peso. */
function sorteoPonderado<T>(items: T[], peso: (x: T) => number): T | undefined {
  if (items.length === 0) return undefined;
  const pesos = items.map((x) => Math.max(0, peso(x)));
  const total = pesos.reduce((acc, w) => acc + w, 0);
  if (!(total > 0)) return items[Math.floor(Math.random() * items.length)];
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= pesos[i]!;
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

app.post("/api/session/attempt", async (c) => {
  const db = getDb(c.env.DB);
  const body = await c.req.json<{
    profileId: string;
    exerciseTemplateId: string;
    answer?: unknown;
    selectedOptionId?: string; // compat: cliente antiguo (solo opción múltiple)
    responseTimeMs?: number;
    clientAttemptId?: string; // idempotencia: mismo id = mismo intento (los reintentos de red no duplican)
  }>();
  if (!body?.profileId || !body?.exerciseTemplateId) return c.json({ error: "invalid body" }, 400);
  const a = await childOrOwner(c, db, body.profileId);
  if (typeof a !== "string") return a;

  // Fuente de verdad: la plantilla del ejercicio. El skill se DERIVA de ella (no se confía en el cliente).
  // Se excluyen las RETIRADAS y las OCULTAS: los ids son adivinables (`<paquete>_<n>`) y las
  // retiradas se acumulan para siempre, así que sin este filtro cualquiera podría puntuar y cobrar
  // monedas con ejercicios que el motor no sirve nunca.
  const [tpl] = await db
    .select()
    .from(exerciseTemplates)
    .where(and(eq(exerciseTemplates.id, body.exerciseTemplateId), eq(exerciseTemplates.retired, false), eq(exerciseTemplates.hidden, false)))
    .limit(1);
  if (!tpl) return c.json({ error: "exercise not found" }, 404);
  const skillId = tpl.skillId;
  if (!(await childCanAttemptSkill(db, body.profileId, skillId))) return c.json({ error: "no_course_access" }, 403);

  // El acierto lo decide el SERVIDOR: reconstruye el ejercicio (con solución) y corrige con el modelo unificado.
  let exercise: Exercise;
  try {
    exercise = exerciseFromRow({
      id: tpl.id,
      packageId: tpl.packageId,
      skillId: tpl.skillId,
      type: tpl.type,
      language: tpl.language,
      contentVersion: tpl.contentVersion,
      stem: tpl.stem,
      payload: tpl.payload,
      difficultyNumeric: tpl.difficultyNumeric,
      difficultyLevel: tpl.difficultyLevel,
    });
  } catch {
    return c.json({ error: "invalid_template" }, 500);
  }

  // Compat: un cliente antiguo envía selectedOptionId (solo opción múltiple).
  const answerRaw =
    body.answer ??
    (typeof body.selectedOptionId === "string" ? { type: "multiple_choice", optionId: body.selectedOptionId } : undefined);
  const parsedAns = AnswerSchema.safeParse(answerRaw);
  if (!parsedAns.success) return c.json({ error: "invalid_answer" }, 400);

  const result = grade(exercise, parsedAns.data);
  const correct = result.correct;
  const now = new Date().toISOString();

  // Veredicto base: idéntico ante un reintento porque grade() es puro.
  const baseResult = {
    correct,
    correctAnswer: result.correctAnswer,
    parts: result.parts ?? null,
    feedback: correct ? (exercise.feedback?.correct ?? null) : (exercise.feedback?.incorrect ?? null),
    solution: exercise.feedback?.solution ?? null,
    theory: exercise.feedback?.theory ?? null, // el porqué: se enseña sobre todo al fallar
  };

  // Idempotencia: tras un microcorte de red el cliente puede reenviar el MISMO intento. Usamos
  // clientAttemptId como PK del intento; si ya existía, devolvemos el mismo veredicto SIN volver a
  // mutar progreso ni conceder monedas (el registro del intento es la barrera atómica).
  const attemptId = body.clientAttemptId && UUID_RE.test(body.clientAttemptId) ? body.clientAttemptId : crypto.randomUUID();
  const insertedAttempt = await db
    .insert(attempts)
    .values({
      id: attemptId,
      profileId: body.profileId,
      skillId,
      exerciseTemplateId: body.exerciseTemplateId,
      contentVersion: tpl.contentVersion,
      correct,
      responseTimeMs: body.responseTimeMs ?? null,
      difficultyServed: tpl.difficultyNumeric ?? null,
      ts: now,
      answerGiven: parsedAns.data,
    })
    .onConflictDoNothing()
    .returning({ id: attempts.id });

  if (insertedAttempt.length === 0) {
    // Reenvío de un intento ya registrado: mismo veredicto, cero monedas nuevas, saldo/estado actuales.
    const [prog] = await db
      .select({ mastery: skillProgress.masteryScore, consecutive: skillProgress.consecutiveCorrect, status: skillProgress.status })
      .from(skillProgress)
      .where(and(eq(skillProgress.profileId, body.profileId), eq(skillProgress.skillId, skillId)))
      .limit(1);
    const [w] = await db.select({ balance: wallets.balance }).from(wallets).where(eq(wallets.profileId, body.profileId)).limit(1);
    return c.json({
      ...baseResult,
      coinsAwarded: 0,
      balance: w?.balance ?? 0,
      masteryScore: prog?.mastery ?? 0,
      consecutiveCorrect: prog?.consecutive ?? 0,
      status: prog?.status ?? "inProgress",
      replay: true,
    });
  }

  // Anti-farm ATÓMICO: la PK compuesta de coin_awards concede monedas una sola vez por (niño, ejercicio).
  let firstCorrect = false;
  if (correct) {
    const inserted = await db
      .insert(coinAwards)
      .values({ profileId: body.profileId, exerciseTemplateId: body.exerciseTemplateId, ts: now })
      .onConflictDoNothing()
      .returning({ p: coinAwards.profileId });
    firstCorrect = inserted.length > 0;
  }

  const [prev] = await db
    .select()
    .from(skillProgress)
    .where(and(eq(skillProgress.profileId, body.profileId), eq(skillProgress.skillId, skillId)))
    .limit(1);
  const oldMastery = prev?.masteryScore ?? 0;
  const newMastery = correct ? Math.min(1, oldMastery + 0.12 * (1 - oldMastery)) : Math.max(0, oldMastery - 0.08);
  const consecutive = correct ? (prev?.consecutiveCorrect ?? 0) + 1 : 0;
  const total = (prev?.totalAttempts ?? 0) + 1;
  const status = newMastery >= 0.85 ? "mastered" : "inProgress";

  await db
    .insert(skillProgress)
    .values({ profileId: body.profileId, skillId, masteryScore: newMastery, consecutiveCorrect: consecutive, totalAttempts: total, status })
    .onConflictDoUpdate({
      target: [skillProgress.profileId, skillProgress.skillId],
      set: { masteryScore: newMastery, consecutiveCorrect: consecutive, totalAttempts: total, status },
    });

  const [skRow] = await db.select({ coins: skills.coinsPerCorrect }).from(skills).where(eq(skills.id, skillId)).limit(1);
  const coins = firstCorrect ? (skRow?.coins ?? COINS_PER_CORRECT) : 0;
  if (coins > 0) {
    await db
      .insert(wallets)
      .values({ profileId: body.profileId, balance: coins })
      .onConflictDoUpdate({ target: wallets.profileId, set: { balance: sql`${wallets.balance} + ${coins}` } });
    await db.insert(walletLedger).values({ id: crypto.randomUUID(), profileId: body.profileId, delta: coins, reason: `exercise:${skillId}`, ts: now });
  }

  const [wallet] = await db.select().from(wallets).where(eq(wallets.profileId, body.profileId)).limit(1);
  return c.json({
    ...baseResult,
    coinsAwarded: coins,
    balance: wallet?.balance ?? 0,
    masteryScore: newMastery,
    consecutiveCorrect: consecutive,
    status,
  });
});

// «Esta pregunta está mal»: el niño marca un ejercicio que acaba de responder. Solo se puede marcar lo
// que ya ha intentado, y su respuesta y el veredicto los copia el SERVIDOR de `attempts` (no el cliente).
// Uno por (niño, ejercicio): volver a marcarlo lo reabre, así que no se puede inundar al tutor.
app.post("/api/session/report", async (c) => {
  const db = getDb(c.env.DB);
  const body = await c.req.json<{ profileId?: string; exerciseTemplateId?: string; reason?: string }>().catch(() => null);
  if (!body?.profileId || !body.exerciseTemplateId) return c.json({ error: "invalid body" }, 400);
  const reason = body.reason && Object.hasOwn(REPORT_REASON_ES, body.reason) ? body.reason : null;
  if (!reason) return c.json({ error: "invalid_reason" }, 400);
  const a = await childOrOwner(c, db, body.profileId);
  if (typeof a !== "string") return a;
  const [tpl] = await db
    .select({ skillId: exerciseTemplates.skillId })
    .from(exerciseTemplates)
    .where(and(eq(exerciseTemplates.id, body.exerciseTemplateId), eq(exerciseTemplates.retired, false)))
    .limit(1);
  if (!tpl) return c.json({ error: "exercise not found" }, 404);
  if (!(await childCanAttemptSkill(db, body.profileId, tpl.skillId))) return c.json({ error: "no_course_access" }, 403);
  const [last] = await db
    .select({ answer: attempts.answerGiven, correct: attempts.correct })
    .from(attempts)
    .where(and(eq(attempts.profileId, body.profileId), eq(attempts.exerciseTemplateId, body.exerciseTemplateId)))
    .orderBy(desc(attempts.ts))
    .limit(1);
  if (!last) return c.json({ error: "not_attempted" }, 409);
  const fila = { reason, answerGiven: last.answer ?? null, correct: last.correct, status: "open", createdAt: new Date().toISOString(), resolvedAt: null };
  await db
    .insert(exerciseReports)
    .values({ profileId: body.profileId, exerciseTemplateId: body.exerciseTemplateId, ...fila })
    .onConflictDoUpdate({ target: [exerciseReports.profileId, exerciseReports.exerciseTemplateId], set: fila });
  return c.json({ ok: true });
});

app.get("/api/rewards", async (c) => {
  const db = getDb(c.env.DB);
  const kid = await currentChildId(c, db);
  const parentId = await currentParentId(c, db);
  if (kid) {
    // El niño solo ve las recompensas asignadas Y del hogar de su tutor, con su progreso/límite calculados.
    const [childRow] = await db.select({ parentId: childProfiles.parentId }).from(childProfiles).where(eq(childProfiles.id, kid)).limit(1);
    const household = childRow ? await householdIds(db, childRow.parentId) : [];
    const rows = await db
      .select({
        id: rewards.id,
        ownerId: rewards.ownerId,
        cost: rewards.cost,
        type: rewards.type,
        kind: rewards.kind,
        period: rewards.period,
        limitCount: rewards.limitCount,
        limitPeriod: rewards.limitPeriod,
        icon: rewards.icon,
        nameI18n: rewards.nameI18n,
      })
      .from(rewards)
      .innerJoin(childRewards, eq(childRewards.rewardId, rewards.id))
      .where(eq(childRewards.childId, kid));
    const out = [];
    for (const r of rows) {
      if (!r.ownerId || !household.includes(r.ownerId)) continue; // solo recompensas del hogar del niño
      const redeemedInWindow = r.limitCount != null ? await redemptionsSince(db, kid, r.id, periodStartIso(r.limitPeriod)) : 0;
      const limitOk = r.limitCount == null || redeemedInWindow < r.limitCount;
      let progress: number | null = null;
      let claimable = limitOk;
      if (r.kind === "goal") {
        progress = await earnedSince(db, kid, periodStartIso(r.period));
        claimable = limitOk && progress >= r.cost;
      }
      out.push({ id: r.id, cost: r.cost, type: r.type, kind: r.kind, period: r.period, limitCount: r.limitCount, limitPeriod: r.limitPeriod, icon: r.icon, nameI18n: r.nameI18n, progress, claimable, redeemedInWindow });
    }
    return c.json(out);
  }
  if (!parentId) return c.json({ error: "unauthorized" }, 401);
  // El tutor ve las recompensas de su hogar (las suyas y las del cónyuge).
  const ids = await householdIds(db, parentId);
  return c.json(await db.select().from(rewards).where(inArray(rewards.ownerId, ids)));
});

app.post("/api/rewards/:id/redeem", async (c) => {
  const db = getDb(c.env.DB);
  const rewardId = c.req.param("id");
  const { profileId } = await c.req.json<{ profileId: string }>();
  const a = await childOrOwner(c, db, profileId);
  if (typeof a !== "string") return a;
  const [reward] = await db.select().from(rewards).where(eq(rewards.id, rewardId)).limit(1);
  if (!reward) return c.json({ error: "reward not found" }, 404);
  // La recompensa debe estar asignada a este niño (no se puede canjear una ajena por id).
  const [assigned] = await db
    .select({ r: childRewards.rewardId })
    .from(childRewards)
    .where(and(eq(childRewards.childId, profileId), eq(childRewards.rewardId, rewardId)))
    .limit(1);
  if (!assigned) return c.json({ error: "forbidden" }, 403);
  // La recompensa debe pertenecer al HOGAR del niño (defensa ante asignaciones cruzadas, p.ej. tras desvincular cónyuge).
  const [childRow] = await db.select({ parentId: childProfiles.parentId, displayName: childProfiles.displayName }).from(childProfiles).where(eq(childProfiles.id, profileId)).limit(1);
  const household = childRow ? await householdIds(db, childRow.parentId) : [];
  if (!reward.ownerId || !household.includes(reward.ownerId)) return c.json({ error: "forbidden" }, 403);
  const childName = childRow?.displayName ?? "Tu hijo/a";
  const rn = (reward.nameI18n ?? {}) as Record<string, string>;
  const rewardName = rn.es ?? Object.values(rn)[0] ?? "una recompensa";
  // Límite de canjes en la ventana configurada (p.ej. una vez, o N al mes).
  if (reward.limitCount != null) {
    const cnt = await redemptionsSince(db, profileId, rewardId, periodStartIso(reward.limitPeriod));
    if (cnt >= reward.limitCount) return c.json({ error: "limit_reached", message: "Ya lo has canjeado el máximo de veces." }, 409);
  }
  const now = new Date().toISOString();
  // Las recompensas del mundo real (definidas por el tutor / vouchers) quedan pendientes de que la familia las conceda.
  const inApp = reward.type === "cosmetic" || reward.type === "streak_freeze";
  const status = inApp ? "applied" : "pending";
  const slim = { id: reward.id, cost: reward.cost, kind: reward.kind, icon: reward.icon, nameI18n: reward.nameI18n };
  if (reward.kind === "goal") {
    // Objetivo por acumulación: exige puntos GANADOS en la ventana; NO descuenta el monedero.
    const earned = await earnedSince(db, profileId, periodStartIso(reward.period));
    if (earned < reward.cost) return c.json({ error: "goal_not_reached", message: "Aún no has alcanzado el objetivo.", earned, target: reward.cost }, 400);
    await db.insert(redemptions).values({ id: crypto.randomUUID(), profileId, rewardId, status, ts: now });
    if (status === "pending") await notifyPendingRedemption(c.env, db, household, childName, rewardName); // push + email
    const [w] = await db.select({ balance: wallets.balance }).from(wallets).where(eq(wallets.profileId, profileId)).limit(1);
    return c.json({ ok: true, balance: w?.balance ?? 0, status, reward: slim });
  }
  // Canjeable: decremento ATÓMICO condicional (evita doble gasto en concurrencia).
  const updated = await db
    .update(wallets)
    .set({ balance: sql`${wallets.balance} - ${reward.cost}` })
    .where(and(eq(wallets.profileId, profileId), gte(wallets.balance, reward.cost)))
    .returning({ balance: wallets.balance });
  if (!updated.length) return c.json({ error: "insufficient_funds" }, 400);
  const newBalance = updated[0]!.balance;
  await db.insert(walletLedger).values({ id: crypto.randomUUID(), profileId, delta: -reward.cost, reason: `redeem:${rewardId}`, ts: now });
  await db.insert(redemptions).values({ id: crypto.randomUUID(), profileId, rewardId, status, ts: now });
  if (status === "pending") for (const pid of household) await notifyOwner(c.env, db, pid); // push: "canje pendiente"
  return c.json({ ok: true, balance: newBalance, status, reward: slim });
});

/* ================= Tutor: recompensas (definidas por el tutor, asignadas por niño) ================= */

app.get("/api/tutor/rewards", async (c) => {
  const db = getDb(c.env.DB);
  const parentId = await requireParent(c, db);
  if (typeof parentId !== "string") return parentId;
  const ids = await householdIds(db, parentId);
  const rows = await db.select().from(rewards).where(inArray(rewards.ownerId, ids));
  const out = [];
  for (const r of rows) {
    const links = await db.select({ childId: childRewards.childId }).from(childRewards).where(eq(childRewards.rewardId, r.id));
    out.push({ id: r.id, cost: r.cost, kind: r.kind, period: r.period, limitCount: r.limitCount, limitPeriod: r.limitPeriod, icon: r.icon, nameI18n: r.nameI18n, childIds: links.map((l) => l.childId) });
  }
  return c.json(out);
});

app.post("/api/tutor/rewards", async (c) => {
  const db = getDb(c.env.DB);
  const parentId = await requireParent(c, db);
  if (typeof parentId !== "string") return parentId;
  const body = await c.req.json<{ name?: string; cost?: number; icon?: string; childIds?: string[]; kind?: string; period?: string; limitCount?: number | null; limitPeriod?: string }>();
  const name = body.name?.trim();
  const cost = Math.floor(Number(body.cost));
  if (!name || !Number.isFinite(cost) || cost < 1) return c.json({ error: "invalid", message: "Nombre y coste (>= 1) requeridos." }, 400);
  const kind = body.kind === "goal" ? "goal" : "spend";
  const period = kind === "goal" ? (body.period && GOAL_PERIODS.includes(body.period) ? body.period : "month") : null;
  let limitCount = body.limitCount != null && Number.isFinite(Number(body.limitCount)) && Number(body.limitCount) > 0 ? Math.floor(Number(body.limitCount)) : null;
  let limitPeriod = body.limitPeriod === "week" || body.limitPeriod === "month" ? body.limitPeriod : "all";
  // Un objetivo siempre lleva límite (si no, sería reclamable infinitas veces): por defecto una vez por su periodo.
  if (kind === "goal" && limitCount == null) {
    limitCount = 1;
    limitPeriod = period ?? "month";
  }
  const ids = await householdIds(db, parentId);
  const validKids = new Set((await db.select({ id: childProfiles.id }).from(childProfiles).where(inArray(childProfiles.parentId, ids))).map((k) => k.id));
  const childIds = (body.childIds ?? []).filter((k) => validKids.has(k));
  const id = `rw_${crypto.randomUUID()}`;
  await db.insert(rewards).values({ id, ownerId: parentId, cost, type: "manual", kind, period, limitCount, limitPeriod, icon: body.icon ?? "gift", payload: null, nameI18n: { es: name, en: name } });
  for (const cid of childIds) await db.insert(childRewards).values({ childId: cid, rewardId: id });
  return c.json({ reward: { id, name, cost } });
});

app.patch("/api/tutor/rewards/:id", async (c) => {
  const db = getDb(c.env.DB);
  const parentId = await requireParent(c, db);
  if (typeof parentId !== "string") return parentId;
  const id = c.req.param("id");
  const ids = await householdIds(db, parentId);
  const [r] = await db.select({ ownerId: rewards.ownerId, kind: rewards.kind, period: rewards.period, limitCount: rewards.limitCount }).from(rewards).where(eq(rewards.id, id)).limit(1);
  if (!r || !r.ownerId || !ids.includes(r.ownerId)) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json<{ name?: string; cost?: number; icon?: string; childIds?: string[]; kind?: string; period?: string; limitCount?: number | null; limitPeriod?: string }>();
  const patch: { nameI18n?: Record<string, string>; cost?: number; icon?: string; kind?: string; period?: string | null; limitCount?: number | null; limitPeriod?: string } = {};
  if (body.name?.trim()) patch.nameI18n = { es: body.name.trim(), en: body.name.trim() };
  if (body.cost != null && Number.isFinite(Number(body.cost))) patch.cost = Math.max(1, Math.floor(Number(body.cost)));
  if (body.icon) patch.icon = body.icon;
  if (body.kind === "spend" || body.kind === "goal") {
    patch.kind = body.kind;
    patch.period = body.kind === "goal" ? (body.period && GOAL_PERIODS.includes(body.period) ? body.period : "month") : null;
  }
  if ("limitCount" in body) patch.limitCount = body.limitCount != null && Number(body.limitCount) > 0 ? Math.floor(Number(body.limitCount)) : null;
  if (body.limitPeriod === "week" || body.limitPeriod === "month" || body.limitPeriod === "all") patch.limitPeriod = body.limitPeriod;
  // Invariante: un objetivo siempre lleva límite (si no, sería reclamable infinitas veces).
  const resultKind = patch.kind ?? r.kind;
  const resultLimit = "limitCount" in body ? patch.limitCount ?? null : r.limitCount;
  if (resultKind === "goal" && resultLimit == null) {
    patch.limitCount = 1;
    patch.limitPeriod = (patch.period ?? r.period) ?? "month";
  }
  if (Object.keys(patch).length) await db.update(rewards).set(patch).where(eq(rewards.id, id));
  if (body.childIds) {
    const validKids = new Set((await db.select({ id: childProfiles.id }).from(childProfiles).where(inArray(childProfiles.parentId, ids))).map((k) => k.id));
    await db.delete(childRewards).where(eq(childRewards.rewardId, id));
    for (const cid of body.childIds.filter((k) => validKids.has(k))) await db.insert(childRewards).values({ childId: cid, rewardId: id });
  }
  return c.json({ ok: true });
});

app.delete("/api/tutor/rewards/:id", async (c) => {
  const db = getDb(c.env.DB);
  const parentId = await requireParent(c, db);
  if (typeof parentId !== "string") return parentId;
  const id = c.req.param("id");
  const ids = await householdIds(db, parentId);
  const [r] = await db.select({ ownerId: rewards.ownerId }).from(rewards).where(eq(rewards.id, id)).limit(1);
  if (!r || !r.ownerId || !ids.includes(r.ownerId)) return c.json({ error: "not_found" }, 404);
  await deleteRewardCascade(db, id);
  return c.json({ ok: true });
});

/* ================= Tutor: canjes pendientes de conceder ================= */

app.get("/api/tutor/redemptions", async (c) => {
  const db = getDb(c.env.DB);
  const parentId = await requireParent(c, db);
  if (typeof parentId !== "string") return parentId;
  const ids = await householdIds(db, parentId);
  const kidRows = await db.select({ id: childProfiles.id, name: childProfiles.displayName }).from(childProfiles).where(inArray(childProfiles.parentId, ids));
  if (!kidRows.length) return c.json([]);
  const kidIds = kidRows.map((k) => k.id);
  const nameById = new Map(kidRows.map((k) => [k.id, k.name]));
  const rows = await db
    .select({ id: redemptions.id, profileId: redemptions.profileId, ts: redemptions.ts, rewardName: rewards.nameI18n, kind: rewards.kind, cost: rewards.cost })
    .from(redemptions)
    .innerJoin(rewards, eq(rewards.id, redemptions.rewardId))
    .where(and(inArray(redemptions.profileId, kidIds), eq(redemptions.status, "pending")))
    .orderBy(asc(redemptions.ts));
  return c.json(rows.map((r) => ({ id: r.id, childName: nameById.get(r.profileId) ?? "", rewardName: r.rewardName, kind: r.kind, cost: r.cost, ts: r.ts })));
});

app.post("/api/tutor/redemptions/:id/grant", async (c) => {
  const db = getDb(c.env.DB);
  const parentId = await requireParent(c, db);
  if (typeof parentId !== "string") return parentId;
  const id = c.req.param("id");
  const [r] = await db.select({ profileId: redemptions.profileId }).from(redemptions).where(eq(redemptions.id, id)).limit(1);
  if (!r) return c.json({ error: "not_found" }, 404);
  if (!(await ownsProfile(db, parentId, r.profileId))) return c.json({ error: "forbidden" }, 403);
  await db.update(redemptions).set({ status: "granted" }).where(eq(redemptions.id, id));
  return c.json({ ok: true });
});

app.post("/api/tutor/redemptions/:id/reject", async (c) => {
  const db = getDb(c.env.DB);
  const parentId = await requireParent(c, db);
  if (typeof parentId !== "string") return parentId;
  const id = c.req.param("id");
  const [r] = await db.select({ profileId: redemptions.profileId, status: redemptions.status, rewardId: redemptions.rewardId }).from(redemptions).where(eq(redemptions.id, id)).limit(1);
  if (!r) return c.json({ error: "not_found" }, 404);
  if (!(await ownsProfile(db, parentId, r.profileId))) return c.json({ error: "forbidden" }, 403);
  if (r.status !== "pending") return c.json({ ok: true });
  // Si era una recompensa canjeable, se reembolsan los puntos gastados.
  const [rw] = await db.select({ kind: rewards.kind, cost: rewards.cost }).from(rewards).where(eq(rewards.id, r.rewardId)).limit(1);
  if (rw && rw.kind === "spend" && rw.cost > 0) {
    await db.update(wallets).set({ balance: sql`${wallets.balance} + ${rw.cost}` }).where(eq(wallets.profileId, r.profileId));
    await db.insert(walletLedger).values({ id: crypto.randomUUID(), profileId: r.profileId, delta: rw.cost, reason: `refund:${r.rewardId}`, ts: new Date().toISOString() });
  }
  await db.update(redemptions).set({ status: "rejected" }).where(eq(redemptions.id, id));
  return c.json({ ok: true });
});

/* ================= SPA ================= */

app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

/* ================= Cron: engagement proactivo (resumen semanal + inactividad) ================= */

// Se ejecuta desde el trigger cron (ver wrangler.toml). Idempotente por día gracias a los anti-spam
// digestAt (tutor) e inactivityNotifiedAt (niño): puede dispararse a diario sin duplicar avisos.
async function runDailyJobs(env: Env): Promise<void> {
  const db = getDb(env.DB);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const APP_URL = "https://app.smart-kids.uk";

  // 1) Alerta de inactividad: niño que YA practicó pero lleva >= 3 días parado (máx. 1 aviso/semana).
  const kids = await db
    .select({ id: childProfiles.id, name: childProfiles.displayName, parentId: childProfiles.parentId, notified: childProfiles.inactivityNotifiedAt })
    .from(childProfiles);
  for (const kid of kids) {
    const [last] = await db.select({ ts: sql<string | null>`max(${attempts.ts})` }).from(attempts).where(eq(attempts.profileId, kid.id));
    const lastTs = last?.ts ? Date.parse(last.ts) : null;
    if (lastTs == null) continue; // nunca practicó: no molestamos (puede ser recién creado)
    if ((now - lastTs) / 86400000 < 3) continue;
    if (kid.notified && now - Date.parse(kid.notified) < 7 * 86400000) continue;
    const household = await householdIds(db, kid.parentId);
    const parents = await db.select({ email: parentAccounts.email }).from(parentAccounts).where(inArray(parentAccounts.id, household));
    const days = Math.floor((now - lastTs) / 86400000);
    const html = emailLayout(
      "Hace días que no practica",
      `<b>${kid.name}</b> lleva ${days} días sin hacer ejercicios. Un pequeño empujón suele bastar para retomar la rutina.`,
      { url: APP_URL, label: "Abrir smartkids" },
    );
    for (const p of parents) await sendEmail(env, p.email, `smartkids · ${kid.name} lleva días sin practicar`, html);
    for (const pid of household) await notifyOwner(env, db, pid);
    await db.update(childProfiles).set({ inactivityNotifiedAt: nowIso }).where(eq(childProfiles.id, kid.id));
  }

  // 2) Resumen semanal por tutor (a lo sumo una vez cada ~7 días), con tema atascado si lo hay.
  const tutors = await db.select().from(parentAccounts).where(eq(parentAccounts.role, "tutor"));
  const weekAgo = new Date(now - 7 * 86400000).toISOString();
  for (const tutor of tutors) {
    if (tutor.digestAt && now - Date.parse(tutor.digestAt) < 6.5 * 86400000) continue;
    const household = await householdIds(db, tutor.id);
    const kidsH = await db.select({ id: childProfiles.id, name: childProfiles.displayName }).from(childProfiles).where(inArray(childProfiles.parentId, household));
    if (!kidsH.length) {
      await db.update(parentAccounts).set({ digestAt: nowIso }).where(eq(parentAccounts.id, tutor.id));
      continue;
    }
    const lines: string[] = [];
    for (const kid of kidsH) {
      const [agg] = await db
        .select({ n: sql<number>`count(*)`, ok: sql<number>`sum(case when ${attempts.correct} then 1 else 0 end)` })
        .from(attempts)
        .where(and(eq(attempts.profileId, kid.id), gte(attempts.ts, weekAgo)));
      const n = Number(agg?.n ?? 0);
      if (n === 0) {
        lines.push(`<li><b>${kid.name}</b>: sin práctica esta semana.</li>`);
        continue;
      }
      const acc = Math.round((Number(agg?.ok ?? 0) / n) * 100);
      const bySkill = await db
        .select({ sk: attempts.skillId, n: sql<number>`count(*)`, ok: sql<number>`sum(case when ${attempts.correct} then 1 else 0 end)` })
        .from(attempts)
        .where(and(eq(attempts.profileId, kid.id), gte(attempts.ts, weekAgo)))
        .groupBy(attempts.skillId);
      const worst = bySkill
        .filter((s) => Number(s.n) >= 5 && Number(s.ok) / Number(s.n) < 0.5)
        .sort((a, b) => Number(a.ok) / Number(a.n) - Number(b.ok) / Number(b.n))[0];
      let extra = "";
      if (worst) {
        const [sn] = await db.select({ name: skills.nameI18n }).from(skills).where(eq(skills.id, worst.sk)).limit(1);
        const nm = sn ? (sn.name as Record<string, string>).es ?? Object.values(sn.name as Record<string, string>)[0] ?? worst.sk : worst.sk;
        extra = ` · atascado en ${nm}`;
      }
      lines.push(`<li><b>${kid.name}</b>: ${n} ejercicios, ${acc}% de aciertos${extra}.</li>`);
    }
    const [rep] = await db
      .select({ n: sql<number>`count(*)` })
      .from(exerciseReports)
      .innerJoin(exerciseTemplates, eq(exerciseTemplates.id, exerciseReports.exerciseTemplateId))
      .where(and(inArray(exerciseReports.profileId, kidsH.map((k) => k.id)), eq(exerciseReports.status, "open"), eq(exerciseTemplates.retired, false)));
    const nRep = Number(rep?.n ?? 0);
    const avisos =
      nRep === 0
        ? ""
        : nRep === 1
          ? "<p>Hay <b>1</b> pregunta marcada como errónea pendiente de revisar en el panel.</p>"
          : `<p>Hay <b>${nRep}</b> preguntas marcadas como erróneas pendientes de revisar en el panel.</p>`;
    const html = emailLayout("Resumen semanal", `Cómo ha ido la semana de tus niños:<ul>${lines.join("")}</ul>${avisos}`, { url: APP_URL, label: "Ver el detalle" });
    await sendEmail(env, tutor.email, "smartkids · resumen semanal", html);
    await db.update(parentAccounts).set({ digestAt: nowIso }).where(eq(parentAccounts.id, tutor.id));
  }

  // 3) Avisos de «pregunta mal» sobre el catálogo GLOBAL (el tutor no puede corregirlo): resumen a los
  //    administradores con lo marcado desde la ejecución anterior (el cron es diario).
  const dayAgo = new Date(now - 86400000).toISOString();
  const globales = await db
    .select({ id: exerciseTemplates.id, skillId: exerciseTemplates.skillId, stem: exerciseTemplates.stem, reason: exerciseReports.reason })
    .from(exerciseReports)
    .innerJoin(exerciseTemplates, eq(exerciseTemplates.id, exerciseReports.exerciseTemplateId))
    .innerJoin(skills, eq(skills.id, exerciseTemplates.skillId))
    .where(and(eq(exerciseReports.status, "open"), gte(exerciseReports.createdAt, dayAgo), isNull(skills.ownerId), eq(exerciseTemplates.retired, false)))
    .limit(50);
  if (globales.length) {
    const admins = await db.select({ email: parentAccounts.email }).from(parentAccounts).where(eq(parentAccounts.role, "admin"));
    const items = globales
      .map((g) => `<li><code>${escHtml(g.id)}</code> (${escHtml(g.skillId)}), ${REPORT_REASON_ES[g.reason] ?? escHtml(g.reason)}: ${escHtml(g.stem.slice(0, 160))}</li>`)
      .join("");
    const html = emailLayout("Preguntas del catálogo marcadas como erróneas", `En las últimas 24 horas:<ul>${items}</ul>Corrige el módulo en <code>content/</code> y republica.`);
    for (const ad of admins) await sendEmail(env, ad.email, "smartkids · preguntas marcadas como erróneas", html);
  }
}

export default {
  fetch: app.fetch,
  scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runDailyJobs(env));
  },
};
