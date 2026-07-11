function Frac({ n, d }: { n: string; d: string }) {
  return (
    <span className="frac">
      <span className="num">{n}</span>
      <span className="den">{d}</span>
    </span>
  );
}

/** Renderiza texto matemático: convierte "a/b" en fracciones apiladas, el resto tal cual. */
export function MathText({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/(\d+\/\d+)/g);
  return (
    <span className={className}>
      {parts.map((p, i) => {
        const m = /^(\d+)\/(\d+)$/.exec(p);
        return m ? <Frac key={i} n={m[1]!} d={m[2]!} /> : <span key={i}>{p}</span>;
      })}
    </span>
  );
}
