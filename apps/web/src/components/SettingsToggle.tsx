import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";
import { getLang, getTheme, setLang, setTheme, type Theme } from "../settings";

const ORDER: Theme[] = ["system", "light", "dark"];

/** Conmutador compacto de tema (sistema → claro → oscuro) e idioma (ES/EN). */
export function SettingsToggle({ className }: { className?: string }) {
  const { t } = useTranslation();
  const [theme, setTh] = useState<Theme>(getTheme());
  const [lang, setLg] = useState(getLang());

  function cycleTheme() {
    const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]!;
    setTheme(next);
    setTh(next);
  }
  function toggleLang() {
    const next = lang === "es" ? "en" : "es";
    setLang(next);
    setLg(next);
  }

  const themeIcon = theme === "light" ? "sun" : theme === "dark" ? "moon" : "globe";
  return (
    <div className={"settings-toggle" + (className ? " " + className : "")}>
      <button type="button" className="st-btn" onClick={cycleTheme} title={t("settings.theme")} aria-label={t("settings.theme")}>
        <Icon name={themeIcon} size={18} />
      </button>
      <button type="button" className="st-btn st-lang" onClick={toggleLang} title={t("settings.language")} aria-label={t("settings.language")}>
        {lang.toUpperCase()}
      </button>
    </div>
  );
}
