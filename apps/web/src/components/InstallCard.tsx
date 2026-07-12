// Tarjeta para instalar la PWA. En Android usa el prompt nativo (beforeinstallprompt);
// en iOS (que no lo tiene) muestra el instructivo de "Compartir → Añadir a pantalla de inicio".
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { isIOS, isStandalone, onInstallAvailable, promptInstall } from "../pwa";
import { Icon } from "./Icon";

const DISMISS_KEY = "sk_install_dismissed";

export function InstallCard() {
  const { t } = useTranslation();
  const [canInstall, setCanInstall] = useState(false);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === "1");

  useEffect(() => onInstallAvailable(setCanInstall), []);

  if (isStandalone() || dismissed) return null;
  const ios = isIOS();
  if (!canInstall && !ios) return null; // navegador sin soporte de instalación

  function close() {
    localStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  }

  return (
    <div className="install-card">
      <span className="install-ic">
        <Icon name="rocket" size={20} />
      </span>
      <div className="install-text">
        <b>{t("install.title")}</b>
        <span>{ios ? t("install.iosHint") : t("install.androidHint")}</span>
      </div>
      {!ios && canInstall && (
        <button className="btn-primary sm" type="button" onClick={() => void promptInstall()}>
          {t("install.button")}
        </button>
      )}
      <button className="install-x" type="button" onClick={close} aria-label={t("common.close")}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
