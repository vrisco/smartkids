import { useState } from "react";
import { useTranslation } from "react-i18next";
import { tx, type ChildMe, type Course, type CustomContent } from "../api";
import { Hud } from "../components/Hud";
import { Icon } from "../components/Icon";
import { GalaxyMap } from "./GalaxyMap";
import { Session } from "./Session";
import { RewardShop } from "./RewardShop";

type View = "map" | "session" | "reward";
type PathGroup = { pathId: string; pathName: CustomContent["pathName"]; modules: CustomContent[] };

export function KidApp({ data, onLogout }: { data: ChildMe; onLogout: () => void }) {
  const { t } = useTranslation();
  const custom = data.customContent ?? [];
  const singles = custom.filter((c) => !c.pathId);
  const paths: PathGroup[] = [];
  {
    const byPath = new Map<string, CustomContent[]>();
    for (const c of custom) {
      if (!c.pathId) continue;
      const arr = byPath.get(c.pathId) ?? [];
      arr.push(c);
      byPath.set(c.pathId, arr);
    }
    for (const [pid, mods] of byPath) {
      mods.sort((a, b) => (a.moduleIndex ?? 0) - (b.moduleIndex ?? 0));
      paths.push({ pathId: pid, pathName: mods[0]?.pathName ?? null, modules: mods });
    }
  }
  const hasCustom = custom.length > 0;

  const [course, setCourse] = useState<Course | null>(
    data.courses.length === 1 && !hasCustom ? data.courses[0]! : null,
  );
  const [openPath, setOpenPath] = useState<PathGroup | null>(null);
  const [customSkill, setCustomSkill] = useState<CustomContent | null>(null);
  const [view, setView] = useState<View>("map");
  const [skillId, setSkillId] = useState<string | null>(null);
  const [balance, setBalance] = useState(data.balance);

  // Ficha o módulo: se juega directamente, sin galaxia intermedia.
  if (customSkill) {
    return (
      <div className="app-shell">
        <div className="app-body">
          <Session profileId={data.child.id} skillId={customSkill.skillId} onBalance={setBalance} onExit={() => setCustomSkill(null)} />
        </div>
      </div>
    );
  }

  // Módulos de un path.
  if (openPath) {
    return (
      <div className="app-shell">
        <Hud profile={data.child} balance={balance} onExit={onLogout} />
        <div className="app-body">
          <button className="btn-ghost sm" type="button" onClick={() => setOpenPath(null)} style={{ alignSelf: "flex-start", marginTop: "0.8rem" }}>
            <Icon name="back" size={14} /> {t("common.back")}
          </button>
          <h2 className="screen-title">{tx(openPath.pathName)}</h2>
          <div className="course-grid">
            {openPath.modules.map((m, i) => (
              <button className="course-card custom" key={m.skillId} type="button" onClick={() => setCustomSkill(m)}>
                <span className="course-emoji">
                  <Icon name="star" size={22} />
                </span>
                <span className="course-text">
                  <b>
                    {t("kid.module")} {i + 1}
                  </b>
                  <span className="course-sub">
                    {m.exercises} {t("content.exercises")}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (data.courses.length === 0 && !hasCustom) {
    return (
      <div className="app-shell">
        <Hud profile={data.child} balance={balance} onExit={onLogout} />
        <div className="screen-pad">
          <h2 className="screen-title">
            {t("kid.noCoursesTitle")} <Icon name="satellite" size={20} />
          </h2>
          <p className="muted">{t("kid.noCoursesBody")}</p>
        </div>
      </div>
    );
  }

  // Inicio: cursos + fichas/paths (contenido a medida) como tarjetas independientes.
  if (!course) {
    return (
      <div className="app-shell">
        <Hud profile={data.child} balance={balance} onExit={onLogout} />
        <div className="app-body">
          {data.courses.length > 0 && (
            <>
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
                    <span className="course-emoji">
                      <Icon name="book" size={22} />
                    </span>
                    <b>{tx(cr.nameI18n)}</b>
                  </button>
                ))}
              </div>
            </>
          )}
          {hasCustom && (
            <>
              <div className="screen-kicker" style={{ paddingTop: "1.4rem" }}>
                {t("kid.worksheets")}
              </div>
              <div className="course-grid">
                {singles.map((cc) => (
                  <button className="course-card custom" key={cc.skillId} type="button" onClick={() => setCustomSkill(cc)}>
                    <span className="course-emoji">
                      <Icon name="star" size={22} />
                    </span>
                    <span className="course-text">
                      <b>{tx(cc.nameI18n)}</b>
                      <span className="course-sub">
                        {cc.exercises} {t("content.exercises")}
                      </span>
                    </span>
                  </button>
                ))}
                {paths.map((p) => (
                  <button className="course-card custom" key={p.pathId} type="button" onClick={() => setOpenPath(p)}>
                    <span className="course-emoji">
                      <Icon name="satellite" size={22} />
                    </span>
                    <span className="course-text">
                      <b>{tx(p.pathName)}</b>
                      <span className="course-sub">
                        {p.modules.length} {t("kid.modules")}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
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
            onBack={data.courses.length > 1 || hasCustom ? () => setCourse(null) : undefined}
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
            <span className="ic">
              <Icon name="planet" size={22} />
            </span>
            <span>{t("kid.galaxy")}</span>
          </button>
          <button className={view === "reward" ? "on" : ""} onClick={() => setView("reward")}>
            <span className="ic">
              <Icon name="coin" size={22} />
            </span>
            <span>{t("kid.shop")}</span>
          </button>
        </nav>
      )}
    </div>
  );
}
