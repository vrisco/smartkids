// Hojas completas para imprimir: ficha de práctica, examen, repaso de fallos y cálculo rápido (con su hoja
// de soluciones), cuadernillos de varias fichas y tarjetas de memoria recortables.
import { Fragment, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Txt, type Notation } from "../Txt";
import { KeyAnswer, KeyExplained, PaperQuestionView, type QuestionOptions } from "./ExercisePaper";
import { AnswerKey, Instructions, ScoreTable, SheetHeader, SignatureLine, type HeaderField } from "./paper";
import type { PrintProfile } from "./profiles";
import { formatPoints } from "./scoring";
import type { PaperQuestion } from "./select";

export type SheetMode = "practice" | "exam" | "review" | "drill";
export type KeyStyle = "simple" | "explained";

export interface SheetSection {
  title: string | null;
  profile: PrintProfile;
  questions: PaperQuestion[];
}

export interface SheetSpec {
  title: string;
  kicker?: string;
  meta: string[];
  course?: string;
  mode: SheetMode;
  sections: SheetSection[];
  workSpace: boolean;
  compact: boolean;
  fontPt: number;
  /** Puntos de cada pregunta (examen), en el orden en que salen. */
  points?: number[];
  minutes?: number;
  code?: string;
  version?: string;
  /** Teoría «Recuerda» bajo cada pregunta (repaso de fallos). */
  remember?: boolean;
}

/** Columnas del cálculo rápido: 3 para los pequeños (letra y casillas más grandes), 4 para el resto. */
const drillColsFor = (p?: PrintProfile) => (p && (p.age === "early" || p.age === "mid") ? 3 : 4);

/** Variables de tamaño del perfil (no son colores: el papel sigue con los tokens --print-*). */
function sheetVars(spec: SheetSpec): CSSProperties {
  const p = spec.sections[0]?.profile;
  return {
    ["--ws-font" as string]: `${spec.fontPt}pt`,
    ["--ws-cell" as string]: `${p?.opCellMm ?? 7}mm`,
    ["--ws-drill-cols" as string]: String(drillColsFor(p)),
  } as CSSProperties;
}

function fieldsFor(mode: SheetMode): HeaderField[] {
  if (mode === "exam") return ["name", "course", "date", "time", "score"];
  if (mode === "drill") return ["name", "date", "time", "score"];
  return ["name", "date", "score"];
}

