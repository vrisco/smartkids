import { Hono } from "hono";
import { cors } from "hono/cors";
import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "./db";

export interface Env {
  DB: D1Database;
}

const app = new Hono<{ Bindings: Env }>();

app.use("/api/*", cors());

app.get("/api/health", (c) =>
  c.json({ ok: true, service: "smartkids-api", ts: new Date().toISOString() }),
);

/** Skills de una asignatura, ordenadas por posición (nodos de la galaxia). */
app.get("/api/skills", async (c) => {
  const db = getDb(c.env.DB);
  const subjectId = c.req.query("subject") ?? "math";
  const rows = await db
    .select()
    .from(schema.skills)
    .where(eq(schema.skills.subjectId, subjectId))
    .orderBy(asc(schema.skills.position));
  return c.json(rows);
});

/** Siguiente ejercicio de una skill (stub del selector; el motor FSRS llega después). */
app.get("/api/session/next", async (c) => {
  const db = getDb(c.env.DB);
  const skillId = c.req.query("skill") ?? "MATH.ESO5.FRAC.ADD";
  const rows = await db
    .select()
    .from(schema.exerciseTemplates)
    .where(eq(schema.exerciseTemplates.skillId, skillId))
    .limit(1);
  const exercise = rows[0];
  if (!exercise) return c.json({ error: "no exercise found" }, 404);
  return c.json(exercise);
});

export default app;
