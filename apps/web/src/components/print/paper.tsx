// Piezas del papel (solo se ven al imprimir, o en la vista previa de papel). Todo se dibuja con bordes o con
// SVG: los fondos NO se imprimen por defecto en los navegadores, así que una cuadrícula hecha con fondo
// saldría en blanco.
import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { LineStyle } from "./profiles";

export type HeaderField = "name" | "date" | "course" | "time" | "score";

export function SheetHeader({
  title,
  kicker,
  meta,
  fields,
  course,
  minutes,
  scoreOf,
  code,
  version,
}: {
  title: string;
  kicker?: string;
  meta?: string[];
  fields: HeaderField[];
  course?: string;
  minutes?: number;
  scoreOf?: number;
  code?: string;
  version?: string;
}) {
  const { t } = useTranslation();
  return (
    <header className="ws-head">
      <div className="ws-head-top">
        <div>
          {kicker && <div className="ws-kicker">{kicker}</div>}
          <h1>{title}</h1>
        </div>
        {(version || code) && (
          <div className="ws-code">
            {version && <b>{t("worksheet.version", { v: version })}</b>}
            {code && <span>{code}</span>}
          </div>
        )}
      </div>
      {meta && meta.length > 0 && <div className="ws-meta">{meta.filter(Boolean).join(" · ")}</div>}
      {fields.length > 0 && (
        <div className="ws-fields">
          {fields.includes("name") && (
            <span className="ws-field grow">
              {t("worksheet.name")}
              <span className="ws-line" />
            </span>
          )}
          {fields.includes("course") && (
            <span className="ws-field">
              {t("worksheet.course")}
              {course ? <span className="ws-filled">{course}</span> : <span className="ws-line" />}
            </span>
          )}
          {fields.includes("date") && (
            <span className="ws-field">
              {t("worksheet.date")}
              <span className="ws-line" />
            </span>
          )}
          {fields.includes("time") && (
            <span className="ws-field">
              {t("worksheet.time")}
              {minutes ? <span className="ws-filled">{t("worksheet.minutes", { count: minutes })}</span> : <span className="ws-line short" />}
            </span>
          )}
          {fields.includes("score") && (
            <span className="ws-field">
              {t("worksheet.score")}
              <span className="ws-line short" />
              {scoreOf !== undefined && `/ ${scoreOf}`}
            </span>
          )}
        </div>
      )}
    </header>
  );
}

/** Recuadro de instrucciones (exámenes). */
export function Instructions({ items }: { items: string[] }) {
  const { t } = useTranslation();
  return (
    <div className="ws-instructions">
      <b>{t("worksheet.instructions")}</b>
      <ul>
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
}

/** Cuadrícula de cuaderno en vectorial (SVG con patrón en mm): siempre se imprime. */
export function GridArea({ heightMm, cellMm, label }: { heightMm: number; cellMm: number; label?: string }) {
  const raw = useId();
  const id = "g" + raw.replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <div className="ws-area">
      {label && <span className="ws-area-label">{label}</span>}
      <svg className="ws-grid" width="100%" height={`${heightMm}mm`} aria-hidden="true">
        <defs>
          <pattern id={id} width={`${cellMm}mm`} height={`${cellMm}mm`} patternUnits="userSpaceOnUse">
            <line x1="0" y1="0" x2={`${cellMm}mm`} y2="0" stroke="currentColor" strokeWidth="0.6" />
            <line x1="0" y1="0" x2="0" y2={`${cellMm}mm`} stroke="currentColor" strokeWidth="0.6" />
          </pattern>
        </defs>
        <rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
        <rect x="0.5" y="0.5" width="99.6%" height="99%" fill="none" stroke="currentColor" strokeWidth="0.8" />
      </svg>
    </div>
  );
}

