// Genera los PNG de la PWA a partir de public/icon.svg (rasteriza con resvg).
// Ejecutar: pnpm --filter @smartkids/web run gen:icons
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pub = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const svg = readFileSync(join(pub, "icon.svg"));

// background rellena las esquinas redondeadas -> PNG cuadrado (bueno para maskable/apple-touch).
const render = (size, out) => {
  const r = new Resvg(svg, { fitTo: { mode: "width", value: size }, background: "#0a0d1f" });
  writeFileSync(join(pub, out), r.render().asPng());
  console.log(`  ${out} (${size}x${size})`);
};

render(192, "icon-192.png");
render(512, "icon-512.png");
render(180, "apple-touch-icon.png");
console.log("iconos PWA generados en public/");
