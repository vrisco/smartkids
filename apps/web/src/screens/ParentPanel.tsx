import { useEffect, useState } from "react";
import { api, tx, type SkillNode } from "../api";

const BAR_COLORS = ["var(--green)", "var(--cyan)", "var(--violet)", "var(--gold)"];

export function ParentPanel({ profileId }: { profileId: string }) {
  const [skills, setSkills] = useState<SkillNode[] | null>(null);
  const [balance, setBalance] = useState(0);
  const [name, setName] = useState("Lucía");

  useEffect(() => {
    api.skills(profileId).then(setSkills).catch(() => setSkills([]));
    api
      .profile(profileId)
      .then((p) => {
        setBalance(p.balance);
        setName(p.profile.displayName);
      })
      .catch(() => {});
  }, [profileId]);

  const list = skills ?? [];
  const totalAttempts = list.reduce((a, s) => a + (s.totalAttempts ?? 0), 0);
  const mastered = list.filter((s) => s.status === "mastered").length;

  return (
    <div className="parent-screen">
      <div className="screen-kicker">Panel de familia</div>
      <h2 className="screen-title">El progreso de {name}</h2>

      <div className="p-grid">
        <div className="p-card">
          <div className="pk">Racha</div>
          <div className="pv">
            7 <small>días 🔥</small>
          </div>
        </div>
        <div className="p-card">
          <div className="pk">Polvo estelar</div>
          <div className="pv">
            {balance} <small>✦</small>
          </div>
        </div>
        <div className="p-card">
          <div className="pk">Ejercicios</div>
          <div className="pv">{totalAttempts}</div>
        </div>
        <div className="p-card">
          <div className="pk">Temas dominados</div>
          <div className="pv">
            {mastered}
            <small>/{list.length}</small>
          </div>
        </div>
      </div>

      <div className="p-card wide">
        <div className="pk">Dominio por tema</div>
        <div className="mastery">
          {list.map((s, i) => (
            <div className="mrow" key={s.id}>
              <span>{tx(s.nameI18n)}</span>
              <span className="mbar">
                <i
                  style={{
                    width: `${Math.round((s.masteryScore ?? 0) * 100)}%`,
                    background: BAR_COLORS[i % BAR_COLORS.length],
                  }}
                />
              </span>
              <span className="pct">{Math.round((s.masteryScore ?? 0) * 100)}%</span>
            </div>
          ))}
        </div>
      </div>

      <div className="p-card wide">
        <div className="pk">Vales pendientes</div>
        <div className="voucher-row">
          <span className="vic">⏱️</span>
          <div className="voucher-txt">
            <b>+30 min</b> · cuando lo canjee
          </div>
          <button className="btn-ghost sm">Aplicar</button>
        </div>
      </div>
    </div>
  );
}