/** Renglones para escribir: simple, doble pauta (línea central punteada) o pauta Montessori (4 guías). */
export function LinedArea({ lines, spacingMm, variant = "single", label }: { lines: number; spacingMm: number; variant?: LineStyle; label?: string }) {
  return (
    // Un área larga (redacción, dictado) puede seguir en la página siguiente: no deja media hoja en blanco.
    <div className={"ws-area" + (lines > 8 ? " long" : "")}>
      {label && <span className="ws-area-label">{label}</span>}
      <div className={"ws-lines " + variant} style={{ ["--ws-line-h" as string]: `${spacingMm}mm` }}>
        {Array.from({ length: lines }, (_, i) => (
          <div className="ws-row" key={i} />
        ))}
      </div>
    </div>
  );
}

/** Recuadro en blanco (espacio libre para operar o dibujar). */
export function BoxArea({ heightMm, label }: { heightMm: number; label?: string }) {
  return (
    <div className="ws-box-area" style={{ height: `${heightMm}mm` }}>
      {label && <span className="ws-area-label">{label}</span>}
    </div>
  );
}

/** Problema «como en el colegio»: Datos (renglones) | Operaciones (cuadrícula), y debajo la Solución. */
export function ProblemArea({ heightMm, gridMm, lineMm }: { heightMm: number; gridMm: number; lineMm: number }) {
  const { t } = useTranslation();
  const lines = Math.max(2, Math.floor(heightMm / Math.max(lineMm, 7)));
  return (
    <div className="ws-problem">
      <div className="ws-problem-data">
        <LinedArea lines={lines} spacingMm={Math.max(lineMm, 7)} label={t("worksheet.problemData")} />
      </div>
      <div className="ws-problem-ops">
        <GridArea heightMm={heightMm} cellMm={gridMm} label={t("worksheet.problemOps")} />
      </div>
    </div>
  );
}

/** Resultado en un recuadro (con la unidad si la hay). */
export function AnswerBox({ unit, label }: { unit?: string; label?: string }) {
  const { t } = useTranslation();
  return (
    <div className="ws-answer-box">
      <span>{label ?? t("worksheet.result")}</span>
      <span className="ws-rbox" />
      {unit && <span>{unit}</span>}
    </div>
  );
}

/** Línea de respuesta. */
export function AnswerLine({ label, unit, short }: { label?: ReactNode; unit?: string; short?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={"ws-answer" + (short ? " short" : "")}>
      <span>{label ?? t("worksheet.answer")}</span>
      <span className="ws-line" />
      {unit && <span>{unit}</span>}
    </div>
  );
}

/** Tabla de calificación de un examen: puntos por sección, obtenidos y total sobre 10. */
export function ScoreTable({ rows, pointsLabel }: { rows: { label: string; points: string }[]; pointsLabel: (p: string) => string }) {
  const { t } = useTranslation();
  return (
    <table className="ws-score">
      <thead>
        <tr>
          <th>{t("worksheet.section")}</th>
          <th>{t("worksheet.points")}</th>
          <th>{t("worksheet.obtained")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td>{r.label}</td>
            <td>{pointsLabel(r.points)}</td>
            <td />
          </tr>
        ))}
        <tr className="total">
          <td>{t("worksheet.total")}</td>
          <td>{pointsLabel("10")}</td>
          <td />
        </tr>
      </tbody>
    </table>
  );
}

export function SignatureLine() {
  const { t } = useTranslation();
  return (
    <div className="ws-signature">
      <span>{t("worksheet.signature")}</span>
      <span className="ws-line" />
    </div>
  );
}

/** Soluciones: SIEMPRE en página aparte (para separarlas antes de dárselo al niño). */
export function AnswerKey({ title, code, columns = 2, children }: { title: string; code?: string; columns?: 1 | 2; children: ReactNode }) {
  return (
    <section className="ws-key">
      <h2>
        {title}
        {code && <span className="ws-key-code">{code}</span>}
      </h2>
      <div className={"ws-key-list" + (columns === 1 ? " one" : "")}>{children}</div>
    </section>
  );
}
