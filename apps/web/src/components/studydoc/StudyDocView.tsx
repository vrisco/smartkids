// Documento de estudio («Apuntes»): el MISMO JSON se pinta en pantalla (tema de la app, soluciones tras
// «Ver solución», tarjetas que se giran) y en papel (tinta negra, renglones para responder, soluciones al
// final, dictado con su página para el adulto, tarjetas recortables). Cada bloque sabe pintarse en los dos.
import { Fragment, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ChildStudyQuestion, TreeNode, ViewableStudyBlock, ViewableStudyDoc } from "@smartkids/shared";
import { WorkedOperation } from "../ColumnOps";
import { ExerciseFigure } from "../ExerciseFigure";
import { Icon, type IconName } from "../Icon";
import { Txt, renderTxt, type Notation } from "../Txt";
import { AnswerKey, BoxArea, GridArea, LinedArea, SheetHeader } from "../print/paper";
import type { PrintProfile } from "../print/profiles";
import { CardsPaper } from "../print/sheets";
import { FlashcardDeck } from "./FlashcardDeck";
import { WRITABLE_KINDS } from "./kinds";

export type Medium = "screen" | "paper";

interface Ctx {
  medium: Medium;
  notation: Notation;
  /** Tutor: todas las soluciones a la vista. */
  reveal: boolean;
  profile: PrintProfile;
  /** Número de cada pregunta en el documento (para la clave del papel). */
  qNum: Map<string, number>;
}

const CALLOUT_ICON: Record<string, IconName> = { remember: "book", tip: "star", warning: "flag", fact: "globe" };
const LETTERS = "abcdefghijklmnopqrstuvwxyz";

function numbering(doc: ViewableStudyDoc): Map<string, number> {
  const m = new Map<string, number>();
  for (const b of doc.blocks) if (b.type === "questions") for (const q of b.items) m.set(q.id, m.size + 1);
  return m;
}

/** ¿Trae la pregunta su solución? (al niño se le quitan si el tutor no quiere que las vea). */
function hasAnswer(q: ChildStudyQuestion): boolean {
  switch (q.kind) {
    case "open":
      return q.answer !== undefined;
    case "choice":
    case "true_false":
      return q.correct !== undefined;
    case "fill":
      return q.answers !== undefined;
  }
}

export interface StudyDocViewProps {
  doc: ViewableStudyDoc;
  medium: Medium;
  profile: PrintProfile;
  /** "rich" en los documentos; "math"/"plain" en los que salen de ejercicios (su texto es de MathText). */
  notation?: Notation;
  reveal?: boolean;
  fontPt?: number;
  cardsLayout?: "duplex" | "fold";
  /** Encabezado del papel: nombre de la asignatura y el curso. */
  kicker?: string;
}

export function StudyDocView(props: StudyDocViewProps) {
  return props.medium === "paper" ? <PaperDoc {...props} /> : <ScreenDoc {...props} />;
}

/* ---------- Pantalla ---------- */

function ScreenDoc({ doc, profile, notation = "rich", reveal = false }: StudyDocViewProps) {
  const { t } = useTranslation();
  const ctx: Ctx = { medium: "screen", notation, reveal, profile, qNum: numbering(doc) };
  return (
    <article className={`sd screen sd-k-${doc.kind}`} lang={doc.language}>
      <header className="sd-head">
        <h1>{doc.title}</h1>
        {doc.subtitle && <p className="muted">{doc.subtitle}</p>}
        {doc.estimatedMinutes && (
          <p className="sd-minutes">
            <Icon name="clock" size={14} /> {t("studydoc.minutes", { count: doc.estimatedMinutes })}
          </p>
        )}
      </header>
      {doc.goals && <Goals goals={doc.goals} />}
      {doc.blocks.map((b, i) => (
        <Block key={i} b={b} ctx={ctx} />
      ))}
    </article>
  );
}

