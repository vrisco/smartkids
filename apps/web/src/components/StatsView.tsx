// Vista de estadísticas/seguimiento de un perfil. La comparten el tutor (en un modal
// por niño) y el propio niño (pestaña "Mis puntos"). Solo lectura.
import { useTranslation } from "react-i18next";
import { tx, type ActivityDay, type ProfileStats } from "../api";
import { Icon, type IconName } from "./Icon";

function fmtTime(ms: number | null): string {
  if (ms == null || ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

function fmtDate(iso: string, locale: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(locale, { day: "2-digit", month: "short" });
}
function fmtDateTime(iso: string, locale: string): string {
  const d = new Date(iso);
  return d.toLocaleString(locale, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function Tile({ icon, label, value, tone }: { icon: IconName; label: string; value: string; tone?: string }) {
  return (
    <div className={"stat-tile" + (tone ? " " + tone : "")}>
      <span className="stat-tile-ic">
        <Icon name={icon} size={18} />
      </span>
      <b className="stat-tile-val">{value}</b>
      <span className="stat-tile-lbl">{label}</span>
    </div>
  );
}

// Mini-gráfico de barras (puntos por día). SVG inline, theme-aware (currentColor).
function ActivityChart({ data, locale }: { data: ActivityDay[]; locale: string }) {
  const { t } = useTranslation();
  const W = 280;
  const H = 84;
  const max = Math.max(1, ...data.map((d) => d.points));
  const n = data.length;
  const gap = 3;
  const bw = (W - gap * (n - 1)) / n;
  return (
    <div className="stat-chart">
      <div className="stat-chart-title">{t("stats.activity")}</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="stat-bars" role="img" aria-label={t("stats.activity")}>
        {data.map((d, i) => {
          const h = d.points > 0 ? Math.max(2, (d.points / max) * (H - 14)) : 0;
          const x = i * (bw + gap);
          return (
            <g key={d.date}>
              {h > 0 && <rect x={x} y={H - 12 - h} width={bw} height={h} rx={2} className="stat-bar" />}
              <rect x={x} y={H - 12} width={bw} height={2} className="stat-bar-base" />
              <title>{`${fmtDate(d.date, locale)}: ${d.points} · ${d.attempts} ${t("stats.attemptsShort")}`}</title>
            </g>
          );
        })}
      </svg>
      <div className="stat-chart-axis">
        <span>{fmtDate(data[0]?.date ?? "", locale)}</span>
        <span>{fmtDate(data[n - 1]?.date ?? "", locale)}</span>
      </div>
    </div>
  );
}

export function StatsView({ stats }: { stats: ProfileStats }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const o = stats.overview;

  return (
    <div className="stats-view">
      <div className="stat-tiles">
        <Tile icon="coin" label={t("stats.points")} value={String(o.balance)} tone="gold" />
        <Tile icon="target" label={t("stats.accuracy")} value={`${o.accuracyPct}%`} tone="green" />
        <Tile icon="check" label={t("stats.attempts")} value={`${o.correct}/${o.attempts}`} />
        <Tile icon="clock" label={t("stats.avgTime")} value={fmtTime(o.avgTimeMs)} />
        <Tile icon="star" label={t("stats.earned")} value={`+${o.pointsEarned}`} />
        <Tile icon="gift" label={t("stats.spent")} value={`-${o.pointsSpent}`} />
        <Tile icon="flame" label={t("stats.activeDays")} value={String(o.activeDays)} />
        <Tile icon="rocket" label={t("stats.earned7d")} value={`+${o.earned7d}`} />
      </div>

      <ActivityChart data={stats.activity} locale={locale} />

      {stats.perSkill.length > 0 && (
        <div className="stat-block">
          <div className="stat-block-title">{t("stats.bySkill")}</div>
          <div className="stat-skill-list">
            {stats.perSkill.map((s) => (
              <div className="stat-skill" key={s.skillId}>
                <div className="stat-skill-head">
                  <b>{tx(s.name)}</b>
                  <span className="stat-skill-acc">{s.accuracyPct}%</span>
                </div>
                <div className="stat-skill-meta">
                  {s.correct}/{s.attempts} · {fmtTime(s.avgTimeMs)}
                  {s.mastery != null && (
                    <span className="stat-mastery" title={t("stats.mastery")}>
                      <span className="stat-mastery-bar" style={{ width: `${Math.round(s.mastery * 100)}%` }} />
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="stat-block">
        <div className="stat-block-title">{t("stats.sessions")}</div>
        {stats.sessions.length === 0 ? (
          <p className="muted">{t("stats.noSessions")}</p>
        ) : (
          <div className="stat-session-list">
            {stats.sessions.map((s, i) => (
              <div className="stat-session" key={i}>
                <div className="stat-session-main">
                  <b>{fmtDateTime(s.start, locale)}</b>
                  <span className="muted">
                    {s.count} {t("stats.questions")} · {fmtTime(s.timeMs)}
                  </span>
                </div>
                <div className="stat-session-marks">
                  <span className="mark ok">
                    <Icon name="check" size={13} /> {s.correct}
                  </span>
                  <span className="mark bad">
                    <Icon name="close" size={13} /> {s.wrong}
                  </span>
                  <span className="mark pts">
                    <Icon name="coin" size={13} /> {s.points >= 0 ? `+${s.points}` : s.points}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