/** Ficha (o examen) completa SIN la clave: cabecera, secciones y preguntas. */
export function ExerciseSheet({ spec }: { spec: SheetSpec }) {
  const { t, i18n } = useTranslation();
  const total = spec.sections.reduce((n, s) => n + s.questions.length, 0);
  const exam = spec.mode === "exam";
  const drill = spec.mode === "drill";
  // «Haz las operaciones...» solo si alguna sección es de números (matemáticas o ciencias).
  const numeric = spec.sections.some((s) => s.profile.family === "math" || s.profile.family === "science");
  const pts = (p: number) => formatPoints(p, i18n.language);
  let idx = 0;
  const sectionPoints = spec.sections.map((s) => {
    const sum = s.questions.reduce((acc, _q, k) => acc + (spec.points?.[idx + k] ?? 0), 0);
    idx += s.questions.length;
    return sum;
  });
  let n = 0;
  return (
    <div className={"ws-sheet" + (drill ? " drill" : "")} style={sheetVars(spec)}>
      <SheetHeader
        title={spec.title}
        kicker={spec.kicker}
        meta={[...spec.meta, t("worksheet.questionsN", { count: total })]}
        fields={fieldsFor(spec.mode)}
        course={spec.course}
        minutes={exam ? spec.minutes : undefined}
        scoreOf={exam ? 10 : total}
        code={spec.code}
        version={spec.version}
      />
      {exam && <Instructions items={[t("worksheet.examInst1"), t(numeric ? "worksheet.examInst2" : "worksheet.examInst2Text"), t("worksheet.examInst3", { minutes: spec.minutes ?? 0 })]} />}
      {drill && <p className="ws-drill-inst">{t("worksheet.drillInst")}</p>}
      {spec.sections.map((s, si) => (
        <section className="ws-section" key={si}>
          {s.title && spec.sections.length > 1 && (
            <h2 className="ws-section-title">
              {s.title}
              {exam && <span className="ws-pts">{t("worksheet.pointsShort", { p: pts(sectionPoints[si] ?? 0) })}</span>}
            </h2>
          )}
          <div className={"ws-qs" + (spec.compact || drill ? " compact" : "") + (drill ? " drill" : "")}>
            {s.questions.map((q) => {
              const i = n++;
              const o: QuestionOptions = {
                workSpace: spec.workSpace && !drill,
                compact: spec.compact || drill,
                drillCols: drill ? drillColsFor(s.profile) : undefined,
                points: exam && spec.points ? pts(spec.points[i] ?? 0) : undefined,
                fails: spec.mode === "review" ? q.item.failCount : undefined,
                remember: spec.remember,
              };
              return <PaperQuestionView key={q.item.templateId + ":" + i} q={q} n={i + 1} p={s.profile} o={o} />;
            })}
          </div>
        </section>
      ))}
      {exam && (
        <>
          <ScoreTable
            rows={spec.sections.map((s, si) => ({ label: s.title ?? t("worksheet.allQuestions"), points: pts(sectionPoints[si] ?? 0) }))}
            pointsLabel={(p) => t("worksheet.pointsShort", { p })}
          />
          <SignatureLine />
        </>
      )}
    </div>
  );
}

/** Hoja de soluciones de una ficha (siempre en página aparte). */
export function SheetKey({ spec, style }: { spec: SheetSpec; style: KeyStyle }) {
  const { t, i18n } = useTranslation();
  let n = 0;
  // Cada «Recuerda» sale solo la primera vez: en un banco de un tema, muchas preguntas comparten teoría.
  const seenTheory = new Set<string>();
  const title = [t("worksheet.keyTitle"), spec.title, spec.version ? t("worksheet.version", { v: spec.version }) : ""].filter(Boolean).join(" · ");
  return (
    <div className="ws-sheet" style={sheetVars(spec)}>
      <AnswerKey title={title} code={spec.code} columns={style === "explained" ? 1 : 2}>
        {spec.sections.map((s) =>
          s.questions.map((q) => {
            const i = n++;
            const th = q.ex.feedback?.theory?.trim().toLowerCase();
            const firstTheory = !!th && !seenTheory.has(th);
            if (th) seenTheory.add(th);
            return (
              <div className="ws-key-item" key={q.item.templateId + ":" + i}>
                <span className="ws-num">{i + 1}.</span>
                <div className="ws-key-body">
                  {style === "explained" ? <KeyExplained q={q} p={s.profile} showTheory={firstTheory} /> : <KeyAnswer q={q} p={s.profile} />}
                  {spec.points && spec.mode === "exam" && (
                    <span className="ws-key-pts">{t("worksheet.pointsShort", { p: formatPoints(spec.points[i] ?? 0, i18n.language) })}</span>
                  )}
                </div>
              </div>
            );
          }),
        )}
      </AnswerKey>
    </div>
  );
}

/** Varias fichas en un solo PDF: cada una en página nueva; las soluciones juntas al final o tras cada ficha. */
export function Booklet({ sheets, keyStyle, includeKey, keysTogether }: { sheets: SheetSpec[]; keyStyle: KeyStyle; includeKey: boolean; keysTogether: boolean }) {
  return (
    <>
      {sheets.map((s, i) => (
        <Fragment key={i}>
          <div className={i > 0 ? "ws-page-break" : undefined}>
            <ExerciseSheet spec={s} />
          </div>
          {includeKey && !keysTogether && <SheetKey spec={s} style={keyStyle} />}
        </Fragment>
      ))}
      {includeKey && keysTogether && sheets.map((s, i) => <SheetKey key={"k" + i} spec={s} style={keyStyle} />)}
    </>
  );
}

