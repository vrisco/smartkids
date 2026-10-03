// Cuentas en columna (suma, resta, multiplicación y división «en casita») y descomposición en factores
// primos con su escalera, colocadas como en el cuaderno. La MISMA colocación sirve en tres sitios:
//   - pantalla (`ColumnOperationInput` / `FactorizationInput`): el niño la hace en una cuadrícula. Solo se
//     corrige el resultado (y el resto); llevadas, productos parciales, restos y escalera son borrador local.
//   - resuelta (`WorkedOperation`): tras fallar y en la vista previa del tutor, la cuenta entera hecha.
//   - papel (`PaperOperation`): la ficha impresa, con la cuadrícula vacía para hacerla a lápiz.
// La aritmética (exacta, sin coma flotante) es la de `@smartkids/shared/arith`, la misma que corrige en
// el servidor; aquí solo se coloca.
import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  factorLadder,
  formatDecimal,
  formatFactorization,
  groupFactors,
  longDivision,
  primeFactors,
  solveColumn,
  splitDigits,
  type ColumnSpec,
} from "@smartkids/shared/arith";
import type { Answer, AttemptResult, RenderPayload } from "../api";
import { MathText } from "./MathText";

type ColumnRender = Extract<RenderPayload, { type: "column_operation" }>;
type FactorRender = Extract<RenderPayload, { type: "prime_factorization" }>;
/** Lo mínimo para dibujar una de estas cuentas: vale el render del niño o el ejercicio completo. */
export type OperationSpec = ({ type: "column_operation" } & ColumnSpec) | { type: "prime_factorization"; number: number };

type Mode = "input" | "solved" | "paper";

/** El niño escribe la coma con la tecla de su teclado; en inglés se pinta punto decimal. */
export const decimalSep = (lang: string | undefined) => (lang?.startsWith("en") ? "." : ",");

const NO_AUTOCORRECT = { autoComplete: "off", autoCorrect: "off", autoCapitalize: "none", spellCheck: false } as const;

/* ======================================================================
 * Colocación en cuadrícula
 * ==================================================================== */

type Role = "carry" | "scratch" | "result" | "quotient";

/** Casilla editable: hacia dónde se avanza al escribir (las cuentas se hacen de derecha a izquierda; el
 *  cociente y los restos, de izquierda a derecha) y si admite coma (la pone el niño) o la trae impresa. */
interface Slot {
  role: Role;
  dir: 1 | -1;
  commaOk?: boolean;
  fixedComma?: boolean;
}

interface Cell {
  text?: string;
  comma?: boolean;
  slot?: Slot;
  /** Raya encima (la del resultado; la de debajo del divisor). */
  top?: boolean;
  /** Raya vertical a la izquierda (la casita de la división). */
  bar?: boolean;
  small?: boolean;
  tone?: "given" | "result" | "work";
}

interface Layout {
  cols: number;
  rows: Cell[][];
  /** División entera: se pide el resto aparte (nº de casillas). */
  remainderCells?: number;
  /** Algún resultado admite coma que pone el niño. */
  commaInput?: boolean;
  /** División con divisor decimal resuelta: la cuenta equivalente sin coma en el divisor. */
  shifted?: { from: string; to: string };
}

const newRow = (cols: number): Cell[] => Array.from({ length: cols }, () => ({}));
const colsVar = (n: number) => ({ "--cols": n }) as CSSProperties;

/** Escribe `digits` de modo que la última cifra caiga en la columna `end`; `commaAfter` = índice de la cifra tras
 *  la que va la coma (-1, ninguna). */
function write(row: Cell[], end: number, digits: string, commaAfter = -1, tone: Cell["tone"] = "given") {
  const start = end - digits.length + 1;
  for (let i = 0; i < digits.length; i++) {
    const c = row[start + i];
    if (!c) continue;
    c.text = digits[i];
    c.tone = tone;
    if (i === commaAfter) c.comma = true;
  }
}

function slots(row: Cell[], from: number, to: number, slot: Slot) {
  for (let c = from; c <= to; c++) if (row[c]) row[c]!.slot = { ...slot };
}

