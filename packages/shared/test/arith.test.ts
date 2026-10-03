/**
 * Pruebas de las cuentas en columna y de la factorización en primos (aritmética exacta + corrección).
 * Los casos salen del cuaderno que motivó estos tipos: 386 × 412, 40417,84 : 352, 1428 = 2^2 · 3 · 7 · 17...
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { factorLadder, formatDecimal, longDivision, primeFactors, solveColumn, type ColumnSpec } from "../src/arith.ts";
import { grade, redactForClient, validateExercise } from "../src/grading.ts";
import { ExerciseSchema, type Exercise } from "../src/exercise.ts";

function col(spec: ColumnSpec): Exercise {
  return ExerciseSchema.parse({
    exerciseId: "e1",
    packageId: "p",
    language: "es",
    skillId: "SK",
    stem: "Calcula.",
    difficulty: { level: "easy", numeric: 0.3 },
    type: "column_operation",
    ...spec,
  });
}

function factor(n: number): Exercise {
  return ExerciseSchema.parse({
    exerciseId: "e2",
    packageId: "p",
    language: "es",
    skillId: "SK",
    stem: `Descompón ${n}.`,
    difficulty: { level: "easy", numeric: 0.3 },
    type: "prime_factorization",
    number: n,
  });
}

const res = (result: number, remainder?: number) =>
  ({ type: "column_operation", result, ...(remainder !== undefined ? { remainder } : {}) }) as const;

describe("solveColumn: resultados exactos (sin coma flotante)", () => {
  it("suma y resta alineando por la coma", () => {
    assert.equal(solveColumn({ operation: "add", operands: [2112, 352] }).result, 2464);
    assert.equal(solveColumn({ operation: "add", operands: [0.1, 0.2] }).result, 0.3); // 0.1+0.2 en double daría 0.30000000000000004
    assert.equal(solveColumn({ operation: "add", operands: [12.5, 3.75, 100] }).result, 116.25);
    assert.equal(solveColumn({ operation: "subtract", operands: [1000, 1] }).result, 999);
    assert.equal(solveColumn({ operation: "subtract", operands: [5, 2.35] }).result, 2.65);
  });

  it("multiplica con decimales sumando las cifras decimales", () => {
    assert.equal(solveColumn({ operation: "multiply", operands: [386, 412] }).result, 159032);
    assert.equal(solveColumn({ operation: "multiply", operands: [0.5, 0.25] }).result, 0.125);
    assert.equal(solveColumn({ operation: "multiply", operands: [12.34, 5.6] }).result, 69.104);
  });

  it("divide a mano: cociente truncado y resto solo en la entera", () => {
    assert.deepEqual(solveColumn({ operation: "divide", operands: [1428, 7] }), { result: 204, remainder: 0 });
    assert.deepEqual(solveColumn({ operation: "divide", operands: [2148, 25] }), { result: 85, remainder: 23 });
    assert.deepEqual(solveColumn({ operation: "divide", operands: [3, 4] }), { result: 0, remainder: 3 });
    // 40417,84 : 352 = 114,82... (truncado, no redondeado)
    assert.deepEqual(solveColumn({ operation: "divide", operands: [40417.84, 352], decimals: 2 }), { result: 114.82 });
    // Divisor con coma: 870,92 : 5,6 -> 8709,2 : 56 = 155,52...
    assert.deepEqual(solveColumn({ operation: "divide", operands: [870.92, 5.6], decimals: 2 }), { result: 155.52 });
    assert.deepEqual(solveColumn({ operation: "divide", operands: [2, 3], decimals: 3 }), { result: 0.666 });
    assert.deepEqual(solveColumn({ operation: "divide", operands: [12, 0.25], decimals: 1 }), { result: 48 });
  });
});

describe("longDivision: la casita paso a paso", () => {
  it("baja cifras y escribe los restos como en el cuaderno", () => {
    const ld = longDivision(40417.84, 352, 2);
    assert.equal(ld.digits, "4041784");
    assert.equal(ld.intLen, 5);
    assert.deepEqual(
      ld.steps.map((s) => [s.end, s.partial, s.digit, s.remainder]),
      [
        [2, 404, 1, 52],
        [3, 521, 1, 169],
        [4, 1697, 4, 289],
        [5, 2898, 8, 82],
        [6, 824, 2, 120],
      ],
    );
    assert.equal(ld.quotientInt, "114");
    assert.equal(ld.quotientFrac, "82");
  });

  it("corre la coma del divisor (con ceros si hace falta)", () => {
    const a = longDivision(870.92, 5.6, 2);
    assert.equal(a.shift, 1);
    assert.equal(a.divisor, 56);
    assert.equal(a.digits.slice(0, a.intLen), "8709");
    const b = longDivision(12, 0.25, 0);
    assert.equal(b.digits, "1200");
    assert.equal(b.shownLen, 4);
    assert.equal(b.quotientInt, "48");
  });

  it("añade ceros al bajar para sacar decimales", () => {
    const ld = longDivision(3, 4, 2);
    assert.equal(ld.shownLen, 1);
    assert.equal(ld.digits, "300");
    assert.equal(ld.quotientInt + "," + ld.quotientFrac, "0,75");
    assert.equal(ld.remainder, 0);
  });
});

describe("column_operation: corrección", () => {
  it("solo cuenta el resultado; en la división entera también el resto", () => {
    const mul = col({ operation: "multiply", operands: [386, 412] });
    assert.equal(grade(mul, res(159032)).correct, true);
    assert.equal(grade(mul, res(159023)).correct, false);

    const div = col({ operation: "divide", operands: [2148, 25] });
    assert.equal(grade(div, res(85, 23)).correct, true);
    const r = grade(div, res(85, 22));
    assert.equal(r.correct, false);
    assert.deepEqual(r.parts, [true, false]);
    assert.equal(grade(div, res(85)).correct, false); // sin resto no está completa
  });

  it("acepta el decimal tecleado con coma o punto (mismo double)", () => {
    const div = col({ operation: "divide", operands: [40417.84, 352], decimals: 2 });
    assert.equal(grade(div, res(Number("114,82".replace(",", ".")))).correct, true);
    assert.equal(grade(div, res(114.83)).correct, false); // redondear no vale: se trunca
    assert.equal(grade(div, res(11482)).correct, false); // la coma mal puesta es un fallo
  });

  it("la validación pone los topes del cuaderno", () => {
    assert.equal(validateExercise(col({ operation: "add", operands: [2112, 352] })).ok, true);
    assert.equal(validateExercise(col({ operation: "subtract", operands: [3, 5] })).ok, false);
    assert.equal(validateExercise(col({ operation: "multiply", operands: [386, 12345] })).ok, false);
    assert.equal(validateExercise(col({ operation: "divide", operands: [10, 0] })).ok, false);
    assert.equal(validateExercise(col({ operation: "divide", operands: [10.5, 2] })).ok, false); // entera con decimales
    assert.equal(validateExercise(col({ operation: "divide", operands: [10.5, 2], decimals: 2 })).ok, true);
    assert.equal(validateExercise(col({ operation: "add", operands: [1.23456, 2] })).ok, false);
    assert.equal(validateExercise(col({ operation: "multiply", operands: [2, 3], decimals: 1 })).ok, false);
  });

  it("el render lleva los números y si se pide el resto, nunca la solución", () => {
    const render = redactForClient(col({ operation: "divide", operands: [2148, 25] }));
    assert.deepEqual(render, { type: "column_operation", operation: "divide", operands: [2148, 25], remainder: true });
  });
});

describe("prime_factorization", () => {
  it("factoriza y monta la escalera del cuaderno", () => {
    assert.deepEqual(primeFactors(1428), [2, 2, 3, 7, 17]);
    assert.deepEqual(primeFactors(2148), [2, 2, 3, 179]);
    assert.deepEqual(primeFactors(97), [97]);
    assert.deepEqual(
      factorLadder(300).map((r) => [r.value, r.divisor]),
      [
        [300, 2],
        [150, 2],
        [75, 3],
        [25, 5],
        [5, 5],
        [1, undefined],
      ],
    );
  });

  it("acepta cualquier orden y repetir primos; exige primos y el producto exacto", () => {
    const ex = factor(1428);
    const f = (...ps: [number, number][]) => ({ type: "prime_factorization", factors: ps.map(([base, exp]) => ({ base, exp })) }) as const;
    assert.equal(grade(ex, f([2, 2], [3, 1], [7, 1], [17, 1])).correct, true);
    assert.equal(grade(ex, f([17, 1], [7, 1], [3, 1], [2, 2])).correct, true);
    assert.equal(grade(ex, f([2, 1], [2, 1], [3, 1], [7, 1], [17, 1])).correct, true);
    assert.equal(grade(ex, f([4, 1], [3, 1], [7, 1], [17, 1])).correct, false); // 4 no es primo
    assert.equal(grade(ex, f([2, 2], [3, 1], [7, 1])).correct, false); // falta el 17
    assert.equal(grade(ex, f([2, 3], [3, 1], [7, 1], [17, 1])).correct, false); // sobra un 2
    assert.equal(grade(ex, f()).correct, false);
    assert.equal(validateExercise(ex).ok, true);
  });
});

describe("formatDecimal", () => {
  it("escribe con coma decimal y sin ceros sobrantes", () => {
    assert.equal(formatDecimal(114.82), "114,82");
    assert.equal(formatDecimal(48), "48");
    assert.equal(formatDecimal(0.125, "."), "0.125");
  });
});
