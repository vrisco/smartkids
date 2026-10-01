import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { GRADE_BANDS, isGradeBand } from "../grades";
import { api, tx, type Child, type ChildSummary, type ContentAsset, type ContentRequest, type Course, type ExerciseReport, type Me, type Mistake, type PrivateSkill, type ProfileStats, type Redemption, type TutorReward } from "../api";
import { Avatar, AVATAR_KEYS, avatarKeyOf } from "../components/Avatar";
import { ContentPreview } from "../components/ContentPreview";
import { WorksheetDialog } from "../components/Worksheet";
import { correctAnswerString } from "../components/ExerciseInput";
import { MathText } from "../components/MathText";
import { StatsView } from "../components/StatsView";
import { InstallCard } from "../components/InstallCard";
import { NotificationsToggle } from "../components/NotificationsToggle";
import { PasskeySettings } from "../components/PasskeySettings";
import { Icon, type IconName } from "../components/Icon";
import { SettingsToggle } from "../components/SettingsToggle";
import { setBadge } from "../pwa";

export function TutorPanel({ me, onLogout, onRefresh }: { me: Me; onLogout: () => void; onRefresh: () => void }) {
  const { t } = useTranslation();
  const [courses, setCourses] = useState<Course[]>([]);
  const [editing, setEditing] = useState<Child | null>(null);
  const [statsChild, setStatsChild] = useState<Child | null>(null);
  const [creating, setCreating] = useState(false);
  const [changingPw, setChangingPw] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);
  const [summary, setSummary] = useState<ChildSummary[] | null>(null);

  useEffect(() => {
    api.courses().then(setCourses).catch(() => {});
  }, []);

  const loadSummary = useCallback(() => {
    api.householdSummary().then(setSummary).catch(() => setSummary(null));
  }, []);
  useEffect(() => {
    loadSummary();
  }, [loadSummary, me.children.length]);

  const summaryById = new Map((summary ?? []).map((s) => [s.id, s]));
  const lastLabel = (iso: string | null) => {
    if (!iso) return t("tutor.neverActive");
    const d = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
    return d <= 0 ? t("tutor.today") : t("tutor.daysAgo", { count: d });
  };

  async function resendVerify() {
    try {
      const r = await api.resendVerification();
      setVerifyMsg(r.devLink ? t("tutor.verifyDevGenerated") : t("tutor.verifyResent"));
    } catch {
      setVerifyMsg(t("tutor.resendFail"));
    }
  }

  return (
    <div className="app-shell">
      <header className="panel-top">
        <button className="panel-id" type="button" onClick={() => setSettingsOpen(true)} aria-label={t("settings.title")}>
          <span className="panel-id-text">
            <span className="panel-kicker">{t("tutor.role")}</span>
            <b>{me.parent.email}</b>
          </span>
          <Icon name="chevronDown" size={14} />
        </button>
        <div className="row-actions">
          <button className="btn-ghost sm" type="button" onClick={onLogout}>
            {t("common.logout")}
          </button>
        </div>
      </header>
      <div className="app-body">
        {!me.parent.emailVerified && (
          <div className="verify-banner">
            <span>{t("tutor.verifyEmail")}</span>
            <button className="btn-ghost sm" type="button" onClick={resendVerify}>
              {t("tutor.resend")}
            </button>
          </div>
        )}
        {verifyMsg && <div className="auth-info panel-msg">{verifyMsg}</div>}

        <InstallCard />

        <PendingRedemptions />

        <ExerciseReports />

        <div className="panel-head">
          <h2 className="screen-title">{t("tutor.myKids")}</h2>
          <button className="btn-primary sm" type="button" onClick={() => setCreating(true)}>
            {t("common.new")}
          </button>
        </div>
        <div className="list">
          {me.children.map((ch) => {
            const s = summaryById.get(ch.id);
            const noCourses = s ? s.courseCount + s.customCount === 0 : false;
            return (
              <div className="list-row" key={ch.id}>
                <Avatar name={ch.avatar} size={38} />
                <div className="list-main">
                  <b>{ch.displayName}</b>
                  <span>
                    @{ch.username}
                    {isGradeBand(ch.gradeBand) ? ` · ${t(`grades.${ch.gradeBand}`)}` : ""}
                  </span>
                  {!isGradeBand(ch.gradeBand) && (
                    <span className="grade-unset">
                      <Icon name="book" size={12} /> {t("tutor.schoolYearUnset")}
                    </span>
                  )}
                  {s && (
                    <span className="muted" style={{ display: "inline-flex", gap: "0.7rem", alignItems: "center", flexWrap: "wrap", fontSize: "0.8rem", marginTop: "0.15rem" }}>
                      <span style={{ display: "inline-flex", gap: "0.25rem", alignItems: "center" }}>
                        <Icon name="coin" size={12} /> {s.balance}
                      </span>
                      <span style={{ display: "inline-flex", gap: "0.25rem", alignItems: "center" }}>
                        <Icon name="flame" size={12} /> {s.streak}
                      </span>
                      <span>{s.accuracyPct}%</span>
                      <span>{lastLabel(s.lastActivity)}</span>
                    </span>
                  )}
                  {noCourses && (
                    <span style={{ display: "inline-flex", gap: "0.3rem", alignItems: "center", fontSize: "0.78rem", color: "#c98a1e", marginTop: "0.15rem" }}>
                      <Icon name="satellite" size={12} /> {t("tutor.noCoursesAssigned")}
                    </span>
                  )}
                </div>
                <button className="btn-ghost sm" type="button" onClick={() => setStatsChild(ch)}>
                  {t("stats.progress")}
                </button>
                <button className="btn-ghost sm" type="button" onClick={() => setEditing(ch)}>
                  {t("common.edit")}
                </button>
              </div>
            );
          })}
          {me.children.length === 0 && <p className="muted screen-pad">{t("tutor.noKids")}</p>}
        </div>

        <SpouseSection me={me} onRefresh={onRefresh} />

        <RewardsSection me={me} />

        <ContentSection me={me} />
      </div>

      {creating && <ChildForm courses={courses} onClose={() => setCreating(false)} onDone={() => { setCreating(false); onRefresh(); }} />}
      {editing && <ChildForm child={editing} courses={courses} onClose={() => setEditing(null)} onDone={() => { setEditing(null); onRefresh(); }} />}
      {statsChild && <ChildStatsModal child={statsChild} onClose={() => { setStatsChild(null); loadSummary(); }} />}
      {changingPw && <ChangePassword onClose={() => setChangingPw(false)} />}
      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          onChangePassword={() => {
            setSettingsOpen(false);
            setChangingPw(true);
          }}
        />
      )}
    </div>
  );
}

