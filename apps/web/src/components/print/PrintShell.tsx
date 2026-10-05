// Motor de impresión: monta lo que se va a imprimir en un portal fuera de #root (el CSS de impresión oculta
// todo lo demás con `html.ws-printing`) y abre el diálogo del navegador («Guardar como PDF»). El PDF sale en
// vectorial, sin dependencias, con el mismo render de fórmulas, figuras y cuentas que la app.
//
// Reglas que hay que respetar:
//  - `print()` DENTRO del clic y sin `await` antes (Safari bloquea las impresiones fuera de un gesto): lo
//    que se imprime tiene que estar ya cargado cuando se pulsa el botón.
//  - Lo impreso se queda montado después de `window.print()` (Firefox lee el DOM más tarde); se desmonta
//    al cerrar el diálogo que lo usa.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import { pageCss, safeFileName, type PrintOptions } from "./page";

export type { PaperSize, PrintOptions } from "./page";

export function usePrintJob() {
  const [job, setJob] = useState<{ node: ReactNode; o: PrintOptions } | null>(null);
  const prevTitle = useRef<string | null>(null);

  // Al desmontar (cerrar el diálogo): fuera la clase de impresión y vuelve el título de la pestaña.
  useEffect(
    () => () => {
      document.documentElement.classList.remove("ws-printing");
      if (prevTitle.current != null) document.title = prevTitle.current;
    },
    [],
  );

  const print = useCallback((node: ReactNode, o: PrintOptions) => {
    // flushSync: la hoja tiene que estar en el DOM ANTES de print().
    flushSync(() => setJob({ node, o }));
    document.documentElement.classList.add("ws-printing");
    if (prevTitle.current == null) prevTitle.current = document.title;
    document.title = safeFileName(o.fileName);
    window.addEventListener(
      "afterprint",
      () => {
        if (prevTitle.current != null) document.title = prevTitle.current;
        prevTitle.current = null;
      },
      { once: true },
    );
    window.print();
  }, []);

  const portal = job
    ? createPortal(
        <div className="ws-print-root">
          <style>{pageCss(job.o)}</style>
          {job.node}
        </div>,
        document.body,
      )
    : null;

  return { print, portal, printed: job !== null };
}
