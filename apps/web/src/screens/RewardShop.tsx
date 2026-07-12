import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api, tx, type Reward } from "../api";
import { Icon, type IconName } from "../components/Icon";

const TYPE_ICONS: Record<string, IconName> = {
  cosmetic: "medal",
  streak_freeze: "shield",
  screen_time_voucher: "clock",
};
function rewardIcon(r: Reward): IconName {
  if (r.icon) return r.icon as IconName;
  return TYPE_ICONS[r.type] ?? (r.kind === "goal" ? "target" : "gift");
}

export function RewardShop({
  profileId,
  balance,
  onBalance,
}: {
  profileId: string;
  balance: number;
  onBalance: (balance: number) => void;
}) {
  const { t } = useTranslation();
  const [rewards, setRewards] = useState<Reward[] | null>(null);
  const [msg, setMsg] = useState<ReactNode>(null);

  function load() {
    api.rewards().then(setRewards).catch(() => setRewards([]));
  }
  useEffect(() => {
    load();
  }, []);

  async function redeem(r: Reward) {
    setMsg(null);
    try {
      const res = await api.redeem(r.id, profileId);
      onBalance(res.balance);
      const done =
        r.kind === "goal"
          ? t("shop.claimed")
          : res.status === "pending"
            ? t("shop.voucherIssued", { name: tx(r.nameI18n) })
            : t("shop.redeemed", { name: tx(r.nameI18n) });
      setMsg(
        <>
          {done} <Icon name="check" size={14} />
        </>,
      );
      load(); // refresca progreso/límites tras canjear
    } catch {
      setMsg(
        <>
          {t("shop.notEnough")} <Icon name="coin" size={14} />
        </>,
      );
    }
  }

  return (
    <div className="shop-screen">
      <div className="screen-kicker">{t("shop.title")}</div>
      <h2 className="screen-title">{t("shop.subtitle")}</h2>
      <div className="balance-big">
        <Icon name="coin" size={18} /> {balance}
      </div>
      {msg && <div className="shop-msg">{msg}</div>}
      <div className="shop">
        {(rewards ?? []).map((r) => {
          const goal = r.kind === "goal";
          const limitReached = r.limitCount != null && (r.redeemedInWindow ?? 0) >= r.limitCount;
          const pct = goal && r.cost > 0 ? Math.min(100, Math.round(((r.progress ?? 0) / r.cost) * 100)) : 0;
          const canRedeem = goal ? Boolean(r.claimable) : balance >= r.cost && !limitReached;
          return (
            <div className={"shop-item" + (goal ? " goal" : "")} key={r.id}>
              <div className="shop-ic">
                <Icon name={rewardIcon(r)} size={28} />
              </div>
              <div className="shop-info">
                <b>{tx(r.nameI18n)}</b>
                {goal ? (
                  <>
                    <div className="goal-bar">
                      <i style={{ width: pct + "%" }} />
                    </div>
                    <span className="fam-tag">
                      {t("shop.goal")}: {r.progress ?? 0} / {r.cost}
                    </span>
                  </>
                ) : (
                  <span className="fam-tag">{t("shop.familyApproves")}</span>
                )}
              </div>
              {goal ? (
                <button className="price-btn" disabled={!canRedeem} onClick={() => redeem(r)}>
                  {limitReached ? t("shop.limitReached") : t("shop.claim")}
                </button>
              ) : (
                <button className="price-btn" disabled={!canRedeem} onClick={() => redeem(r)}>
                  {limitReached ? t("shop.limitReached") : (
                    <>
                      {r.cost} <Icon name="coin" size={14} />
                    </>
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
