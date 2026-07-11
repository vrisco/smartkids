import { Hono } from "hono";
import { cors } from "hono/cors";
import { and, asc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "./db";

export interface Env {
  DB: D1Database;
}

const {
  skills,
  skillProgress,
  exerciseTemplates,
  childProfiles,
  wallets,
  walletLedger,
  attempts,
  rewards,
} = schema;

const COINS_PER_CORRECT = 10;

const app = new Hono<{ Bindings: Env }>();

app.use("/api/*", cors());

app.get("/api/health", (c) =>
  c.json({ ok: true, service: "smartkids-api", ts: new Date().toISOString() }),
);

/** Perfil de hijo + saldo de la wallet (para el HUD). */
app.get("/api/profiles/:id", async (c) => {
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const [profile] = await db
    .select()
    .from(childProfiles)
    .where(eq(childProfiles.id, id))
    .limit(1);
  if (!profile) return c.json({ error: "profile not found" }, 404);
  const [wallet] = await db.select().from(wallets).where(eq(wallets.profileId, id)).limit(1);
  return c.json({ profile, balance: wallet?.balance ?? 0 });
});

/** Skills de una asignatura, ordenadas por posición, con el progreso del perfil (nodos de la galaxia). */
app.get("/api/skills", async (c) => {
  const db = getDb(c.env.DB);
  const subjectId = c.req.query("subject") ?? "math";
  const profileId = c.req.query("profile");

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

/** Siguiente ejercicio de una skill (stub del selector; el motor FSRS llega después). */
app.get("/api/session/next", async (c) => {
  const db = getDb(c.env.DB);
  const skillId = c.req.query("skill") ?? "MATH.ESO5.FRAC.ADD";
  const rows = await db
    .select()
    .from(exerciseTemplates)
    .where(eq(exerciseTemplates.skillId, skillId))
    .limit(10);
  if (rows.length === 0) return c.json({ error: "no exercise found" }, 404);
  // Elige uno pseudo-aleatorio del conjunto (variedad simple).
  const exercise = rows[Math.floor(Math.random() * rows.length)]!;
  return c.json(exercise);
});

/** Registra un intento: guarda el attempt, actualiza mastery y otorga monedas. */
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

  if (!body?.profileId || !body?.skillId || !body?.exerciseTemplateId || typeof body?.correct !== "boolean") {
    return c.json({ error: "invalid body" }, 400);
  }

  const now = new Date().toISOString();

  // 1) Log del intento (append-only).
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

  // 2) Recalcular mastery del (perfil, skill).
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
      set: {
        masteryScore: newMastery,
        consecutiveCorrect: consecutive,
        totalAttempts: total,
        status,
      },
    });

  // 3) Otorgar monedas si es correcto (wallet + ledger).
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

  const [wallet] = await db
    .select()
    .from(wallets)
    .where(eq(wallets.profileId, body.profileId))
    .limit(1);

  return c.json({
    correct: body.correct,
    coinsAwarded: coins,
    balance: wallet?.balance ?? 0,
    masteryScore: newMastery,
    consecutiveCorrect: consecutive,
    status,
  });
});

/** Catálogo de recompensas (tienda estelar). */
app.get("/api/rewards", async (c) => {
  const db = getDb(c.env.DB);
  return c.json(await db.select().from(rewards));
});

/** Canjear una recompensa: descuenta del saldo y registra la redención. */
app.post("/api/rewards/:id/redeem", async (c) => {
  const db = getDb(c.env.DB);
  const rewardId = c.req.param("id");
  const { profileId } = await c.req.json<{ profileId: string }>();
  if (!profileId) return c.json({ error: "invalid body" }, 400);

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
  // Los vales de pantalla quedan "pending" (el adulto los aplica a mano); el resto se aplica al momento.
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

export default app;
