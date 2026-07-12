// Utilidades de capacidades PWA (instalación, badge del icono, vibración, wake lock).
// Todo defensivo: si el navegador no soporta algo, no pasa nada.

/* ---------- Instalación (Android: beforeinstallprompt) ---------- */

type PromptEvent = Event & { prompt: () => void; userChoice: Promise<{ outcome: string }> };
let deferred: PromptEvent | null = null;
const listeners = new Set<(can: boolean) => void>();
const notify = () => listeners.forEach((l) => l(deferred != null));

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as PromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    notify();
  });
}

/** Suscribe a cambios de disponibilidad de instalación. Devuelve el estado actual y un desuscriptor. */
export function onInstallAvailable(cb: (can: boolean) => void): () => void {
  listeners.add(cb);
  cb(deferred != null);
  return () => listeners.delete(cb);
}

/** Lanza el diálogo de instalación (Android). Devuelve true si el usuario aceptó. */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  deferred.prompt();
  const res = await deferred.userChoice.catch(() => ({ outcome: "dismissed" }));
  deferred = null;
  notify();
  return res.outcome === "accepted";
}

/** ¿Está corriendo en modo app instalada (standalone)? */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // iOS Safari legacy
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/** ¿iOS? (para mostrar el instructivo de "Compartir → Añadir a pantalla de inicio"). */
export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/* ---------- Badge del icono (nº de pendientes) ---------- */

export function setBadge(n: number): void {
  try {
    const nav = navigator as unknown as { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (n > 0) void nav.setAppBadge?.(n);
    else void nav.clearAppBadge?.();
  } catch {
    /* no soportado */
  }
}

/* ---------- Vibración (Android) ---------- */

export function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* no soportado */
  }
}

/* ---------- Web Push ---------- */

export function pushSupported(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function urlB64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function getPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** Pide permiso y crea la suscripción. Devuelve la suscripción (para mandarla al servidor) o null. */
export async function subscribePush(vapidPublic: string): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(vapidPublic) as BufferSource });
}

/** Cancela la suscripción en el navegador. Devuelve el endpoint que había (para borrarlo en el servidor). */
export async function unsubscribePush(): Promise<string | null> {
  const sub = await getPushSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  return endpoint;
}

/* ---------- Wake lock (mantener pantalla encendida en una sesión) ---------- */

type WakeSentinel = { release: () => Promise<void> };

/** Pide un wake lock de pantalla; devuelve una función para liberarlo. Re-adquiere al volver de segundo plano. */
export function keepAwake(): () => void {
  let sentinel: WakeSentinel | null = null;
  let released = false;
  const req = async () => {
    try {
      const wl = (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<WakeSentinel> } }).wakeLock;
      if (wl && !released) sentinel = await wl.request("screen");
    } catch {
      /* denegado / no soportado */
    }
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") void req();
  };
  void req();
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    released = true;
    document.removeEventListener("visibilitychange", onVisible);
    void sentinel?.release().catch(() => {});
    sentinel = null;
  };
}
