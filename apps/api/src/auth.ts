import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { and, eq, lt } from "drizzle-orm";
import { getDb, schema } from "./db";

type DB = ReturnType<typeof getDb>;

const PBKDF2_ITER = 100_000;
const COOKIE = "sk_session";
const SESSION_DAYS = 30;
const enc = new TextEncoder();

/* ---------- Utilidades hex ---------- */

function toHex(u8: Uint8Array): string {
  let s = "";
  for (const b of u8) s += b.toString(16).padStart(2, "0");
  return s;
}
function fromHex(hex: string): Uint8Array {
  const u8 = new Uint8Array(hex.length / 2);
  for (let i = 0; i < u8.length; i++) u8[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return u8;
}

/* ---------- Hash de contraseñas / PIN (PBKDF2-SHA256) ---------- */

async function pbkdf2(secret: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITER, hash: "SHA-256" },
    key,
    256,
  );
  return toHex(new Uint8Array(bits));
}

export async function hashSecret(secret: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `${toHex(salt)}:${await pbkdf2(secret, salt)}`;
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const hash = await pbkdf2(secret, fromHex(saltHex));
  if (hash.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ hashHex.charCodeAt(i);
  return diff === 0;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return toHex(new Uint8Array(buf));
}

/* ---------- Sesiones (D1 + cookie mismo origen) ---------- */

export async function createSession(db: DB, parentId: string): Promise<string> {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await db.insert(schema.sessions).values({
    id: await sha256Hex(token),
    parentId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_DAYS * 86_400_000).toISOString(),
  });
  return token;
}

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:", // sin Secure en http local
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
}

export async function currentParentId(c: Context, db: DB): Promise<string | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const id = await sha256Hex(token);
  const [row] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).limit(1);
  if (!row) return null;
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    await db.delete(schema.sessions).where(eq(schema.sessions.id, id));
    return null;
  }
  return row.parentId;
}

export async function destroySession(c: Context, db: DB): Promise<void> {
  const token = getCookie(c, COOKIE);
  if (token) await db.delete(schema.sessions).where(eq(schema.sessions.id, await sha256Hex(token)));
  deleteCookie(c, COOKIE, { path: "/" });
}

export async function ownsProfile(db: DB, parentId: string, profileId: string): Promise<boolean> {
  const [child] = await db
    .select({ owner: schema.childProfiles.parentId })
    .from(schema.childProfiles)
    .where(eq(schema.childProfiles.id, profileId))
    .limit(1);
  if (!child) return false;
  if (child.owner === parentId) return true;
  // El niño puede pertenecer al cónyuge (hogar compartido). Exigimos vínculo SIMÉTRICO
  // en ambas cuentas: así un estado asimétrico (p.ej. por una carrera) nunca concede acceso.
  const [me] = await db
    .select({ spouseId: schema.parentAccounts.spouseId })
    .from(schema.parentAccounts)
    .where(eq(schema.parentAccounts.id, parentId))
    .limit(1);
  if (!me?.spouseId || me.spouseId !== child.owner) return false;
  const [owner] = await db
    .select({ spouseId: schema.parentAccounts.spouseId })
    .from(schema.parentAccounts)
    .where(eq(schema.parentAccounts.id, child.owner))
    .limit(1);
  return owner?.spouseId === parentId;
}

/* ---------- Tokens de verificación / recuperación (un solo uso) ---------- */

export async function createAuthToken(
  db: DB,
  parentId: string,
  type: "verify" | "reset",
  ttlMs: number,
): Promise<string> {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await db.insert(schema.authTokens).values({
    id: await sha256Hex(token),
    parentId,
    type,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  });
  return token;
}

export async function consumeAuthToken(
  db: DB,
  token: string,
  type: "verify" | "reset",
): Promise<string | null> {
  const id = await sha256Hex(token);
  const [row] = await db
    .select()
    .from(schema.authTokens)
    .where(and(eq(schema.authTokens.id, id), eq(schema.authTokens.type, type)))
    .limit(1);
  if (!row) return null;
  await db.delete(schema.authTokens).where(eq(schema.authTokens.id, id)); // un solo uso
  return new Date(row.expiresAt).getTime() < Date.now() ? null : row.parentId;
}

/* ---------- Rate limiting (registro de intentos en D1) ---------- */

const RL_WINDOW_MS = 15 * 60 * 1000;
const RL_MAX = 6;

export async function rateLimited(db: DB, ident: string): Promise<boolean> {
  const since = new Date(Date.now() - RL_WINDOW_MS).toISOString();
  await db.delete(schema.loginAttempts).where(lt(schema.loginAttempts.ts, since)); // poda
  const rows = await db
    .select({ id: schema.loginAttempts.id })
    .from(schema.loginAttempts)
    .where(eq(schema.loginAttempts.ident, ident));
  return rows.length >= RL_MAX;
}

export async function recordAttempt(db: DB, ident: string): Promise<void> {
  await db
    .insert(schema.loginAttempts)
    .values({ id: crypto.randomUUID(), ident, ts: new Date().toISOString() });
}

export async function clearAttempts(db: DB, ident: string): Promise<void> {
  await db.delete(schema.loginAttempts).where(eq(schema.loginAttempts.ident, ident));
}

/* ---------- Sesiones de NIÑO (login propio usuario + PIN) ---------- */

const CHILD_COOKIE = "sk_child";

export async function createChildSession(db: DB, childId: string): Promise<string> {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await db.insert(schema.childSessions).values({
    id: await sha256Hex(token),
    childId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_DAYS * 86_400_000).toISOString(),
  });
  return token;
}

export function setChildCookie(c: Context, token: string): void {
  setCookie(c, CHILD_COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
}

export async function currentChildId(c: Context, db: DB): Promise<string | null> {
  const token = getCookie(c, CHILD_COOKIE);
  if (!token) return null;
  const id = await sha256Hex(token);
  const [row] = await db.select().from(schema.childSessions).where(eq(schema.childSessions.id, id)).limit(1);
  if (!row) return null;
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    await db.delete(schema.childSessions).where(eq(schema.childSessions.id, id));
    return null;
  }
  return row.childId;
}

export async function destroyChildSession(c: Context, db: DB): Promise<void> {
  const token = getCookie(c, CHILD_COOKIE);
  if (token) await db.delete(schema.childSessions).where(eq(schema.childSessions.id, await sha256Hex(token)));
  deleteCookie(c, CHILD_COOKIE, { path: "/" });
}