function layoutAddSub(spec: ColumnSpec, mode: Mode): Layout {
  const add = spec.operation === "add";
  const ds = spec.operands.map(splitDigits);
  const I = Math.max(...ds.map((d) => d.int.length));
  const F = Math.max(...ds.map((d) => d.frac.length));
  const intCols = add ? I + 1 : I; // la suma puede ganar una cifra a la izquierda
  const cols = 1 + intCols + F; // columna 0 = signo
  const units = intCols;
  const rows: Cell[][] = [];

  // Llevadas (fila pequeña de arriba).
  const carry = newRow(cols).map((c) => ({ ...c, small: true }));
  if (mode === "solved") {
    const aligned = ds.map((d) => d.int.padStart(intCols, "0") + d.frac.padEnd(F, "0"));
    let k = 0;
    for (let i = intCols + F - 1; i > 0; i--) {
      const col = aligned.map((s) => Number(s[i]));
      if (add) {
        k = Math.floor((col.reduce((a, b) => a + b, 0) + k) / 10);
      } else {
        k = col[0]! < col[1]! + k ? 1 : 0;
      }
      // La llevada que entra en la cifra nueva de la suma ya es resultado: no se apunta arriba.
      if (k > 0 && !(add && i - 1 === 0)) write(carry, i, String(k), -1, "work");
    }
  } else {
    slots(carry, add ? 2 : 1, cols - 2, { role: "carry", dir: -1 });
  }
  rows.push(carry);

  ds.forEach((d, i) => {
    const r = newRow(cols);
    write(r, units, d.int, d.frac ? d.int.length - 1 : -1);
    write(r, units + d.frac.length, d.frac);
    if (i === ds.length - 1) r[0]!.text = add ? "+" : "−";
    rows.push(r);
  });

  const res = newRow(cols).map((c) => ({ ...c, top: true }));
  if (mode === "solved") {
    const d = splitDigits(solveColumn(spec).result);
    write(res, units, d.int, F ? d.int.length - 1 : -1, "result");
    write(res, units + F, d.frac.padEnd(F, "0"), -1, "result");
  } else {
    slots(res, 1, cols - 1, { role: "result", dir: -1 });
    if (F) res[units]!.slot!.fixedComma = true; // al sumar se alinean las comas: la del resultado va impresa
  }
  rows.push(res);
  return { cols, rows };
}

function layoutMultiply(spec: ColumnSpec, mode: Mode): Layout {
  const a = splitDigits(spec.operands[0]!);
  const b = splitDigits(spec.operands[1]!);
  const da = a.int + a.frac;
  const db = b.int + b.frac;
  const scale = a.frac.length + b.frac.length;
  const cols = 1 + da.length + db.length;
  const last = cols - 1;
  const rows: Cell[][] = [];

  if (mode !== "solved") {
    const carry = newRow(cols).map((c) => ({ ...c, small: true }));
    slots(carry, last - da.length + 1, last - 1, { role: "carry", dir: -1 });
    rows.push(carry);
  }
  const ra = newRow(cols);
  write(ra, last, da, a.frac ? a.int.length - 1 : -1);
  const rb = newRow(cols);
  write(rb, last, db, b.frac ? b.int.length - 1 : -1);
  rb[0]!.text = "×";
  rows.push(ra, rb);

  // Un producto parcial por cifra del factor de abajo, cada uno corrido un lugar a la izquierda.
  if (db.length > 1) {
    for (let k = 0; k < db.length; k++) {
      const r = newRow(cols).map((c) => ({ ...c, top: k === 0 }));
      const end = last - k;
      if (mode === "solved") {
        write(r, end, String(BigInt(da) * BigInt(db[db.length - 1 - k]!)), -1, "work");
      } else {
        slots(r, end - da.length, end, { role: "scratch", dir: -1 });
      }
      rows.push(r);
    }
  }

  const res = newRow(cols).map((c) => ({ ...c, top: true }));
  if (mode === "solved") {
    const d = splitDigits(solveColumn(spec).result);
    const frac = d.frac.padEnd(scale, "0"); // 0,5 × 0,4 = 0,20: tantas cifras decimales como entre los dos
    write(res, last, d.int + frac, scale ? d.int.length - 1 : -1, "result");
  } else {
    slots(res, 1, last, { role: "result", dir: -1, commaOk: scale > 0 });
  }
  rows.push(res);
  return { cols, rows, commaInput: mode === "input" && scale > 0 };
}

