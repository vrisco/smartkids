// Preview del tutor: navega por TODOS los ejercicios de un skill privado (uno a uno,
// con botones adelante/atrás), muestra la solución y permite ocultar/mostrar cada uno.
// Es solo lectura: no se responde.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type FullExercise, type PreviewExercise } from "../api";
import { ExerciseFigure } from "./ExerciseFigure";
import { Icon } from "./Icon";
import { MathText } from "./MathText";

export function ContentPreview({ skillId, title, onClose }: { skillId: string; title: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<PreviewExercise[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .skillExercises(skillId)
      .then(setItems)
      .catch(() => setError(true));
  }, [skillId]);

  const total = items?.length ?? 0;
  const pos = Math.min(idx, Math.max(0, total - 1));
  const cur = items && total > 0 ? items[pos] : null;

  async function toggleHidden() {
    if (!cur || !items) return;
    setBusy(true);
    try {
      const r = await api.setExerciseHidden(cur.templateId, !cur.hidden);
      setItems(items.map((it) => (it.templateId === cur.templateId ? { ...it, hidden: r.hidden } : it)));
    } catch {
      /* noop */
    } finally {
      setBusy(false);
    }
  }

  const visible = (items ?? []).filter((it) => !it.hidden).length;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="preview-head">
          <div className="list-main">
            <b>{title}</b>
            {items && <span className="muted">{t("content.previewVisible", { visible, total })}</span>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t("common.close")}>
            <Icon name="close" size={16} />
          </button>
        </div>

        {error ? (
          <p className="muted screen-pad">{t("session.connError")}</p>
        ) : !items ? (
          <p className="muted screen-pad">{t("content.previewLoading")}</p>
        ) : total === 0 || !cur ? (
          <p className="muted screen-pad">{t("content.noExercises")}</p>
        ) : (
          <>
            <div className={"preview-body" + (cur.hidden ? " is-hidden" : "")}>
              {cur.hidden && (
                <div className="preview-hidden-badge">
                  <Icon name="eyeOff" size={14} /> {t("content.hiddenTag")}
                </div>
              )}
              <ExerciseFigure svg={cur.exercise.figure} />
              <PreviewExerciseView ex={cur.exercise} />
            </div>

            <div className="preview-actions">
              <button className={"btn-ghost sm" + (cur.hidden ? "" : " danger")} disabled={busy} onClick={toggleHidden}>
                <Icon name={cur.hidden ? "eye" : "eyeOff"} size={16} /> {cur.hidden ? t("content.show") : t("content.hide")}
              </button>
            </div>

            <div className="preview-nav">
              <button className="btn-ghost sm" disabled={pos <= 0} onClick={() => setIdx(pos - 1)}>
                <Icon name="chevronLeft" size={16} /> {t("content.prev")}
              </button>
              <span className="preview-count">
                {pos + 1} / {total}
              </span>
              <button className="btn-ghost sm" disabled={pos >= total - 1} onClick={() => setIdx(pos + 1)}>
                {t("content.next")} <Icon name="chevronRight" size={16} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Visor read-only de un ejercicio completo: enunciado + respuesta correcta + solución. */
function PreviewExerciseView({ ex }: { ex: FullExercise }) {
  const { t } = useTranslation();
  return (
    <div className="preview-ex">
      <div className="preview-type">{t(`content.type_${ex.type}`)}</div>
      <div className="preview-stem">
        <MathText text={ex.stem} />
      </div>
      <Answer ex={ex} />
      {ex.feedback?.solution && (
        <div className="preview-solution">
          <span className="preview-label">{t("content.solution")}</span>
          <MathText text={ex.feedback.solution} />
        </div>
      )}
    </div>
  );
}

function Answer({ ex }: { ex: FullExercise }) {
  const { t } = useTranslation();
  switch (ex.type) {
    case "multiple_choice":
      return (
        <div className="preview-opts">
          {ex.options.map((o) => (
            <div key={o.id} className={"preview-opt" + (o.isCorrect ? " correct" : "")}>
              {o.isCorrect && <Icon name="check" size={14} />}
              <MathText text={o.text} />
            </div>
          ))}
        </div>
      );
    case "true_false":
      return (
        <div className="preview-answer">
          <span className="preview-label">{t("content.answer")}</span>
          {ex.answer.value ? t("session.true") : t("session.false")}
        </div>
      );
    case "numeric":
      return (
        <div className="preview-answer">
          <span className="preview-label">{t("content.answer")}</span>
          <MathText text={String(ex.answer.value)} />
          {ex.answer.unit ? ` ${ex.answer.unit}` : ""}
        </div>
      );
    case "fill_in_blank":
      return (
        <div className="preview-answer">
          <span className="preview-label">{t("content.answer")}</span>
          {ex.blanks.map((b, i) => (
            <span key={i} className="preview-chip">
              {b.accept[0]}
            </span>
          ))}
        </div>
      );
    case "ordering":
      return (
        <ol className="preview-order">
          {ex.correctOrder.map((id) => (
            <li key={id}>
              <MathText text={ex.items.find((it) => it.id === id)?.text ?? id} />
            </li>
          ))}
        </ol>
      );
    case "matching":
      return (
        <div className="preview-pairs">
          {ex.correctPairs.map((p, i) => (
            <div key={i} className="preview-pair">
              <span>
                <MathText text={ex.left.find((l) => l.id === p.leftId)?.text ?? p.leftId} />
              </span>
              <Icon name="arrow" size={14} />
              <span>
                <MathText text={ex.right.find((r) => r.id === p.rightId)?.text ?? p.rightId} />
              </span>
            </div>
          ))}
        </div>
      );
    case "step_problem":
      return (
        <ol className="preview-steps">
          {ex.steps.map((s) => (
            <li key={s.id}>
              <MathText text={s.prompt} />
              <span className="preview-chip">
                {s.kind === "numeric" ? `${s.answer.value}${s.answer.unit ? " " + s.answer.unit : ""}` : s.accept[0]}
              </span>
            </li>
          ))}
        </ol>
      );
  }
}
