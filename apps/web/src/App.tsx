import { useCallback, useEffect, useState } from "react";
import { api, type Profile } from "./api";
import { Starfield } from "./components/Starfield";
import { Hud } from "./components/Hud";
import { GalaxyMap } from "./screens/GalaxyMap";
import { Session } from "./screens/Session";
import { RewardShop } from "./screens/RewardShop";
import { ParentPanel } from "./screens/ParentPanel";

const PROFILE_ID = "kid_demo";
type View = "map" | "session" | "reward" | "parent";

export function App() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [balance, setBalance] = useState(0);
  const [view, setView] = useState<View>("map");
  const [skillId, setSkillId] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);

  const refreshProfile = useCallback(() => {
    api
      .profile(PROFILE_ID)
      .then((p) => {
        setProfile(p.profile);
        setBalance(p.balance);
        setOffline(false);
      })
      .catch(() => setOffline(true));
  }, []);

  useEffect(() => {
    refreshProfile();
  }, [refreshProfile]);

  function play(id: string) {
    setSkillId(id);
    setView("session");
  }

  function exitSession() {
    setView("map");
    refreshProfile();
  }

  if (offline || !profile) {
    return (
      <>
        <Starfield />
        <main className="hero">
          <p className="eyebrow">smartkids</p>
          <h1 className="title">Órbita</h1>
          <p className="tagline">{offline ? "Conectando con la nave nodriza…" : "Cargando…"}</p>
          {offline && (
            <p className="muted small">
              Arranca el backend con <code>pnpm dev</code>.
            </p>
          )}
        </main>
      </>
    );
  }

  return (
    <>
      <Starfield />
      <div className="app-shell">
        {view !== "session" && <Hud profile={profile} balance={balance} />}
        <div className="app-body">
          {view === "map" && <GalaxyMap profileId={PROFILE_ID} onPlay={play} />}
          {view === "session" && skillId && (
            <Session
              profileId={PROFILE_ID}
              skillId={skillId}
              onBalance={setBalance}
              onExit={exitSession}
            />
          )}
          {view === "reward" && (
            <RewardShop profileId={PROFILE_ID} balance={balance} onBalance={setBalance} />
          )}
          {view === "parent" && <ParentPanel profileId={PROFILE_ID} />}
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
            <button className={view === "parent" ? "on" : ""} onClick={() => setView("parent")}>
              <span className="ic">👪</span>
              <span>Familia</span>
            </button>
          </nav>
        )}
      </div>
    </>
  );
}
