import { useState } from "react";
import { tx, type ChildMe, type Course } from "../api";
import { Hud } from "../components/Hud";
import { GalaxyMap } from "./GalaxyMap";
import { Session } from "./Session";
import { RewardShop } from "./RewardShop";

type View = "map" | "session" | "reward";

export function KidApp({ data, onLogout }: { data: ChildMe; onLogout: () => void }) {
  const [course, setCourse] = useState<Course | null>(data.courses.length === 1 ? data.courses[0]! : null);
  const [view, setView] = useState<View>("map");
  const [skillId, setSkillId] = useState<string | null>(null);
  const [balance, setBalance] = useState(data.balance);

  if (data.courses.length === 0) {
    return (
      <div className="app-shell">
        <Hud profile={data.child} balance={balance} onExit={onLogout} />
        <div className="screen-pad">
          <h2 className="screen-title">Sin cursos todavía 🛰️</h2>
          <p className="muted">Tu tutor aún no te ha asignado ningún curso. ¡Vuelve pronto!</p>
        </div>
      </div>
    );
  }

  if (!course) {
    return (
      <div className="app-shell">
        <Hud profile={data.child} balance={balance} onExit={onLogout} />
        <div className="app-body">
          <div className="screen-kicker" style={{ paddingTop: "1.2rem" }}>
            Tus cursos
          </div>
          <h2 className="screen-title">¿Qué quieres estudiar?</h2>
          <div className="course-grid">
            {data.courses.map((cr) => (
              <button
                className="course-card"
                key={cr.id}
                type="button"
                onClick={() => {
                  setCourse(cr);
                  setView("map");
                }}
              >
                <span className="course-emoji">📚</span>
                <b>{tx(cr.nameI18n)}</b>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {view !== "session" && <Hud profile={data.child} balance={balance} onExit={onLogout} />}
      <div className="app-body">
        {view === "map" && (
          <GalaxyMap
            profileId={data.child.id}
            courseId={course.id}
            courseName={tx(course.nameI18n)}
            onPlay={(s) => {
              setSkillId(s);
              setView("session");
            }}
            onBack={data.courses.length > 1 ? () => setCourse(null) : undefined}
          />
        )}
        {view === "session" && skillId && (
          <Session profileId={data.child.id} skillId={skillId} onBalance={setBalance} onExit={() => setView("map")} />
        )}
        {view === "reward" && <RewardShop profileId={data.child.id} balance={balance} onBalance={setBalance} />}
      </div>
      {view !== "session" && (
        <nav className="bottom-nav">
          <button className={view === "map" ? "on" : ""} onClick={() => setView("map")}>
            <span className="ic">🪐</span>
            <span>Galaxia</span>
          </button>
          <button className={view === "reward" ? "on" : ""} onClick={() => setView("reward")}>
            <span className="ic">✦</span>
            <span>Tienda</span>
          </button>
        </nav>
      )}
    </div>
  );
}
