import { useEffect, useState } from "react";

const QUERY = "(max-width: 767px)";

export function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined" && "matchMedia" in window
      ? window.matchMedia(QUERY).matches
      : false,
  );

  useEffect(() => {
    if (!("matchMedia" in window)) {
      return;
    }
    const media = window.matchMedia(QUERY);
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return narrow;
}