function layoutDivide(spec: ColumnSpec, mode: Mode, sep: string): Layout {
  const [A, B] = spec.operands as [number, number];
  const dec = spec.decimals ?? 0;
  const ld = longDivision(A, B, dec);
  const need = ld.intLen + dec;

  if (mode === "solved") {
    // Resuelta: la cuenta ya sin coma en el divisor, con los restos que se escriben bajo el dividendo.
    const quotient = ld.quotientInt + ld.quotientFrac;
    const divisor = String(ld.divisor);
    const L = Math.max(ld.shownLen, need);
    const R = Math.max(divisor.length, quotient.length);
    const cols = L + R;
    const rows: Cell[][] = [];
    const r0 = newRow(cols);
    write(r0, ld.shownLen - 1, ld.digits.slice(0, ld.shownLen), ld.shownLen > ld.intLen ? ld.intLen - 1 : -1);
    write(r0, L + divisor.length - 1, divisor);
    r0[L]!.bar = true;
    rows.push(r0);
    const n = ld.steps.length;
    for (let k = 1; k <= n; k++) {
      const r = newRow(cols);
      if (k < n) {
        const step = ld.steps[k]!;
        write(r, step.end, String(ld.steps[k - 1]!.remainder) + ld.digits[step.end], -1, "work");
      } else {
        const lastStep = ld.steps[n - 1]!;
        write(r, lastStep.end, String(lastStep.remainder), -1, dec ? "work" : "result");
      }
      rows.push(r);
    }
    if (rows.length < 2) rows.push(newRow(cols));
    const r1 = rows[1]!;
    for (let c = L; c < cols; c++) r1[c]!.top = true;
    r1[L]!.bar = true;
    write(r1, L + quotient.length - 1, quotient, ld.quotientFrac ? ld.quotientInt.length - 1 : -1, "result");
    const shifted =
      ld.shift > 0
        ? {
            from: `${formatDecimal(A, sep)} : ${formatDecimal(B, sep)}`,
            to: `${ld.digits.slice(0, ld.intLen)}${ld.shownLen > ld.intLen ? sep + ld.digits.slice(ld.intLen, ld.shownLen) : ""} : ${divisor}`,
          }
        : undefined;
    return { cols, rows, shifted };
  }

  // Para hacerla: el dividendo y el divisor tal cual (quitar la coma del divisor es parte del ejercicio),
  // sitio para los restos y casillas para el cociente (tantas como cifras PUEDE tener: no chiva cuántas son).
  const a = splitDigits(A);
  const b = splitDigits(B);
  const da = a.int + a.frac;
  const db = b.int + b.frac;
  const L = Math.max(da.length, need, ld.shownLen);
  const qCells = Math.max(1, ld.intLen - String(ld.divisor).length + 1) + dec;
  const R = Math.max(db.length, qCells);
  const cols = L + R;
  const rows: Cell[][] = [];
  const r0 = newRow(cols);
  write(r0, da.length - 1, da, a.frac ? a.int.length - 1 : -1);
  write(r0, L + db.length - 1, db, b.frac ? b.int.length - 1 : -1);
  r0[L]!.bar = true;
  rows.push(r0);
  for (let k = 1; k <= qCells; k++) {
    const r = newRow(cols);
    slots(r, 0, L - 1, { role: "scratch", dir: 1 });
    rows.push(r);
  }
  const r1 = rows[1]!;
  for (let c = L; c < cols; c++) r1[c]!.top = true;
  r1[L]!.bar = true;
  slots(r1, L, L + qCells - 1, { role: "quotient", dir: 1, commaOk: dec > 0 });
  return {
    cols,
    rows,
    remainderCells: dec ? undefined : String(ld.divisor).length,
    commaInput: mode === "input" && dec > 0,
  };
}

function layoutColumn(spec: ColumnSpec, mode: Mode, sep: string): Layout {
  switch (spec.operation) {
    case "add":
    case "subtract":
      return layoutAddSub(spec, mode);
    case "multiply":
      return layoutMultiply(spec, mode);
    case "divide":
      return layoutDivide(spec, mode, sep);
  }
}

/* ======================================================================
 * Pintado de la cuadrícula
 * ==================================================================== */

interface CellVal {
  d: string;
  comma: boolean;
}
const EMPTY: CellVal = { d: "", comma: false };

interface GridInputProps {
  vals: Record<string, CellVal>;
  onType: (key: string, slot: Slot, raw: string) => void;
  onKey: (e: KeyboardEvent<HTMLInputElement>, key: string, slot: Slot) => void;
  register: (key: string, el: HTMLInputElement | null) => void;
  disabled: boolean;
  /** Clase de corrección por rol (tras responder). */
  mark: (role: Role) => string;
  label: (role: Role) => string;
}