/* ---------- Tarjetas de memoria recortables ---------- */

export interface PaperCard {
  front: string;
  back: string;
  hint?: string;
}

const CARDS_PER_PAGE = 8; // 2 columnas × 4 filas en A4 o Carta
const FOLD_PER_PAGE = 5;

/**
 * Tarjetas para recortar. «duplex»: una página con los anversos y la siguiente con los reversos, con las
 * columnas ESPEJADAS (al imprimir a doble cara por el borde largo, cada reverso cae detrás de su anverso).
 * «fold»: para impresoras sin doble cara, cada fila es anverso | reverso y se dobla por la línea.
 */
export function CardsPaper({
  cards,
  layout,
  frontNotation,
  backNotation,
  frontLang,
  backLang,
  title,
}: {
  cards: PaperCard[];
  layout: "duplex" | "fold";
  frontNotation: Notation;
  backNotation: Notation;
  frontLang?: string;
  backLang?: string;
  title: string;
}) {
  const { t } = useTranslation();
  const face = (c: PaperCard, i: number, side: "front" | "back") => (
    <div className={"ws-card " + side + (((side === "front" ? c.front : c.back).length > 140 ? " long" : ""))} key={side + i}>
      <span className="ws-card-num">{i + 1}</span>
      <div className="ws-card-text" lang={side === "front" ? frontLang : backLang}>
        <Txt text={side === "front" ? c.front : c.back} notation={side === "front" ? frontNotation : backNotation} />
      </div>
      {side === "front" && c.hint && <div className="ws-card-hint">{c.hint}</div>}
    </div>
  );
  if (layout === "fold") {
    const pages: PaperCard[][] = [];
    for (let i = 0; i < cards.length; i += FOLD_PER_PAGE) pages.push(cards.slice(i, i + FOLD_PER_PAGE));
    return (
      <div className="ws-sheet ws-cards">
        {pages.map((pg, pi) => (
          <div className={"ws-card-page fold" + (pi > 0 ? " ws-page-break" : "")} key={pi}>
            {pi === 0 && <div className="ws-cards-title">{title}</div>}
            {pg.map((c, k) => {
              const i = pi * FOLD_PER_PAGE + k;
              return (
                <div className="ws-fold-row" key={i}>
                  {face(c, i, "front")}
                  {face(c, i, "back")}
                </div>
              );
            })}
            <div className="ws-cards-tip">{t("worksheet.foldTip")}</div>
          </div>
        ))}
      </div>
    );
  }
  const pages: PaperCard[][] = [];
  for (let i = 0; i < cards.length; i += CARDS_PER_PAGE) pages.push(cards.slice(i, i + CARDS_PER_PAGE));
  return (
    <div className="ws-sheet ws-cards">
      {pages.map((pg, pi) => {
        // Reverso: cada fila de dos, al revés (espejo para la doble cara por el borde largo).
        const rows: (PaperCard | null)[][] = [];
        for (let r = 0; r < pg.length; r += 2) rows.push([pg[r] ?? null, pg[r + 1] ?? null]);
        return (
          <Fragment key={pi}>
            <div className={"ws-card-page" + (pi > 0 ? " ws-page-break" : "")}>
              {rows.flatMap((row, r) => row.map((c, k) => (c ? face(c, pi * CARDS_PER_PAGE + r * 2 + k, "front") : <div className="ws-card empty" key={`ef${r}${k}`} />)))}
            </div>
            <div className="ws-card-page ws-page-break">
              {rows.flatMap((row, r) =>
                [row[1] ?? null, row[0] ?? null].map((c, k) => {
                  const col = 1 - k;
                  return c ? face(c, pi * CARDS_PER_PAGE + r * 2 + col, "back") : <div className="ws-card empty" key={`eb${r}${k}`} />;
                }),
              )}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
