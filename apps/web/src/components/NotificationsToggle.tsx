// Activar/desactivar notificaciones push. Pide permiso, se suscribe con la clave VAPID
// y guarda la suscripción en el servidor. En iOS requiere tener la app instalada.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { getPushSubscription, isIOS, isStandalone, pushSupported, subscribePush, unsubscribePush } from "../pwa";
import { Icon } from "./Icon";

export function NotificationsToggle() {
  const { t } = useTranslation();
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const supported = pushSupported();

  useEffect(() => {
    getPushSubscription()
      .then((s) => setOn(Boolean(s)))
      .catch(() => {});
  }, []);

  if (!supported) return null;
  const iosNeedsInstall = isIOS() && !isStandalone();

  async function toggle() {
    setBusy(true);
    setMsg(null);
    try {
      if (on) {
        const ep = await unsubscribePush();
        if (ep) await api.pushUnsubscribe(ep);
        setOn(false);
      } else {
        const { publicKey } = await api.pushKey();
        if (!publicKey) {
          setMsg(t("notif.unavailable"));
          return;
        }
        const sub = await subscribePush(publicKey);
        if (!sub) {
          setMsg(t("notif.denied"));
          return;
        }
        await api.pushSubscribe(sub.toJSON());
        setOn(true);
      }
    } catch {
      setMsg(t("notif.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="settings-row">
        <span>{t("notif.label")}</span>
        {iosNeedsInstall ? (
          <span className="muted small">{t("notif.iosInstall")}</span>
        ) : (
          <button className={"btn-ghost sm" + (on ? " danger" : "")} type="button" disabled={busy} onClick={toggle}>
            <Icon name={on ? "check" : "mail"} size={14} /> {on ? t("notif.on") : t("notif.enable")}
          </button>
        )}
      </div>
      {msg && <p className="muted small" style={{ textAlign: "right", margin: 0 }}>{msg}</p>}
    </>
  );
}
