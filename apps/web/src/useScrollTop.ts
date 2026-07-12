import { useEffect } from "react";

// La SPA no tiene router: al cambiar de pantalla por estado, el scroll de la ventana
// se quedaba donde estaba (a media página). Este hook lo devuelve al inicio cada vez
// que cambia `key` (una cadena que identifica la pantalla actual).
export function useScrollTop(key: string) {
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 });
  }, [key]);
}
