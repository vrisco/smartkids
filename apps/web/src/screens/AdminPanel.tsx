import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type Parent, type Tutor } from "../api";
import { Icon } from "../components/Icon";
import { SettingsToggle } from "../components/SettingsToggle";

export function AdminPanel({ parent, onLogout }: { parent: Parent; onLogout: () => void }) {
  const { t } = useTranslation();
  const [tutors, setTutors] = useState<Tutor[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [resetFor, setResetFor] = useState<Tutor | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  function load() {
    api.adminTutors().then(setTutors).catch(() => setTutors([]));
  }

  async function removeTutor(tutor: Tutor) {
    if (!window.confirm(t("admin.deleteConfirm", { email: tutor.email }))) return;
    setMsg(null);
    try {
      await api.deleteTutor(tutor.id);
      load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  useEffect(() => {
    load();
  }, []);

  return (
    <div className="app-shell">
      <header className="panel-top">
        <div>
          <div className="panel-kicker">{t("admin.role")}</div>
          <b>{parent.email}</b>
        </div>
        <div className="row-actions">
          <SettingsToggle />
          <button className="btn-ghost sm" type="button" onClick={onLogout}>
            {t("common.logout")}
          </button>
        </div>
      </header>
      <div className="app-body">
        <div className="panel-head">
          <h2 className="screen-title">{t("admin.tutors")}</h2>
          <button className="btn-primary sm" type="button" onClick={() => setShowCreate(true)}>
            <Icon name="plus" size={16} /> {t("admin.newTutor")}
          </button>
        </div>
        {msg && <div className="auth-error panel-msg">{msg}</div>}
        <div className="list">
          {(tutors ?? []).map((tutor) => (
            <div className="list-row" key={tutor.id}>
              <div className="list-main">
                <b>{tutor.email}</b>
                <span>{tutor.emailVerified ? t("admin.emailVerified") : t("admin.unverified")}</span>
              </div>
              <button className="btn-ghost sm" type="button" onClick={() => setResetFor(tutor)}>
                {t("admin.reset")}
              </button>
              <button className="btn-ghost sm danger" type="button" onClick={() => removeTutor(tutor)}>
                {t("admin.delete")}
              </button>
            </div>
          ))}
          {tutors && tutors.length === 0 && <p className="muted screen-pad">{t("admin.noTutors")}</p>}
        </div>
      </div>
      {showCreate && (
        <CreateTutor
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}
      {resetFor && <ResetTutor tutor={resetFor} onClose={() => setResetFor(null)} />}
    </div>
  );
}

function CreateTutor({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ email: string; devLink?: string } | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.createTutor(email);
      setSent({ email, devLink: r.devLink });
      setBusy(false);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t("admin.newTutor")}</h3>
        {sent ? (
          <>
            <div className="auth-info">{t("admin.inviteSent", { email: sent.email })}</div>
            {sent.devLink && <div className="auth-devlink">{sent.devLink}</div>}
            <div className="modal-actions">
              <button className="btn-primary" type="button" onClick={onCreated}>
                {t("common.done")}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted">{t("admin.inviteHint")}</p>
            <input className="field" type="email" placeholder={t("admin.tutorEmailPh")} value={email} onChange={(e) => setEmail(e.target.value)} />
            {error && <div className="auth-error">{error}</div>}
            <div className="modal-actions">
              <button className="btn-ghost" type="button" onClick={onClose}>
                {t("common.cancel")}
              </button>
              <button className="btn-primary" type="button" onClick={create} disabled={busy || !email.includes("@")}>
                {busy ? "…" : t("admin.createInvite")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ResetTutor({ tutor, onClose }: { tutor: Tutor; onClose: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ devLink?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.resetTutorPassword(tutor.id);
      setSent({ devLink: r.devLink });
      setBusy(false);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t("admin.resetTitle")}</h3>
        <p className="muted">{tutor.email}</p>
        {sent ? (
          <>
            <div className="auth-info">{t("admin.resetSent")}</div>
            {sent.devLink && <div className="auth-devlink">{sent.devLink}</div>}
            <div className="modal-actions">
              <button className="btn-primary" type="button" onClick={onClose}>
                {t("common.close")}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted">{t("admin.resetHint")}</p>
            {error && <div className="auth-error">{error}</div>}
            <div className="modal-actions">
              <button className="btn-ghost" type="button" onClick={onClose}>
                {t("common.cancel")}
              </button>
              <button className="btn-primary" type="button" onClick={send} disabled={busy}>
                {busy ? "…" : t("auth.sendLink")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
