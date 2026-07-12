import { Hono } from "hono";
import type { Context } from "hono";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, like, sql } from "drizzle-orm";
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
  pushSubscriptions,
  webauthnCredentials,
  webauthnFlows,
} = schema;

const COINS_PER_CORRECT = 10;
const GOAL_PERIODS = ["week", "month", "quarter", "semester", "year"]; // ventanas rodantes de objetivo
const VERIFY_TTL = 24 * 60 * 60 * 1000;
const RESET_TTL = 60 * 60 * 1000;
const INVITE_TTL = 7 * 24 * 60 * 60 * 1000; // invitación de tutor: 7 días
const ADMIN_RESET_TTL = 24 * 60 * 60 * 1000; // reset iniciado por admin: 24 h
const USERNAME_RE = /^[a-z0-9._-]{3,}$/;

type Ctx = Context<{ Bindings: Env }>;
type DB = ReturnType<typeof getDb>;

const app = new Hono<{ Bindings: Env }>();

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
  await db.delete(childSkills).where(eq(childSkills.childId, childId));
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.ownerId, childId));
  await db.update(contentRequests).set({ childId: null }).where(eq(contentRequests.childId, childId));
  await db.delete(childProfiles).where(eq(childProfiles.id, childId));
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
      gradeBand: childProfiles.gradeBand,
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
    // Tiene cónyuge: los niños y las recompensas sobreviven. Se reasignan al cónyuge y se deshace el vínculo.
    await db.update(childProfiles).set({ parentId: t.spouseId }).where(eq(childProfiles.parentId, id));
    await db.update(rewards).set({ ownerId: t.spouseId }).where(eq(rewards.ownerId, id));
    await db.update(parentAccounts).set({ spouseId: null }).where(eq(parentAccounts.id, t.spouseId));
  } else {
    // Sin cónyuge: se borran sus niños en cascada (con su progreso) y sus recompensas.
    const kids = await db.select({ id: childProfiles.id }).from(childProfiles).where(eq(childProfiles.parentId, id));
    for (const k of kids) await deleteChildCascade(db, k.id);
    const rw = await db.select({ id: rewards.id }).from(rewards).where(eq(rewards.ownerId, id));
    for (const r of rw) await deleteRewardCascade(db, r.id);
  }
  // Limpia cualquier invitación de cónyuge pendiente que apuntara a este tutor.
  await db.update(parentAccounts).set({ spousePendingFrom: null }).where(eq(parentAccounts.spousePendingFrom, id));
  await db.delete(schema.authTokens).where(eq(schema.authTokens.parentId, id));
  await db.delete(schema.sessions).where(eq(schema.sessions.parentId, id));
  await db.delete(webauthnCredentials).where(eq(webauthnCredentials.parentId, id));
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.ownerId, id));
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
  const body = await c.req.json<{ displayName?: string; username?: string; avatar?: string; gradeBand?: string; pin?: string; courseIds?: string[] }>();
  const displayName = body.displayName?.trim();
  const username = body.username?.trim().toLowerCase();
  const pin = String(body.pin ?? "");
  if (!displayName || !username || !USERNAME_RE.test(username) || pin.length < 4)
    return c.json({ error: "invalid", message: "Nombre, usuario (3+ car. a-z0-9._-) y PIN (4+ díg.) requeridos." }, 400);
  const [ex] = await db.select({ id: childProfiles.id }).from(childProfiles).where(eq(childProfiles.username, username)).limit(1);
  if (ex) return c.json({ error: "username_taken", message: "Ese usuario ya existe." }, 409);
  const id = `kid_${crypto.randomUUID()}`;
  await db.insert(childProfiles).values({
    id,
    parentId,
    displayName,
    avatar: body.avatar ?? "orbi",
    gradeBand: body.gradeBand ?? "ESO-5",
    loginPinHash: await hashSecret(pin),
    username,
    preferredLocale: "es",
    region: "ES",
  });
  await db.insert(wallets).values({ profileId: id, balance: 0 });
  const requested = (body.courseIds ?? []).filter(Boolean);
  if (requested.length) {
    const valid = new Set((await db.select({ id: courses.id }).from(courses)).map((v) => v.id));
    for (const cid of requested) if (valid.has(cid)) await db.insert(childCourses).values({ childId: id, courseId: cid });
  }
  return c.json({ profile: { id, displayName, username, avatar: body.avatar ?? "orbi", gradeBand: body.gradeBand ?? "ESO-5" } });
});

