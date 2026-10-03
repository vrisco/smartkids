// Inputs y correcciones para los 10 tipos de ejercicio. Recibe el `render` (sin
// solución) y reporta un `Answer | null` hacia arriba; `null` = aún incompleto.
// Las cuentas en columna y la factorización en primos viven en ColumnOps.tsx.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Answer, AttemptResult, RenderPayload } from "../api";
import i18n from "../i18n";
import { ColumnOperationInput, FactorizationInput, decimalSep, operationAnswerText } from "./ColumnOps";
import { Icon } from "./Icon";
import { MathText, renderMath } from "./MathText";

type Narrow<T extends RenderPayload["type"]> = Extract<RenderPayload, { type: T }>;

// El teclado del móvil no debe «ayudar» en una respuesta: el autocorrector cambiaría una forma mal
// escrita por la buena (p. ej. «catched» por «caught») y el subrayado del corrector chivaría el error.
const NO_AUTOCORRECT = { autoComplete: "off", autoCorrect: "off", autoCapitalize: "none", spellCheck: false } as const;

interface CtrlProps<T extends RenderPayload["type"]> {
  render: Narrow<T>;
  answer: Answer | null;
  onChange: (a: Answer | null) => void;
  result: AttemptResult | null;
}

/* ---------- Selección ---------- */
function MultipleChoice({ render, answer, onChange, result }: CtrlProps<"multiple_choice">) {
  const selected = answer?.type === "multiple_choice" ? answer.optionId : null;
  const correctId = result?.correctAnswer?.type === "multiple_choice" ? result.correctAnswer.optionId : null;
  return (
    <div className="opts">
      {render.options.map((o) => {
        let cls = "opt";
        if (result) {
          if (o.id === correctId) cls += " correct";
          else if (o.id === selected) cls += " wrong";
        } else if (o.id === selected) cls += " sel";
        return (
          <button key={o.id} className={cls} disabled={Boolean(result)} onClick={() => onChange({ type: "multiple_choice", optionId: o.id })}>
            <MathText text={o.text} />
          </button>
        );
      })}
    </div>
  );
}

