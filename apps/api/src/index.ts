import { Hono } from "hono";
import type { Context } from "hono";
import { and, asc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "./db";
import {
  createSession,
  currentParentId,
  destroySession,
  hashSecret,
  ownsProfile,
  setSessionCookie,
  verifySecret,
} from "./auth";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
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
} = schema;

const COINS_PER_CORRECT = 10;

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) =>
  c.json({ ok: true, service: "smartkids-api", ts: new Date().toISOString() }),
);

/* ================= Auth ================= */

app.post("/api/auth/signup", async (c) => {
  const db = getDb(c.env.DB);
  const body = await c.req.json<{ email?: string; password?: string }>();
  const email = body.email?.trim().toLowerCase();
  const password = body.password ?? "";
  if (!email || !email.includes("@") || password.length < 6)
    return c.json({ error: "invalid", message: "Email válido y contraseña de 6+ caracteres." }, 400);

  const [existing] = await db
    .select({ id: parentAccounts.id })
    .from(parentAccounts)
    .where(eq(parentAccounts.email, email))
    .limit(1);
  if (existing) return c.json({ error: "email_taken", message: "Ese email ya está registrado." }, 409);

  const id = `par_${crypto.randomUUID()}`;
  await db.insert(parentAccounts).values({
    id,
    email,
    passwordHash: await hashSecret(password),
    localeFormat: "es-ES",
    createdAt: new Date().toISOString(),
  });
  setSessionCookie(c, await createSession(db, id));
  return c.json({ parent: { id, email } });
});

app.post("/api/auth/login", async (c) => {
  const db = getDb(c.env.DB);
  const body = await c.req.json<{ email?: string; password?: string }>();
  const email = body.email?.trim().toLowerCase() ?? "";
  const [p] = await db.select().from(parentAccounts).where(eq(parentAccounts.email, email)).limit(1);
  if (!p || !(await verifySecret(body.password ?? "", p.passwordHash)))
    return c.json({ error: "invalid_credentials", message: "Email o contraseña incorrectos." }, 401);
  setSessionCookie(c, await createSession(db, p.id));
  return c.json({ parent: { id: p.id, email: p.email } });
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
      avatar: childProfiles.avatar,
      gradeBand: childProfiles.gradeBand,
    })
    .from(childProfiles)
    .where(eq(childProfiles.parentId, parentId));
  return c.json({ parent: { id: p.id, email: p.email }, children });
});

/* ================= Perfiles de hijo ================= */

app.post("/api/profiles", async (c) => {
  const db = getDb(c.env.DB);
  const parentId = await currentParentId(c, db);
  if (!parentId) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json<{ displayName?: string; avatar?: string; gradeBand?: string; pin?: string }>();
  const displayName = body.displayName?.trim();
  const pin = String(body.pin ?? "");
  if (!displayName || pin.length < 4)
    return c.json({ error: "invalid", message: "Nombre y PIN de 4+ dígitos." }, 400);
  const id = `kid_${crypto.randomUUID()}`;
  await db.insert(childProfiles).values({
    id,
    parentId,
    displayName,
    avatar: body.avatar ?? "orbi",
    gradeBand: body.gradeBand ?? "ESO-5",
    loginPinHash: await hashSecret(pin),
    preferredLocale: "es",
    region: "ES",
  });
  await db.insert(wallets).values({ profileId: id, balance: 0 });
  return c.json({ profile: { id, displayName, avatar: body.avatar ?? "orbi", gradeBand: body.gradeBand ?? "ESO-5" } });
});

app.post("/api/profiles/:id/unlock", async (c) => {
  const db = getDb(c.env.DB);
  const parentId = await currentParentId(c, db);
  if (!parentId) return c.json({ error: "unauthorized" }, 401);
  const id = c.req.param("id");
  const [p] = await db
    .select()
    .from(childProfiles)
    .where(and(eq(childProfiles.id, id), eq(childProfiles.parentId, parentId)))
    .limit(1);
  if (!p) return c.json({ error: "not_found" }, 404);
  const { pin } = await c.req.json<{ pin?: string }>();
  if (!p.loginPinHash || !(await verifySecret(String(pin ?? ""), p.loginPinHash)))
    return c.json({ error: "bad_pin", message: "PIN incorrecto." }, 401);
  return c.json({ profile: { id: p.id, displayName: p.displayName, avatar: p.avatar, gradeBand: p.gradeBand } });
});

/** Guard: exige sesión de padre y, opcionalmente, que el perfil sea suyo. */
async function guard(
  c: Context<{ Bindings: Env }>,
  db: ReturnType<typeof getDb>,
  profileId?: string,
): Promise<string | Response> {
  const parentId = await currentParentId(c, db);
  if (!parentId) return c.json({ error: "unauthorized" }, 401);
  if (profileId && !(await ownsProfile(db, parentId, profileId)))
    return c.json({ error: "forbidden" }, 403);
  return parentId;
}

