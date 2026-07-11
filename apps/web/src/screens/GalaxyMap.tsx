import { useEffect, useState } from "react";
import { api, tx, type SkillNode } from "../api";
import { Orbi } from "../components/Orbi";

function planetClass(status: string | null, isCurrent: boolean): string {
  if (status === "mastered") return "planet done";
  if (isCurrent) return "planet current";
  if (status === "locked" || status == null) return "planet locked";
  return "planet available";
}

export function GalaxyMap({
  profileId,
  onPlay,
}: {
  profileId: string;
  onPlay: (skillId: string) => void;
}) {
  const [skills, setSkills] = useState<SkillNode[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    api.skills(profileId).then(setSkills).catch(() => setError(true));
  }, [profileId]);

  if (error) return <p className="screen-pad muted">No se pudo cargar la galaxia.</p>;
  if (!skills) return <p className="screen-pad muted">Cargando galaxia…</p>;

  const playableIdx = skills.findIndex((s) => s.status !== "mastered" && s.status !== "locked");

  return (
    <div className="galaxy-screen">
      <div className="screen-kicker">Galaxia</div>
      <h2 className="screen-title">Matemáticas · Fracciones</h2>

      <div className="nodes">
        {skills.map((s, i) => {
          const isCurrent = i === playableIdx;
          const cls = planetClass(s.status, isCurrent);
          const playable = s.status === "mastered" || (s.status !== "locked" && s.status != null) || isCurrent;
          const icon = s.status === "mastered" ? "✓" : cls.includes("locked") ? "🔒" : "🪐";
          return (
            <div className="node-item" key={s.id}>
              {i > 0 && <div className="connector" />}
              <div className="planet-holder">
                <button
                  className={cls}
                  disabled={!playable}
                  onClick={() => playable && onPlay(s.id)}
                  aria-label={tx(s.nameI18n)}
                >
                  {icon}
                </button>
                <div className="node-label">
                  <b>{tx(s.nameI18n)}</b>
                  {s.masteryScore != null && s.status !== "locked" && (
                    <span>{Math.round((s.masteryScore ?? 0) * 100)}%</span>
                  )}
                </div>
                {isCurrent && <Orbi className="node-orbi float" />}
              </div>
            </div>
          );
        })}
      </div>

      {playableIdx >= 0 && (
        <div className="galaxy-cta">
          <button className="btn-primary" onClick={() => onPlay(skills[playableIdx]!.id)}>
            ▶ Continuar misión
          </button>
        </div>
      )}
    </div>
  );
}