app.post("/api/profiles/:id/update", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const parentId = await requireParent(c, db);
  if (typeof parentId !== "string") return parentId;
  if (!(await ownsProfile(db, parentId, id))) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json<{ displayName?: string; avatar?: string; pin?: string; username?: string }>();
  const patch: { displayName?: string; avatar?: string; loginPinHash?: string; username?: string } = {};
  if (body.displayName?.trim()) patch.displayName = body.displayName.trim();
  if (body.avatar) patch.avatar = body.avatar;
  if (body.pin != null && String(body.pin).length >= 4) patch.loginPinHash = await hashSecret(String(body.pin));
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
  return c.json({ profile: { id: p!.id, displayName: p!.displayName, username: p!.username, avatar: p!.avatar, gradeBand: p!.gradeBand } });
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
  const [profile] = await db.select().from(childProfiles).where(eq(childProfiles.id, id)).limit(1);
  if (!profile) return c.json({ error: "profile not found" }, 404);
  const [wallet] = await db.select().from(wallets).where(eq(wallets.profileId, id)).limit(1);
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
  return c.json({ child: { id: kid.id, displayName: kid.displayName, avatar: kid.avatar, gradeBand: kid.gradeBand }, courses: crs });
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
    const [cnt] = await db.select({ n: sql<number>`count(*)` }).from(exerciseTemplates).where(eq(exerciseTemplates.skillId, s.id));
    customContent.push({ skillId: s.id, nameI18n: s.nameI18n, exercises: cnt?.n ?? 0, pathId: s.pathId, pathName: s.pathName, moduleIndex: s.moduleIndex });
  }
  return c.json({ child: { id: child.id, displayName: child.displayName, avatar: child.avatar, gradeBand: child.gradeBand }, balance: wallet?.balance ?? 0, courses: crs, customContent });
});

/* ================= Estadísticas / seguimiento ================= */

const SESSION_GAP_MS = 20 * 60 * 1000; // hueco que separa una "sesión" de la siguiente al reconstruirlas

// Agrega el progreso de un perfil desde attempts + wallet_ledger + skill_progress.
// No hay tabla de sesiones: se RECONSTRUYEN agrupando los intentos por huecos de tiempo.
async function computeProfileStats(db: DB, profileId: string) {
  const now = Date.now();
  const attemptRows = await db
    .select({ skillId: attempts.skillId, correct: attempts.correct, rt: attempts.responseTimeMs, ts: attempts.ts })
    .from(attempts)
    .where(eq(attempts.profileId, profileId))
    .orderBy(asc(attempts.ts))
    .limit(5000);
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
  const timed = attemptRows.filter((a) => typeof a.rt === "number");
  const avgTimeMs = timed.length ? Math.round(timed.reduce((s, a) => s + (a.rt as number), 0) / timed.length) : null;
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
    if (typeof a.rt === "number") {
      g.rtSum += a.rt;
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

  // Sesiones reconstruidas (hueco > SESSION_GAP_MS = nueva sesión)
  const exLedger = ledgerRows.filter((l) => isExercise(l.reason)).map((l) => ({ t: Date.parse(l.ts), d: l.delta }));
  const sessions: Array<{ start: string; end: string; count: number; correct: number; wrong: number; timeMs: number; points: number }> = [];
  let cur: { startT: number; endT: number; count: number; correct: number; rtSum: number } | null = null;
  const flush = () => {
    if (!cur) return;
    const g = cur;
    const points = exLedger.filter((l) => l.t >= g.startT - 1000 && l.t <= g.endT + 1000).reduce((s, l) => s + l.d, 0);
    sessions.push({
      start: new Date(g.startT).toISOString(),
      end: new Date(g.endT).toISOString(),
      count: g.count,
      correct: g.correct,
      wrong: g.count - g.correct,
      timeMs: g.rtSum,
      points,
    });
    cur = null;
  };
  for (const a of attemptRows) {
    const t = Date.parse(a.ts);
    if (cur && t - cur.endT > SESSION_GAP_MS) flush();
    if (!cur) cur = { startT: t, endT: t, count: 0, correct: 0, rtSum: 0 };
    cur.endT = t;
    cur.count++;
    if (a.correct) cur.correct++;
    if (typeof a.rt === "number") cur.rtSum += a.rt;
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
      lastActivity: attemptRows.length ? attemptRows[attemptRows.length - 1]!.ts : null,
    },
    perSkill,
    sessions: sessions.slice(0, 30),
    activity,
  };
}

