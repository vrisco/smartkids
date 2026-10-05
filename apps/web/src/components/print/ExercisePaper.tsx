// Cómo se ve UN ejercicio en papel (y su entrada en la hoja de soluciones). El perfil de la materia y la
// edad decide la notación, el espacio para responder (recuadro, línea o renglones) y el de trabajo
// (cuadrícula, «Datos / Operaciones» o nada).
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { FullExercise } from "../../api";
import { PaperOperation, WorkedOperation, decimalSep, operationCols, operationSolutionText } from "../ColumnOps";
import { ExerciseFigure } from "../ExerciseFigure";
import { renderTxt, Txt, type Notation } from "../Txt";
import { AnswerBox, AnswerLine, GridArea, LinedArea, ProblemArea } from "./paper";
import { answerStyle, blankWidthMm, workFor, type PrintProfile } from "./profiles";
import type { PaperQuestion } from "./select";

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
export const letter = (i: number) => LETTERS[i] ?? String(i + 1);

const hasStemBlanks = (stem: string) => /\{\{\d+\}\}/.test(stem);
export const notationOf = (p: PrintProfile): Notation => (p.mathNotation ? "math" : "plain");

function instructionKey(ex: FullExercise, kid: boolean): string {
  const base = kid ? "worksheet.instKid_" : "worksheet.inst_";
  if (ex.type !== "fill_in_blank") return base + ex.type;
  if (!hasStemBlanks(ex.stem)) return base + "short";
  return ex.blanks.length === 1 ? base + "fill_one" : base + "fill_in_blank";
}

export interface QuestionOptions {
  workSpace: boolean;
  compact: boolean;
  /** Puntos de la pregunta en un examen («1,25»). */
  points?: string;
  /** Veces que el niño la ha fallado (repaso de fallos). */
  fails?: number;
  /** Teoría «Recuerda» debajo (repaso de fallos). */
  remember?: boolean;
  /** Columnas de la rejilla del cálculo rápido: una cuenta ancha ocupa las que necesite. */
  drillCols?: number;
}

/** Ancho útil de A4 (y de sobra para Carta) con márgenes de 12 mm, el hueco entre columnas y el del número. */
const SHEET_MM = 186;
const GAP_MM = 8;
const NUM_MM = 10;

function drillSpan(ex: FullExercise, p: PrintProfile, cols: number): number {
  if (ex.type !== "column_operation") return 1;
  const colMm = (SHEET_MM - (cols - 1) * GAP_MM) / cols;
  const need = operationCols(ex) * p.opCellMm + NUM_MM;
  return Math.min(cols, Math.max(1, Math.ceil((need - colMm) / (colMm + GAP_MM)) + 1));
}

/** ¿Ocupa todo el ancho? (en el diseño compacto, las cortas van a dos columnas). */
export function isWide(ex: FullExercise, p: PrintProfile, o: QuestionOptions): boolean {
  if (ex.figure || ex.type === "matching" || ex.type === "step_problem" || ex.type === "column_operation") return true;
  if (workFor(ex, p, o)) return true;
  const a = answerStyle(ex, p);
  return a.kind === "lines" || ex.stem.length > 90;
}

