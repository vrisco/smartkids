/**
 * Aritmética escolar EXACTA para los tipos `column_operation` (cuentas en columna: suma, resta,
 * multiplicación y división «en casita») y `prime_factorization` (descomposición en factores primos con
 * la escalera del cuaderno). Todo con enteros BigInt escalados: nada de coma flotante al corregir.
 *
 * El contenido solo guarda los NÚMEROS de partida; la solución (resultado, resto, restos parciales,
 * escalera de divisores) sale de aquí, así que una cuenta publicada no puede venir mal resuelta.
 *
 * SIN dependencias (ni zod): la web lo importa en tiempo de ejecución (`@smartkids/shared/arith`) para
 * dibujar la cuenta resuelta, la vista previa y la ficha impresa; la API lo usa vía grading.ts.
 */

export type ColumnOp = "add" | "subtract" | "multiply" | "divide";

/** Lo que define una cuenta en columna (lo comparten el ejercicio completo y su render). */
export interface ColumnSpec {
  operation: ColumnOp;
  operands: number[];
  /** Solo división: decimales del cociente (se trunca, como al dividir a mano). 0/ausente = entera con resto. */
  decimals?: number;
}

/** Cifras de un número tal y como se escribe: `int` = parte entera ("40417"), `frac` = decimales ("84"). */
export interface Digits {
  int: string;
  frac: string;
}

export function splitDigits(n: number): Digits {
  // toString pasa a notación exponencial por debajo de 1e-6 o por encima de 1e21: fuera del rango escolar.
  const s = Math.abs(n).toString();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`número fuera de rango: ${n}`);
  const [int, frac = ""] = s.split(".");
  return { int: int!, frac };
}

/** «40417,84» con el separador decimal pedido. */
export function formatDecimal(n: number, sep = ","): string {
  const d = splitDigits(n);
  return (n < 0 ? "-" : "") + d.int + (d.frac ? sep + d.frac : "");
}

const pow10 = (k: number): bigint => 10n ** BigInt(k);

/** Valor exacto: `v / 10^scale`. */
interface Dec {
  v: bigint;
  scale: number;
}

function toDec(n: number): Dec {
  const d = splitDigits(n);
  return { v: BigInt(d.int + d.frac), scale: d.frac.length };
}

function at(d: Dec, scale: number): bigint {
  return d.v * pow10(scale - d.scale);
}

/** Pasa un decimal exacto a number por su texto (así sale el double más cercano, igual que al teclearlo). */
function decToNumber(v: bigint, scale: number): number {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(scale + 1, "0");
  const int = s.slice(0, s.length - scale);
  const frac = s.slice(s.length - scale).replace(/0+$/, "");
  return Number((neg ? "-" : "") + int + (frac ? "." + frac : ""));
}

/* ======================================================================
 * Cuentas en columna
 * ==================================================================== */

/** Solo la división ENTERA (sin decimales en el cociente) pide el resto. */
export function hasRemainder(spec: ColumnSpec): boolean {
  return spec.operation === "divide" && !spec.decimals;
}

/** Nº de cifras como se escriben (sin la coma): 40417,84 -> 7. */
function digitCount(n: number): number {
  const d = splitDigits(n);
  return d.int.length + d.frac.length;
}

/**
 * Motivo por el que una cuenta NO es válida para el cuaderno (o null si lo es). Lo usa validateExercise;
 * los topes mantienen la cuadrícula dentro de una pantalla de móvil y de una hoja.
 */