function Grid({ layout, paper, sep, input }: { layout: Layout; paper?: boolean; sep: string; input?: GridInputProps }) {
  return (
    <div className={"cg" + (paper ? " paper" : "")} style={colsVar(layout.cols)}>
      {layout.rows.map((row, r) =>
        row.map((cell, c) => {
          const key = `${r}:${c}`;
          const cls =
            "cg-cell" +
            (cell.top ? " top" : "") +
            (cell.bar ? " bar" : "") +
            (cell.small ? " small" : "") +
            (cell.tone ? " " + cell.tone : "") +
            (cell.slot ? " slot " + cell.slot.role : "");
          const v = input?.vals[key] ?? EMPTY;
          return (
            <div className={cls} key={key}>
              {cell.slot && input ? (
                <input
                  ref={(el) => input.register(key, el)}
                  data-cell={key}
                  className={"cg-in " + cell.slot.role + (v.d ? input.mark(cell.slot.role) : "")}
                  type="text"
                  inputMode={cell.slot.commaOk ? "decimal" : "numeric"}
                  {...NO_AUTOCORRECT}
                  aria-label={input.label(cell.slot.role)}
                  value={v.d}
                  disabled={input.disabled}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => input.onType(key, cell.slot!, e.target.value)}
                  onKeyDown={(e) => input.onKey(e, key, cell.slot!)}
                />
              ) : (
                cell.text
              )}
              {(cell.comma || cell.slot?.fixedComma || v.comma) && <span className={"cg-comma" + (v.comma ? " user" : "")}>{sep}</span>}
            </div>
          );
        }),
      )}
    </div>
  );
}

