import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, tx, type ChildMe, type Course, type CustomContent, type ProfileStats, type ScopeProgress } from "../api";
import { Hud } from "../components/Hud";
import { Icon } from "../components/Icon";
import { ProgressLine, ReviewButton } from "../components/KidProgress";
import { Mascot, MascotContext, MascotPick, mascotKeyOf, rememberMascot, type MascotKey } from "../components/Mascot";
import { StatsView } from "../components/StatsView";
import { useScrollTop } from "../useScrollTop";
import { GalaxyMap } from "./GalaxyMap";
import { Session } from "./Session";
import { RewardShop } from "./RewardShop";

type Tab = "home" | "stats" | "shop";
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
  const noContent = data.courses.length === 0 && !hasCustom;

  const [tab, setTab] = useState<Tab>("home");
  // Sub-navegación DENTRO de "Inicio": curso abierto (galaxia), ficha/módulo o path abiertos.
  const [course, setCourse] = useState<Course | null>(
    data.courses.length === 1 && !hasCustom ? data.courses[0]! : null,
  );
  const [openPath, setOpenPath] = useState<PathGroup | null>(null);
  const [customSkill, setCustomSkill] = useState<CustomContent | null>(null);
  const [sessionSkillId, setSessionSkillId] = useState<string | null>(null); // sesión de un skill de curso (galaxia)
  // "Repasar fallos": ejercicios concretos (los pendientes que más falla) de un curso, ficha o path.
  const [reviewIds, setReviewIds] = useState<string[] | null>(null);
  const [reviewBusy, setReviewBusy] = useState<string | null>(null); // ámbito cuyo repaso se está preparando
  const [reviewError, setReviewError] = useState(false);
  // Cómo va en cada curso / ficha / path (null = aún cargando). Se recarga al volver de cada misión.
  const [progress, setProgress] = useState<Record<string, ScopeProgress> | null>(null);
  const [balance, setBalance] = useState(data.balance);
  const [mascot, setMascot] = useState<MascotKey>(mascotKeyOf(data.child.mascot));
  // El login muestra el último compañero usado en este dispositivo.
  useEffect(() => rememberMascot(mascot), [mascot]);

  const loadProgress = useCallback(() => {
    api
      .childProgress()
      .then((r) => setProgress(r.scopes))
      .catch(() => setProgress((cur) => cur ?? {}));
  }, []);
  useEffect(() => {
    loadProgress();
  }, [loadProgress]);

  async function startReview(scope: string) {
    setReviewBusy(scope);
    setReviewError(false);
    try {
      const r = await api.childReview(scope);
      if (r.ids.length > 0) setReviewIds(r.ids);
      else loadProgress(); // ya no quedaba nada pendiente: refresca los botones
    } catch {
      setReviewError(true);
    }
    setReviewBusy(null);
  }

  const inSession = customSkill !== null || sessionSkillId !== null || reviewIds !== null;
  useScrollTop(`${tab}|${course?.id ?? ""}|${openPath?.pathId ?? ""}|${customSkill?.skillId ?? ""}|${sessionSkillId ?? ""}|${reviewIds ? "repaso" : ""}`);

  // Misión a pantalla completa, sin HUD ni barra: ficha/módulo, skill de la galaxia o repaso de fallos.
  if (inSession) {
    const exit = () => {
      setCustomSkill(null);
      setSessionSkillId(null);
      setReviewIds(null);
      loadProgress();
    };
    return (
      <MascotContext.Provider value={mascot}>
        <div className="app-shell">
          <div className="app-body">
            {reviewIds ? (
              <Session profileId={data.child.id} reviewIds={reviewIds} onBalance={setBalance} onExit={exit} />
            ) : (
              <Session profileId={data.child.id} skillId={customSkill?.skillId ?? sessionSkillId ?? ""} onBalance={setBalance} onExit={exit} />
            )}
          </div>
        </div>
      </MascotContext.Provider>
    );
  }

  const ready = progress !== null;
  const prog = (scope: string) => progress?.[scope];
  const review = (scope: string) => (
    <ReviewButton pending={prog(scope)?.pending ?? 0} busy={reviewBusy === scope} onClick={() => void startReview(scope)} />
  );

  return (
    <MascotContext.Provider value={mascot}>
      <div className="app-shell">
        <Hud profile={data.child} balance={balance} streak={data.streak} onExit={onLogout} />
        <div className="app-body">
          {reviewError && tab === "home" && <div className="auth-error kid-review-error">{t("kid.reviewError")}</div>}
          {tab === "shop" ? (
            <RewardShop profileId={data.child.id} balance={balance} onBalance={setBalance} />
          ) : tab === "stats" ? (
            <KidStats mascot={mascot} onMascot={setMascot} />
          ) : /* tab === "home" */ course ? (
            <GalaxyMap
              profileId={data.child.id}
              courseId={course.id}
              courseName={tx(course.nameI18n)}
              onPlay={(s) => setSessionSkillId(s)}
              onBack={data.courses.length > 1 || hasCustom ? () => setCourse(null) : undefined}
              progress={<ProgressLine p={prog(`course:${course.id}`)} ready={ready} />}
              review={review(`course:${course.id}`)}
            />
          ) : openPath ? (
            <>
              <button className="btn-ghost sm" type="button" onClick={() => setOpenPath(null)} style={{ alignSelf: "flex-start", marginTop: "0.8rem" }}>
                <Icon name="back" size={14} /> {t("common.back")}
              </button>
              <h2 className="screen-title">{tx(openPath.pathName)}</h2>
              <div className="galaxy-progress">
                <ProgressLine p={prog(`path:${openPath.pathId}`)} ready={ready} total={openPath.modules.reduce((n, m) => n + m.exercises, 0)} />
              </div>
              <div className="course-grid">
                <div className="course-item">{review(`path:${openPath.pathId}`)}</div>
                {openPath.modules.map((m, i) => (
                  <button className="course-card custom" key={m.skillId} type="button" onClick={() => setCustomSkill(m)}>
                    <span className="course-emoji">
                      <Icon name="star" size={22} />
                    </span>
                    <span className="course-text">
                      <b>
                        {t("kid.module")} {(m.moduleIndex ?? i) + 1}
                      </b>
                      <ProgressLine p={prog(`skill:${m.skillId}`)} ready={ready} total={m.exercises} />
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : noContent ? (
            <div className="screen-pad">
              <h2 className="screen-title">
                {t("kid.noCoursesTitle")} <Icon name="satellite" size={20} />
              </h2>
              <p className="muted">{t("kid.noCoursesBody")}</p>
            </div>
          ) : (
            <>
              {data.courses.length > 0 && (
                <>
                  <div className="screen-kicker" style={{ paddingTop: "1.2rem" }}>
                    {t("kid.yourCourses")}
                  </div>
                  <h2 className="screen-title">{t("kid.whatStudy")}</h2>
                  <div className="course-grid">
                    {data.courses.map((cr) => (
                      <div className="course-item" key={cr.id}>
                        <button className="course-card" type="button" onClick={() => setCourse(cr)}>
                          <span className="course-emoji">
                            <Icon name="book" size={22} />
                          </span>
                          <span className="course-text">
                            <b>{tx(cr.nameI18n)}</b>
                            <ProgressLine p={prog(`course:${cr.id}`)} ready={ready} />
                          </span>
                        </button>
                        {review(`course:${cr.id}`)}
                      </div>
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
                      <div className="course-item" key={cc.skillId}>
                        <button className="course-card custom" type="button" onClick={() => setCustomSkill(cc)}>
                          <span className="course-emoji">
                            <Icon name="star" size={22} />
                          </span>
                          <span className="course-text">
                            <b>{tx(cc.nameI18n)}</b>
                            <ProgressLine p={prog(`skill:${cc.skillId}`)} ready={ready} total={cc.exercises} />
                          </span>
                        </button>
                        {review(`skill:${cc.skillId}`)}
                      </div>
                    ))}
                    {paths.map((p) => (
                      <div className="course-item" key={p.pathId}>
                        <button className="course-card custom" type="button" onClick={() => setOpenPath(p)}>
                          <span className="course-emoji">
                            <Icon name="satellite" size={22} />
                          </span>
                          <span className="course-text">
                            <b>{tx(p.pathName)}</b>
                            <span className="course-sub">
                              {p.modules.length} {t("kid.modules")}
                            </span>
                            <ProgressLine p={prog(`path:${p.pathId}`)} ready={ready} total={p.modules.reduce((n, m) => n + m.exercises, 0)} />
                          </span>
                        </button>
                        {review(`path:${p.pathId}`)}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>

        <nav className="bottom-nav">
          <button className={tab === "home" ? "on" : ""} onClick={() => setTab("home")}>
            <span className="ic">
              <Icon name="planet" size={22} />
            </span>
            <span>{t("kid.home")}</span>
          </button>
          <button className={tab === "stats" ? "on" : ""} onClick={() => setTab("stats")}>
            <span className="ic">
              <Icon name="target" size={22} />
            </span>
            <span>{t("kid.stats")}</span>
          </button>
          <button className={tab === "shop" ? "on" : ""} onClick={() => setTab("shop")}>
            <span className="ic">
              <Icon name="coin" size={22} />
            </span>
            <span>{t("kid.shop")}</span>
          </button>
        </nav>
      </div>
    </MascotContext.Provider>
  );
}

// Pestaña "Mis puntos": el niño ve sus propias estadísticas y elige su compañero de viaje.
function KidStats({ mascot, onMascot }: { mascot: MascotKey; onMascot: (key: MascotKey) => void }) {
  const { t } = useTranslation();
  const [stats, setStats] = useState<ProfileStats | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    api
      .childStats()
      .then(setStats)
      .catch(() => setError(true));
  }, []);

  return (
    <>
      <MascotCard mascot={mascot} onMascot={onMascot} />
      <h2 className="screen-title" style={{ paddingTop: "1rem" }}>
        {t("stats.myPoints")}
      </h2>
      {error ? (
        <p className="muted screen-pad">{t("session.connError")}</p>
      ) : !stats ? (
        <p className="muted screen-pad">{t("content.previewLoading")}</p>
      ) : (
        <StatsView stats={stats} />
      )}
    </>
  );
}

// Compañero de viaje: se ve en la galaxia y en las misiones. Cambio optimista; si falla, vuelve al anterior.
function MascotCard({ mascot, onMascot }: { mascot: MascotKey; onMascot: (key: MascotKey) => void }) {
  const { t } = useTranslation();
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function choose(key: MascotKey) {
    if (key === mascot) {
      setPicking(false);
      return;
    }
    const prev = mascot;
    onMascot(key);
    setBusy(true);
    setError(false);
    try {
      await api.setMascot(key);
      setPicking(false);
    } catch {
      onMascot(prev);
      setError(true);
    }
    setBusy(false);
  }

  return (
    <>
      <div className="mascot-card">
        <Mascot className="mascot-card-art float" />
        <div className="mascot-card-text">
          <span className="screen-kicker">{t("mascot.title")}</span>
          <b>{t(`mascot.names.${mascot}`)}</b>
        </div>
        <button className="btn-ghost sm" type="button" onClick={() => setPicking(true)}>
          {t("mascot.change")}
        </button>
      </div>
      {picking && (
        <div className="modal-backdrop" onClick={() => !busy && setPicking(false)}>
          <div className="modal mascot-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t("mascot.pickTitle")}</h3>
            <MascotPick value={mascot} onChange={(k) => void choose(k)} disabled={busy} />
            {error && <div className="auth-error">{t("mascot.saveError")}</div>}
            <div className="modal-actions">
              <button className="btn-ghost sm" type="button" disabled={busy} onClick={() => setPicking(false)}>
                {t("common.close")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
