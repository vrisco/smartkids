// Web Push (VAPID) SIN payload: firma un JWT ES256 con la clave privada (JWK) y hace
// POST al endpoint de la suscripción con cuerpo vacío. El service worker recibe el
// evento `push` (sin datos) y muestra una notificación. No ciframos payload (RFC 8291)
// a propósito: es más simple y robusto; el SW ya sabe qué texto mostrar.

export interface PushEnv {
  VAPID_PUBLIC?: string;
  VAPID_PRIVATE_JWK?: string;
  VAPID_SUBJECT?: string;
}

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let cached: { jwk: string; key: CryptoKey } | null = null;
async function privateKey(jwk: string): Promise<CryptoKey> {
  if (cached && cached.jwk === jwk) return cached.key;
  const key = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(jwk) as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  cached = { jwk, key };
  return key;
}

// JWT VAPID: header.payload firmado ES256 (la firma de WebCrypto ya es r||s, formato JOSE).
async function vapidToken(aud: string, sub: string, key: CryptoKey): Promise<string> {
  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const payload = b64url(enc.encode(JSON.stringify({ aud, exp, sub })));
  const signingInput = `${header}.${payload}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
}

export interface PushResult {
  ok: boolean;
  status: number;
  gone: boolean; // 404/410 -> la suscripción ya no existe, hay que borrarla
}

/** Envía un push (sin payload) a un endpoint. No lanza: devuelve el resultado. */
export async function sendPush(env: PushEnv, endpoint: string): Promise<PushResult> {
  if (!env.VAPID_PRIVATE_JWK || !env.VAPID_PUBLIC) return { ok: false, status: 0, gone: false };
  try {
    const u = new URL(endpoint);
    const aud = `${u.protocol}//${u.host}`;
    const key = await privateKey(env.VAPID_PRIVATE_JWK);
    const jwt = await vapidToken(aud, env.VAPID_SUBJECT ?? "https://app.smart-kids.uk", key);
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        TTL: "86400",
        Urgency: "normal",
        Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC}`,
      },
    });
    return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
  } catch {
    return { ok: false, status: 0, gone: false };
  }
}
