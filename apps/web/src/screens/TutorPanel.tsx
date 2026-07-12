import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, tx, type Child, type Course, type Me, type Redemption, type TutorReward } from "../api";
import { Avatar, AVATAR_KEYS, avatarKeyOf } from "../components/Avatar";
import { Icon, type IconName } from "../components/Icon";
import { SettingsToggle } from "../components/SettingsToggle";

export function TutorPanel({ me, onLogout, onRefresh }: { me: Me; onLogout: () => void; onRefresh: () => void }) {
  const { t } = useTranslation();
  const [courses, setCourses] = useState<Course[]>([]);
  const [editing, setEditing] = useState<Child | null>(null);
  const [creating, setCreating] = useState(false);
  const [changingPw, setChangingPw] = useState(false);
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);

  useEffect(() => {
    api.courses().then(setCourses).catch(() => {});
  }, []);

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
        <div>
          <div className="panel-kicker">{t("tutor.role")}</div>
          <b>{me.parent.email}</b>
        </div>
        <div className="row-actions">
          <SettingsToggle />
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

        <PendingRedemptions />

        <div className="panel-head">
          <h2 className="screen-title">{t("tutor.myKids")}</h2>
          <button className="btn-primary sm" type="button" onClick={() => setCreating(true)}>
            {t("common.new")}
          </button>
        </div>
        <div className="list">
          {me.children.map((ch) => (
            <div className="list-row" key={ch.id}>
              <Avatar name={ch.avatar} size={38} />
              <div className="list-main">
                <b>{ch.displayName}</b>
                <span>@{ch.username}</span>
              </div>
              <button className="btn-ghost sm" type="button" onClick={() => setEditing(ch)}>
                {t("common.edit")}
              </button>
            </div>
          ))}
          {me.children.length === 0 && <p className="muted screen-pad">{t("tutor.noKids")}</p>}
        </div>

        <SpouseSection me={me} onRefresh={onRefresh} />

        <RewardsSection me={me} />

        <button className="btn-ghost panel-pw" type="button" onClick={() => setChangingPw(true)}>
          {t("tutor.changeMyPw")}
        </button>
      </div>

      {creating && <ChildForm courses={courses} onClose={() => setCreating(false)} onDone={() => { setCreating(false); onRefresh(); }} />}
      {editing && <ChildForm child={editing} courses={courses} onClose={() => setEditing(null)} onDone={() => { setEditing(null); onRefresh(); }} />}
      {changingPw && <ChangePassword onClose={() => setChangingPw(false)} />}
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
      if (editing) {
        const patch: { displayName: string; avatar: string; username: string; pin?: string } = { displayName: name, avatar, username };
        if (pin.length >= 4) patch.pin = pin;
        await api.updateChild(child!.id, patch);
      } else {
        if (pin.length < 4) throw new Error(t("tutor.pinError"));
        const r = await api.createChild({ displayName: name, username, avatar, gradeBand: "ESO-5", pin, courseIds: sel });
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
        <div className="avatar-pick">
          {AVATAR_KEYS.map((k) => (
            <button key={k} type="button" className={"ava" + (k === avatar ? " on" : "")} onClick={() => setAvatar(k)}>
              <Avatar name={k} size={30} />
            </button>
          ))}
        </div>
        <div className="course-label">{t("tutor.coursesAccess")}</div>
        <div className="course-checks">
          {courses.map((cr) => (
            <label className={"course-check" + (sel.includes(cr.id) ? " on" : "")} key={cr.id}>
              <input type="checkbox" checked={sel.includes(cr.id)} onChange={() => toggle(cr.id)} />
              {tx(cr.nameI18n)}
            </label>
          ))}
          {courses.length === 0 && <span className="muted">{t("tutor.noCourses")}</span>}
        </div>
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
          <button className="btn-primary" type="button" onClick={save} disabled={busy || !name || username.length < 3}>
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
        <p className="muted screen-pad">{t("tutor.spouseOutPending", { email: me.spouseInviteOut.toEmail })}</p>
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
          <div className="seg">
            <button type="button" className={period === "week" ? "on" : ""} onClick={() => setPeriod("week")}>
              {t("rewards.periodWeek")}
            </button>
            <button type="button" className={period === "month" ? "on" : ""} onClick={() => setPeriod("month")}>
              {t("rewards.periodMonth")}
            </button>
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
    api.tutorRedemptions().then(setItems).catch(() => setItems([]));
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
