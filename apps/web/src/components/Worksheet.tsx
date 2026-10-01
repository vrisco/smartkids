// Ficha para imprimir: el tutor elige cuántas preguntas y de qué tipos de un contenido del hogar y la app
// compone una hoja para hacerla a mano, con las soluciones al final en página aparte para corregir. El PDF
// lo genera el diálogo de impresión del navegador («Guardar como PDF»): sin dependencias, en vectorial y
// reutilizando el render de fórmulas (MathText) y figuras (ExerciseFigure) de la app. La hoja se monta en
// un portal fuera de #root y el CSS de impresión oculta todo lo demás (ver «Ficha imprimible» en app.css).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { api, type FullExercise, type PreviewExercise } from "../api";
import { ExerciseFigure } from "./ExerciseFigure";
import { Icon } from "./Icon";
import { MathText, renderMath } from "./MathText";

type ExType = FullExercise["type"];
const TYPE_ORDER: ExType[] = ["multiple_choice", "multiple_select", "true_false", "fill_in_blank", "numeric", "ordering", "matching", "step_problem"];
const COUNTS = [5, 10, 15, 20, 25, 30, 40, 50];
const MAX_COUNT = 50;
const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const letter = (i: number) => LETTERS[i] ?? String(i + 1);

interface PaperItem {
  id: string;
  text: string;
}
/** Pregunta lista para el papel: el ejercicio + su presentación barajada (opciones, ítems a ordenar o
 *  columna derecha de las parejas). La hoja de soluciones usa ESTA presentación para dar las letras. */
interface PaperQuestion {
  id: string;
  ex: FullExercise;
  shown: PaperItem[];
}