export function columnSpecProblem(spec: ColumnSpec): string | null {
  const { operation: op, operands } = spec;
  if (op === "add" ? operands.length < 2 || operands.length > 4 : operands.length !== 2)
    return op === "add" ? "la suma lleva de 2 a 4 sumandos" : "esta operación lleva exactamente 2 números";
  for (const n of operands) {
    if (!Number.isFinite(n) || n < 0) return `operando no válido: ${n}`;
    let d: Digits;
    try {
      d = splitDigits(n);
    } catch {
      return `operando fuera de rango: ${n}`;
    }
    if (d.frac.length > 4) return `máximo 4 decimales por operando: ${n}`;
    if (d.int.length > 9) return `máximo 9 cifras enteras por operando: ${n}`;
  }
  if (spec.decimals !== undefined && op !== "divide") return "`decimals` solo tiene sentido en la división";
  const [a, b] = operands as [number, number];
  switch (op) {
    case "subtract": {
      const s = Math.max(toDec(a).scale, toDec(b).scale);
      if (at(toDec(a), s) < at(toDec(b), s)) return "en la resta el minuendo debe ser mayor o igual que el sustraendo";
      break;
    }
    case "multiply":
      if (digitCount(b) > 4) return "el segundo factor (el de abajo) admite como mucho 4 cifras";
      if (digitCount(a) + digitCount(b) > 12) return "multiplicación demasiado larga (máximo 12 cifras entre los dos)";
      break;
    case "divide": {
      if (toDec(b).v === 0n) return "no se puede dividir entre 0";
      const dec = spec.decimals ?? 0;
      if (dec === 0 && (splitDigits(a).frac || splitDigits(b).frac))
        return "la división entera (sin `decimals`) necesita dividendo y divisor enteros; pide decimales con `decimals`";
      const ld = longDivision(a, b, dec);
      if (String(ld.divisor).length > 5) return "divisor demasiado largo (máximo 5 cifras sin la coma)";
      if (ld.quotientInt.length + ld.quotientFrac.length > 9) return "cociente demasiado largo para la casita";
      break;
    }
    case "add":
      break;
  }
  return null;
}

export interface ColumnSolution {
  /** El resultado; en la división, el cociente truncado a `decimals`. */
  result: number;
  /** Resto (solo división entera). */
  remainder?: number;
}

export function solveColumn(spec: ColumnSpec): ColumnSolution {
  const ds = spec.operands.map(toDec);
  switch (spec.operation) {
    case "add": {
      const s = Math.max(...ds.map((d) => d.scale));
      return { result: decToNumber(ds.reduce((acc, d) => acc + at(d, s), 0n), s) };
    }
    case "subtract": {
      const s = Math.max(ds[0]!.scale, ds[1]!.scale);
      return { result: decToNumber(at(ds[0]!, s) - at(ds[1]!, s), s) };
    }
    case "multiply":
      return { result: decToNumber(ds[0]!.v * ds[1]!.v, ds[0]!.scale + ds[1]!.scale) };
    case "divide": {
      const ld = longDivision(spec.operands[0]!, spec.operands[1]!, spec.decimals ?? 0);
      const result = Number(ld.quotientInt + (ld.quotientFrac ? "." + ld.quotientFrac : ""));
      return hasRemainder(spec) ? { result, remainder: ld.remainder } : { result };
    }
  }
}

/** Un paso de la división «en casita»: se baja una cifra, se divide y queda un resto. */
export interface DivStep {
  /** Posición (en `digits`) de la última cifra bajada: ahí acaba este dividendo parcial. */
  end: number;
  /** Dividendo parcial: el resto anterior con la cifra bajada (en el primer paso, las primeras cifras). */
  partial: number;
  /** Cifra del cociente que sale en este paso. */
  digit: number;
  remainder: number;
}

export interface LongDivision {
  /** Cifras del dividendo con la coma ya corrida (si el divisor tenía decimales) y ampliadas con los
   *  ceros que se «bajan» para sacar decimales. Sin la coma. */
  digits: string;
  /** Cuántas de `digits` son parte entera (la coma va detrás de esa cifra). */
  intLen: number;
  /** Cuántas de `digits` se escriben en el dividendo; las siguientes son ceros que se bajan. */
  shownLen: number;
  /** Divisor sin coma. */
  divisor: number;
  /** Lugares que se ha corrido la coma (= decimales del divisor). 0 = nada que quitar. */
  shift: number;
  steps: DivStep[];
  quotientInt: string;
  quotientFrac: string;
  /** Resto final, en unidades de la última cifra bajada (como queda escrito en la casita). */
  remainder: number;
}

