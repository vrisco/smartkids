import { Hono } from "hono";
import { cors } from "hono/cors";

export interface Env {
  DB: D1Database;
}

const app = new Hono<{ Bindings: Env }>();

app.use("/api/*", cors());

app.get("/api/health", (c) =>
  c.json({ ok: true, service: "smartkids-api", ts: new Date().toISOString() }),
);

// Stub: el motor real (heurístico + FSRS, lectura de D1) llega en un hito posterior.
app.get("/api/session/next", (c) =>
  c.json({
    exerciseId: "demo-1",
    type: "multiple_choice",
    skillId: "MATH.ESO5.FRAC.ADD",
    stem: "1/2 + 1/3 = ?",
    options: [
      { id: "a", text: "5/6", isCorrect: true },
      { id: "b", text: "2/5", isCorrect: false },
      { id: "c", text: "1/6", isCorrect: false },
      { id: "d", text: "3/6", isCorrect: false },
    ],
  }),
);

export default app;
