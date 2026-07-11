import { useEffect, useState } from "react";
import { api, tx, type Reward } from "../api";

const ICONS: Record<string, string> = {
  cosmetic: "🪖",
  streak_freeze: "🛡️",
  screen_time_voucher: "⏱️",
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
  const [rewards, setRewards] = useState<Reward[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api.rewards().then(setRewards).catch(() => setRewards([]));
  }, []);

  async function redeem(r: Reward) {
    setMsg(null);
    try {
      const res = await api.redeem(r.id, profileId);
      onBalance(res.balance);
      setMsg(
        res.status === "pending"
          ? `Vale emitido: ${tx(r.nameI18n)} — tu familia lo aplicará ✔`
          : `¡Canjeado: ${tx(r.nameI18n)}! ✔`,
      );
    } catch {
      setMsg("Aún no tienes suficiente polvo estelar ✦");
    }
  }

  return (
    <div className="shop-screen">
      <div className="screen-kicker">Tienda estelar</div>
      <h2 className="screen-title">Canjea tu polvo estelar</h2>
      <div className="balance-big">✦ {balance}</div>
      {msg && <div className="shop-msg">{msg}</div>}
      <div className="shop">
        {(rewards ?? []).map((r) => (
          <div className={`shop-item ${r.type === "screen_time_voucher" ? "voucher" : ""}`} key={r.id}>
            <div className="shop-ic">{ICONS[r.type] ?? "★"}</div>
            <div className="shop-info">
              <b>{tx(r.nameI18n)}</b>
              {r.type === "screen_time_voucher" && <span className="fam-tag">Lo aprueba tu familia</span>}
            </div>
            <button className="price-btn" disabled={balance < r.cost} onClick={() => redeem(r)}>
              {r.cost} ✦
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
