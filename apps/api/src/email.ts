export interface EmailEnv {
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_DEV_LINKS?: string;
}

/** En local (EMAIL_DEV_LINKS=true) devolvemos el enlace en la respuesta para poder probar sin proveedor. */
export function devLinksEnabled(env: EmailEnv): boolean {
  return (env.EMAIL_DEV_LINKS ?? "").trim() === "true";
}

/** Envía por Resend si hay API key; si no, modo mock (solo log). Provider intercambiable. */
export async function sendEmail(
  env: EmailEnv,
  to: string,
  subject: string,
  html: string,
): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.log(`[email:mock] to=${to} · ${subject}`);
    return false;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM ?? "smartkids <onboarding@resend.dev>",
      to,
      subject,
      html,
    }),
  });
  if (!res.ok) console.log(`[email] Resend error ${res.status}`);
  return res.ok;
}

export function emailLayout(title: string, body: string, cta?: { url: string; label: string }): string {
  const button = cta
    ? `<p style="margin:24px 0"><a href="${cta.url}" style="background:#37E1E8;color:#04121B;padding:12px 20px;border-radius:12px;text-decoration:none;font-weight:700">${cta.label}</a></p>`
    : "";
  return `<div style="font-family:sans-serif;max-width:480px;margin:auto;color:#16201E">
    <h1 style="color:#0E7C6B">smartkids · Órbita</h1>
    <h2>${title}</h2><p>${body}</p>${button}
    <p style="color:#7A857F;font-size:12px">Si no fuiste tú, ignora este correo.</p></div>`;
}
