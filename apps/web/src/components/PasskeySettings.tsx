// Ajustes del tutor: registrar/quitar una passkey (Face ID / Touch ID / huella).
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { passkeySupported, registerPasskey } from "../passkeys";
import { Icon } from "./Icon";

export function PasskeySettings() {
  const { t } = useTranslation();
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const supported = passkeySupported();

  useEffect(() => {
    if (supported)
      api
        .passkeyList()
        .then((r) => setCount(r.count))
        .catch(() => setCount(0));
  }, [supported]);

  if (!supported) return null;

  async function add() {
    setBusy(true);
    setMsg(null);
    try {
      await registerPasskey();
      const r = await api.passkeyList();
      setCount(r.count);
    } catch {
      setMsg(t("auth.passkeyError"));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setMsg(null);
    try {
      await api.passkeyDelete();
      setCount(0);
    } catch {
      /* noop */
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="settings-row">
        <span>{t("auth.passkeyLabel")}</span>
        {count && count > 0 ? (
          <button className="btn-ghost sm danger" type="button" disabled={busy} onClick={remove}>
            <Icon name="close" size={14} /> {t("auth.passkeyRemove")}
          </button>
        ) : (
          <button className="btn-ghost sm" type="button" disabled={busy} onClick={add}>
            <Icon name="lock" size={14} /> {t("auth.passkeyAdd")}
          </button>
        )}
      </div>
      {msg && <p className="muted small" style={{ textAlign: "right", margin: 0 }}>{msg}</p>}
    </>
  );
}
