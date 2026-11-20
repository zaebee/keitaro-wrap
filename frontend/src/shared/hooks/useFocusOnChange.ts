import { useEffect, useRef } from "react";

export function useFocusOnChange<T extends HTMLElement>(key: string | null) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (key !== null) {
      ref.current?.focus();
    }
  }, [key]);
  return ref;
}