/** Lee el número escrito en una fila de casillas (de izquierda a derecha). null = vacío, a medias o ilegible. */
function readNumber(cells: { val: CellVal; fixedComma?: boolean }[]): number | null {
  const has = (i: number) => cells[i]!.val.d !== "";
  const first = cells.findIndex((_, i) => has(i));
  if (first < 0) return null;
  let last = cells.length - 1;
  while (!has(last)) last--;
  const commaAt = (i: number) => cells[i]!.val.comma || Boolean(cells[i]!.fixedComma);
  let s = cells.slice(0, first).some((_, i) => commaAt(i)) ? "0." : "";
  let commas = s ? 1 : 0;
  for (let i = first; i <= last; i++) {
    if (!has(i)) return null; // un hueco en medio: aún no está completa
    s += cells[i]!.val.d;
    if (i < last && commaAt(i)) {
      s += ".";
      commas++;
    }
  }
  if (commas > 1) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/* ======================================================================
 * Pantalla: la cuenta en columna
 * ==================================================================== */

export function ColumnOperationInput({
  render,
  onChange,
  result,
}: {
  render: ColumnRender;
  onChange: (a: Answer | null) => void;
  result: AttemptResult | null;
}) {
  const { t, i18n } = useTranslation();
  const sep = decimalSep(i18n.language);
  const layout = useMemo(() => layoutColumn(render, "input", sep), [render, sep]);
  const [vals, setVals] = useState<Record<string, CellVal>>({});
  const refs = useRef(new Map<string, HTMLInputElement>());

  // Casillas editables por fila, de izquierda a derecha, y las del resto (fuera de la cuadrícula).
  const rowSlots = useMemo(
    () => layout.rows.map((row, r) => row.flatMap((cell, c) => (cell.slot ? [{ key: `${r}:${c}`, c, slot: cell.slot }] : []))),
    [layout],
  );
  const remKeys = useMemo(() => Array.from({ length: layout.remainderCells ?? 0 }, (_, i) => `rem:${i}`), [layout]);
  const remSlot: Slot = { role: "result", dir: 1 };

  function answerFrom(next: Record<string, CellVal>): Answer | null {
    const graded = rowSlots.flat().filter((s) => s.slot.role === "result" || s.slot.role === "quotient");
    const value = readNumber(graded.map((s) => ({ val: next[s.key] ?? EMPTY, fixedComma: s.slot.fixedComma })));
    if (value === null) return null;
    if (!render.remainder) return { type: "column_operation", result: value };
    const rem = readNumber(remKeys.map((k) => ({ val: next[k] ?? EMPTY })));
    return rem === null ? null : { type: "column_operation", result: value, remainder: rem };
  }

  function update(changes: Record<string, CellVal>) {
    const next = { ...vals, ...changes };
    setVals(next);
    onChange(answerFrom(next));
  }

  /** La casilla vecina en la misma fila: `step` = +1 derecha, -1 izquierda. */
  function neighbour(key: string, step: number): string | undefined {
    if (key.startsWith("rem:")) {
      const i = Number(key.slice(4)) + step;
      return remKeys[i];
    }
    const [r, c] = key.split(":").map(Number) as [number, number];
    const row = rowSlots[r] ?? [];
    const sorted = step > 0 ? row.filter((s) => s.c > c) : row.filter((s) => s.c < c).reverse();
    return sorted[0]?.key;
  }

  function vertical(key: string, step: number): string | undefined {
    if (key.startsWith("rem:")) return undefined;
    const [r, c] = key.split(":").map(Number) as [number, number];
    for (let rr = r + step; rr >= 0 && rr < rowSlots.length; rr += step) {
      const hit = rowSlots[rr]!.find((s) => s.c === c);
      if (hit) return hit.key;
    }
    return undefined;
  }

  const focus = (key: string | undefined) => key && refs.current.get(key)?.focus();

  function onType(key: string, slot: Slot, raw: string) {
    const cur = vals[key] ?? EMPTY;
    if (raw === "") return update({ [key]: { ...cur, d: "" } });
    // Al enfocar se selecciona la cifra, así que normalmente llega solo lo tecleado; si no, se quita la que había.
    const typed = cur.d && raw.length > cur.d.length && raw.includes(cur.d) ? raw.replace(cur.d, "") : raw;
    const digit = typed.replace(/\D/g, "").slice(-1);
    const comma = /[.,]/.test(typed);
    if (comma && slot.commaOk && !digit && !cur.d && slot.dir === 1) {
      // Escribiendo de izquierda a derecha, la coma va detrás de la cifra que se acaba de poner.
      const prev = neighbour(key, -1);
      const pv = prev ? vals[prev] : undefined;
      if (prev && pv?.d) return update({ [prev]: { ...pv, comma: !pv.comma } });
    }
    const next = { d: digit || cur.d, comma: comma && slot.commaOk ? !cur.comma : cur.comma };
    update({ [key]: next });
    if (digit) focus(neighbour(key, slot.dir));
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>, key: string, slot: Slot) {
    const cur = vals[key] ?? EMPTY;
    if (e.key === "Backspace" && cur.d === "") {
      e.preventDefault();
      if (cur.comma) return update({ [key]: { ...cur, comma: false } });
      const prev = neighbour(key, -slot.dir);
      if (prev) {
        update({ [prev]: { ...(vals[prev] ?? EMPTY), d: "" } });
        focus(prev);
      }
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      focus(neighbour(key, e.key === "ArrowRight" ? 1 : -1));
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      focus(vertical(key, e.key === "ArrowDown" ? 1 : -1));
    }
  }

  const parts = result?.parts;
  const mark = (role: Role | "remainder") => {
    if (!result) return "";
    if (role === "result" || role === "quotient") return (parts?.[0] ?? result.correct) ? " correct" : " wrong";
    if (role === "remainder") return parts?.[1] ? " correct" : " wrong";
    return "";
  };
  const label = (role: Role | "remainder") => t(`session.cell_${role}`);
  const gridInput: GridInputProps = {
    vals,
    onType,
    onKey,
    register: (key, el) => {
      if (el) refs.current.set(key, el);
      else refs.current.delete(key);
    },
    disabled: Boolean(result),
    mark,
    label,
  };

  return (
    <div className="column-op">
      <div className="cg-wrap">
        <Grid layout={layout} sep={sep} input={gridInput} />
      </div>
      {remKeys.length > 0 && (
        <div className="cg-remainder">
          <span className="cg-rem-label">{t("session.remainder")}</span>
          <div className="cg" style={colsVar(remKeys.length)}>
            {remKeys.map((k) => (
              <div className="cg-cell slot result" key={k}>
                <input
                  ref={(el) => gridInput.register(k, el)}
                  className={"cg-in result" + ((vals[k] ?? EMPTY).d ? mark("remainder") : "")}
                  type="text"
                  inputMode="numeric"
                  {...NO_AUTOCORRECT}
                  aria-label={label("remainder")}
                  value={(vals[k] ?? EMPTY).d}
                  disabled={Boolean(result)}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => onType(k, remSlot, e.target.value)}
                  onKeyDown={(e) => onKey(e, k, remSlot)}
                />
              </div>
            ))}
          </div>
        </div>
      )}
      {!result && (
        <p className="cg-hint">
          {t("session.scratchHint")}
          {layout.commaInput && <> {t("session.commaHint")}</>}
        </p>
      )}
    </div>
  );
}