app.get("/api/profiles/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const g = await guard(c, db, id);
  if (typeof g !== "string") return g;
  const [profile] = await db.select().from(childProfiles).where(eq(childProfiles.id, id)).limit(1);
  if (!profile) return c.json({ error: "profile not found" }, 404);
  const [wallet] = await db.select().from(wallets).where(eq(wallets.profileId, id)).limit(1);
  return c.json({ profile, balance: wallet?.balance ?? 0 });
});

/* ================= Datos de juego ================= */

app.get("/api/skills", async (c) => {
  const db = getDb(c.env.DB);
  const subjectId = c.req.query("subject") ?? "math";
  const profileId = c.req.query("profile");
  const g = await guard(c, db, profileId);
  if (typeof g !== "string") return g;

  if (!profileId) {
    const rows = await db
      .select()
      .from(skills)
      .where(eq(skills.subjectId, subjectId))
      .orderBy(asc(skills.position));
    return c.json(rows);
  }

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
    .leftJoin(
      skillProgress,
      and(eq(skillProgress.skillId, skills.id), eq(skillProgress.profileId, profileId)),
    )
    .where(eq(skills.subjectId, subjectId))
    .orderBy(asc(skills.position));
  return c.json(rows);
});

app.get("/api/session/next", async (c) => {
  const db = getDb(c.env.DB);
  const profileId = c.req.query("profile");
  const g = await guard(c, db, profileId);
  if (typeof g !== "string") return g;
  const skillId = c.req.query("skill") ?? "MATH.ESO5.FRAC.ADD";
  const rows = await db
    .select()
    .from(exerciseTemplates)
    .where(eq(exerciseTemplates.skillId, skillId))
    .limit(10);
  if (rows.length === 0) return c.json({ error: "no exercise found" }, 404);
  const exercise = rows[Math.floor(Math.random() * rows.length)]!;
  return c.json(exercise);
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
  const g = await guard(c, db, body.profileId);
  if (typeof g !== "string") return g;

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
  const newMastery = body.correct
    ? Math.min(1, oldMastery + 0.12 * (1 - oldMastery))
    : Math.max(0, oldMastery - 0.08);
  const consecutive = body.correct ? (prev?.consecutiveCorrect ?? 0) + 1 : 0;
  const total = (prev?.totalAttempts ?? 0) + 1;
  const status = newMastery >= 0.85 ? "mastered" : "inProgress";

  await db
    .insert(skillProgress)
    .values({
      profileId: body.profileId,
      skillId: body.skillId,
      masteryScore: newMastery,
      consecutiveCorrect: consecutive,
      totalAttempts: total,
      status,
    })
    .onConflictDoUpdate({
      target: [skillProgress.profileId, skillProgress.skillId],
      set: { masteryScore: newMastery, consecutiveCorrect: consecutive, totalAttempts: total, status },
    });

  const coins = body.correct ? COINS_PER_CORRECT : 0;
  if (coins > 0) {
    await db
      .insert(wallets)
      .values({ profileId: body.profileId, balance: coins })
      .onConflictDoUpdate({
        target: wallets.profileId,
        set: { balance: sql`${wallets.balance} + ${coins}` },
      });
    await db.insert(walletLedger).values({
      id: crypto.randomUUID(),
      profileId: body.profileId,
      delta: coins,
      reason: `exercise:${body.skillId}`,
      ts: now,
    });
  }

  const [wallet] = await db.select().from(wallets).where(eq(wallets.profileId, body.profileId)).limit(1);
  return c.json({
    correct: body.correct,
    coinsAwarded: coins,
    balance: wallet?.balance ?? 0,
    masteryScore: newMastery,
    consecutiveCorrect: consecutive,
    status,
  });
});

app.get("/api/rewards", async (c) => {
  const db = getDb(c.env.DB);
  const g = await guard(c, db);
  if (typeof g !== "string") return g;
  return c.json(await db.select().from(rewards));
});

app.post("/api/rewards/:id/redeem", async (c) => {
  const db = getDb(c.env.DB);
  const rewardId = c.req.param("id");
  const { profileId } = await c.req.json<{ profileId: string }>();
  const g = await guard(c, db, profileId);
  if (typeof g !== "string") return g;

  const [reward] = await db.select().from(rewards).where(eq(rewards.id, rewardId)).limit(1);
  if (!reward) return c.json({ error: "reward not found" }, 404);

  const [wallet] = await db.select().from(wallets).where(eq(wallets.profileId, profileId)).limit(1);
  const balance = wallet?.balance ?? 0;
  if (balance < reward.cost) return c.json({ error: "insufficient_funds", balance }, 400);

  const now = new Date().toISOString();
  const newBalance = balance - reward.cost;
  await db.update(wallets).set({ balance: newBalance }).where(eq(wallets.profileId, profileId));
  await db.insert(walletLedger).values({
    id: crypto.randomUUID(),
    profileId,
    delta: -reward.cost,
    reason: `redeem:${rewardId}`,
    ts: now,
  });
  const status = reward.type === "screen_time_voucher" ? "pending" : "applied";
  await db.insert(schema.redemptions).values({
    id: crypto.randomUUID(),
    profileId,
    rewardId,
    status,
    ts: now,
  });
  return c.json({ ok: true, balance: newBalance, status, reward });
});

/* ================= SPA ================= */

app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