// El niño ve SUS propias estadísticas.
app.get("/api/child/stats", async (c) => {
  const db = getDb(c.env.DB);
  const kid = await currentChildId(c, db);
  if (!kid) return c.json({ error: "unauthorized" }, 401);
  return c.json(await computeProfileStats(db, kid));
});

// El tutor ve las estadísticas de un niño de su hogar.
app.get("/api/tutor/children/:id/stats", async (c) => {
  const db = getDb(c.env.DB);
  const a = await requireParent(c, db);
  if (typeof a !== "string") return a;
  const childId = c.req.param("id");
  if (!(await ownsProfile(db, a, childId))) return c.json({ error: "forbidden" }, 403);
  return c.json(await computeProfileStats(db, childId));
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
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, body.endpoint));
  return c.json({ ok: true });
});

/* ================= Passkeys (WebAuthn) — login biométrico del tutor ================= */

const WEBAUTHN_RP_NAME = "Smartkids";
const FLOW_TTL_MS = 5 * 60 * 1000;

// rpID = hostname del origen del navegador; origin = ese origen completo (deben cuadrar con la página).
function rpFromReq(c: Ctx): { rpID: string; origin: string } {
  const origin = c.req.header("origin") ?? new URL(c.req.url).origin;
  return { rpID: new URL(origin).hostname, origin };
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
    };
    package: { id: string; subjectId: string; gradeBand?: string | null; version: string; ownerId?: string | null };
    exercises: unknown[];
    assign?: { childIds: string[] };
    requestId?: string;
  }>();
  if (!body?.package?.id || !Array.isArray(body?.exercises)) return c.json({ error: "invalid body" }, 400);

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
      })
      .onConflictDoUpdate({
        target: skills.id,
        set: {
          nameI18n: body.skill.nameI18n,
          coinsPerCorrect: skillCoins,
          pathId: body.skill.pathId ?? null,
          pathName: body.skill.pathName ?? null,
          moduleIndex: body.skill.moduleIndex ?? 0,
        },
      });
  }

  // Upsert del paquete (idempotente): reemplaza sus plantillas.
  await db.delete(exerciseTemplates).where(eq(exerciseTemplates.packageId, body.package.id));
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

  let i = 0;
  for (const ex of parsed) {
    i += 1;
    await db.insert(exerciseTemplates).values({
      id: `${body.package.id}_${i}`,
      packageId: body.package.id,
      skillId: ex.skillId,
      type: ex.type,
      language: ex.language,
      contentVersion: body.package.version,
      stem: ex.stem,
      payload: toStoredPayload(ex),
      difficultyNumeric: ex.difficulty.numeric,
      difficultyLevel: ex.difficulty.level,
    });
  }

  // Asignar el skill privado a los niños destino.
  const assigned = body.assign?.childIds ?? [];
  const targetSkillId = body.skill?.id;
  if (targetSkillId && assigned.length > 0) {
    for (const childId of assigned) {
      await db.insert(childSkills).values({ childId, skillId: targetSkillId }).onConflictDoNothing();
    }
  }

  // Cierre de la solicitud (Vía B): marcar publicada + avisar al tutor por email.
  if (body.requestId) {
    const [req] = await db.select().from(contentRequests).where(eq(contentRequests.id, body.requestId)).limit(1);
    if (req) {
      await db
        .update(contentRequests)
        .set({ status: "published", skillId: targetSkillId ?? null, packageId: body.package.id, exerciseCount: parsed.length, publishedAt: now })
        .where(eq(contentRequests.id, body.requestId));
      const [owner] = await db.select({ email: parentAccounts.email }).from(parentAccounts).where(eq(parentAccounts.id, req.ownerId)).limit(1);
      if (owner) {
        await sendEmail(
          c.env,
          owner.email,
          "Tu contenido esta listo · smartkids",
          emailLayout("Contenido listo", `Ya hemos generado "${req.title}" (${parsed.length} ejercicios). Entra para asignarlo o revisarlo.`, {
            url: "https://app.smart-kids.uk",
            label: "Abrir smartkids",
          }),
        );
        await db.update(contentRequests).set({ notifiedAt: new Date().toISOString() }).where(eq(contentRequests.id, body.requestId));
      }
      await notifyOwner(c.env, db, req.ownerId); // push al tutor: "contenido listo"
    }
  }

  return c.json({ ok: true, packageId: body.package.id, skillId: targetSkillId ?? null, exercises: parsed.length, assigned: assigned.length });
});