/* ======================================================================
 * Pantalla: descomposición en factores primos
 * ==================================================================== */

interface LadderRow {
  v: string;
  d: string;
}
interface Chip {
  b: string;
  e: string;
}

const digitsOnly = (s: string) => s.replace(/\D/g, "").slice(0, 8);

export function FactorizationInput({
  render,
  onChange,
  result,
}: {
  render: FactorRender;
  onChange: (a: Answer | null) => void;
  result: AttemptResult | null;
}) {
  const { t } = useTranslation();
  const n = render.number;
  const [ladder, setLadder] = useState<LadderRow[]>([{ v: String(n), d: "" }]);
  const [chips, setChips] = useState<Chip[]>([{ b: "", e: "" }]);

  // La escalera crece sola: siempre hay una fila libre debajo de la última escrita (mínimo 3). Y el producto,
  // una potencia libre tras la última escrita. Ya corregido, sobran los huecos libres.
  const free = result ? 0 : 1;
  const lastUsed = ladder.reduce((acc, row, i) => (row.v || row.d ? i : acc), 0);
  const ladderRows = Math.min(24, Math.max(result ? 1 : 3, lastUsed + 1 + free));
  const shownLadder = Array.from({ length: ladderRows }, (_, i) => ladder[i] ?? { v: "", d: "" });
  const lastChip = chips.reduce((acc, c, i) => (c.b || c.e ? i : acc), -1);
  const shownChips = Array.from({ length: Math.min(10, Math.max(1, lastChip + 1 + free)) }, (_, i) => chips[i] ?? { b: "", e: "" });

  function setRow(i: number, field: keyof LadderRow, value: string) {
    setLadder((cur) => {
      const next = Array.from({ length: Math.max(cur.length, i + 1) }, (_, k) => cur[k] ?? { v: "", d: "" });
      next[i] = { ...next[i]!, [field]: digitsOnly(value) };
      return next;
    });
  }

  function setChip(i: number, field: keyof Chip, value: string) {
    const next = Array.from({ length: Math.max(chips.length, i + 1) }, (_, k) => chips[k] ?? { b: "", e: "" });
    next[i] = { ...next[i]!, [field]: digitsOnly(value) };
    setChips(next);
    const used = next.filter((c) => c.b !== "");
    onChange(
      used.length > 0
        ? { type: "prime_factorization", factors: used.map((c) => ({ base: Number(c.b), exp: c.e ? Math.max(1, Number(c.e)) : 1 })) }
        : null,
    );
  }

  const done = Boolean(result);
  const state = result ? (result.correct ? " correct" : " wrong") : "";
  return (
    <div className="factor-op">
      <div className="fl">
        {shownLadder.map((row, i) => (
          <div className="fl-row" key={i}>
            <div className="fl-v">
              {i === 0 ? (
                <b>{n}</b>
              ) : (
                <input
                  className="fl-in"
                  type="text"
                  inputMode="numeric"
                  {...NO_AUTOCORRECT}
                  aria-label={t("session.cell_scratch")}
                  value={row.v}
                  disabled={done}
                  onChange={(e) => setRow(i, "v", e.target.value)}
                />
              )}
            </div>
            <div className="fl-d">
              <input
                className="fl-in"
                type="text"
                inputMode="numeric"
                {...NO_AUTOCORRECT}
                aria-label={t("session.cell_divisor")}
                value={row.d}
                disabled={done}
                onChange={(e) => setRow(i, "d", e.target.value)}
              />
            </div>
          </div>
        ))}
      </div>
      <div className={"fe" + state}>
        <span className="fe-n">{n} =</span>
        {shownChips.map((c, i) => (
          <span className="fe-chip" key={i}>
            {i > 0 && <span className="fe-dot">·</span>}
            <input
              className={"fe-base" + (c.b ? " filled" : "")}
              type="text"
              inputMode="numeric"
              {...NO_AUTOCORRECT}
              aria-label={t("session.cell_base")}
              value={c.b}
              disabled={done}
              onChange={(e) => setChip(i, "b", e.target.value)}
            />
            <input
              className={"fe-exp" + (c.e ? " filled" : "")}
              type="text"
              inputMode="numeric"
              {...NO_AUTOCORRECT}
              aria-label={t("session.cell_exp")}
              value={c.e}
              disabled={done}
              onChange={(e) => setChip(i, "e", e.target.value)}
            />
          </span>
        ))}
      </div>
      {!result && <p className="cg-hint">{t("session.factorHint")}</p>}
    </div>
  );
}