function shuffle<T>(arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Elige `n` ejercicios repartidos entre los tipos (por turnos, para que salgan todos los marcados) y los
 *  ordena de más fácil a más difícil. Cada llamada da una selección distinta. */
function pickQuestions(pool: PreviewExercise[], n: number): PreviewExercise[] {
  const byType = new Map<ExType, PreviewExercise[]>();
  for (const it of shuffle(pool)) byType.set(it.exercise.type, [...(byType.get(it.exercise.type) ?? []), it]);
  const queues = shuffle([...byType.values()]);
  const out: PreviewExercise[] = [];
  while (out.length < n && queues.some((q) => q.length > 0)) {
    for (const q of queues) {
      const it = q.shift();
      if (it && out.length < n) out.push(it);
    }
  }
  return out.sort((a, b) => a.exercise.difficulty.numeric - b.exercise.difficulty.numeric);
}

function toPaper(it: PreviewExercise): PaperQuestion {
  const ex = it.exercise;
  switch (ex.type) {
    case "multiple_choice":
    case "multiple_select":
      return { id: it.templateId, ex, shown: shuffle(ex.options) };
    case "ordering": {
      let shown = shuffle(ex.items);
      // Que no salga ya ordenado (con 2 ítems pasa la mitad de las veces): unos pocos intentos bastan.
      for (let i = 0; i < 5 && shown.every((x, k) => x.id === ex.correctOrder[k]); i++) shown = shuffle(ex.items);
      return { id: it.templateId, ex, shown };
    }
    case "matching":
      return { id: it.templateId, ex, shown: shuffle(ex.right) };
    default:
      return { id: it.templateId, ex, shown: [] };
  }
}

/** Opciones del selector de nº de preguntas: las fijas que caben + el total disponible (tope 50) + el valor actual. */
function countOptions(available: number, current: number): number[] {
  const set = new Set([...COUNTS.filter((c) => c < available), Math.min(available, MAX_COUNT), current]);
  return [...set].filter((v) => v > 0).sort((a, b) => a - b);
}

export function WorksheetDialog({ skillId, title, level, onClose }: { skillId: string; title: string; level?: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [pool, setPool] = useState<PreviewExercise[] | null>(null);
  const [error, setError] = useState(false);
  const [types, setTypes] = useState<ExType[]>([]);
  const [count, setCount] = useState(10);
  const [workSpace, setWorkSpace] = useState(true);
  const [sheet, setSheet] = useState<PaperQuestion[] | null>(null);
  const prevTitle = useRef<string | null>(null);

  useEffect(() => {
    api
      .skillExercises(skillId)
      .then((items) => {
        const visible = items.filter((it) => !it.hidden); // lo oculto por el tutor tampoco va al papel
        setPool(visible);
        setTypes(TYPE_ORDER.filter((ty) => visible.some((it) => it.exercise.type === ty)));
      })
      .catch(() => setError(true));
  }, [skillId]);

  // Mientras haya ficha montada, el CSS de impresión oculta la app y deja solo la hoja.
  useLayoutEffect(() => {
    if (!sheet) return;
    document.documentElement.classList.add("ws-printing");
    return () => document.documentElement.classList.remove("ws-printing");
  }, [sheet]);

  // Al cerrar, devuelve el título de la pestaña si el navegador no llegó a avisar de `afterprint`.
  useEffect(
    () => () => {
      if (prevTitle.current != null) document.title = prevTitle.current;
    },
    [],
  );

  const perType = useMemo(() => {
    const m = new Map<ExType, number>();
    for (const it of pool ?? []) m.set(it.exercise.type, (m.get(it.exercise.type) ?? 0) + 1);
    return m;
  }, [pool]);
  const selected = (pool ?? []).filter((it) => types.includes(it.exercise.type));
  const available = selected.length;
  const n = Math.min(count, available, MAX_COUNT);

  function toggleType(ty: ExType, on: boolean) {
    setTypes((cur) => (on ? TYPE_ORDER.filter((x) => x === ty || cur.includes(x)) : cur.filter((x) => x !== ty)));
  }

  function generate() {
    if (n === 0) return;
    // flushSync: la hoja tiene que estar en el DOM ANTES de print(), y print() debe ir dentro del clic
    // (Safari bloquea las impresiones que no salen de un gesto del usuario).
    flushSync(() => setSheet(pickQuestions(selected, n).map(toPaper)));
    if (prevTitle.current == null) prevTitle.current = document.title;
    document.title = `${title} - ${t("worksheet.fileName")}`; // el navegador lo usa como nombre del PDF
    window.addEventListener(
      "afterprint",
      () => {
        if (prevTitle.current != null) document.title = prevTitle.current;
        prevTitle.current = null;
      },
      { once: true },
    );
    window.print();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal worksheet-modal" onClick={(e) => e.stopPropagation()}>
        <div className="preview-head">
          <div className="list-main">
            <b>{t("worksheet.title")}</b>
            <span className="muted">{title}</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t("common.close")}>
            <Icon name="close" size={16} />
          </button>
        </div>
        <p className="muted">{t("worksheet.hint")}</p>

        {error ? (
          <p className="muted screen-pad">{t("session.connError")}</p>
        ) : !pool ? (
          <p className="muted screen-pad">{t("content.previewLoading")}</p>
        ) : pool.length === 0 ? (
          <p className="muted screen-pad">{t("worksheet.empty")}</p>
        ) : (
          <>
            <div className="course-label">{t("worksheet.types")}</div>
            <div className="type-checks">
              {TYPE_ORDER.filter((ty) => perType.has(ty)).map((ty) => {
                const on = types.includes(ty);
                return (
                  <label className={"course-check option-card" + (on ? " on" : "")} key={ty}>
                    <input type="checkbox" checked={on} onChange={(e) => toggleType(ty, e.target.checked)} />
                    <span className="option-text">
                      <b>{t(`content.qt_${ty}`)}</b>
                      <span>{t("worksheet.inBank", { count: perType.get(ty) })}</span>
                    </span>
                  </label>
                );
              })}
            </div>

            <label className="form-cell">
              <span className="course-label">{t("worksheet.numQuestions")}</span>
              <select className="field" value={n} disabled={available === 0} onChange={(e) => setCount(Number(e.target.value))}>
                {countOptions(available, n).map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <p className="reward-hint">{available === 0 ? t("worksheet.noTypes") : t("worksheet.available", { count: available })}</p>

            <div className="course-label">{t("worksheet.options")}</div>
            <div className="type-checks">
              <label className={"course-check option-card" + (workSpace ? " on" : "")}>
                <input type="checkbox" checked={workSpace} onChange={(e) => setWorkSpace(e.target.checked)} />
                <span className="option-text">
                  <b>{t("worksheet.workSpace")}</b>
                  <span>{t("worksheet.workSpaceHint")}</span>
                </span>
              </label>
            </div>
          </>
        )}

        {sheet && <div className="auth-info">{t("worksheet.again")}</div>}
        <div className="modal-actions">
          <button className="btn-ghost" type="button" onClick={onClose}>
            {t("common.close")}
          </button>
          <button className="btn-primary" type="button" onClick={generate} disabled={n === 0}>
            <Icon name="printer" size={16} /> {t("worksheet.generate")}
          </button>
        </div>
      </div>

      {sheet &&
        createPortal(
          <div className="ws-print-root">
            <Sheet title={title} level={level} questions={sheet} workSpace={workSpace} />
          </div>,
          document.body,
        )}
    </div>
  );
}

/* ---------- La hoja (solo se ve al imprimir) ---------- */

function Sheet({ title, level, questions, workSpace }: { title: string; level?: string; questions: PaperQuestion[]; workSpace: boolean }) {
  const { t } = useTranslation();
  const meta = [level, t("worksheet.questionsN", { count: questions.length })].filter(Boolean).join(" · ");
  return (
    <div className="ws-sheet">
      <header className="ws-head">
        <h1>{title}</h1>
        <div className="ws-meta">{meta}</div>
        <div className="ws-fields">
          <span className="ws-field grow">
            {t("worksheet.name")}
            <span className="ws-line" />
          </span>
          <span className="ws-field">
            {t("worksheet.date")}
            <span className="ws-line" />
          </span>
          <span className="ws-field">
            {t("worksheet.score")}
            <span className="ws-line short" />/ {questions.length}
          </span>
        </div>
      </header>

      {questions.map((q, i) => (
        <PaperQuestionView key={q.id} q={q} n={i + 1} workSpace={workSpace} />
      ))}

      {/* Soluciones: siempre, al final y en página aparte (para separarlas antes de dárselo al niño).
          Sencillas a propósito: solo número y respuesta, sin explicaciones. */}
      <section className="ws-key">
        <h2>
          {t("worksheet.keyTitle")} · {title}
        </h2>
        <div className="ws-key-list">
          {questions.map((q, i) => (
            <div className="ws-key-item" key={q.id}>
              <span className="ws-num">{i + 1}.</span>
              <div className="ws-key-body">
                <KeyAnswer q={q} />
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

const hasStemBlanks = (stem: string) => /\{\{\d+\}\}/.test(stem);

function instructionKey(ex: FullExercise): string {
  if (ex.type !== "fill_in_blank") return `worksheet.inst_${ex.type}`;
  if (!hasStemBlanks(ex.stem)) return "worksheet.inst_short";
  return ex.blanks.length === 1 ? "worksheet.inst_fill_one" : "worksheet.inst_fill_in_blank";
}

function PaperQuestionView({ q, n, workSpace }: { q: PaperQuestion; n: number; workSpace: boolean }) {
  const { t } = useTranslation();
  const { ex } = q;
  return (
    <div className="ws-q">
      <span className="ws-num">{n}.</span>
      <div className="ws-q-body">
        <div className="ws-inst">{t(instructionKey(ex))}</div>
        <div className="ws-stem">
          {ex.type === "fill_in_blank" ? renderMath(ex.stem, { blank: () => <span className="ws-blank" /> }) : <MathText text={ex.stem} />}
        </div>
        <ExerciseFigure svg={ex.figure} className="ws-figure" />
        <PaperAnswer q={q} />
        {workSpace && (ex.type === "numeric" || ex.type === "step_problem") && (
          <div className="ws-work">
            <span>{t("worksheet.work")}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function AnswerLine({ label, unit }: { label?: string; unit?: string }) {
  const { t } = useTranslation();
  return (
    <div className="ws-answer">
      <span>{label ?? t("worksheet.answer")}</span>
      <span className="ws-line" />
      {unit && <span>{unit}</span>}
    </div>
  );
}

/** Dónde escribe el niño: opciones para rodear o marcar, casillas, líneas de respuesta o columnas para unir. */
function PaperAnswer({ q }: { q: PaperQuestion }) {
  const { t } = useTranslation();
  const { ex, shown } = q;
  switch (ex.type) {
    case "multiple_choice":
    case "multiple_select": {
      const short = shown.every((o) => o.text.length <= 22);
      return (
        <div className={"ws-opts" + (short ? " cols" : "")}>
          {shown.map((o, k) => (
            <div className="ws-opt" key={o.id}>
              {ex.type === "multiple_select" && <span className="ws-box" />}
              <span className="ws-letter">{letter(k)})</span>
              <MathText text={o.text} />
            </div>
          ))}
        </div>
      );
    }
    case "true_false":
      return (
        <div className="ws-opts cols">
          <div className="ws-opt">
            <span className="ws-box" />
            {t("session.true")}
          </div>
          <div className="ws-opt">
            <span className="ws-box" />
            {t("session.false")}
          </div>
        </div>
      );
    case "numeric":
      return <AnswerLine unit={ex.answer.unit} />;
    case "fill_in_blank":
      // Huecos dentro del enunciado: se escriben ahí. Si el enunciado no los marca, una línea por hueco.
      if (hasStemBlanks(ex.stem)) return null;
      return (
        <>
          {ex.blanks.map((_, k) => (
            <AnswerLine key={k} label={ex.blanks.length > 1 ? `(${k + 1})` : undefined} />
          ))}
        </>
      );
    case "ordering":
      return (
        <div className="ws-opts">
          {shown.map((it, k) => (
            <div className="ws-opt" key={it.id}>
              <span className="ws-box" />
              <span className="ws-letter">{letter(k)})</span>
              <MathText text={it.text} />
            </div>
          ))}
        </div>
      );
    case "matching":
      return (
        <div className="ws-match">
          <div className="ws-match-col">
            {ex.left.map((l, k) => (
              <div className="ws-match-item" key={l.id}>
                <span className="ws-letter">{k + 1}.</span>
                <MathText text={l.text} />
                <span className="ws-dot end" />
              </div>
            ))}
          </div>
          <div className="ws-match-col">
            {shown.map((r, k) => (
              <div className="ws-match-item" key={r.id}>
                <span className="ws-dot" />
                <span className="ws-letter">{letter(k)})</span>
                <MathText text={r.text} />
              </div>
            ))}
          </div>
        </div>
      );
    case "step_problem":
      return (
        <div className="ws-steps">
          {ex.steps.map((s, k) => (
            <div className="ws-step" key={s.id}>
              <div className="ws-step-prompt">
                <span className="ws-letter">{letter(k)})</span>
                <MathText text={s.prompt} />
              </div>
              <AnswerLine unit={s.kind === "numeric" ? s.answer.unit : undefined} />
            </div>
          ))}
        </div>
      );
  }
}

/* ---------- Hoja de soluciones ---------- */

/** Partes de una respuesta; el separador «·» lo pone el CSS. */
function Parts({ parts }: { parts: ReactNode[] }) {
  return (
    <>
      {parts.map((p, i) => (
        <span className="ws-key-part" key={i}>
          {p}
        </span>
      ))}
    </>
  );
}

/** Respuestas aceptadas de un hueco (sin repetidas por mayúsculas), hasta 3: «3/4 o 0,75». */
function Accepted({ list }: { list: string[] }) {
  const { t } = useTranslation();
  const seen = new Set<string>();
  const uniq = list.filter((s) => {
    const k = s.trim().toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return (
    <>
      {uniq.slice(0, 3).map((s, i) => (
        <span key={i}>
          {i > 0 && ` ${t("worksheet.or")} `}
          <MathText text={s} />
        </span>
      ))}
    </>
  );
}

/** Número con su unidad (la unidad, como en la vista previa, en texto plano: «m» no es una variable). */
function NumAnswer({ a }: { a: { value: number; unit?: string } }) {
  return (
    <>
      <MathText text={String(a.value)} />
      {a.unit ? ` ${a.unit}` : ""}
    </>
  );
}

function KeyAnswer({ q }: { q: PaperQuestion }) {
  const { t } = useTranslation();
  const { ex, shown } = q;
  const letterOf = (id: string) => letter(shown.findIndex((o) => o.id === id));
  switch (ex.type) {
    case "multiple_choice":
    case "multiple_select": {
      const ok = new Set(ex.options.filter((o) => o.isCorrect).map((o) => o.id));
      return (
        <Parts
          parts={shown
            .filter((o) => ok.has(o.id))
            .map((o) => (
              <>
                <b>{letterOf(o.id)})</b> <MathText text={o.text} />
              </>
            ))}
        />
      );
    }
    case "true_false":
      return <b>{ex.answer.value ? t("session.true") : t("session.false")}</b>;
    case "numeric":
      return <NumAnswer a={ex.answer} />;
    case "fill_in_blank":
      return (
        <Parts
          parts={ex.blanks.map((b, k) => (
            <>
              {ex.blanks.length > 1 && <b>({k + 1}) </b>}
              <Accepted list={b.accept} />
            </>
          ))}
        />
      );
    case "ordering":
      // Tal como lo corrige el tutor: el número que debía ir en la casilla de cada letra.
      return (
        <Parts
          parts={shown.map((it, k) => (
            <>
              <b>{letter(k)})</b> {ex.correctOrder.indexOf(it.id) + 1}
            </>
          ))}
        />
      );
    case "matching": {
      const leftIdx = (id: string) => ex.left.findIndex((l) => l.id === id);
      return (
        <Parts
          parts={[...ex.correctPairs]
            .sort((a, b) => leftIdx(a.leftId) - leftIdx(b.leftId))
            .map((p) => (
              <b>
                {leftIdx(p.leftId) + 1}-{letterOf(p.rightId)}
              </b>
            ))}
        />
      );
    }
    case "step_problem":
      return (
        <Parts
          parts={ex.steps.map((s, k) => (
            <>
              <b>{letter(k)})</b> {s.kind === "numeric" ? <NumAnswer a={s.answer} /> : <Accepted list={s.accept} />}
            </>
          ))}
        />
      );
  }
}