function ChildStatsModal({ child, onClose }: { child: Child; onClose: () => void }) {
  const { t } = useTranslation();
  const [stats, setStats] = useState<ProfileStats | null>(null);
  const [error, setError] = useState(false);

  const loadStats = useCallback(() => {
    setError(false);
    api
      .tutorChildStats(child.id)
      .then(setStats)
      .catch(() => setError(true));
  }, [child.id]);
  useEffect(() => {
    loadStats();
  }, [loadStats]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal stats-modal" onClick={(e) => e.stopPropagation()}>
        <div className="preview-head">
          <div className="list-main">
            <b>{child.displayName}</b>
            <span className="muted">{t("stats.title")}</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t("common.close")}>
            <Icon name="close" size={16} />
          </button>
        </div>
        {error ? (
          <p className="muted screen-pad">{t("session.connError")}</p>
        ) : !stats ? (
          <p className="muted screen-pad">{t("content.previewLoading")}</p>
        ) : (
          <StatsView stats={stats} />
        )}
        <Mistakes childId={child.id} />
        <WalletAdjust childId={child.id} onDone={loadStats} />
        <div className="modal-actions" style={{ marginTop: "var(--sp-3)" }}>
          <a className="btn-ghost sm" href={api.exportChildUrl(child.id)} download>
            {t("stats.exportData")}
          </a>
        </div>
      </div>
    </div>
  );
}