/* ---------- Casillas: marcar TODAS las correctas ---------- */
function MultipleSelect({ render, answer, onChange, result }: CtrlProps<"multiple_select">) {
  const { t } = useTranslation();
  const selected = answer?.type === "multiple_select" ? answer.optionIds : [];
  const correctIds = result?.correctAnswer?.type === "multiple_select" ? result.correctAnswer.optionIds : [];
  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    onChange(next.length > 0 ? { type: "multiple_select", optionIds: next } : null);
  };
  return (
    <>
      <p className="select-all-hint">{t("session.selectAll")}</p>
      <div className="checks">
        {render.options.map((o) => {
          const on = selected.includes(o.id);
          let cls = "check-opt";
          if (result) {
            const good = correctIds.includes(o.id);
            // Tras corregir: verde lo que había que marcar; rojo lo marcado de más.
            if (good) cls += " correct";
            else if (on) cls += " wrong";
          } else if (on) cls += " sel";
          return (
            <button key={o.id} type="button" className={cls} aria-pressed={on} disabled={Boolean(result)} onClick={() => toggle(o.id)}>
              <span className="check-box">{(result ? correctIds.includes(o.id) : on) && <Icon name="check" size={14} />}</span>
              <span className="check-text">
                <MathText text={o.text} />
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

/* ---------- Verdadero / Falso ---------- */
function TrueFalse({ answer, onChange, result }: CtrlProps<"true_false">) {
  const { t } = useTranslation();
  const sel = answer?.type === "true_false" ? answer.value : null;
  const correct = result?.correctAnswer?.type === "true_false" ? result.correctAnswer.value : null;
  const btn = (v: boolean, label: string) => {
    let cls = "opt";
    if (result) {
      if (correct === v) cls += " correct";
      else if (sel === v) cls += " wrong";
    } else if (sel === v) cls += " sel";
    return (
      <button className={cls} disabled={Boolean(result)} onClick={() => onChange({ type: "true_false", value: v })}>
        {label}
      </button>
    );
  };
  return (
    <div className="opts">
      {btn(true, t("session.true"))}
      {btn(false, t("session.false"))}
    </div>
  );
}

/* ---------- Numérico ---------- */
function NumericInput({ render, onChange, result }: CtrlProps<"numeric">) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  return (
    <div className="num-input">
      <input
        type="text"
        inputMode="decimal"
        {...NO_AUTOCORRECT}
        className="answer-field"
        value={text}
        disabled={Boolean(result)}
        placeholder={t("session.yourAnswer")}
        onChange={(e) => {
          const s = e.target.value;
          setText(s);
          const n = Number(s.replace(",", "."));
          onChange(s.trim() !== "" && Number.isFinite(n) ? { type: "numeric", value: n } : null);
        }}
      />
      {render.unit && <span className="unit">{render.unit}</span>}
    </div>
  );
}

/* ---------- Rellenar huecos (inline con el enunciado) ---------- */
export function FillBlanks({
  stem,
  render,
  onChange,
  result,
}: {
  stem: string;
  render: Narrow<"fill_in_blank">;
  onChange: (a: Answer | null) => void;
  result: AttemptResult | null;
}) {
  const [vals, setVals] = useState<string[]>(() => render.blanks.map(() => ""));
  const update = (i: number, s: string) => {
    const nv = [...vals];
    nv[i] = s;
    setVals(nv);
    onChange(nv.every((v) => v.trim() !== "") ? { type: "fill_in_blank", values: nv } : null);
  };
  // El hueco {{n}} se pinta donde toque DENTRO de la fórmula (p. ej. en el exponente de 2^{{1}}).
  const blank = (n: number) => {
    const i = Math.max(0, n - 1);
    const ok = result?.parts ? result.parts[i] : null;
    const cls = "blank-input" + (ok === true ? " correct" : ok === false ? " wrong" : "");
    const ph = render.blanks[i]?.placeholder ?? "…";
    return (
      <input
        key={"blank" + i}
        {...NO_AUTOCORRECT}
        className={cls}
        disabled={Boolean(result)}
        value={vals[i] ?? ""}
        placeholder={ph}
        size={Math.max(3, ph.length)}
        onChange={(e) => update(i, e.target.value)}
      />
    );
  };
  return <span className="fill-stem">{renderMath(stem, { blank })}</span>;
}

/* ---------- Ordenar (toques: subir/bajar) ---------- */
function Ordering({ render, onChange, result }: CtrlProps<"ordering">) {
  const [order, setOrder] = useState<string[]>(() => render.items.map((i) => i.id));
  useEffect(() => {
    onChange({ type: "ordering", order: render.items.map((i) => i.id) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const textOf = (id: string) => render.items.find((i) => i.id === id)?.text ?? "";
  const move = (idx: number, dir: -1 | 1) => {
    if (result) return;
    const ni = idx + dir;
    if (ni < 0 || ni >= order.length) return;
    const a = [...order];
    [a[idx], a[ni]] = [a[ni]!, a[idx]!];
    setOrder(a);
    onChange({ type: "ordering", order: a });
  };
  return (
    <div className="order-list">
      {order.map((id, idx) => (
        <div key={id} className="order-row">
          <span className="order-pos">{idx + 1}</span>
          <span className="order-text">
            <MathText text={textOf(id)} />
          </span>
          {!result && (
            <span className="order-ctrls">
              <button className="order-btn" disabled={idx === 0} onClick={() => move(idx, -1)} aria-label="↑">
                <Icon name="chevronUp" size={16} />
              </button>
              <button className="order-btn" disabled={idx === order.length - 1} onClick={() => move(idx, 1)} aria-label="↓">
                <Icon name="chevronDown" size={16} />
              </button>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/* ---------- Emparejar (select por cada elemento de la izquierda) ---------- */
function Matching({ render, onChange, result }: CtrlProps<"matching">) {
  const { t } = useTranslation();
  const [pairs, setPairs] = useState<Record<string, string>>({});
  const correct: Record<string, string> =
    result?.correctAnswer?.type === "matching"
      ? Object.fromEntries(result.correctAnswer.pairs.map((p) => [p.leftId, p.rightId]))
      : {};
  const set = (leftId: string, rightId: string) => {
    const np = { ...pairs, [leftId]: rightId };
    setPairs(np);
    const arr = Object.entries(np)
      .filter(([, r]) => r !== "")
      .map(([leftId, rightId]) => ({ leftId, rightId }));
    onChange(arr.length === render.left.length ? { type: "matching", pairs: arr } : null);
  };
  return (
    <div className="match-list">
      {render.left.map((l) => {
        const val = pairs[l.id] ?? "";
        let cls = "match-select";
        if (result) cls += correct[l.id] === val ? " correct" : " wrong";
        return (
          <div key={l.id} className="match-row">
            <span className="match-left">
              <MathText text={l.text} />
            </span>
            <select className={cls} value={val} disabled={Boolean(result)} onChange={(e) => set(l.id, e.target.value)}>
              <option value="">{t("session.choose")}</option>
              {render.right.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.text}
                </option>
              ))}
            </select>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- Problema por pasos ---------- */
function StepProblem({ render, onChange, result }: CtrlProps<"step_problem">) {
  const { t } = useTranslation();
  const [vals, setVals] = useState<Record<string, string>>({});
  const update = (stepId: string, s: string) => {
    const nv = { ...vals, [stepId]: s };
    setVals(nv);
    const steps = render.steps.map((st) =>
      st.kind === "numeric"
        ? { stepId: st.id, value: Number(String(nv[st.id] ?? "").replace(",", ".")) }
        : { stepId: st.id, text: nv[st.id] ?? "" },
    );
    const complete = render.steps.every((st) => {
      const raw = (nv[st.id] ?? "").trim();
      if (raw === "") return false;
      return st.kind !== "numeric" || Number.isFinite(Number(raw.replace(",", ".")));
    });
    onChange(complete ? { type: "step_problem", steps } : null);
  };
  return (
    <div className="steps">
      {render.steps.map((st, i) => (
        <div key={st.id} className="step-row">
          <div className="step-prompt">
            <span className="step-n">{i + 1}</span>
            <MathText text={st.prompt} />
          </div>
          <div className="num-input">
            <input
              type="text"
              inputMode={st.kind === "numeric" ? "decimal" : "text"}
              {...NO_AUTOCORRECT}
              className="answer-field"
              disabled={Boolean(result)}
              value={vals[st.id] ?? ""}
              placeholder={t("session.yourAnswer")}
              onChange={(e) => update(st.id, e.target.value)}
            />
            {st.kind === "numeric" && st.unit && <span className="unit">{st.unit}</span>}
            {result?.parts && (
              <span className={result.parts[i] ? "step-mark ok" : "step-mark bad"}>
                <Icon name={result.parts[i] ? "check" : "close"} size={14} />
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------- Despachador (todo menos fill_in_blank, que va inline) ---------- */
export function ExerciseInput({
  render,
  answer,
  onChange,
  result,
}: {
  render: RenderPayload;
  answer: Answer | null;
  onChange: (a: Answer | null) => void;
  result: AttemptResult | null;
}) {
  switch (render.type) {
    case "multiple_choice":
      return <MultipleChoice render={render} answer={answer} onChange={onChange} result={result} />;
    case "multiple_select":
      return <MultipleSelect render={render} answer={answer} onChange={onChange} result={result} />;
    case "true_false":
      return <TrueFalse render={render} answer={answer} onChange={onChange} result={result} />;
    case "numeric":
      return <NumericInput render={render} answer={answer} onChange={onChange} result={result} />;
    case "ordering":
      return <Ordering render={render} answer={answer} onChange={onChange} result={result} />;
    case "matching":
      return <Matching render={render} answer={answer} onChange={onChange} result={result} />;
    case "step_problem":
      return <StepProblem render={render} answer={answer} onChange={onChange} result={result} />;
    case "column_operation":
      return <ColumnOperationInput render={render} onChange={onChange} result={result} />;
    case "prime_factorization":
      return <FactorizationInput render={render} onChange={onChange} result={result} />;
    case "fill_in_blank":
      return null; // se renderiza inline dentro del enunciado (FillBlanks)
  }
}

/* ---------- Respuesta correcta en texto (para el feedback tras fallar) ---------- */
export function correctAnswerString(render: RenderPayload, ca: Answer): string {
  if (ca.type !== render.type) return "";
  switch (render.type) {
    case "multiple_choice": {
      if (ca.type !== "multiple_choice") return "";
      return render.options.find((o) => o.id === ca.optionId)?.text ?? "";
    }
    case "multiple_select": {
      if (ca.type !== "multiple_select") return "";
      return ca.optionIds.map((id) => render.options.find((o) => o.id === id)?.text ?? id).join("  ·  ");
    }
    case "numeric":
      return ca.type === "numeric" ? `${ca.value}${render.unit ? " " + render.unit : ""}` : "";
    case "fill_in_blank":
      return ca.type === "fill_in_blank" ? ca.values.join(", ") : "";
    case "true_false":
      return ca.type === "true_false" ? String(ca.value) : "";
    case "ordering": {
      if (ca.type !== "ordering") return "";
      return ca.order.map((id) => render.items.find((i) => i.id === id)?.text ?? id).join("  ·  ");
    }
    case "matching": {
      if (ca.type !== "matching") return "";
      return ca.pairs
        .map((p) => {
          const l = render.left.find((x) => x.id === p.leftId)?.text ?? p.leftId;
          const r = render.right.find((x) => x.id === p.rightId)?.text ?? p.rightId;
          return `${l} = ${r}`;
        })
        .join("  ·  ");
    }
    case "step_problem": {
      if (ca.type !== "step_problem") return "";
      return ca.steps
        .map((s) => (s.value !== undefined ? String(s.value) : (s.text ?? "")))
        .join("  ·  ");
    }
    case "column_operation":
    case "prime_factorization":
      return operationAnswerText(render, ca, decimalSep(i18n.language), i18n.t("session.remainder").toLowerCase());
  }
}
