#!/usr/bin/env node
/**
 * Copia de seguridad CIFRADA de la D1 de producción.
 *
 *   pnpm --filter @smartkids/api run backup
 *
 * Por qué cifrada: el volcado lleva emails de los tutores, los hashes PBKDF2 de sus
 * contraseñas y de los PIN de los niños, y los nombres de los menores. Un .sql en claro
 * en el disco es el mismo dato personal que protege el resto del sistema.
 *
 * La frase de paso se lee de SMARTKIDS_BACKUP_PASSPHRASE y NUNCA se escribe a disco ni
 * se imprime. Sin ella el script no corre: es preferible no tener copia a tener una
 * copia en claro que nadie vigila.
 *
 * Restaurar:
 *   gpg --decrypt copia.sql.gpg > copia.sql
 *   wrangler d1 execute smartkids --remote --file=copia.sql   (OJO: sobrescribe)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DESTINO = process.env.SMARTKIDS_BACKUP_DIR ?? join(homedir(), "smartkids-backups");
const RETENER = 5; // copias que se conservan; las más viejas se borran
const PASS = process.env.SMARTKIDS_BACKUP_PASSPHRASE;

if (!PASS) {
  console.error(
    [
      "Falta SMARTKIDS_BACKUP_PASSPHRASE.",
      "",
      "El volcado lleva datos personales de menores, así que este script no genera copias en claro.",
      "Define la frase de paso una vez (PowerShell, permanente para tu usuario):",
      "",
      '  [Environment]::SetEnvironmentVariable("SMARTKIDS_BACKUP_PASSPHRASE", "<frase larga>", "User")',
      "",
      "Guárdala en tu gestor de contraseñas: sin ella la copia no se puede restaurar.",
    ].join("\n"),
  );
  process.exit(1);
}

function correr(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"], ...opts });
}

mkdirSync(DESTINO, { recursive: true });
const sello = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const plano = join(DESTINO, `smartkids-${sello}.sql`);
const cifrado = `${plano}.gpg`;

console.log(`Exportando la D1 de producción a ${cifrado}`);
try {
  correr("npx", ["wrangler", "d1", "export", "smartkids", "--remote", "--output", plano]);

  // gpg lee la frase de la entrada estándar: nunca aparece en la línea de comandos,
  // que en Windows es visible desde el gestor de tareas.
  correr(
    "gpg",
    ["--batch", "--yes", "--symmetric", "--cipher-algo", "AES256", "--passphrase-fd", "0", "--output", cifrado, plano],
    { input: PASS, stdio: ["pipe", "inherit", "inherit"] },
  );
  console.log(`Cifrada: ${(statSync(cifrado).size / 1024).toFixed(0)} KB`);
} finally {
  // El volcado en claro se borra SIEMPRE, también si el cifrado falló a mitad.
  try {
    rmSync(plano, { force: true });
  } catch {
    console.error(`AVISO: no se pudo borrar el volcado en claro ${plano}. Bórralo a mano.`);
  }
}

// Retención: conserva las N más recientes.
const copias = readdirSync(DESTINO)
  .filter((f) => f.endsWith(".sql.gpg"))
  .sort()
  .reverse();
for (const vieja of copias.slice(RETENER)) {
  rmSync(join(DESTINO, vieja), { force: true });
  console.log(`Rotada: ${vieja}`);
}
console.log(`Listo. ${Math.min(copias.length, RETENER)} copias en ${DESTINO}`);