function Goals({ goals }: { goals: string[] }) {
  const { t } = useTranslation();
  return (
    <div className="sd-goals">
      <b>{t("studydoc.goals")}</b>
      <ul>
        {goals.map((g, i) => (
          <li key={i}>{g}</li>
        ))}
      </ul>
    </div>
  );
}

/* ---------- Papel ---------- */

function PaperDoc({ doc, profile, notation = "rich", fontPt, cardsLayout = "duplex", kicker }: StudyDocViewProps) {
  const { t } = useTranslation();
  const ctx: Ctx = { medium: "paper", notation, reveal: true, profile, qNum: numbering(doc) };
  const style = { ["--ws-font" as string]: `${fontPt ?? profile.fontPt}pt`, ["--ws-cell" as string]: `${profile.opCellMm}mm` } as CSSProperties;

  // Tarjetas: solo los mazos, recortables.
  if (doc.kind === "flashcards") {
    const decks = doc.blocks.filter((b): b is Extract<ViewableStudyBlock, { type: "flashcards" }> => b.type === "flashcards");
    return (
      <div style={style}>
        <CardsPaper
          title={doc.title}
          cards={decks.flatMap((d) => d.cards)}
          layout={cardsLayout}
          frontNotation={notation}
          backNotation={notation}
          frontLang={decks[0]?.frontLang}
          backLang={decks[0]?.backLang}
        />
      </div>
    );
  }

  // Dictado: primero la página para el adulto (el texto), después la hoja pautada del niño.
  const dictations = doc.blocks.filter((b): b is Extract<ViewableStudyBlock, { type: "dictation" }> => b.type === "dictation" && Boolean(b.text));
  const answers: { n: number; node: ReactNode; long: boolean }[] = [];
  for (const b of doc.blocks)
    if (b.type === "questions")
      for (const q of b.items)
        if (hasAnswer(q)) answers.push({ n: ctx.qNum.get(q.id) ?? 0, node: <QuestionAnswer q={q} notation={notation} />, long: q.kind === "open" });
  const model = doc.blocks.find((b): b is Extract<ViewableStudyBlock, { type: "writing_prompt" }> => b.type === "writing_prompt" && Boolean(b.model));
  const cols2 = doc.print?.columns === 2 || doc.kind === "cheatsheet";

  return (
    <div style={style}>
      {dictations.length > 0 && (
        <div className="ws-sheet sd-adult">
          <SheetHeader title={t("studydoc.forAdult")} kicker={doc.title} fields={[]} />
          {dictations.map((d, i) => (
            <div className="sd-dictation-adult" key={i} lang={d.lang}>
              {d.title && <h2>{d.title}</h2>}
              <p className="sd-dictation-text">{d.text}</p>
              {d.focus && (
                <p>
                  <b>{t("studydoc.focus")}</b> {d.focus.join(" · ")}
                </p>
              )}
              {d.pace && (
                <p className="muted">
                  <b>{t("studydoc.pace")}</b> {d.pace}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      <div className={"ws-sheet sd-sheet" + (dictations.length > 0 ? " ws-page-break" : "")}>
        <SheetHeader
          title={doc.title}
          kicker={kicker}
          meta={[doc.subtitle ?? "", doc.estimatedMinutes ? t("studydoc.minutes", { count: doc.estimatedMinutes }) : ""].filter(Boolean)}
          fields={WRITABLE_KINDS.has(doc.kind) || answers.length > 0 ? ["name", "date"] : []}
        />
        {doc.goals && <Goals goals={doc.goals} />}
        <article className={`sd paper sd-k-${doc.kind}` + (cols2 ? " cols2" : "")} lang={doc.language}>
          {doc.blocks.map((b, i) => (
            <Block key={i} b={b} ctx={ctx} />
          ))}
        </article>
      </div>
      {(answers.length > 0 || model) && (
        <div className="ws-sheet">
          <AnswerKey title={`${t("worksheet.keyTitle")} · ${doc.title}`} columns={model || answers.some((a) => a.long) ? 1 : 2}>
            {answers.map((a) => (
              <div className="ws-key-item" key={a.n}>
                <span className="ws-num">{a.n}.</span>
                <div className="ws-key-body">{a.node}</div>
              </div>
            ))}
            {model?.model && (
              <div className="ws-key-item">
                <div className="ws-key-body">
                  <b>{t("studydoc.model")}</b>
                  <p className="sd-model">
                    <Txt text={model.model} notation={notation} />
                  </p>
                </div>
              </div>
            )}
          </AnswerKey>
        </div>
      )}
    </div>
  );
}

function QuestionAnswer({ q, notation }: { q: ChildStudyQuestion; notation: Notation }) {
  const { t } = useTranslation();
  switch (q.kind) {
    case "open":
      return <Txt text={q.answer ?? ""} notation={notation} />;
    case "choice":
      return (
        <>
          <b>{LETTERS[q.correct ?? 0]})</b> <Txt text={q.options[q.correct ?? 0] ?? ""} notation={notation} />
          {q.explanation && (
            <span className="muted">
              {" "}
              · <Txt text={q.explanation} notation={notation} />
            </span>
          )}
        </>
      );
    case "true_false":
      return (
        <>
          <b>{q.correct ? t("session.true") : t("session.false")}</b>
          {q.explanation && (
            <span className="muted">
              {" "}
              · <Txt text={q.explanation} notation={notation} />
            </span>
          )}
        </>
      );
    case "fill":
      return <>{(q.answers ?? []).map((a, i) => <span className="ws-key-part" key={i}>{q.answers && q.answers.length > 1 && <b>({i + 1}) </b>}<Txt text={a} notation={notation} /></span>)}</>;
  }
}

/* ---------- Bloques ---------- */

function Block({ b, ctx }: { b: ViewableStudyBlock; ctx: Ctx }) {
  const { t } = useTranslation();
  const tx = (s: string) => <Txt text={s} notation={ctx.notation} />;
  const paper = ctx.medium === "paper";
  switch (b.type) {
    case "heading": {
      const H = b.level === 1 ? "h2" : b.level === 2 ? "h3" : "h4";
      return <H className="sd-h sd-keep">{b.text}</H>;
    }
    case "paragraph":
      return <p className="sd-p">{tx(b.text)}</p>;
    case "callout":
      return (
        <aside className={"sd-callout " + b.variant}>
          <div className="sd-callout-label">
            <Icon name={CALLOUT_ICON[b.variant] ?? "book"} size={15} /> {b.title ?? t(`studydoc.${b.variant}`)}
          </div>
          {b.text && <p>{tx(b.text)}</p>}
          {b.items && (
            <ul>
              {b.items.map((it, i) => (
                <li key={i}>{tx(it)}</li>
              ))}
            </ul>
          )}
        </aside>
      );
    case "list": {
      const L = b.ordered ? "ol" : "ul";
      return (
        <L className="sd-list">
          {b.items.map((it, i) =>
            typeof it === "string" ? (
              <li key={i}>{tx(it)}</li>
            ) : (
              <li key={i}>
                {tx(it.text)}
                <ul>
                  {it.items.map((s, k) => (
                    <li key={k}>{tx(s)}</li>
                  ))}
                </ul>
              </li>
            ),
          )}
        </L>
      );
    }
    case "table":
      return (
        <div className="sd-table-wrap">
          <table className={"sd-table" + (b.headerColumn ? " hcol" : "")}>
            {b.caption && <caption>{b.caption}</caption>}
            <thead>
              <tr>
                {b.header.map((h, i) => (
                  <th key={i} scope="col">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) =>
                    c === 0 && b.headerColumn ? (
                      <th key={c} scope="row">
                        {tx(cell)}
                      </th>
                    ) : (
                      <td key={c}>{cell ? tx(cell) : paper ? <span className="sd-empty-cell" /> : null}</td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "formula":
      return (
        <div className="sd-formula">
          {b.label && <div className="sd-formula-label">{b.label}</div>}
          <div className="sd-formula-expr">{renderTxt(b.expr, "math")}</div>
          {b.vars && (
            <dl className="sd-vars">
              {b.vars.map((v, i) => (
                <Fragment key={i}>
                  <dt>{renderTxt(v.symbol, "math")}</dt>
                  <dd>{v.meaning}</dd>
                </Fragment>
              ))}
            </dl>
          )}
          {b.note && <p className="sd-note">{tx(b.note)}</p>}
        </div>
      );
    case "definitions":
      return (
        <div className="sd-defs-wrap">
          {b.title && <h4 className="sd-h">{b.title}</h4>}
          <dl className="sd-defs">
            {b.items.map((d, i) => (
              <div className="sd-def" key={i}>
                <dt>{d.term}</dt>
                <dd>
                  {tx(d.definition)}
                  {d.example && (
                    <span className="sd-example">
                      {" "}
                      {t("studydoc.exampleShort")} {tx(d.example)}
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      );
    case "vocabulary": {
      const hasPh = b.items.some((it) => it.phonetics);
      const hasEx = b.items.some((it) => it.example);
      return (
        <div className="sd-table-wrap">
          <table className="sd-table sd-vocab">
            {b.title && <caption>{b.title}</caption>}
            <thead>
              <tr>
                <th scope="col">{t("studydoc.term")}</th>
                {hasPh && <th scope="col">{t("studydoc.phonetic")}</th>}
                <th scope="col">{t("studydoc.translation")}</th>
                {hasEx && <th scope="col">{t("studydoc.exampleCol")}</th>}
              </tr>
            </thead>
            <tbody>
              {b.items.map((it, i) => (
                <tr key={i}>
                  <th scope="row" lang={b.lang}>
                    {it.term}
                    {it.partOfSpeech && <small className="muted"> ({it.partOfSpeech})</small>}
                  </th>
                  {hasPh && <td className="sd-ipa">{it.phonetics}</td>}
                  <td>{it.translation}</td>
                  {hasEx && (
                    <td>
                      {it.example && <span lang={b.lang}>{it.example}</span>}
                      {it.exampleTranslation && <small className="muted"> ({it.exampleTranslation})</small>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "worked_example":
      return (
        <div className="sd-worked">
          <div className="sd-worked-title">
            <Icon name="pencil" size={15} /> {b.title ?? t("studydoc.example")}
          </div>
          <p className="sd-statement">{tx(b.statement)}</p>
          <ExerciseFigure svg={b.figure} />
          {b.operation && (
            <div className="sd-op">
              <WorkedOperation ex={b.operation} />
            </div>
          )}
          <ol className="sd-steps">
            {b.steps.map((s, i) => (
              <li key={i}>
                {tx(s.text)}
                {s.work && <div className="sd-work">{renderTxt(s.work, "math")}</div>}
              </li>
            ))}
          </ol>
          <div className="sd-answer">
            <b>{t("studydoc.answer")}</b> {tx(b.answer)}
          </div>
          {b.check && <p className="sd-check">{tx(b.check)}</p>}
        </div>
      );
    case "figure":
      return (
        <figure className={"sd-figure " + (b.size ?? "m")} role="img" aria-label={b.alt}>
          <ExerciseFigure svg={b.svg} />
          {b.caption && <figcaption>{b.caption}</figcaption>}
        </figure>
      );
    case "timeline":
      return (
        <div className="sd-timeline-wrap">
          {b.title && <h4 className="sd-h">{b.title}</h4>}
          <ol className={"sd-timeline" + (b.events.length > 12 ? " many" : "")}>
            {b.events.map((e, i) => (
              <li key={i}>
                <span className="sd-when">{e.when}</span>
                <div>
                  <b>{e.title}</b>
                  {e.text && <div className="sd-event-text">{tx(e.text)}</div>}
                </div>
              </li>
            ))}
          </ol>
        </div>
      );
    case "tree":
      return (
        <div className={"sd-tree " + b.layout}>
          {b.title && <h4 className="sd-h">{b.title}</h4>}
          <TreeView node={b.root} ctx={ctx} />
        </div>
      );
    case "flashcards":
      return paper ? (
        // Dentro de otro documento, en papel: lista compacta (las recortables son el documento «Tarjetas»).
        <div className="sd-table-wrap">
          <table className="sd-table sd-cardlist">
            {b.title && <caption>{b.title}</caption>}
            <tbody>
              {b.cards.map((c, i) => (
                <tr key={i}>
                  <th scope="row" lang={b.frontLang}>
                    {tx(c.front)}
                  </th>
                  <td lang={b.backLang}>{tx(c.back)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="sd-deck">
          {b.title && <h4 className="sd-h">{b.title}</h4>}
          <FlashcardDeck cards={b.cards} frontLang={b.frontLang} backLang={b.backLang} notation={ctx.notation} />
        </div>
      );
    case "passage":
      return (
        <div className="sd-passage" lang={b.lang}>
          {b.title && <h3 className="sd-passage-title">{b.title}</h3>}
          {b.text.split(/\n\s*\n/).map((par, i) => (
            <p key={i} className={b.numberLines ? "numbered" : undefined} data-n={b.numberLines ? i + 1 : undefined}>
              {par}
            </p>
          ))}
          {b.source && <p className="sd-source">{b.source}</p>}
        </div>
      );
    case "questions":
      return (
        <div className="sd-questions">
          {b.title && <h3 className="sd-h">{b.title}</h3>}
          {b.items.map((q) => (paper ? <PaperQuestion key={q.id} q={q} ctx={ctx} /> : <ScreenQuestion key={q.id} q={q} ctx={ctx} />))}
        </div>
      );
    case "dictation":
      if (paper)
        return (
          <div className="sd-dictation">
            {b.title && <h3 className="sd-h">{b.title}</h3>}
            <LinedArea lines={b.lines} spacingMm={ctx.profile.lineMm} variant={ctx.profile.line} />
          </div>
        );
      return b.text ? (
        <aside className="sd-callout fact">
          <div className="sd-callout-label">
            <Icon name="pencil" size={15} /> {t("studydoc.forAdult")}
          </div>
          <p lang={b.lang}>{b.text}</p>
          {b.focus && <p className="muted">{t("studydoc.focus")} {b.focus.join(" · ")}</p>}
        </aside>
      ) : (
        <aside className="sd-callout remember">
          <div className="sd-callout-label">
            <Icon name="pencil" size={15} /> {b.title ?? t("studydoc.kind_dictation")}
          </div>
          <p>{t("studydoc.dictationKid")}</p>
        </aside>
      );
    case "writing_prompt":
      return <WritingPrompt b={b} ctx={ctx} />;
    case "rubric":
      return <Rubric b={b} ctx={ctx} />;
    case "answer_space":
      if (!paper) return <p className="sd-notebook muted">{t("studydoc.notebook")}</p>;
      if (b.style === "grid") return <GridArea heightMm={Math.min(120, b.lines * ctx.profile.lineMm)} cellMm={ctx.profile.gridMm} label={b.label} />;
      if (b.style === "blank") return <BoxArea heightMm={Math.min(120, b.lines * ctx.profile.lineMm)} label={b.label} />;
      return <LinedArea lines={b.lines} spacingMm={ctx.profile.lineMm} variant={ctx.profile.line} label={b.label} />;
    case "page_break":
      return paper ? <div className="ws-page-break" /> : null;
  }
}

/** Esquema de llaves (CSS puro): cada nodo es [etiqueta] { hijos }. */
function TreeView({ node, ctx }: { node: TreeNode; ctx: Ctx }) {
  return (
    <div className="sd-node">
      <div className="sd-node-label">
        <b>{node.label}</b>
        {node.text && <span className="sd-node-text">{renderTxt(node.text, ctx.notation)}</span>}
      </div>
      {node.children && node.children.length > 0 && (
        <>
          <div className="sd-brace" aria-hidden="true" />
          <div className="sd-children">
            {node.children.map((ch, i) => (
              <TreeView key={i} node={ch} ctx={ctx} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ---------- Preguntas ---------- */

function PaperQuestion({ q, ctx }: { q: ChildStudyQuestion; ctx: Ctx }) {
  const { t } = useTranslation();
  const n = ctx.qNum.get(q.id) ?? 0;
  const blank = () => <span className="ws-blank" />;
  return (
    <div className="ws-q">
      <span className="ws-num">{n}.</span>
      <div className="ws-q-body">
        <div className="ws-stem">{renderTxt(q.prompt, ctx.notation, q.kind === "fill" ? blank : undefined)}</div>
        {q.kind === "choice" && (
          <div className={"ws-opts" + (q.options.every((o) => o.length <= 22) ? " cols" : "")}>
            {q.options.map((o, i) => (
              <div className="ws-opt" key={i}>
                <span className="ws-letter">{LETTERS[i]})</span>
                <Txt text={o} notation={ctx.notation} />
              </div>
            ))}
          </div>
        )}
        {q.kind === "true_false" && (
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
        )}
        {q.kind === "open" && <LinedArea lines={q.lines ?? 2} spacingMm={ctx.profile.lineMm} variant={ctx.profile.line} />}
      </div>
    </div>
  );
}

/** Pregunta en pantalla: se responde tocando (opciones, V/F) y la solución se ve tras «Ver solución». */
function ScreenQuestion({ q, ctx }: { q: ChildStudyQuestion; ctx: Ctx }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(ctx.reveal);
  const [picked, setPicked] = useState<number | boolean | null>(null);
  const n = ctx.qNum.get(q.id) ?? 0;
  const can = hasAnswer(q);
  const showResult = picked !== null && can;
  const tx = (s: string) => <Txt text={s} notation={ctx.notation} />;
  return (
    <div className="sd-q">
      <div className="sd-q-prompt">
        <b>{n}.</b> {renderTxt(q.prompt, ctx.notation, q.kind === "fill" ? (k) => <span className="sd-blank">{open && q.answers ? q.answers[k - 1] : ""}</span> : undefined)}
      </div>
      {q.kind === "choice" && (
        <div className="sd-q-opts">
          {q.options.map((o, i) => {
            const cls = showResult ? (i === q.correct ? " ok" : picked === i ? " ko" : "") : picked === i ? " on" : "";
            return (
              <button key={i} type="button" className={"sd-q-opt" + cls} onClick={() => setPicked(i)} aria-pressed={picked === i}>
                <span className="ws-letter">{LETTERS[i]})</span> {tx(o)}
              </button>
            );
          })}
        </div>
      )}
      {q.kind === "true_false" && (
        <div className="sd-q-opts two">
          {[true, false].map((v) => {
            const cls = showResult ? (v === q.correct ? " ok" : picked === v ? " ko" : "") : picked === v ? " on" : "";
            return (
              <button key={String(v)} type="button" className={"sd-q-opt" + cls} onClick={() => setPicked(v)} aria-pressed={picked === v}>
                {v ? t("session.true") : t("session.false")}
              </button>
            );
          })}
        </div>
      )}
      {can && (
        <button className="btn-ghost sm sd-reveal" type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? t("studydoc.hideSolution") : t("studydoc.showSolution")}
        </button>
      )}
      {open && can && (
        <div className="sd-q-answer">
          {q.kind === "open" && tx(q.answer ?? "")}
          {q.kind === "choice" && (
            <>
              <b>{LETTERS[q.correct ?? 0]})</b> {tx(q.options[q.correct ?? 0] ?? "")}
              {q.explanation && <div className="muted">{tx(q.explanation)}</div>}
            </>
          )}
          {q.kind === "true_false" && (
            <>
              <b>{q.correct ? t("session.true") : t("session.false")}</b>
              {q.explanation && <div className="muted">{tx(q.explanation)}</div>}
            </>
          )}
          {q.kind === "fill" && (q.answers ?? []).join(" · ")}
        </div>
      )}
    </div>
  );
}

/* ---------- Redacción y rúbrica ---------- */

function WritingPrompt({ b, ctx }: { b: Extract<ViewableStudyBlock, { type: "writing_prompt" }>; ctx: Ctx }) {
  const { t } = useTranslation();
  const [done, setDone] = useState<Set<number>>(new Set());
  const [showModel, setShowModel] = useState(false);
  const paper = ctx.medium === "paper";
  const words =
    b.minWords && b.maxWords
      ? t("studydoc.wordsRange", { min: b.minWords, max: b.maxWords })
      : b.minWords
        ? t("studydoc.wordsMin", { min: b.minWords })
        : b.maxWords
          ? t("studydoc.wordsMax", { max: b.maxWords })
          : null;
  return (
    <div className="sd-writing">
      {b.title && <h3 className="sd-h">{b.title}</h3>}
      <p className="sd-statement">
        <Txt text={b.prompt} notation={ctx.notation} />
      </p>
      {(b.genre || words) && <p className="muted">{[b.genre, words].filter(Boolean).join(" · ")}</p>}
      {b.checklist && (
        <ul className="sd-checklist">
          {b.checklist.map((c, i) => (
            <li key={i}>
              {paper ? (
                <span className="ws-box" />
              ) : (
                <input
                  type="checkbox"
                  checked={done.has(i)}
                  onChange={() =>
                    setDone((d) => {
                      const nd = new Set(d);
                      if (nd.has(i)) nd.delete(i);
                      else nd.add(i);
                      return nd;
                    })
                  }
                  aria-label={c}
                />
              )}
              <span>{c}</span>
            </li>
          ))}
        </ul>
      )}
      {!paper && b.model && (
        <>
          <button className="btn-ghost sm sd-reveal" type="button" aria-expanded={showModel} onClick={() => setShowModel((s) => !s)}>
            {showModel ? t("studydoc.hideModel") : t("studydoc.showModel")}
          </button>
          {showModel && (
            <p className="sd-model">
              <Txt text={b.model} notation={ctx.notation} />
            </p>
          )}
        </>
      )}
      {paper && <BoxArea heightMm={22} label={t("studydoc.plan")} />}
    </div>
  );
}

function Rubric({ b, ctx }: { b: Extract<ViewableStudyBlock, { type: "rubric" }>; ctx: Ctx }) {
  const { t } = useTranslation();
  const [sel, setSel] = useState<Record<number, number>>({});
  const paper = ctx.medium === "paper";
  const levels = b.criteria[0]?.levels ?? [];
  return (
    <div className="sd-table-wrap">
      <table className="sd-table sd-rubric">
        <caption>{b.title ?? t("studydoc.rubric")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("studydoc.criterion")}</th>
            {levels.map((l, i) => (
              <th key={i} scope="col">
                {l.label}
                {l.points !== undefined && <small> ({l.points})</small>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {b.criteria.map((c, ci) => (
            <tr key={ci}>
              <th scope="row">{c.name}</th>
              {c.levels.map((l, li) => (
                <td key={li} className={sel[ci] === li ? "on" : undefined}>
                  {paper ? (
                    <span className="sd-rubric-cell">
                      <span className="ws-box" /> {l.descriptor}
                    </span>
                  ) : (
                    <button type="button" className="sd-rubric-btn" aria-pressed={sel[ci] === li} onClick={() => setSel((s) => ({ ...s, [ci]: li }))}>
                      {l.descriptor}
                    </button>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
