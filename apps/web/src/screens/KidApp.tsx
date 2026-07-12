import { useState } from "react";
import { useTranslation } from "react-i18next";
import { tx, type ChildMe, type Course } from "../api";
import { Hud } from "../components/Hud";
import { Icon } from "../components/Icon";
import { GalaxyMap } from "./GalaxyMap";
import { Session } from "./Session";
import { RewardShop } from "./RewardShop";

type View = "map" | "session" | "reward";

export function KidApp({ data, onLogout }: { data: ChildMe; onLogout: () => void }) {
  const { t } = useTranslation();
  const [course, setCourse] = useState<Course | null>(data.courses.length === 1 ? data.courses[0]! : null);
  const [view, setView] = useState<View>("map");
  const [skillId, setSkillId] = useState<string | null>(null);
  const [balance, setBalance] = useState(data.balance);

  if (data.courses.length === 0) {
    return (
      <div className="app-shell">
        <Hud profile={data.child} balance={balance} onExit={onLogout} />
        <div className="screen-pad">
          <h2 className="screen-title">{t("kid.noCoursesTitle")} <Icon name="satellite" size={20} /></h2>
          <p className="muted">{t("kid.noCoursesBody")}</p>
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
            {t("kid.yourCourses")}
          </div>
          <h2 className="screen-title">{t("kid.whatStudy")}</h2>
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
                <span className="course-emoji"><Icon name="book" size={22} /></span>
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
            <span className="ic"><Icon name="planet" size={22} /></span>
            <span>{t("kid.galaxy")}</span>
          </button>
          <button className={view === "reward" ? "on" : ""} onClick={() => setView("reward")}>
            <span className="ic"><Icon name="coin" size={22} /></span>
            <span>{t("kid.shop")}</span>
          </button>
        </nav>
      )}
    </div>
  );
}
