import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Starfield } from "./components/Starfield";
import { Orbi } from "./components/Orbi";

type ApiState = "loading" | "ok" | "error";

export function App() {
  const { t } = useTranslation();
  const [api, setApi] = useState<ApiState>("loading");

  useEffect(() => {
    let alive = true;
    fetch("/api/health")
      .then((r) => {
        if (alive) setApi(r.ok ? "ok" : "error");
      })
      .catch(() => {
        if (alive) setApi("error");
      });
    return () => {
      alive = false;
    };
  }, []);

  const dotClass = api === "ok" ? "ok" : api === "error" ? "error" : "";
  const dotLabel = api === "loading" ? "…" : api === "ok" ? "online" : "offline";

  return (
    <>
      <Starfield />
      <main className="hero">
        <p className="eyebrow">smartkids</p>
        <h1 className="title">Órbita</h1>
        <p className="tagline">{t("tagline")}</p>
        <Orbi className="mascot float" />
        <button className="btn-primary" type="button">
          ▶ {t("start")}
        </button>
        <p className="api">
          {t("apiStatus")}: <span className={`dot ${dotClass}`} /> {dotLabel}
        </p>
      </main>
    </>
  );
}
