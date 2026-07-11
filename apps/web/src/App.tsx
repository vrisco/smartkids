import { useCallback, useEffect, useState } from "react";
import { api, type Child, type Me } from "./api";
import { Starfield } from "./components/Starfield";
import { Hud } from "./components/Hud";
import { Auth } from "./components/Auth";
import { FamilyHome } from "./screens/FamilyHome";
import { GalaxyMap } from "./screens/GalaxyMap";
import { Session } from "./screens/Session";
import { RewardShop } from "./screens/RewardShop";
import { ParentPanel } from "./screens/ParentPanel";

type View = "map" | "session" | "reward" | "parent";

export function App() {
  const [me, setMe] = useState<Me | null | "loading">("loading");
  const [child, setChild] = useState<Child | null>(null);
  const [balance, setBalance] = useState(0);
  const [view, setView] = useState<View>("map");
  const [skillId, setSkillId] = useState<string | null>(null);

  const loadMe = useCallback(() => api.me().then(setMe).catch(() => setMe(null)), []);
  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  const loadBalance = useCallback((id: string) => {
    api
      .profile(id)
      .then((p) => setBalance(p.balance))
      .catch(() => {});
  }, []);

  function enterChild(c: Child) {
    setChild(c);
    setView("map");
    loadBalance(c.id);
  }

  async function logout() {
    try {
      await api.logout();
    } catch {
      /* da igual */
    }
    setChild(null);
    setMe(null);
  }

  if (me === "loading") {
    return (
      <>
        <Starfield />
        <main className="hero">
          <h1 className="title">Órbita</h1>
          <p className="tagline">Cargando…</p>
        </main>
      </>
    );
  }

  if (me === null) {
    return (
      <>
        <Starfield />
        <Auth onDone={loadMe} />
      </>
    );
  }

  if (!child) {
    return (
      <>
        <Starfield />
        <div className="app-shell">
          <FamilyHome
            me={me}
            onPlay={enterChild}
            onParent={(c) => {
              setChild(c);
              setView("parent");
              loadBalance(c.id);
            }}
            onLogout={logout}
            onRefresh={loadMe}
          />
        </div>
      </>
    );
  }

  return (
    <>
      <Starfield />
      <div className="app-shell">
        {view !== "session" && (
          <Hud profile={child} balance={balance} onExit={() => setChild(null)} />
        )}
        <div className="app-body">
          {view === "map" && (
            <GalaxyMap
              profileId={child.id}
              onPlay={(s) => {
                setSkillId(s);
                setView("session");
              }}
            />
          )}
          {view === "session" && skillId && (
            <Session
              profileId={child.id}
              skillId={skillId}
              onBalance={setBalance}
              onExit={() => {
                setView("map");
                loadBalance(child.id);
              }}
            />
          )}
          {view === "reward" && (
            <RewardShop profileId={child.id} balance={balance} onBalance={setBalance} />
          )}
          {view === "parent" && <ParentPanel profileId={child.id} />}
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
