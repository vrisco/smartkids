import { Hono } from "hono";
import type { Context } from "hono";
import { and, asc, eq, sql } from "drizzle-orm";
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
} = schema;

const COINS_PER_CORRECT = 10;
const VERIFY_TTL = 24 * 60 * 60 * 1000;
const RESET_TTL = 60 * 60 * 1000;
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

/* ================= Auth tutor / admin ================= */

async function issueVerification(c: Ctx, db: DB, parentId: string, email: string): Promise<string | null> {
  const token = await createAuthToken(db, parentId, "verify", VERIFY_TTL);
  const url = `${new URL(c.req.url).origin}/verify?token=${token}`;
  await sendEmail(c.env, email, "Verifica tu email · smartkids", emailLayout("Verifica tu email", "Confirma tu email para tu cuenta de tutor.", { url, label: "Verificar email" }));
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
  const children = await db
    .select({
      id: childProfiles.id,
      displayName: childProfiles.displayName,
      username: childProfiles.username,
      avatar: childProfiles.avatar,
      gradeBand: childProfiles.gradeBand,
    })
    .from(childProfiles)
    .where(eq(childProfiles.parentId, parentId));
  return c.json({ parent: { id: p.id, email: p.email, role: p.role, emailVerified: p.emailVerified }, children });
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
  await db.update(parentAccounts).set({ passwordHash: await hashSecret(password) }).where(eq(parentAccounts.id, parentId));
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
  const body = await c.req.json<{ email?: string; password?: string }>();
  const email = body.email?.trim().toLowerCase();
  const password = body.password ?? "";
  if (!email || !email.includes("@") || password.length < 6)
    return c.json({ error: "invalid", message: "Email válido y contraseña de 6+ caracteres." }, 400);
  const [ex] = await db.select({ id: parentAccounts.id }).from(parentAccounts).where(eq(parentAccounts.email, email)).limit(1);
  if (ex) return c.json({ error: "email_taken", message: "Ese email ya existe." }, 409);
  const id = `par_${crypto.randomUUID()}`;
  await db.insert(parentAccounts).values({
    id,
    email,
    passwordHash: await hashSecret(password),
    role: "tutor",
    emailVerified: false,
    createdAt: new Date().toISOString(),
  });
  return c.json({ tutor: { id, email } });
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
  const { password } = await c.req.json<{ password?: string }>();
  if (!password || password.length < 6) return c.json({ error: "invalid", message: "Contraseña de 6+ caracteres." }, 400);
  const [t] = await db.select({ role: parentAccounts.role }).from(parentAccounts).where(eq(parentAccounts.id, id)).limit(1);
  if (!t || t.role !== "tutor") return c.json({ error: "not_found" }, 404);
  await db.update(parentAccounts).set({ passwordHash: await hashSecret(password) }).where(eq(parentAccounts.id, id));
  await db.delete(schema.sessions).where(eq(schema.sessions.parentId, id));
  return c.json({ ok: true });
});

/* ================= Cursos ================= */

app.get("/api/courses", async (c) => {
  const db = getDb(c.env.DB);
  const a = await requireParent(c, db);
  if (typeof a !== "string") return a;
  return c.json(await db.select().from(courses));
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
  await db.delete(childCourses).where(eq(childCourses.childId, id));
  await db.delete(schema.childSessions).where(eq(schema.childSessions.childId, id));
  await db.delete(redemptions).where(eq(redemptions.profileId, id));
  await db.delete(walletLedger).where(eq(walletLedger.profileId, id));
  await db.delete(wallets).where(eq(wallets.profileId, id));
  await db.delete(attempts).where(eq(attempts.profileId, id));
  await db.delete(skillProgress).where(eq(skillProgress.profileId, id));
  await db.delete(childProfiles).where(eq(childProfiles.id, id));
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
  if (!kid && !parentId) return c.json({ error: "unauthorized" }, 401);
  return c.json(await db.select().from(rewards));
});

app.post("/api/rewards/:id/redeem", async (c) => {
  const db = getDb(c.env.DB);
  const rewardId = c.req.param("id");
  const { profileId } = await c.req.json<{ profileId: string }>();
  const a = await childOrOwner(c, db, profileId);
  if (typeof a !== "string") return a;
  const [reward] = await db.select().from(rewards).where(eq(rewards.id, rewardId)).limit(1);
  if (!reward) return c.json({ error: "reward not found" }, 404);
  const [wallet] = await db.select().from(wallets).where(eq(wallets.profileId, profileId)).limit(1);
  const balance = wallet?.balance ?? 0;
  if (balance < reward.cost) return c.json({ error: "insufficient_funds", balance }, 400);
  const now = new Date().toISOString();
  const newBalance = balance - reward.cost;
  await db.update(wallets).set({ balance: newBalance }).where(eq(wallets.profileId, profileId));
  await db.insert(walletLedger).values({ id: crypto.randomUUID(), profileId, delta: -reward.cost, reason: `redeem:${rewardId}`, ts: now });
  const status = reward.type === "screen_time_voucher" ? "pending" : "applied";
  await db.insert(redemptions).values({ id: crypto.randomUUID(), profileId, rewardId, status, ts: now });
  return c.json({ ok: true, balance: newBalance, status, reward });
});

/* ================= SPA ================= */

app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