/** División larga como se hace a mano en España (método abreviado: se escriben solo los restos). */
export function longDivision(dividend: number, divisor: number, decimals = 0): LongDivision {
  const a = splitDigits(dividend);
  const b = splitDigits(divisor);
  const shift = b.frac.length;
  const div = Number(b.int + b.frac); // divisor sin coma
  // Se corre la coma del dividendo `shift` lugares (con ceros si no tiene tantos decimales).
  let digits = a.int + a.frac;
  let intLen = a.int.length + shift;
  if (digits.length < intLen) digits = digits.padEnd(intLen, "0");
  while (intLen > 1 && digits[0] === "0") {
    digits = digits.slice(1);
    intLen--;
  }
  const shownLen = digits.length;
  const need = intLen + decimals; // hasta dónde se baja: `decimals` cifras tras la coma
  if (digits.length < need) digits = digits.padEnd(need, "0");

  // Primer dividendo parcial: las primeras cifras que alcanzan al divisor (sin pasar de la parte entera).
  let j = 0;
  let cur = Number(digits[0]);
  while (cur < div && j < intLen - 1) {
    j++;
    cur = cur * 10 + Number(digits[j]);
  }
  const steps: DivStep[] = [];
  let rem = 0;
  for (let i = j; i < need; i++) {
    if (i > j) cur = rem * 10 + Number(digits[i]);
    const digit = Math.floor(cur / div);
    rem = cur % div;
    steps.push({ end: i, partial: cur, digit, remainder: rem });
  }
  const qDigits = steps.map((s) => String(s.digit)).join("");
  const nInt = intLen - j; // pasos que caen en la parte entera
  return {
    digits,
    intLen,
    shownLen,
    divisor: div,
    shift,
    steps,
    quotientInt: qDigits.slice(0, nInt),
    quotientFrac: qDigits.slice(nInt),
    remainder: rem,
  };
}

/* ======================================================================
 * Factores primos
 * ==================================================================== */

export function isPrime(n: number): boolean {
  if (!Number.isInteger(n) || n < 2) return false;
  if (n % 2 === 0) return n === 2;
  for (let d = 3; d * d <= n; d += 2) if (n % d === 0) return false;
  return true;
}

/** Factores primos de menor a mayor, repetidos: 1428 -> [2, 2, 3, 7, 17]. */
export function primeFactors(n: number): number[] {
  const out: number[] = [];
  let m = n;
  for (let d = 2; d * d <= m; d += d === 2 ? 1 : 2) {
    while (m % d === 0) {
      out.push(d);
      m /= d;
    }
  }
  if (m > 1) out.push(m);
  return out;
}

export interface PrimePower {
  base: number;
  exp: number;
}

/** [2, 2, 3, 7, 17] -> 2^2 · 3 · 7 · 17 */
export function groupFactors(factors: number[]): PrimePower[] {
  const out: PrimePower[] = [];
  for (const f of factors) {
    const last = out[out.length - 1];
    if (last && last.base === f) last.exp++;
    else out.push({ base: f, exp: 1 });
  }
  return out;
}

/** «2^2 · 3 · 7 · 17» en la notación de MathText. */
export function formatFactorization(fs: PrimePower[]): string {
  return fs.map((f) => (f.exp > 1 ? `${f.base}^${f.exp}` : String(f.base))).join(" · ");
}

/** La escalera del cuaderno: cada fila, el número y el primo entre el que se divide; la última, el 1. */
export function factorLadder(n: number): { value: number; divisor?: number }[] {
  const rows: { value: number; divisor?: number }[] = [];
  let v = n;
  for (const p of primeFactors(n)) {
    rows.push({ value: v, divisor: p });
    v /= p;
  }
  rows.push({ value: v });
  return rows;
}

/** ¿Es `fs` la descomposición de `n`? Vale cualquier orden y repetir un primo (2 · 2 = 2^2): todas las
 *  bases primas y el producto exacto igual a `n` (por la unicidad de la factorización, basta con eso). */
export function isFactorizationOf(n: number, fs: PrimePower[]): boolean {
  if (fs.length === 0) return false;
  const target = BigInt(n);
  let prod = 1n;
  for (const f of fs) {
    if (!Number.isInteger(f.exp) || f.exp < 1 || !isPrime(f.base)) return false;
    for (let k = 0; k < f.exp; k++) {
      prod *= BigInt(f.base);
      if (prod > target) return false;
    }
  }
  return prod === target;
}
