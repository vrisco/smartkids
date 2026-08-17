import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError, type ChildMe, type Me } from "./api";
import { useScrollTop } from "./useScrollTop";
import { Starfield } from "./components/Starfield";
import { Auth } from "./components/Auth";
import { AdminPanel } from "./screens/AdminPanel";
import { TutorPanel } from "./screens/TutorPanel";
import { KidApp } from "./screens/KidApp";
import { VerifyPage, ResetPage } from "./screens/VerifyReset";

export function App() {
  const { t } = useTranslation();
  const path = window.location.pathname;
  const token = new URLSearchParams(window.location.search).get("token") ?? "";

  const [me, setMe] = useState<Me | null>(null);
  const [kid, setKid] = useState<ChildMe | null>(null);
  const [ready, setReady] = useState(false);
  const [offline, setOffline] = useState(false);

  const load = useCallback(async () => {
    setReady(false);
    setOffline(false);
    // 1) ¿Sesión de niño? Un fallo de RED no debe expulsar al login: la cookie sigue válida.
    try {
      const k = await api.childMe();
      setKid(k);
      setMe(null);
      setReady(true);
      return;
    } catch (e) {
      if (e instanceof ApiError && e.kind === "network") {
        setOffline(true);
        setReady(true);
        return;
      }
      /* 401: no hay sesión de niño → probamos tutor/admin */
    }
    // 2) ¿Sesión de tutor/admin?
    try {
      const m = await api.me();
      setMe(m);
      setKid(null);
    } catch (e) {
      if (e instanceof ApiError && e.kind === "network") {
        setOffline(true);
        setReady(true);
        return;
      }
      setMe(null);
      setKid(null);
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (path === "/verify" || path === "/reset") return;
    void load();
  }, [load, path]);

  // Reset de scroll al cambiar la pantalla de nivel superior (login/rol/estado).
  useScrollTop(`${ready ? "r" : "l"}|${kid?.child.id ?? ""}|${me?.parent.id ?? ""}|${path}`);

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
          <p className="tagline">{t("common.loading")}</p>
        </main>
      </>
    );

  if (offline)
    return (
      <>
        <Starfield />
        <main className="hero">
          <h1 className="title">Órbita</h1>
          <p className="tagline">{t("common.offline")}</p>
          <button className="btn-primary" type="button" onClick={() => void load()}>
            {t("common.retry")}
          </button>
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