/* ======================================================================
 * Resuelta (tras fallar / vista previa) y papel (ficha impresa)
 * ==================================================================== */

function Ladder({ n, mode }: { n: number; mode: "solved" | "paper" }) {
  // En papel: el número arriba y tantas filas vacías como divisiones hay, más una para el 1.
  const rows: { value?: number; divisor?: number }[] =
    mode === "solved" ? factorLadder(n) : [{ value: n }, ...Array.from({ length: primeFactors(n).length }, () => ({}))];
  return (
    <div className={"fl static" + (mode === "paper" ? " paper" : "")}>
      {rows.map((row, i) => (
        <div className="fl-row" key={i}>
          <div className="fl-v">{row.value !== undefined && (i === 0 ? <b>{row.value}</b> : row.value)}</div>
          <div className="fl-d">{row.divisor}</div>
        </div>
      ))}
    </div>
  );
}

export function WorkedOperation({ ex }: { ex: OperationSpec }) {
  const { t, i18n } = useTranslation();
  const sep = decimalSep(i18n.language);
  if (ex.type === "prime_factorization") {
    return (
      <div className="worked-op">
        <Ladder n={ex.number} mode="solved" />
        <div className="fe solved">
          <MathText text={`${ex.number} = ${formatFactorization(groupFactors(primeFactors(ex.number)))}`} />
        </div>
      </div>
    );
  }
  const layout = layoutColumn(ex, "solved", sep);
  return (
    <div className="worked-op">
      {layout.shifted && <p className="cg-hint">{t("session.shiftComma", layout.shifted)}</p>}
      <div className="cg-wrap">
        <Grid layout={layout} sep={sep} />
      </div>
    </div>
  );
}

export function PaperOperation({ ex }: { ex: OperationSpec }) {
  const { t, i18n } = useTranslation();
  const sep = decimalSep(i18n.language);
  if (ex.type === "prime_factorization") {
    return (
      <div className="ws-op">
        <Ladder n={ex.number} mode="paper" />
        <div className="ws-answer">
          <span>{ex.number} =</span>
          <span className="ws-line" />
        </div>
      </div>
    );
  }
  const layout = layoutColumn(ex, "paper", sep);
  return (
    <div className="ws-op">
      <Grid layout={layout} sep={sep} paper />
      {layout.remainderCells !== undefined && (
        <div className="ws-answer short">
          <span>{t("session.remainder")}</span>
          <span className="ws-line" />
        </div>
      )}
    </div>
  );
}

/** La solución en texto a partir de los números (hoja de soluciones de la ficha). */
export function operationSolutionText(ex: OperationSpec, sep: string, remainderWord: string): string {
  const ca: Answer =
    ex.type === "column_operation"
      ? { type: "column_operation", ...solveColumn(ex) }
      : { type: "prime_factorization", factors: groupFactors(primeFactors(ex.number)) };
  return operationAnswerText(ex, ca, sep, remainderWord);
}

/** La respuesta en texto (feedback, revisión del tutor, hoja de soluciones): «114,82», «85 · resto 23»,
 *  «1428 = 2^2 · 3 · 7 · 17» (notación de MathText). */
export function operationAnswerText(ex: OperationSpec | null, ca: Answer, sep: string, remainderWord: string): string {
  if (ca.type === "column_operation") {
    const r = formatDecimal(ca.result, sep);
    return ca.remainder !== undefined ? `${r} · ${remainderWord} ${ca.remainder}` : r;
  }
  if (ca.type === "prime_factorization") {
    const n = ex?.type === "prime_factorization" ? `${ex.number} = ` : "";
    return n + formatFactorization(ca.factors);
  }
  return "";
}
