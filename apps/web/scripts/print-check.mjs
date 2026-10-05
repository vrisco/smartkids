// Comprobación visual de la impresión (SOLO desarrollo). Con `pnpm --filter @smartkids/web dev` arrancado,
// genera con Chrome sin interfaz un PDF por caso de print-demo.html (materias × edades × modos y cada tipo
// de documento) en apps/web/.print-out/ y comprueba el número de páginas de los casos que lo garantizan
// (la clave en su propia página, las tarjetas a doble cara en número par). Los PDF se revisan después a ojo.
//
//   node apps/web/scripts/print-check.mjs [--base http://localhost:5173] [--only <texto>]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", ".print-out");
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const BASE = arg("--base", "http://localhost:5173");
const ONLY = arg("--only", "");

const CHROMES = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const CHROME = CHROMES.find((c) => existsSync(c));
if (!CHROME) {
  console.error("No encuentro Chrome/Edge (variable CHROME para indicarlo).");
  process.exit(1);
}

// [nombre, query, páginas esperadas | null]
const CASES = [
  ["mates-ficha-pri6", "view=sheet&subject=math&grade=PRI-6&mode=practice", null],
  ["mates-ficha-pri3-compacta", "view=sheet&subject=math&grade=PRI-3&mode=practice&compact=1", null],
  ["mates-examen-AB", "view=sheet&subject=math&grade=PRI-6&mode=exam&versions=1", null],
  ["mates-examen-explicada", "view=sheet&subject=math&grade=ESO-2&mode=exam&key=explained", null],
  ["mates-calculo-rapido", "view=sheet&subject=math&grade=PRI-6&mode=drill&n=16", null],
  ["mates-cuadernillo-3", "view=sheet&subject=math&grade=PRI-5&mode=practice&sheets=3&n=6", null],
  ["mates-ficha-carta", "view=sheet&subject=math&grade=PRI-6&mode=practice&paper=letter", null],
  ["mates-ficha-oscuro", "view=sheet&subject=math&grade=PRI-6&mode=practice&key=explained&dark=1", null],
  ["lengua-ficha-pri1-pauta", "view=sheet&subject=lengua&grade=PRI-1&mode=practice&n=6", null],
  ["lengua-repaso-pri4", "view=sheet&subject=lengua&grade=PRI-4&mode=review&n=6", null],
  ["ingles-ficha", "view=sheet&subject=ingles&grade=PRI-5&mode=practice&n=3", null],
  ["sociales-examen", "view=sheet&subject=sociales&grade=ESO-2&mode=exam&n=3", null],
  ["tarjetas-ejercicios-doble", "view=cards&subject=math&grade=PRI-6", "par"],
  ["tarjetas-ejercicios-doblar", "view=cards&subject=math&grade=PRI-6&layout=fold", null],
  ["ejemplos-resueltos", "view=worked&subject=math&grade=PRI-6", null],
  ["hoja-recuerda", "view=remember&subject=math&grade=PRI-6", null],
  ...[
    "summary.math",
    "cheatsheet.lengua",
    "flashcards.ingles",
    "glossary.naturales",
    "worked_examples.math",
    "concept_map.naturales",
    "timeline.sociales",
    "reading.lengua",
    "dictation.ingles",
    "writing.lengua",
    "00-calculo.cheatsheet",
    "03-division-entera.summary",
  ].map((d) => [`doc-${d}`, `view=doc&doc=${d}&grade=PRI-5`, d === "flashcards.ingles" ? "par" : null]),
];

mkdirSync(OUT, { recursive: true });
// Perfil propio: si Chrome ya está abierto, sin esto la orden se va a esa ventana y no sale ningún PDF.
const PROFILE = join(tmpdir(), "sk-print-check-profile");
/** En Windows chrome.exe vuelve antes de que su proceso hijo escriba el PDF: espera a que aparezca y no crezca. */
function waitForFile(file, ms = 30_000) {
  const end = Date.now() + ms;
  let last = -1;
  while (Date.now() < end) {
    if (existsSync(file)) {
      const size = statSync(file).size;
      if (size > 0 && size === last) return true;
      last = size;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
  }
  return existsSync(file);
}
let bad = 0;
for (const [name, query, pages] of CASES) {
  if (ONLY && !name.includes(ONLY)) continue;
  const file = join(OUT, `${name}.pdf`);
  rmSync(file, { force: true });
  try {
    execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--no-pdf-header-footer", `--user-data-dir=${PROFILE}`, "--virtual-time-budget=10000", `--print-to-pdf=${file}`, `${BASE}/print-demo.html?${query}`], {
      stdio: "ignore",
      timeout: 60_000,
    });
  } catch (e) {
    bad++;
    console.log(`  x ${name}: Chrome falló (${e.message})`);
    continue;
  }
  if (!waitForFile(file)) {
    bad++;
    console.log(`  x ${name}: no se generó el PDF`);
    continue;
  }
  const pdf = readFileSync(file, "latin1");
  const n = (pdf.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  const ok = pages === null || (pages === "par" ? n % 2 === 0 : n === pages);
  if (!ok) bad++;
  console.log(`  ${ok ? "ok" : "x "} ${name}: ${n} página(s)${pages !== null ? ` (esperadas: ${pages})` : ""}`);
}
console.log(bad ? `\n${bad} caso(s) con problemas.` : `\nPDF en ${OUT}`);
process.exit(bad ? 1 : 0);
