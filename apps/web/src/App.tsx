import { useCallback, useEffect, useState } from "react";
import { api, type ChildMe, type Me } from "./api";
import { Starfield } from "./components/Starfield";
import { Auth } from "./components/Auth";
import { AdminPanel } from "./screens/AdminPanel";
import { TutorPanel } from "./screens/TutorPanel";
import { KidApp } from "./screens/KidApp";
import { VerifyPage, ResetPage } from "./screens/VerifyReset";

export function App() {
  const path = window.location.pathname;
  const token = new URLSearchParams(window.location.search).get("token") ?? "";

  const [me, setMe] = useState<Me | null>(null);
  const [kid, setKid] = useState<ChildMe | null>(null);
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    setReady(false);
    try {
      const k = await api.childMe();
      setKid(k);
      setMe(null);
      setReady(true);
      return;
    } catch {
      /* no hay sesión de niño */
    }
    try {
      const m = await api.me();
      setMe(m);
      setKid(null);
    } catch {
      setMe(null);
      setKid(null);
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (path === "/verify" || path === "/reset") return;
    void load();
  }, [load, path]);

  if (path === "/verify")
    return (
      <>
        <Starfield />
        <VerifyPage token={token} />
      </>
    );
  if (path === "/reset")
    return (
      <>
        <Starfield />
        <ResetPage token={token} />
      </>
    );

  async function logoutParent() {
    try {
      await api.logout();
    } catch {
      /* da igual */
    }
    setMe(null);
  }
  async function logoutChild() {
    try {
      await api.childLogout();
    } catch {
      /* da igual */
    }
    setKid(null);
  }

  if (!ready)
    return (
      <>
        <Starfield />
        <main className="hero">
          <h1 className="title">Órbita</h1>
          <p className="tagline">Cargando…</p>
        </main>
      </>
    );

  if (kid)
    return (
      <>
        <Starfield />
        <KidApp data={kid} onLogout={logoutChild} />
      </>
    );
  if (me?.parent.role === "admin")
    return (
      <>
        <Starfield />
        <AdminPanel parent={me.parent} onLogout={logoutParent} />
      </>
    );
  if (me?.parent.role === "tutor")
    return (
      <>
        <Starfield />
        <TutorPanel me={me} onLogout={logoutParent} onRefresh={load} />
      </>
    );

  return (
    <>
      <Starfield />
      <Auth onTutor={load} onChild={load} />
    </>
  );
}
