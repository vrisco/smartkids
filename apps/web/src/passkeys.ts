// Passkeys (WebAuthn) en el cliente: registro (tutor logueado) y login biométrico.
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { api, type Parent } from "./api";

export function passkeySupported(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential !== "undefined";
}

/** Registra una passkey para el tutor actual (Face ID / Touch ID / huella). */
export async function registerPasskey(): Promise<boolean> {
  const { options, flowId } = await api.passkeyRegisterOptions();
  const response = await startRegistration({ optionsJSON: options });
  const r = await api.passkeyRegisterVerify(flowId, response);
  return r.ok;
}

/** Inicia sesión con una passkey. Devuelve el tutor autenticado. */
export async function loginWithPasskey(): Promise<Parent> {
  const { options, flowId } = await api.passkeyLoginOptions();
  const response = await startAuthentication({ optionsJSON: options });
  const r = await api.passkeyLoginVerify(flowId, response);
  return r.parent;
}
