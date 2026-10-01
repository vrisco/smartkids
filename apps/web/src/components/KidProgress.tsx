// Cómo va el niño en un curso, ficha o path (en su tarjeta y en la cabecera de la galaxia) y el botón
// "Repasar fallos". Los datos vienen de GET /api/child/progress, por ámbito (`course:`, `skill:`, `path:`).
import { useTranslation } from "react-i18next";
import type { ScopeProgress } from "../api";
import { Icon } from "./Icon";
import { fmtTime } from "./StatsView";

/** Color del acierto: bien (80 % o más), regular (50 % o más) o flojo. */
function tono(pct: number): string {
  return pct >= 80 ? "good" : pct >= 50 ? "mid" : "low";
}

/**
 * Aciertos (con tendencia), tiempo por pregunta y avance: temas dominados en un curso, preguntas vistas
 * en una ficha o path (`total` = preguntas que tiene). Sin pintar nada hasta que llegan los datos.
 */
export function ProgressLine({ p, ready, total }: { p?: ScopeProgress; ready: boolean; total?: number }) {
  const { t } = useTranslation();
  if (!ready) return null;
  const started = Boolean(p && p.attempts > 0);
  return (
    <span className="kid-progress">
      {!started && <span className="kp-stat">{t("kid.notStarted")}</span>}
      {p && started && (
        <span className={"kp-stat acc " + tono(p.accuracyPct)}>
          <Icon name="target" size={12} /> {t("kid.statAccuracy", { pct: p.accuracyPct })}
          {p.trend === "up" && (
            <span className="trend up" title={t("kid.trendUp")} aria-label={t("kid.trendUp")}>
              <Icon name="chevronUp" size={12} />
            </span>
          )}
          {p.trend === "down" && (
            <span className="trend down" title={t("kid.trendDown")} aria-label={t("kid.trendDown")}>
              <Icon name="chevronDown" size={12} />
            </span>
          )}
        </span>
      )}
      {p && started && p.avgMs != null && (
        <span className="kp-stat">
          <Icon name="clock" size={12} /> {t("kid.statPerQuestion", { time: fmtTime(p.avgMs) })}
        </span>
      )}
      {p?.totalSkills ? (
        <span className="kp-stat">
          <Icon name="planet" size={12} /> {t("kid.statTopics", { done: p.mastered ?? 0, total: p.totalSkills })}
        </span>
      ) : total ? (
        <span className="kp-stat">
          <Icon name="check" size={12} /> {t("kid.statSeen", { done: Math.min(p?.seen ?? 0, total), total })}
        </span>
      ) : null}
    </span>
  );
}

/** "Repasar fallos" con el nº de preguntas pendientes de corregir; no se pinta si no queda ninguna. */
export function ReviewButton({ pending, busy, onClick }: { pending: number; busy: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  if (pending <= 0) return null;
  return (
    <button className="btn-ghost sm review-btn" type="button" disabled={busy} onClick={onClick}>
      <Icon name="target" size={14} /> {t("kid.reviewMistakes")} <span className="review-count">{pending}</span>
    </button>
  );
}
