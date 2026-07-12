import { Hono } from "hono";
import type { Context } from "hono";
import { and, asc, eq, gte, inArray, isNull, like, sql } from "drizzle-orm";
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

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_DEV_LINKS?: string;
}

const {
  skills,
  skillProgress,
  exerciseTemplates,
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
} = schema;

const COINS_PER_CORRECT = 10;
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

/** Inicio (ISO) de la ventana rodante: 'week'=7d, 'month'=30d, resto='all' (epoch). */
function periodStartIso(period: string | null | undefined): string {
  const now = Date.now();
  if (period === "week") return new Date(now - 7 * 86400000).toISOString();
  if (period === "month") return new Date(now - 30 * 86400000).toISOString();
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
  // Barre asignaciones de recompensas cruzadas entre los dos hogares que ahora se separan.
  const aKids = (await db.select({ id: childProfiles.id }).from(childProfiles).where(eq(childProfiles.parentId, parentId))).map((k) => k.id);
  const bKids = (await db.select({ id: childProfiles.id }).from(childProfiles).where(eq(childProfiles.parentId, other))).map((k) => k.id);
  const aRewards = (await db.select({ id: rewards.id }).from(rewards).where(eq(rewards.ownerId, parentId))).map((r) => r.id);
  const bRewards = (await db.select({ id: rewards.id }).from(rewards).where(eq(rewards.ownerId, other))).map((r) => r.id);
  if (aKids.length && bRewards.length) await db.delete(childRewards).where(and(inArray(childRewards.childId, aKids), inArray(childRewards.rewardId, bRewards)));
  if (bKids.length && aRewards.length) await db.delete(childRewards).where(and(inArray(childRewards.childId, bKids), inArray(childRewards.rewardId, aRewards)));
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
  return c.json({ child: { id: child.id, displayName: child.displayName, avatar: child.avatar, gradeBand: child.gradeBand }, balance: wallet?.balance ?? 0, courses: crs });
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
  const rows = await db
    .select({
      id: skills.id,
      position: skills.position,
      nameI18n: skills.nameI18n,
      gradeBand: skills.gradeBand,
      difficultyBase: skills.difficultyBase,
      status: skillProgress.status,
      masteryScore: skillProgress.masteryScore,
      totalAttempts: skillProgress.totalAttempts,
    })
    .from(skills)
    .leftJoin(skillProgress, and(eq(skillProgress.skillId, skills.id), eq(skillProgress.profileId, profileId)))
    .where(and(eq(skills.subjectId, course.subjectId), eq(skills.gradeBand, course.gradeBand)))
    .orderBy(asc(skills.position));
  return c.json(rows);
});

app.get("/api/session/next", async (c) => {
  const db = getDb(c.env.DB);
  const profileId = c.req.query("profile");
  if (!profileId) return c.json({ error: "invalid" }, 400);
  const a = await childOrOwner(c, db, profileId);
  if (typeof a !== "string") return a;
  const skillId = c.req.query("skill") ?? "MATH.ESO5.FRAC.ADD";
  const rows = await db.select().from(exerciseTemplates).where(eq(exerciseTemplates.skillId, skillId)).limit(10);
  if (rows.length === 0) return c.json({ error: "no exercise found" }, 404);
  return c.json(rows[Math.floor(Math.random() * rows.length)]!);
});

app.post("/api/session/attempt", async (c) => {
  const db = getDb(c.env.DB);
  const body = await c.req.json<{
    profileId: string;
    skillId: string;
    exerciseTemplateId: string;
    contentVersion?: string;
    correct: boolean;
    responseTimeMs?: number;
    difficultyServed?: number;
  }>();
  if (!body?.profileId || !body?.skillId || !body?.exerciseTemplateId || typeof body?.correct !== "boolean")
    return c.json({ error: "invalid body" }, 400);
  const a = await childOrOwner(c, db, body.profileId);
  if (typeof a !== "string") return a;

  const now = new Date().toISOString();
  await db.insert(attempts).values({
    id: crypto.randomUUID(),
    profileId: body.profileId,
    skillId: body.skillId,
    exerciseTemplateId: body.exerciseTemplateId,
    contentVersion: body.contentVersion ?? "1.0.0",
    correct: body.correct,
    responseTimeMs: body.responseTimeMs ?? null,
    difficultyServed: body.difficultyServed ?? null,
    ts: now,
  });

  const [prev] = await db
    .select()
    .from(skillProgress)
    .where(and(eq(skillProgress.profileId, body.profileId), eq(skillProgress.skillId, body.skillId)))
    .limit(1);
  const oldMastery = prev?.masteryScore ?? 0;
  const newMastery = body.correct ? Math.min(1, oldMastery + 0.12 * (1 - oldMastery)) : Math.max(0, oldMastery - 0.08);
  const consecutive = body.correct ? (prev?.consecutiveCorrect ?? 0) + 1 : 0;
  const total = (prev?.totalAttempts ?? 0) + 1;
  const status = newMastery >= 0.85 ? "mastered" : "inProgress";

  await db
    .insert(skillProgress)
    .values({ profileId: body.profileId, skillId: body.skillId, masteryScore: newMastery, consecutiveCorrect: consecutive, totalAttempts: total, status })
    .onConflictDoUpdate({
      target: [skillProgress.profileId, skillProgress.skillId],
      set: { masteryScore: newMastery, consecutiveCorrect: consecutive, totalAttempts: total, status },
    });

  const coins = body.correct ? COINS_PER_CORRECT : 0;
  if (coins > 0) {
    await db
      .insert(wallets)
      .values({ profileId: body.profileId, balance: coins })
      .onConflictDoUpdate({ target: wallets.profileId, set: { balance: sql`${wallets.balance} + ${coins}` } });
    await db.insert(walletLedger).values({ id: crypto.randomUUID(), profileId: body.profileId, delta: coins, reason: `exercise:${body.skillId}`, ts: now });
  }

  const [wallet] = await db.select().from(wallets).where(eq(wallets.profileId, body.profileId)).limit(1);
  return c.json({ correct: body.correct, coinsAwarded: coins, balance: wallet?.balance ?? 0, masteryScore: newMastery, consecutiveCorrect: consecutive, status });
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
  const period = kind === "goal" ? (body.period === "week" ? "week" : "month") : null;
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
    patch.period = body.kind === "goal" ? (body.period === "week" ? "week" : "month") : null;
  }
  if ("limitCount" in body) patch.limitCount = body.limitCount != null && Number(body.limitCount) > 0 ? Math.floor(Number(body.limitCount)) : null;
  if (body.limitPeriod === "week" || body.limitPeriod === "month" || body.limitPeriod === "all") patch.limitPeriod = body.limitPeriod;
  // Invariante: un objetivo siempre lleva límite (si no, sería reclamable infinitas veces).
  const resultKind = patch.kind ?? r.kind;
  const resultLimit = "limitCount" in body ? patch.limitCount ?? null : r.limitCount;
  if (resultKind === "goal" && resultLimit == null) {
    patch.limitCount = 1;
    patch.limitPeriod = (patch.period ?? r.period) === "week" ? "week" : "month";
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
