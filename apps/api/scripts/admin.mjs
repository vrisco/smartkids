// CLI para crear/resetear el usuario ADMIN (todopoderoso). El admin da de alta tutores.
// Uso:
//   pnpm --filter @smartkids/api run admin -- create <email> <password> [--remote]
//   pnpm --filter @smartkids/api run admin -- reset  <email> <password> [--remote]
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const c = globalThis.crypto;
const enc = new TextEncoder();
const toHex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hashSecret(secret) {
  const salt = c.getRandomValues(new Uint8Array(16));
  const key = await c.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await c.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  return toHex(salt) + ":" + toHex(new Uint8Array(bits));
}

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const [cmd, email, password] = args.filter((a) => !a.startsWith("--"));

if (!["create", "reset"].includes(cmd) || !email || !password) {
  console.error("Uso: admin <create|reset> <email> <password> [--remote]");
  process.exit(1);
}
if (password.length < 6) {
  console.error("La contraseña debe tener 6+ caracteres.");
  process.exit(1);
}

const esc = (s) => String(s).replace(/'/g, "''");
const emailLc = email.trim().toLowerCase();
const hash = await hashSecret(password);

let sql;
if (cmd === "create") {
  const id = `par_admin_${c.randomUUID()}`;
  sql =
    `INSERT INTO parent_accounts (id, email, password_hash, email_verified, role, locale_format, created_at) ` +
    `VALUES ('${id}', '${esc(emailLc)}', '${hash}', 1, 'admin', 'es-ES', '${new Date().toISOString()}') ` +
    `ON CONFLICT(email) DO UPDATE SET password_hash='${hash}', role='admin', email_verified=1;`;
} else {
  sql = `UPDATE parent_accounts SET password_hash='${hash}', role='admin', email_verified=1 WHERE email='${esc(emailLc)}';`;
}

const file = join(mkdtempSync(join(tmpdir(), "sk-admin-")), "admin.sql");
writeFileSync(file, sql + "\n");

const flag = remote ? "--remote" : "--local";
console.log(`\n${cmd === "create" ? "Creando/actualizando" : "Reseteando"} admin '${emailLc}' en D1 ${remote ? "REMOTA" : "local"}…\n`);
const res = spawnSync(`wrangler d1 execute smartkids ${flag} --file="${file}"`, {
  shell: true,
  stdio: "inherit",
  env: { ...process.env, CI: "true" },
});
if (res.status === 0) console.log(`\n✅ Admin '${emailLc}' listo. Contraseña establecida.`);
process.exit(res.status ?? 1);
