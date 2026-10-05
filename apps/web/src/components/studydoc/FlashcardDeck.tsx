// Tarjetas de estudio en pantalla: una a una, se giran al pulsar (o con Espacio/Intro), «La sé» / «Otra vez»
// y al final se repasan solo las que fallaron. Sin animación si el sistema pide movimiento reducido (CSS).
import { useEffect, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../Icon";
import { Txt, type Notation } from "../Txt";

export interface DeckCard {
  front: string;
  back: string;
  hint?: string;
}

function shuffled(n: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export function FlashcardDeck({ cards, frontLang, backLang, notation }: { cards: DeckCard[]; frontLang?: string; backLang?: string; notation: Notation }) {
  const { t } = useTranslation();
  const [order, setOrder] = useState<number[]>(() => cards.map((_, i) => i));
  const [pos, setPos] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [again, setAgain] = useState<number[]>([]);
  const [known, setKnown] = useState(0);

  // Si cambia el mazo (otro documento), empieza de cero.
  useEffect(() => {
    setOrder(cards.map((_, i) => i));
    setPos(0);
    setFlipped(false);
    setAgain([]);
    setKnown(0);
  }, [cards]);

  const done = pos >= order.length;
  const card = done ? null : cards[order[pos]!];

  function next(knew: boolean) {
    if (!knew) setAgain((a) => [...a, order[pos]!]);
    else setKnown((k) => k + 1);
    setFlipped(false);
    setPos((p) => p + 1);
  }
  function restart(ids: number[]) {
    setOrder(ids);
    setPos(0);
    setFlipped(false);
    setAgain([]);
    setKnown(0);
  }
  function onKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowRight" && flipped) next(true);
    if (e.key === "ArrowLeft" && flipped) next(false);
  }

  if (cards.length === 0) return null;
  if (done || !card)
    return (
      <div className="deck-end">
        <Icon name="medal" size={28} />
        <p>{t("studydoc.cardsDone", { known, total: order.length })}</p>
        <div className="row-actions">
          {again.length > 0 && (
            <button className="btn-primary" type="button" onClick={() => restart(again)}>
              {t("studydoc.retryMissed", { count: again.length })}
            </button>
          )}
          <button className="btn-ghost" type="button" onClick={() => restart(shuffled(cards.length))}>
            {t("studydoc.shuffle")}
          </button>
        </div>
      </div>
    );

  return (
    <div className="deck">
      <div className="deck-top">
        <span className="muted">{t("studydoc.cardsLeft", { n: pos + 1, total: order.length })}</span>
        <button className="btn-ghost sm" type="button" onClick={() => restart(shuffled(cards.length))}>
          {t("studydoc.shuffle")}
        </button>
      </div>
      <button className={"deck-card" + (flipped ? " flipped" : "")} type="button" aria-pressed={flipped} aria-label={t("studydoc.flip")} onClick={() => setFlipped((f) => !f)} onKeyDown={onKey}>
        <span className="deck-face front" lang={frontLang} aria-hidden={flipped}>
          <Txt text={card.front} notation={notation} />
          {card.hint && <small className="deck-hint">{card.hint}</small>}
        </span>
        <span className="deck-face back" lang={backLang} aria-hidden={!flipped}>
          <Txt text={card.back} notation={notation} />
        </span>
      </button>
      {flipped ? (
        <div className="row-actions deck-actions">
          <button className="btn-ghost" type="button" onClick={() => next(false)}>
            {t("studydoc.again")}
          </button>
          <button className="btn-primary" type="button" onClick={() => next(true)}>
            <Icon name="check" size={16} /> {t("studydoc.know")}
          </button>
        </div>
      ) : (
        <p className="muted deck-tip">{t("studydoc.flipTip")}</p>
      )}
    </div>
  );
}
