import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api, tx, type Reward } from "../api";
import { Icon, type IconName } from "../components/Icon";

const ICONS: Record<string, IconName> = {
  cosmetic: "medal",
  streak_freeze: "shield",
  screen_time_voucher: "clock",
};

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

  useEffect(() => {
    api.rewards().then(setRewards).catch(() => setRewards([]));
  }, []);

  async function redeem(r: Reward) {
    setMsg(null);
    try {
      const res = await api.redeem(r.id, profileId);
      onBalance(res.balance);
      setMsg(
        res.status === "pending" ? (
          <>
            {t("shop.voucherIssued", { name: tx(r.nameI18n) })} <Icon name="check" size={14} />
          </>
        ) : (
          <>
            {t("shop.redeemed", { name: tx(r.nameI18n) })} <Icon name="check" size={14} />
          </>
        ),
      );
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
      <div className="balance-big"><Icon name="coin" size={18} /> {balance}</div>
      {msg && <div className="shop-msg">{msg}</div>}
      <div className="shop">
        {(rewards ?? []).map((r) => (
          <div className={`shop-item ${r.type === "screen_time_voucher" ? "voucher" : ""}`} key={r.id}>
            <div className="shop-ic"><Icon name={ICONS[r.type] ?? "star"} size={28} /></div>
            <div className="shop-info">
              <b>{tx(r.nameI18n)}</b>
              {r.type === "screen_time_voucher" && <span className="fam-tag">{t("shop.familyApproves")}</span>}
            </div>
            <button className="price-btn" disabled={balance < r.cost} onClick={() => redeem(r)}>
              {r.cost} <Icon name="coin" size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