// Revisión de errores: qué ha fallado el niño (su respuesta vs la correcta).
function Mistakes({ childId }: { childId: string }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<Mistake[] | null>(null);
  useEffect(() => {
    api.childMistakes(childId).then(setItems).catch(() => setItems([]));
  }, [childId]);
  if (!items || items.length === 0) return null; // sin errores registrados: no mostramos la sección
  const ans = (m: Mistake, a: Mistake["given"]) => (m.render && a ? correctAnswerString(m.render, a) : "—");
  return (
    <div className="stat-block">
      <div className="stat-block-title">{t("stats.mistakes")}</div>
      <div className="mistake-list">
        {items.map((m, i) => (
          <div className="mistake" key={i}>
            <div className="mistake-skill">{tx(m.skillName)}</div>
            <div className="mistake-stem">
              <MathText text={m.stem} />
            </div>
            <div className="mistake-answers">
              <span className="mistake-a wrong">
                <Icon name="close" size={12} /> <MathText text={ans(m, m.given)} />
              </span>
              <span className="mistake-a ok">
                <Icon name="check" size={12} /> <MathText text={ans(m, m.correctAnswer)} />
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// El tutor da o quita puntos del monedero del niño (premiar/corregir fuera de la app).
function WalletAdjust({ childId, onDone }: { childId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function apply(sign: 1 | -1) {
    const n = parseInt(amount, 10);
    if (!Number.isFinite(n) || n <= 0) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.adjustWallet(childId, sign * n, reason.trim());
      setAmount("");
      setReason("");
      setMsg(t("stats.walletDone", { balance: r.balance }));
      onDone();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stat-block">
      <div className="stat-block-title">{t("stats.adjustWallet")}</div>
      <div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap" }}>
        <input
          className="field"
          style={{ flex: "0 0 6rem" }}
          inputMode="numeric"
          placeholder={t("stats.amountPh")}
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/\D/g, "").slice(0, 6))}
        />
        <input
          className="field"
          style={{ flex: "1 1 8rem" }}
          placeholder={t("stats.reasonPh")}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <div className="row-actions" style={{ marginTop: "var(--sp-2)" }}>
        <button className="btn-ghost sm" type="button" disabled={busy || !amount} onClick={() => apply(-1)}>
          <Icon name="close" size={14} /> {t("stats.take")}
        </button>
        <button className="btn-primary sm" type="button" disabled={busy || !amount} onClick={() => apply(1)}>
          <Icon name="plus" size={14} /> {t("stats.give")}
        </button>
      </div>
      {msg && <div className="auth-info" style={{ marginTop: "var(--sp-2)" }}>{msg}</div>}
    </div>
  );
}

function SettingsPanel({ onClose, onChangePassword }: { onClose: () => void; onChangePassword: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t("settings.title")}</h3>
        <div className="settings-row">
          <span>{t("settings.appearance")}</span>
          <SettingsToggle />
        </div>
        <NotificationsToggle />
        <PasskeySettings />
        <button className="btn-ghost" type="button" onClick={onChangePassword}>
          {t("tutor.changeMyPw")}
        </button>
        <div className="app-version" style={{ textAlign: "center" }}>v{__APP_VERSION__}</div>
        <div className="modal-actions">
          <button className="btn-primary" type="button" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

function ChildForm({ child, courses, onClose, onDone }: { child?: Child; courses: Course[]; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const editing = Boolean(child);
  const [name, setName] = useState(child?.displayName ?? "");
  const [username, setUsername] = useState(child?.username ?? "");
  const [pin, setPin] = useState("");
  const [avatar, setAvatar] = useState<string>(avatarKeyOf(child?.avatar));
  const [birthYear, setBirthYear] = useState<string>(child?.birthYear != null ? String(child.birthYear) : "");
  // Curso escolar: lo usa la generación de contenido para adaptar temario y dificultad.
  const [grade, setGrade] = useState<string>(isGradeBand(child?.gradeBand) ? child!.gradeBand : "");
  const [consent, setConsent] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (child)
      api
        .childCourses(child.id)
        .then((cs) => setSel(cs.map((c) => c.id)))
        .catch(() => {});
  }, [child]);

  function toggle(id: string) {
    setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      let id = child?.id;
      const by = birthYear ? parseInt(birthYear, 10) : null;
      if (editing) {
        const patch: { displayName: string; avatar: string; username: string; pin?: string; birthYear?: number | null; gradeBand?: string } = { displayName: name, avatar, username };
        if (pin.length >= 4) patch.pin = pin;
        if (by) patch.birthYear = by;
        if (grade) patch.gradeBand = grade;
        await api.updateChild(child!.id, patch);
      } else {
        if (pin.length < 4) throw new Error(t("tutor.pinError"));
        const r = await api.createChild({ displayName: name, username, avatar, gradeBand: grade, pin, courseIds: sel, birthYear: by, consent });
        id = r.profile.id;
      }
      if (id) await api.setChildCourses(id, sel);
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function remove() {
    if (!child) return;
    if (!window.confirm(t("tutor.deleteKidConfirm", { name: child.displayName }))) return;
    setBusy(true);
    try {
      await api.deleteChild(child.id);
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{editing ? t("tutor.editKid") : t("tutor.newKid")}</h3>
        <input className="field" placeholder={t("tutor.namePh")} value={name} onChange={(e) => setName(e.target.value)} />
        <input
          className="field"
          placeholder={t("tutor.usernamePh")}
          value={username}
          onChange={(e) => setUsername(e.target.value.replace(/\s/g, "").toLowerCase())}
          autoCapitalize="none"
        />
        <input
          className="field"
          inputMode="numeric"
          maxLength={8}
          placeholder={editing ? t("tutor.newPinKeepPh") : t("tutor.pinPh")}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
        />
        <input
          className="field"
          inputMode="numeric"
          maxLength={4}
          placeholder={t("tutor.birthYearPh")}
          value={birthYear}
          onChange={(e) => setBirthYear(e.target.value.replace(/\D/g, "").slice(0, 4))}
        />
        <div className="course-label">{t("tutor.schoolYear")}</div>
        <select className="field" value={grade} onChange={(e) => setGrade(e.target.value)}>
          <option value="" disabled>
            {t("tutor.schoolYearPh")}
          </option>
          {GRADE_BANDS.map((g) => (
            <option key={g} value={g}>
              {t(`grades.${g}`)}
            </option>
          ))}
        </select>
        <div className="avatar-pick">
          {AVATAR_KEYS.map((k) => (
            <button key={k} type="button" className={"ava" + (k === avatar ? " on" : "")} onClick={() => setAvatar(k)}>
              <Avatar name={k} size={30} />
            </button>
          ))}
        </div>
        <div className="course-label">{t("tutor.coursesAccess")}</div>
        <div className="course-checks">
          {[...courses]
            .sort((a, b) => Number(b.gradeBand === grade) - Number(a.gradeBand === grade))
            .map((cr) => (
              <label className={"course-check" + (sel.includes(cr.id) ? " on" : "")} key={cr.id}>
                <input type="checkbox" checked={sel.includes(cr.id)} onChange={() => toggle(cr.id)} />
                {tx(cr.nameI18n)}
                {grade && cr.gradeBand === grade && <span className="course-tag">{t("tutor.ofSchoolYear")}</span>}
              </label>
            ))}
          {courses.length === 0 && <span className="muted">{t("tutor.noCourses")}</span>}
        </div>
        {!editing && (
          <label className="muted" style={{ display: "flex", gap: "var(--sp-2)", alignItems: "flex-start", margin: "var(--sp-2) 0", fontSize: "0.85rem", lineHeight: 1.4 }}>
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: "0.2rem", flexShrink: 0 }} />
            <span>{t("tutor.consentLabel")}</span>
          </label>
        )}
        {error && <div className="auth-error">{error}</div>}
        <div className="modal-actions">
          {editing && (
            <button className="btn-danger" type="button" onClick={remove} disabled={busy}>
              {t("common.delete")}
            </button>
          )}
          <button className="btn-ghost" type="button" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn-primary" type="button" onClick={save} disabled={busy || !name || username.length < 3 || (!editing && (!consent || !grade))}>
            {t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

function ChangePassword({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(cur, next);
      setDone(true);
      setBusy(false);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t("tutor.changePwTitle")}</h3>
        {done ? (
          <>
            <div className="auth-info">{t("tutor.pwChanged")}</div>
            <div className="modal-actions">
              <button className="btn-primary" type="button" onClick={onClose}>
                {t("common.close")}
              </button>
            </div>
          </>
        ) : (
          <>
            <input className="field" type="password" placeholder={t("tutor.currentPwPh")} value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
            <input className="field" type="password" placeholder={t("verify.newPwPh")} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
            {error && <div className="auth-error">{error}</div>}
            <div className="modal-actions">
              <button className="btn-ghost" type="button" onClick={onClose}>
                {t("common.cancel")}
              </button>
              <button className="btn-primary" type="button" onClick={save} disabled={busy || next.length < 6}>
                {t("common.save")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SpouseSection({ me, onRefresh }: { me: Me; onRefresh: () => void }) {
  const { t } = useTranslation();
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState(false);

  async function resendInvite() {
    setBusy(true);
    try {
      await api.resendSpouse();
      setResent(true);
    } catch {
      /* noop */
    }
    setBusy(false);
  }
  async function cancelInvite() {
    if (!window.confirm(t("tutor.cancelInviteConfirm"))) return;
    setBusy(true);
    try {
      await api.cancelSpouseInvite();
      onRefresh();
    } catch {
      setBusy(false);
    }
  }

  async function unlink() {
    if (!window.confirm(t("tutor.unlinkConfirm"))) return;
    try {
      await api.unlinkSpouse();
      onRefresh();
    } catch {
      /* noop */
    }
  }
  async function accept() {
    setBusy(true);
    try {
      await api.acceptSpouse();
      onRefresh();
    } catch {
      setBusy(false);
    }
  }
  async function reject() {
    setBusy(true);
    try {
      await api.rejectSpouse();
      onRefresh();
    } catch {
      setBusy(false);
    }
  }

  const canInvite = !me.spouse && !me.spouseInviteOut;

  return (
    <div className="panel-section">
      <div className="panel-head">
        <h2 className="screen-title">{t("tutor.spouse")}</h2>
        {canInvite && (
          <button className="btn-primary sm" type="button" onClick={() => setInviting(true)}>
            {t("tutor.link")}
          </button>
        )}
      </div>

      {me.spouseInviteIn && (
        <div className="verify-banner">
          <span>{t("tutor.spouseIncoming", { email: me.spouseInviteIn.fromEmail })}</span>
          <span className="row-actions">
            <button className="btn-primary sm" type="button" onClick={accept} disabled={busy}>
              {t("tutor.accept")}
            </button>
            <button className="btn-ghost sm" type="button" onClick={reject} disabled={busy}>
              {t("tutor.reject")}
            </button>
          </span>
        </div>
      )}

      {me.spouse ? (
        <div className="list">
          <div className="list-row">
            <div className="list-main">
              <b>{me.spouse.email}</b>
              <span>{me.spouse.emailVerified ? t("tutor.spouseActive") : t("tutor.spousePending")}</span>
            </div>
            <button className="btn-ghost sm danger" type="button" onClick={unlink}>
              {t("tutor.unlink")}
            </button>
          </div>
        </div>
      ) : me.spouseInviteOut ? (
        <div className="list">
          <div className="list-row">
            <div className="list-main">
              <b>{me.spouseInviteOut.toEmail}</b>
              <span>{t("tutor.spousePending")}</span>
            </div>
            <span className="row-actions">
              <button className="btn-ghost sm" type="button" onClick={resendInvite} disabled={busy}>
                {t("tutor.resendInvite")}
              </button>
              <button className="btn-ghost sm danger" type="button" onClick={cancelInvite} disabled={busy}>
                {t("tutor.cancelInvite")}
              </button>
            </span>
          </div>
          {resent && <p className="muted screen-pad">{t("tutor.inviteResent")}</p>}
        </div>
      ) : (
        <p className="muted screen-pad">{t("tutor.spouseHint")}</p>
      )}

      {inviting && <InviteSpouse onClose={() => setInviting(false)} onDone={() => { setInviting(false); onRefresh(); }} />}
    </div>
  );
}

function InviteSpouse({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ devLink?: string } | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.inviteSpouse(email);
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
        <h3>{t("tutor.inviteSpouseTitle")}</h3>
        {sent ? (
          <>
            <div className="auth-info">{t("tutor.spouseInviteSent")}</div>
            {sent.devLink && <div className="auth-devlink">{sent.devLink}</div>}
            <div className="modal-actions">
              <button className="btn-primary" type="button" onClick={onDone}>
                {t("common.done")}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted">{t("tutor.spouseEmailHint")}</p>
            <input className="field" type="email" placeholder={t("tutor.spouseEmailPh")} value={email} onChange={(e) => setEmail(e.target.value)} />
            {error && <div className="auth-error">{error}</div>}
            <div className="modal-actions">
              <button className="btn-ghost" type="button" onClick={onClose}>
                {t("common.cancel")}
              </button>
              <button className="btn-primary" type="button" onClick={send} disabled={busy || !email.includes("@")}>
                {busy ? "…" : t("tutor.sendInvite")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const REWARD_ICONS: IconName[] = ["gift", "clock", "star", "medal", "rocket", "book", "planet", "target"];

function RewardsSection({ me }: { me: Me }) {
  const { t } = useTranslation();
  const [rewards, setRewards] = useState<TutorReward[] | null>(null);
  const [editing, setEditing] = useState<TutorReward | null>(null);
  const [creating, setCreating] = useState(false);

  function load() {
    api.tutorRewards().then(setRewards).catch(() => setRewards([]));
  }
  useEffect(() => {
    load();
  }, []);

  async function remove(r: TutorReward) {
    if (!window.confirm(t("rewards.deleteConfirm"))) return;
    try {
      await api.deleteReward(r.id);
      load();
    } catch {
      /* noop */
    }
  }

  return (
    <div className="panel-section">
      <div className="panel-head">
        <h2 className="screen-title">{t("rewards.section")}</h2>
        {me.children.length > 0 && (
          <button className="btn-primary sm" type="button" onClick={() => setCreating(true)}>
            {t("common.new")}
          </button>
        )}
      </div>
      {me.children.length === 0 ? (
        <p className="muted screen-pad">{t("rewards.noKids")}</p>
      ) : (
        <div className="list">
          {(rewards ?? []).map((r) => (
            <div className="list-row" key={r.id}>
              <div className="shop-ic sm">
                <Icon name={(r.icon as IconName) || (r.kind === "goal" ? "target" : "gift")} size={20} />
              </div>
              <div className="list-main">
                <b>{tx(r.nameI18n)}</b>
                <span>
                  {r.kind === "goal" ? t("rewards.kindGoal") : t("rewards.kindSpend")} · {r.cost}
                </span>
              </div>
              <button className="btn-ghost sm" type="button" onClick={() => setEditing(r)}>
                {t("common.edit")}
              </button>
              <button className="btn-ghost sm danger" type="button" onClick={() => remove(r)}>
                {t("common.delete")}
              </button>
            </div>
          ))}
          {rewards && rewards.length === 0 && <p className="muted screen-pad">{t("rewards.none")}</p>}
        </div>
      )}
      {(creating || editing) && (
        <RewardForm
          reward={editing ?? undefined}
          kids={me.children}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onDone={() => {
            setCreating(false);
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

type LimitMode = "none" | "once" | "week" | "month";

function RewardForm({ reward, kids, onClose, onDone }: { reward?: TutorReward; kids: Child[]; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const editing = Boolean(reward);
  const [name, setName] = useState(reward ? tx(reward.nameI18n) : "");
  const [kind, setKind] = useState(reward?.kind ?? "spend");
  const [cost, setCost] = useState(String(reward?.cost ?? ""));
  const [period, setPeriod] = useState(reward?.period ?? "month");
  const [limitMode, setLimitMode] = useState<LimitMode>(
    reward
      ? reward.limitCount == null
        ? "none"
        : reward.limitCount === 1 && reward.limitPeriod === "all"
          ? "once"
          : reward.limitPeriod === "week"
            ? "week"
            : "month"
      : "none",
  );
  const [count, setCount] = useState(String(reward?.limitCount ?? 1));
  const [icon, setIcon] = useState<string>(reward?.icon ?? "gift");
  const [sel, setSel] = useState<string[]>(reward?.childIds ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string) {
    setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const limit =
        limitMode === "none"
          ? { limitCount: null, limitPeriod: "all" }
          : limitMode === "once"
            ? { limitCount: 1, limitPeriod: "all" }
            : { limitCount: Math.max(1, parseInt(count) || 1), limitPeriod: limitMode };
      const data = {
        name: name.trim(),
        cost: parseInt(cost) || 0,
        icon,
        childIds: sel,
        kind,
        period: kind === "goal" ? period : undefined,
        ...limit,
      };
      if (editing) await api.updateReward(reward!.id, data);
      else await api.createReward(data);
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{editing ? t("rewards.editTitle") : t("rewards.newTitle")}</h3>
        <input className="field" placeholder={t("rewards.namePh")} value={name} onChange={(e) => setName(e.target.value)} />

        <div className="course-label">{t("rewards.kind")}</div>
        <div className="seg">
          <button type="button" className={kind === "spend" ? "on" : ""} onClick={() => setKind("spend")}>
            {t("rewards.kindSpend")}
          </button>
          <button type="button" className={kind === "goal" ? "on" : ""} onClick={() => setKind("goal")}>
            {t("rewards.kindGoal")}
          </button>
        </div>
        <p className="reward-hint">{kind === "goal" ? t("rewards.kindGoalHint") : t("rewards.kindSpendHint")}</p>

        <input
          className="field"
          inputMode="numeric"
          placeholder={kind === "goal" ? t("rewards.target") : t("rewards.cost")}
          value={cost}
          onChange={(e) => setCost(e.target.value.replace(/\D/g, ""))}
        />

        {kind === "goal" && (
          <div className="seg wrap">
            {(["week", "month", "quarter", "semester", "year"] as const).map((p) => (
              <button key={p} type="button" className={period === p ? "on" : ""} onClick={() => setPeriod(p)}>
                {t(`rewards.period_${p}`)}
              </button>
            ))}
          </div>
        )}

        <div className="course-label">{t("rewards.limit")}</div>
        <div className="seg wrap">
          {(["none", "once", "week", "month"] as LimitMode[]).map((m) => (
            <button key={m} type="button" className={limitMode === m ? "on" : ""} onClick={() => setLimitMode(m)}>
              {m === "none" ? t("rewards.limitNone") : m === "once" ? t("rewards.limitOnce") : m === "week" ? t("rewards.limitPerWeek") : t("rewards.limitPerMonth")}
            </button>
          ))}
        </div>
        {(limitMode === "week" || limitMode === "month") && (
          <input className="field" inputMode="numeric" placeholder={t("rewards.count")} value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, ""))} />
        )}

        <div className="course-label">{t("rewards.icon")}</div>
        <div className="avatar-pick">
          {REWARD_ICONS.map((ic) => (
            <button key={ic} type="button" className={"ava" + (ic === icon ? " on" : "")} onClick={() => setIcon(ic)}>
              <Icon name={ic} size={22} />
            </button>
          ))}
        </div>

        <div className="course-label">{t("rewards.forChildren")}</div>
        <div className="course-checks">
          {kids.map((ch) => (
            <label className={"course-check" + (sel.includes(ch.id) ? " on" : "")} key={ch.id}>
              <input type="checkbox" checked={sel.includes(ch.id)} onChange={() => toggle(ch.id)} />
              {ch.displayName}
            </label>
          ))}
        </div>

        {error && <div className="auth-error">{error}</div>}
        <div className="modal-actions">
          <button className="btn-ghost" type="button" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn-primary" type="button" onClick={save} disabled={busy || !name.trim() || !(parseInt(cost) > 0)}>
            {t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

function PendingRedemptions() {
  const { t } = useTranslation();
  const [items, setItems] = useState<Redemption[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  function load() {
    api
      .tutorRedemptions()
      .then((r) => {
        setItems(r);
        setBadge(r.length); // nº de canjes pendientes en el icono de la app
      })
      .catch(() => setItems([]));
  }
  useEffect(() => {
    load();
  }, []);

  async function act(id: string, grant: boolean) {
    setBusy(id);
    try {
      await (grant ? api.grantRedemption(id) : api.rejectRedemption(id));
      load();
    } catch {
      /* noop */
    } finally {
      setBusy(null);
    }
  }

  if (!items || items.length === 0) return null;
  return (
    <div className="panel-section">
      <div className="panel-head">
        <h2 className="screen-title">{t("rewards.pending")}</h2>
      </div>
      <div className="list">
        {items.map((r) => (
          <div className="list-row" key={r.id}>
            <div className="list-main">
              <b>{tx(r.rewardName)}</b>
              <span>
                {r.childName} · {r.cost}
              </span>
            </div>
            <button className="btn-primary sm" type="button" disabled={busy === r.id} onClick={() => act(r.id, true)}>
              {t("rewards.grant")}
            </button>
            <button className="btn-ghost sm danger" type="button" disabled={busy === r.id} onClick={() => act(r.id, false)}>
              {t("rewards.reject")}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// Preguntas que los niños han marcado como erróneas: el tutor ve su respuesta y la esperada, y decide
// si ocultar la pregunta (solo contenido propio) o descartar el aviso porque estaba bien.
function ExerciseReports() {
  const { t } = useTranslation();
  const [items, setItems] = useState<ExerciseReport[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .tutorReports()
      .then(setItems)
      .catch(() => setItems([]));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function act(r: ExerciseReport, action: "hide" | "dismiss") {
    setBusy(r.profileId + r.templateId);
    try {
      await api.resolveReport(r.templateId, r.profileId, action);
      load();
    } catch {
      /* noop */
    } finally {
      setBusy(null);
    }
  }

  if (!items || items.length === 0) return null;
  const ans = (r: ExerciseReport, a: ExerciseReport["given"]) => (r.render && a ? correctAnswerString(r.render, a) : "—");
  return (
    <div className="panel-section">
      <div className="panel-head">
        <h2 className="screen-title">{t("reports.title")}</h2>
      </div>
      <p className="muted report-intro">{t("reports.intro")}</p>
      <div className="mistake-list">
        {items.map((r) => {
          const k = r.profileId + r.templateId;
          return (
            <div className="mistake" key={k}>
              <div className="mistake-skill">
                {r.childName} · {tx(r.skillName)}
              </div>
              <div className="report-reason">
                <Icon name="flag" size={12} /> {t(`reports.reason_${r.reason}`)}
              </div>
              <div className="mistake-stem">
                <MathText text={r.stem} />
              </div>
              <div className="mistake-answers">
                {r.given && (
                  <span className={`mistake-a ${r.wasCorrect ? "ok" : "wrong"}`}>
                    {t("reports.childAnswer")}: <MathText text={ans(r, r.given)} />
                  </span>
                )}
                <span className="mistake-a ok">
                  <Icon name="check" size={12} /> <MathText text={ans(r, r.correctAnswer)} />
                </span>
              </div>
              {r.solution && (
                <div className="report-solution">
                  <MathText text={r.solution} />
                </div>
              )}
              {!r.canHide && <p className="muted report-note">{t("reports.globalNote")}</p>}
              <div className="row-actions report-actions">
                {r.canHide && (
                  <button className="btn-primary sm" type="button" disabled={busy === k} onClick={() => act(r, "hide")}>
                    <Icon name="eyeOff" size={14} /> {t("reports.hide")}
                  </button>
                )}
                <button className="btn-ghost sm" type="button" disabled={busy === k} onClick={() => act(r, "dismiss")}>
                  {t("reports.dismiss")}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ContentSection({ me }: { me: Me }) {
  const { t } = useTranslation();
  const [reqs, setReqs] = useState<ContentRequest[] | null>(null);
  const [content, setContent] = useState<PrivateSkill[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState<ContentRequest | null>(null);
  const [regenerating, setRegenerating] = useState<ContentRequest | null>(null);
  const [preview, setPreview] = useState<PrivateSkill | null>(null);
  const [worksheet, setWorksheet] = useState<PrivateSkill | null>(null);
  const [showOld, setShowOld] = useState(false);
  const contentRef = useRef<PrivateSkill[]>([]);

  function load() {
    api.contentRequests().then(setReqs).catch(() => setReqs([]));
    api
      .tutorContent()
      .then((c) => {
        contentRef.current = c;
        setContent(c);
      })
      .catch(() => {
        contentRef.current = [];
        setContent([]);
      });
  }
  useEffect(() => {
    load();
  }, []);

  // Estado optimista con ref: evita la carrera de toggles rápidos (assignSkill REEMPLAZA todo el conjunto,
  // así que cada toque debe partir del conjunto MÁS RECIENTE, no del snapshot del render).
  function assign(skillId: string, childId: string, on: boolean) {
    const cur = contentRef.current.find((s) => s.id === skillId)?.childIds ?? [];
    const ids = on ? [...new Set([...cur, childId])] : cur.filter((x) => x !== childId);
    const next = contentRef.current.map((s) => (s.id === skillId ? { ...s, childIds: ids } : s));
    contentRef.current = next;
    setContent(next);
    api.assignSkill(skillId, ids).catch(() => load());
  }

  function setMissionLength(skillId: string, sessionLength: number) {
    const next = contentRef.current.map((s) => (s.id === skillId ? { ...s, sessionLength } : s));
    contentRef.current = next;
    setContent(next);
    api.setSkillSessionLength(skillId, sessionLength).catch(() => load());
  }

  async function delRequest(id: string) {
    if (!window.confirm(t("content.deleteRequestConfirm"))) return;
    try {
      await api.deleteContentRequest(id);
      load();
    } catch {
      /* noop */
    }
  }

  async function delContent(id: string) {
    if (!window.confirm(t("content.deleteContentConfirm"))) return;
    try {
      await api.deleteContentSkill(id);
      load();
    } catch {
      /* noop */
    }
  }

  // Solicitud de la que sale un contenido, si se puede regenerar (ya procesada, no pendiente).
  const regenerableOf = (requestId?: string | null) => {
    const r = requestId ? (reqs ?? []).find((x) => x.id === requestId) : undefined;
    return r && (r.status === "published" || r.status === "failed") ? r : undefined;
  };

  return (
    <div className="panel-section">
      <div className="panel-head">
        <h2 className="screen-title">{t("content.section")}</h2>
        {me.children.length > 0 && (
          <button className="btn-primary sm" type="button" onClick={() => setUploading(true)}>
            {t("content.upload")}
          </button>
        )}
      </div>
      {me.children.length === 0 ? (
        <p className="muted screen-pad">{t("content.noKids")}</p>
      ) : (
        <>
          <p className="muted screen-pad" style={{ textAlign: "center" }}>{t("content.hint")}</p>
          {(() => {
            const active = (reqs ?? []).filter((r) => r.status !== "published");
            const old = (reqs ?? []).filter((r) => r.status === "published");
            return (
              <>
                {active.length > 0 && (
                  <div className="list">
                    {active.map((r) => (
                      <div className="list-row" key={r.id}>
                        <div className="shop-ic sm">
                          <Icon name="book" size={20} />
                        </div>
                        <div className="list-main">
                          <b>{r.title || t("content.untitled")}</b>
                          <span>
                            {t(`content.status_${r.status}`)}
                            {r.exerciseCount ? ` · ${r.exerciseCount}` : r.assets && r.assets.length ? ` · ${r.assets.length}` : ""}
                          </span>
                        </div>
                        {r.status === "uploaded" && (
                          <button className="btn-ghost sm" type="button" onClick={() => setEditing(r)}>
                            {t("common.edit")}
                          </button>
                        )}
                        {r.status === "failed" && (
                          <button className="btn-ghost sm" type="button" onClick={() => setRegenerating(r)}>
                            {t("content.regenerate")}
                          </button>
                        )}
                        <button className="btn-ghost sm danger" type="button" onClick={() => delRequest(r.id)}>
                          {t("common.delete")}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {old.length > 0 && (
                  <div className="archived">
                    <button className="archived-toggle" type="button" onClick={() => setShowOld((v) => !v)}>
                      <Icon name={showOld ? "chevronDown" : "chevronRight"} size={16} />
                      {t("content.archived", { count: old.length })}
                    </button>
                    {showOld && (
                      <div className="list">
                        {old.map((r) => (
                          <div className="list-row" key={r.id}>
                            <div className="shop-ic sm">
                              <Icon name="book" size={20} />
                            </div>
                            <div className="list-main">
                              <b>{r.title || t("content.untitled")}</b>
                              <span>
                                {t(`content.status_${r.status}`)}
                                {r.exerciseCount ? ` · ${r.exerciseCount}` : ""}
                              </span>
                            </div>
                            <button className="btn-ghost sm" type="button" onClick={() => setRegenerating(r)}>
                              {t("content.regenerate")}
                            </button>
                            <button className="btn-ghost sm danger" type="button" onClick={() => delRequest(r.id)}>
                              {t("common.delete")}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            );
          })()}
          {(content ?? []).length > 0 && (
            <div className="list">
              {(content ?? []).map((s) => {
                const regen = regenerableOf(s.requestId);
                return (
                  <div className="list-row col" key={s.id}>
                    <div className="content-row-head">
                      <div className="list-main">
                        <b>{tx(s.nameI18n)}</b>
                        <span>
                          {s.exercises} {t("content.exercises")} · {t("content.perMission", { count: s.sessionLength })}
                        </span>
                      </div>
                      <button className="btn-ghost sm" type="button" onClick={() => setPreview(s)}>
                        {t("content.preview")}
                      </button>
                      <button className="btn-ghost sm" type="button" onClick={() => setWorksheet(s)} disabled={s.exercises === 0}>
                        {t("worksheet.button")}
                      </button>
                      {regen && (
                        <button className="btn-ghost sm" type="button" onClick={() => setRegenerating(regen)}>
                          {t("content.regenerate")}
                        </button>
                      )}
                      <button className="btn-ghost sm danger" type="button" onClick={() => delContent(s.id)}>
                        {t("common.delete")}
                      </button>
                    </div>
                    <div className="course-checks">
                      {me.children.map((ch) => (
                        <label className={"course-check" + (s.childIds.includes(ch.id) ? " on" : "")} key={ch.id}>
                          <input type="checkbox" checked={s.childIds.includes(ch.id)} onChange={(e) => assign(s.id, ch.id, e.target.checked)} />
                          {ch.displayName}
                        </label>
                      ))}
                    </div>
                    <label className="mission-len">
                      <span>{t("content.sessionLength")}</span>
                      <select className="field" value={s.sessionLength} onChange={(e) => setMissionLength(s.id, Number(e.target.value))}>
                        {withValue(SESSION_LENGTHS, s.sessionLength).map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
      {(uploading || editing || regenerating) && (
        <UploadContent
          kids={me.children}
          request={editing ?? regenerating ?? undefined}
          mode={regenerating ? "regenerate" : editing ? "edit" : "create"}
          onClose={() => {
            setUploading(false);
            setEditing(null);
            setRegenerating(null);
          }}
          onDone={() => {
            setUploading(false);
            setEditing(null);
            setRegenerating(null);
            load();
          }}
        />
      )}
      {preview && <ContentPreview skillId={preview.id} title={tx(preview.nameI18n)} onClose={() => setPreview(null)} />}
      {worksheet && (
        <WorksheetDialog
          skillId={worksheet.id}
          title={tx(worksheet.nameI18n)}
          level={isGradeBand(worksheet.gradeBand) ? t(`grades.${worksheet.gradeBand}`) : undefined}
          onClose={() => setWorksheet(null)}
        />
      )}
    </div>
  );
}

/* ---------- Formulario de solicitud de contenido (crear / editar / regenerar) ---------- */

const QUESTION_COUNTS = [10, 20, 30, 50, 75, 100, 150, 200];
const SESSION_LENGTHS = [5, 10, 15, 20, 25, 30];
const GENERATION_EXTRA = 1.5; // igual que la API: se genera un 50 % más de lo pedido para variar cada tanda
const QUESTION_TYPES = ["multiple_choice", "multiple_select", "true_false", "fill_in_blank", "numeric", "ordering", "matching", "step_problem"] as const;
type QuestionType = (typeof QUESTION_TYPES)[number];
/** Tipos sugeridos por materia: lo que mejor evalúa cada una sin corrección manual. */
const TYPE_PRESETS: Record<string, QuestionType[]> = {
  math: ["numeric", "multiple_choice", "fill_in_blank", "true_false", "step_problem", "ordering"],
  language: ["multiple_choice", "multiple_select", "fill_in_blank", "true_false", "ordering", "matching"],
  foreign: ["fill_in_blank", "matching", "multiple_choice", "ordering", "true_false"],
  science: ["multiple_choice", "multiple_select", "true_false", "matching", "ordering", "fill_in_blank", "numeric"],
  social: ["multiple_choice", "multiple_select", "true_false", "ordering", "matching", "fill_in_blank"],
  all: [...QUESTION_TYPES],
};

/** Opciones de un select + el valor actual si no está entre ellas (datos antiguos), ordenadas. */
function withValue(opts: number[], v: number | null | undefined): number[] {
  return v != null && !opts.includes(v) ? [...opts, v].sort((a, b) => a - b) : opts;
}

function UploadContent({
  kids,
  request,
  mode,
  onClose,
  onDone,
}: {
  kids: Child[];
  request?: ContentRequest;
  mode: "create" | "edit" | "regenerate";
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(request?.title ?? "");
  const [instructions, setInstructions] = useState(request?.instructions ?? "");
  const [childId, setChildId] = useState(request?.childId ?? kids[0]?.id ?? "");
  const gradeOf = (id: string) => {
    const g = kids.find((k) => k.id === id)?.gradeBand;
    return isGradeBand(g) ? g : "";
  };
  // Nivel del contenido: por defecto el curso escolar del niño; si el tutor lo cambia a mano, se respeta.
  const [level, setLevel] = useState<string>(isGradeBand(request?.gradeBand) ? request!.gradeBand! : gradeOf(childId));
  const [levelTouched, setLevelTouched] = useState(Boolean(request?.gradeBand));
  const [files, setFiles] = useState<FileList | null>(null);
  const [assets, setAssets] = useState<ContentAsset[]>(request?.assets ?? []);
  const [numQuestions, setNumQuestions] = useState(request?.numQuestions ?? 20);
  const [sessionLength, setSessionLength] = useState(request?.sessionLength ?? 10);
  const [points, setPoints] = useState(String(request?.pointsPerCorrect ?? 10));
  const [modules, setModules] = useState(String(request?.modules ?? 1));
  const [types, setTypes] = useState<string[]>(request?.questionTypes ?? []);
  const [regenMode, setRegenMode] = useState<"replace" | "copy">("replace");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasNewFiles = Boolean(files && files.length > 0);
  const canSave = Boolean(title.trim() || instructions.trim() || hasNewFiles || assets.length > 0);

  function toggleType(ty: string, on: boolean) {
    setTypes((cur) => (on ? QUESTION_TYPES.filter((x) => x === ty || cur.includes(x)) : cur.filter((x) => x !== ty)));
  }

  async function removeAsset(assetId: string) {
    if (!request) return;
    try {
      await api.deleteRequestAsset(request.id, assetId);
      setAssets((a) => a.filter((x) => x.id !== assetId));
    } catch {
      /* noop */
    }
  }

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("title", title.trim());
      form.set("instructions", instructions.trim());
      if (childId) form.set("childId", childId);
      form.set("gradeBand", level); // vacío = el curso escolar del niño (lo resuelve la API)
      form.set("numQuestions", String(numQuestions));
      form.set("sessionLength", String(sessionLength));
      form.set("pointsPerCorrect", points);
      form.set("modules", modules);
      form.set("questionTypes", types.join(",")); // vacío = variados
      if (files) for (const f of Array.from(files)) form.append("files", f);
      if (mode === "regenerate" && request) {
        form.set("mode", regenMode);
        await api.regenerateContentRequest(request.id, form);
      } else if (mode === "edit" && request) await api.updateContentRequest(request.id, form);
      else await api.createContentRequest(form);
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const heading = mode === "regenerate" ? t("content.regenerateTitle") : mode === "edit" ? t("content.editTitle") : t("content.uploadTitle");

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal upload-modal" onClick={(e) => e.stopPropagation()}>
        <h3>{heading}</h3>
        <p className="muted">{mode === "regenerate" ? t("content.regenerateHint") : t("content.uploadHint")}</p>

        {mode === "regenerate" && (
          <>
            <div className="course-label">{t("content.regenMode")}</div>
            <div className="course-checks">
              {(["replace", "copy"] as const).map((m) => (
                <label className={"course-check option-card" + (regenMode === m ? " on" : "")} key={m}>
                  <input type="radio" name="regenMode" checked={regenMode === m} onChange={() => setRegenMode(m)} />
                  <span className="option-text">
                    <b>{m === "replace" ? t("content.regenReplace") : t("content.regenCopy")}</b>
                    <span>{m === "replace" ? t("content.regenReplaceHint") : t("content.regenCopyHint")}</span>
                  </span>
                </label>
              ))}
            </div>
          </>
        )}

        <input className="field" placeholder={t("content.titlePh")} value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea className="field" rows={5} placeholder={t("content.instructionsPh")} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        <div className="course-label">{t("content.forChild")}</div>
        <select
          className="field"
          value={childId}
          onChange={(e) => {
            setChildId(e.target.value);
            if (!levelTouched) setLevel(gradeOf(e.target.value));
          }}
        >
          {kids.map((ch) => (
            <option key={ch.id} value={ch.id}>
              {ch.displayName}
            </option>
          ))}
        </select>
        <div className="course-label">{t("content.level")}</div>
        <select
          className="field"
          value={level}
          onChange={(e) => {
            setLevel(e.target.value);
            setLevelTouched(true);
          }}
        >
          <option value="">{t("content.levelUnset")}</option>
          {GRADE_BANDS.map((g) => (
            <option key={g} value={g}>
              {t(`grades.${g}`)}
            </option>
          ))}
        </select>
        <p className="reward-hint">{t("content.levelHint")}</p>

        <div className="form-grid-2">
          <label className="form-cell">
            <span className="course-label">{t("content.numQuestions")}</span>
            <select className="field" value={numQuestions} onChange={(e) => setNumQuestions(Number(e.target.value))}>
              {withValue(QUESTION_COUNTS, numQuestions).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="form-cell">
            <span className="course-label">{t("content.sessionLength")}</span>
            <select className="field" value={sessionLength} onChange={(e) => setSessionLength(Number(e.target.value))}>
              {withValue(SESSION_LENGTHS, sessionLength).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="form-cell">
            <span className="course-label">{t("content.pointsPerCorrect")}</span>
            <select className="field" value={points} onChange={(e) => setPoints(e.target.value)}>
              <option value="5">5</option>
              <option value="10">10</option>
              <option value="20">20</option>
            </select>
          </label>
          <label className="form-cell">
            <span className="course-label">{t("content.structure")}</span>
            <select className="field" value={modules} onChange={(e) => setModules(e.target.value)}>
              <option value="1">{t("content.single")}</option>
              {[2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={String(n)}>
                  {t("content.pathN", { count: n })}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="reward-hint">{t("content.numQuestionsHint", { count: Math.ceil(numQuestions * GENERATION_EXTRA) })}</p>

        <div className="course-label">{t("content.questionTypes")}</div>
        <div className="type-presets">
          <span className="reward-hint">{t("content.suggestFor")}</span>
          <div className="seg wrap">
            {Object.keys(TYPE_PRESETS).map((k) => (
              <button type="button" key={k} onClick={() => setTypes([...TYPE_PRESETS[k]!])}>
                {t(`content.subj_${k}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="type-checks">
          {QUESTION_TYPES.map((ty) => {
            const on = types.includes(ty);
            return (
              <label className={"course-check option-card" + (on ? " on" : "")} key={ty}>
                <input type="checkbox" checked={on} onChange={(e) => toggleType(ty, e.target.checked)} />
                <span className="option-text">
                  <b>{t(`content.qt_${ty}`)}</b>
                  <span>{t(`content.qtd_${ty}`)}</span>
                </span>
              </label>
            );
          })}
        </div>
        <p className="reward-hint">{t("content.questionTypesHint")}</p>

        {assets.length > 0 && (
          <>
            {mode === "regenerate" && <div className="course-label">{t("content.keptFiles")}</div>}
            <div className="asset-list">
              {assets.map((as) => (
                <div className="asset-row" key={as.id}>
                  <span className="asset-name">{as.filename}</span>
                  {/* Al regenerar, el material ya subido se reutiliza tal cual: no se quita desde aquí. */}
                  {mode === "edit" && (
                    <button className="asset-x" type="button" onClick={() => removeAsset(as.id)} aria-label={t("common.delete")}>
                      <Icon name="close" size={12} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
        <div className="course-label">{mode === "create" ? t("content.filesOptional") : t("content.addFiles")}</div>
        <input className="field" type="file" multiple accept="image/*,application/pdf,text/plain,.md" onChange={(e) => setFiles(e.target.files)} />
        {error && <div className="auth-error">{error}</div>}
        <div className="modal-actions">
          <button className="btn-ghost" type="button" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn-primary" type="button" onClick={save} disabled={busy || !canSave}>
            {busy ? "…" : mode === "regenerate" ? t("content.regenerate") : mode === "edit" ? t("common.save") : t("content.send")}
          </button>
        </div>
      </div>
    </div>
  );
}
