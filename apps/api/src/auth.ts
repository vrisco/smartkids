import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { and, eq } from "drizzle-orm";
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
  const [row] = await db
    .select({ id: schema.childProfiles.id })
    .from(schema.childProfiles)
    .where(and(eq(schema.childProfiles.id, profileId), eq(schema.childProfiles.parentId, parentId)))
    .limit(1);
  return Boolean(row);
}
