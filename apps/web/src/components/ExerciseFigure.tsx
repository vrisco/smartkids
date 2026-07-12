// Ilustración del ejercicio: renderiza un SVG en línea como imagen (data URI).
// Cargarlo vía <img> garantiza que el navegador NO ejecuta scripts del SVG
// (a diferencia de inyectarlo en el DOM), así que es seguro para contenido generado.
export function ExerciseFigure({ svg, className }: { svg?: string | null; className?: string }) {
  const s = svg?.trim();
  if (!s || !s.startsWith("<svg")) return null;
  const src = `data:image/svg+xml;utf8,${encodeURIComponent(s)}`;
  return (
    <div className={"ex-figure" + (className ? " " + className : "")}>
      <img src={src} alt="" draggable={false} />
    </div>
  );
}
