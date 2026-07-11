import { useEffect, useRef } from "react";

type Star = { x: number; y: number; r: number; a: number; s: number; col: string };

const COLORS = ["#FFFFFF", "#CFE8FF", "#37E1E8", "#B14BFF"];

/** Campo de estrellas parpadeante en Canvas (respeta prefers-reduced-motion). */
export function Starfield() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0;
    let h = 0;
    let raf = 0;
    let resizeTimer = 0;
    let stars: Star[] = [];

    const init = () => {
      w = c.width = window.innerWidth;
      h = c.height = window.innerHeight;
      const n = Math.min(220, Math.floor((w * h) / 8000));
      stars = Array.from({ length: n }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        r: Math.random() * 1.5 + 0.3,
        a: Math.random() * 0.7 + 0.2,
        s: (Math.random() * 0.012 + 0.003) * (Math.random() < 0.5 ? 1 : -1),
        col: COLORS[Math.random() < 0.78 ? 0 : 1 + Math.floor(Math.random() * 3)]!,
      }));
    };

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      for (const st of stars) {
        if (!reduce) {
          st.a += st.s;
          if (st.a > 0.95 || st.a < 0.15) st.s = -st.s;
        }
        ctx.globalAlpha = st.a;
        ctx.fillStyle = st.col;
        ctx.beginPath();
        ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (!reduce) raf = requestAnimationFrame(draw);
    };

    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        init();
        if (reduce) draw();
      }, 150);
    };

    init();
    draw();
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return <canvas id="starfield" ref={ref} aria-hidden="true" />;
}