// Contenido privado del hogar: lista de skills propios con conteo y niños asignados.
app.get("/api/tutor/content", async (c) => {
  const db = getDb(c.env.DB);
  const a = await requireParent(c, db);
  if (typeof a !== "string") return a;
  const household = await householdIds(db, a);
  const rows = await db
    .select({ id: skills.id, nameI18n: skills.nameI18n, subjectId: skills.subjectId, gradeBand: skills.gradeBand })
    .from(skills)
    .where(inArray(skills.ownerId, household));
  const out: Array<{ id: string; nameI18n: unknown; subjectId: string; gradeBand: string; exercises: number; childIds: string[] }> = [];
  for (const s of rows) {
    const [cnt] = await db.select({ n: sql<number>`count(*)` }).from(exerciseTemplates).where(eq(exerciseTemplates.skillId, s.id));
    const kids = await db.select({ childId: childSkills.childId }).from(childSkills).where(eq(childSkills.skillId, s.id));
    out.push({ ...s, exercises: cnt?.n ?? 0, childIds: kids.map((k) => k.childId) });
  }
  return c.json(out);
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
  const rows = await db.select().from(exerciseTemplates).where(eq(exerciseTemplates.skillId, skillId));
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
  const pkgRows = await db.selectDistinct({ pkg: exerciseTemplates.packageId }).from(exerciseTemplates).where(eq(exerciseTemplates.skillId, skillId));
  const tplRows = await db.select({ id: exerciseTemplates.id }).from(exerciseTemplates).where(eq(exerciseTemplates.skillId, skillId));
  const tplIds = tplRows.map((r) => r.id);
  // Sin ON DELETE cascade: borramos respetando el orden de las FKs.
  // coin_awards referencia exercise_templates: hay que vaciarlo ANTES de borrar las plantillas
  // (si no, un ejercicio con monedas ya concedidas rompe el borrado por FK y el curso no se elimina).
  await db.delete(attempts).where(eq(attempts.skillId, skillId));
  await db.delete(skillProgress).where(eq(skillProgress.skillId, skillId));
  await db.delete(childSkills).where(eq(childSkills.skillId, skillId));
  if (tplIds.length) await db.delete(coinAwards).where(inArray(coinAwards.exerciseTemplateId, tplIds));
  await db.delete(exerciseTemplates).where(eq(exerciseTemplates.skillId, skillId));
  await db.update(contentRequests).set({ skillId: null, packageId: null }).where(eq(contentRequests.skillId, skillId));
  for (const { pkg } of pkgRows) {
    const [rem] = await db.select({ n: sql<number>`count(*)` }).from(exerciseTemplates).where(eq(exerciseTemplates.packageId, pkg));
    if ((rem?.n ?? 0) === 0) await db.delete(contentPackages).where(and(eq(contentPackages.id, pkg), inArray(contentPackages.ownerId, household)));
  }
  await db.delete(skills).where(eq(skills.id, skillId));
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
  const assets = await db.select().from(contentRequestAssets).where(eq(contentRequestAssets.requestId, reqId));
  if (c.env.UPLOADS) {
    for (const as of assets) {
      try {
        await c.env.UPLOADS.delete(as.r2Key);
      } catch {
        /* el objeto pudo no existir; seguimos */
      }
    }
  }
  await db.delete(contentRequestAssets).where(eq(contentRequestAssets.requestId, reqId));
  await db.delete(contentRequests).where(eq(contentRequests.id, reqId));
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
  const gradeBand = form["gradeBand"] ? String(form["gradeBand"]) : null;
  const numQuestions = form["numQuestions"] ? clampInt(form["numQuestions"], 5, 40, 20) : null;
  const pointsPerCorrect = form["pointsPerCorrect"] ? clampInt(form["pointsPerCorrect"], 1, 50, 10) : null;
  const modules = form["modules"] ? clampInt(form["modules"], 1, 6, 1) : null;

  const household = await householdIds(db, a);
  if (childId) {
    const [ch] = await db.select({ parentId: childProfiles.parentId }).from(childProfiles).where(eq(childProfiles.id, childId)).limit(1);
    if (!ch || !household.includes(ch.parentId)) return c.json({ error: "child_forbidden" }, 403);
  }

  const raw = form["files"];
  const files = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((f): f is File => f instanceof File);
  // Título opcional (la skill lo nombra con la info). Solo hace falta ALGO con lo que generar: fichero, descripción o al menos un título/tema.
  if (files.length === 0 && !instructions && !title) return c.json({ error: "empty_request", message: "Sube material o describe qué generar." }, 400);
  if (files.length > UPLOAD_MAX_FILES) return c.json({ error: "too_many_files" }, 400);
  for (const f of files) {
    if (!UPLOAD_KINDS[f.type]) return c.json({ error: "unsupported_type", detail: `${f.name}: ${f.type}` }, 400);
    if (f.size > UPLOAD_MAX_BYTES) return c.json({ error: "file_too_large", detail: f.name }, 400);
  }

  const requestId = `creq_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await db.insert(contentRequests).values({ id: requestId, ownerId: a, childId, subjectId, gradeBand, title, instructions, numQuestions, pointsPerCorrect, modules, status: "uploaded", createdAt: now });

  const stored: Array<{ id: string; filename: string; kind: string }> = [];
  for (const file of files) {
    const kind = UPLOAD_KINDS[file.type]!;
    const assetId = `asset_${crypto.randomUUID()}`;
    const key = `requests/${requestId}/${assetId}`;
    await c.env.UPLOADS.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
    await db.insert(contentRequestAssets).values({ id: assetId, requestId, r2Key: key, filename: file.name, contentType: file.type, kind, size: file.size, createdAt: now });
    stored.push({ id: assetId, filename: file.name, kind });
  }
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
  const numQuestions = form["numQuestions"] ? clampInt(form["numQuestions"], 5, 40, 20) : req.numQuestions;
  const pointsPerCorrect = form["pointsPerCorrect"] ? clampInt(form["pointsPerCorrect"], 1, 50, 10) : req.pointsPerCorrect;
  const modules = form["modules"] ? clampInt(form["modules"], 1, 6, 1) : req.modules;
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
  await db.update(contentRequests).set({ title, instructions, childId, numQuestions, pointsPerCorrect, modules }).where(eq(contentRequests.id, reqId));
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
  if (c.env.UPLOADS) {
    try {
      await c.env.UPLOADS.delete(asset.r2Key);
    } catch {
      /* noop */
    }
  }
  await db.delete(contentRequestAssets).where(eq(contentRequestAssets.id, asset.id));
  return c.json({ ok: true });
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
    out.push({ ...r, assets });
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

app.get("/api/session/next", async (c) => {
  const db = getDb(c.env.DB);
  const profileId = c.req.query("profile");
  if (!profileId) return c.json({ error: "invalid" }, 400);
  const a = await childOrOwner(c, db, profileId);
  if (typeof a !== "string") return a;
  const skillId = c.req.query("skill") ?? "MATH.ESO5.FRAC.ADD";
  // El niño solo puede practicar skills de un curso al que tiene acceso.
  if (!(await childCanAttemptSkill(db, profileId, skillId))) return c.json({ error: "no_course_access" }, 403);

  // Banco de plantillas del skill (con un tope de seguridad); ya no solo las 10 primeras.
  // Excluye las ocultas por el tutor: el niño no las recibe.
  const rows = await db
    .select()
    .from(exerciseTemplates)
    .where(and(eq(exerciseTemplates.skillId, skillId), eq(exerciseTemplates.hidden, false)))
    .limit(200);
  if (rows.length === 0) return c.json({ error: "no exercise found" }, 404);

  // Evitar repetición: excluye lo que pida el cliente (repaso / sesión en curso) y lo visto hace poco.
  const excludeSet = new Set(
    (c.req.query("exclude") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  );
  const recent = await db
    .select({ tid: attempts.exerciseTemplateId })
    .from(attempts)
    .where(and(eq(attempts.profileId, profileId), eq(attempts.skillId, skillId)))
    .orderBy(desc(attempts.ts))
    .limit(20);
  const recentSet = new Set(recent.map((r) => r.tid));

  const notExcluded = rows.filter((r) => !excludeSet.has(r.id));
  let pool = notExcluded.filter((r) => !recentSet.has(r.id));
  if (pool.length === 0) pool = notExcluded.length > 0 ? notExcluded : rows;

  // Baraja el pool (Fisher-Yates) y sirve la primera plantilla que parsee al modelo unificado.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  for (const ex of pool) {
    let exercise: Exercise;
    try {
      exercise = exerciseFromRow({
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
    } catch {
      continue; // payload no conforme al esquema: se salta esta plantilla.
    }
    // Redacción anti-cheat: el cliente nunca recibe la solución; barajamos la presentación.
    const render = shuffleRender(redactForClient(exercise));
    return c.json({
      id: ex.id,
      skillId: ex.skillId,
      type: exercise.type,
      stem: exercise.stem,
      figure: exercise.figure ?? null,
      contentVersion: ex.contentVersion,
      render,
    });
  }
  return c.json({ error: "no exercise found" }, 404);
});

app.post("/api/session/attempt", async (c) => {
  const db = getDb(c.env.DB);
  const body = await c.req.json<{
    profileId: string;
    exerciseTemplateId: string;
    answer?: unknown;
    selectedOptionId?: string; // compat: cliente antiguo (solo opción múltiple)
    responseTimeMs?: number;
  }>();
  if (!body?.profileId || !body?.exerciseTemplateId) return c.json({ error: "invalid body" }, 400);
  const a = await childOrOwner(c, db, body.profileId);
  if (typeof a !== "string") return a;

  // Fuente de verdad: la plantilla del ejercicio. El skill se DERIVA de ella (no se confía en el cliente).
  const [tpl] = await db.select().from(exerciseTemplates).where(eq(exerciseTemplates.id, body.exerciseTemplateId)).limit(1);
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
  // Anti-farm ATÓMICO: la PK compuesta de coin_awards concede monedas una sola vez por
  // (niño, ejercicio). Sustituye al read-check anterior, que tenía una carrera (dos aciertos
  // simultáneos leían "no ganado" y duplicaban monedas).
  let firstCorrect = false;
  if (correct) {
    const inserted = await db
      .insert(coinAwards)
      .values({ profileId: body.profileId, exerciseTemplateId: body.exerciseTemplateId, ts: now })
      .onConflictDoNothing()
      .returning({ p: coinAwards.profileId });
    firstCorrect = inserted.length > 0;
  }

  await db.insert(attempts).values({
    id: crypto.randomUUID(),
    profileId: body.profileId,
    skillId,
    exerciseTemplateId: body.exerciseTemplateId,
    contentVersion: tpl.contentVersion,
    correct,
    responseTimeMs: body.responseTimeMs ?? null,
    difficultyServed: tpl.difficultyNumeric ?? null,
    ts: now,
  });

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
    correct,
    correctAnswer: result.correctAnswer,
    parts: result.parts ?? null,
    feedback: correct ? (exercise.feedback?.correct ?? null) : (exercise.feedback?.incorrect ?? null),
    solution: exercise.feedback?.solution ?? null,
    coinsAwarded: coins,
    balance: wallet?.balance ?? 0,
    masteryScore: newMastery,
    consecutiveCorrect: consecutive,
    status,
  });
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
  const [childRow] = await db.select({ parentId: childProfiles.parentId }).from(childProfiles).where(eq(childProfiles.id, profileId)).limit(1);
  const household = childRow ? await householdIds(db, childRow.parentId) : [];
  if (!reward.ownerId || !household.includes(reward.ownerId)) return c.json({ error: "forbidden" }, 403);
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
    if (status === "pending") for (const pid of household) await notifyOwner(c.env, db, pid); // push: "canje pendiente"
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

export default app;