export function PaperQuestionView({ q, n, p, o }: { q: PaperQuestion; n: number; p: PrintProfile; o: QuestionOptions }) {
  const { t } = useTranslation();
  const { ex } = q;
  const notation = notationOf(p);
  const work = workFor(ex, p, o);
  const span = o.drillCols ? drillSpan(ex, p, o.drillCols) : 1;
  return (
    <div className={"ws-q" + (isWide(ex, p, o) ? " wide" : "")} style={span > 1 ? { gridColumn: `span ${span}` } : undefined}>
      <span className="ws-num">{n}.</span>
      <div className="ws-q-body">
        <div className="ws-inst">
          {t(instructionKey(ex, p.kidTone))}
          {o.points && <span className="ws-pts">{t("worksheet.pointsShort", { p: o.points })}</span>}
          {o.fails !== undefined && o.fails > 1 && <span className="ws-pts">{t("worksheet.failedN", { count: o.fails })}</span>}
        </div>
        <div className="ws-stem" lang={ex.language}>
          {ex.type === "fill_in_blank"
            ? renderTxt(ex.stem, notation, (k) => <span className="ws-blank" style={{ minWidth: `${blankWidthMm(ex.blanks[k - 1]?.accept ?? [])}mm` }} />)
            : renderTxt(ex.stem, notation)}
        </div>
        <ExerciseFigure svg={ex.figure} className="ws-figure" />
        <PaperAnswer q={q} p={p} />
        {work?.kind === "grid" && <GridArea heightMm={work.heightMm} cellMm={p.gridMm} label={t("worksheet.work")} />}
        {work?.kind === "problem" && <ProblemArea heightMm={work.heightMm} gridMm={p.gridMm} lineMm={p.lineMm} />}
        {work?.kind === "lines" && <LinedArea lines={work.lines} spacingMm={p.lineMm} variant={p.line} />}
        {o.remember && ex.feedback?.theory && (
          <div className="ws-remember">
            <b>{t("studydoc.remember")}</b> <Txt text={ex.feedback.theory} notation={notation} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Dónde responde el niño: opciones para rodear o marcar, casillas, recuadros, líneas o renglones. */
function PaperAnswer({ q, p }: { q: PaperQuestion; p: PrintProfile }) {
  const { t } = useTranslation();
  const { ex, shown } = q;
  const notation = notationOf(p);
  const style = answerStyle(ex, p);
  const answerSlot = (key: number | string, label?: ReactNode, unit?: string): ReactNode =>
    style.kind === "box" ? (
      <AnswerBox key={key} unit={unit} label={typeof label === "string" ? label : undefined} />
    ) : style.kind === "lines" ? (
      <LinedArea key={key} lines={style.lines} spacingMm={p.lineMm} variant={p.line} label={typeof label === "string" ? label : undefined} />
    ) : (
      <AnswerLine key={key} label={label} unit={unit} />
    );

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
              <Txt text={o.text} notation={notation} />
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
      return <>{answerSlot("n", undefined, ex.answer.unit)}</>;
    case "fill_in_blank":
      // Huecos dentro del enunciado: se escriben ahí. Si el enunciado no los marca, un sitio por hueco.
      if (hasStemBlanks(ex.stem)) return null;
      return <>{ex.blanks.map((_, k) => answerSlot(k, ex.blanks.length > 1 ? `(${k + 1})` : undefined))}</>;
    case "ordering":
      return (
        <div className="ws-opts">
          {shown.map((it, k) => (
            <div className="ws-opt" key={it.id}>
              <span className="ws-box" />
              <span className="ws-letter">{letter(k)})</span>
              <Txt text={it.text} notation={notation} />
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
                <Txt text={l.text} notation={notation} />
                <span className="ws-dot end" />
              </div>
            ))}
          </div>
          <div className="ws-match-col">
            {shown.map((r, k) => (
              <div className="ws-match-item" key={r.id}>
                <span className="ws-dot" />
                <span className="ws-letter">{letter(k)})</span>
                <Txt text={r.text} notation={notation} />
              </div>
            ))}
          </div>
        </div>
      );
    case "column_operation":
    case "prime_factorization":
      // La cuenta colocada en cuadrícula (o la escalera) para hacerla a lápiz: ya es el sitio para operar.
      return <PaperOperation ex={ex} />;
    case "step_problem": {
      // En matemáticas y ciencias, una línea por paso; en las demás materias, renglones.
      const lined = !p.mathNotation;
      return (
        <div className="ws-steps">
          {ex.steps.map((s, k) => (
            <div className="ws-step" key={s.id}>
              <div className="ws-step-prompt">
                <span className="ws-letter">{letter(k)})</span>
                <Txt text={s.prompt} notation={notation} />
              </div>
              {lined ? (
                <LinedArea lines={2} spacingMm={p.lineMm} variant={p.line} />
              ) : (
                <AnswerLine unit={s.kind === "numeric" ? s.answer.unit : undefined} />
              )}
            </div>
          ))}
        </div>
      );
    }
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
function Accepted({ list, notation }: { list: string[]; notation: Notation }) {
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
          <Txt text={s} notation={notation} />
        </span>
      ))}
    </>
  );
}

/** Número con su unidad (la unidad en texto plano: «m» no es una variable). */
function NumAnswer({ a, notation }: { a: { value: number; unit?: string }; notation: Notation }) {
  const { i18n } = useTranslation();
  return (
    <>
      <Txt text={String(a.value).replace(".", decimalSep(i18n.language))} notation={notation} />
      {a.unit ? ` ${a.unit}` : ""}
    </>
  );
}

export function KeyAnswer({ q, p }: { q: PaperQuestion; p: PrintProfile }) {
  const { t, i18n } = useTranslation();
  const { ex, shown } = q;
  const notation = notationOf(p);
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
                <b>{letterOf(o.id)})</b> <Txt text={o.text} notation={notation} />
              </>
            ))}
        />
      );
    }
    case "true_false":
      return <b>{ex.answer.value ? t("session.true") : t("session.false")}</b>;
    case "numeric":
      return <NumAnswer a={ex.answer} notation={notation} />;
    case "fill_in_blank":
      return (
        <Parts
          parts={ex.blanks.map((b, k) => (
            <>
              {ex.blanks.length > 1 && <b>({k + 1}) </b>}
              <Accepted list={b.accept} notation={notation} />
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
            .map((pair) => (
              <b>
                {leftIdx(pair.leftId) + 1}-{letterOf(pair.rightId)}
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
              <b>{letter(k)})</b> {s.kind === "numeric" ? <NumAnswer a={s.answer} notation={notation} /> : <Accepted list={s.accept} notation={notation} />}
            </>
          ))}
        />
      );
    case "column_operation":
    case "prime_factorization":
      return <Txt text={operationSolutionText(ex, decimalSep(i18n.language), t("session.remainder").toLowerCase())} notation="math" />;
  }
}

/** Entrada de la clave «explicada»: la respuesta, la cuenta resuelta y cómo se hace. */
/** `showTheory=false` cuando esa misma teoría ya salió en una pregunta anterior de la clave. */
export function KeyExplained({ q, p, showTheory = true }: { q: PaperQuestion; p: PrintProfile; showTheory?: boolean }) {
  const { t } = useTranslation();
  const { ex } = q;
  const notation = notationOf(p);
  return (
    <div className="ws-key-explained">
      <div>
        <KeyAnswer q={q} p={p} />
      </div>
      {(ex.type === "column_operation" || ex.type === "prime_factorization") && <WorkedOperation ex={ex} />}
      {ex.feedback?.solution && (
        <div className="ws-key-note">
          <b>{t("content.solution")}</b> <Txt text={ex.feedback.solution} notation={notation} />
        </div>
      )}
      {showTheory && ex.feedback?.theory && (
        <div className="ws-key-note">
          <b>{t("studydoc.remember")}</b> <Txt text={ex.feedback.theory} notation={notation} />
        </div>
      )}
    </div>
  );
}
