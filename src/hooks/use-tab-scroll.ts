import { useCallback, useRef } from "react";
import {
  readScrollTop,
  restoreScrollTop,
} from "@/lib/ui-session";

/**
 * Per-tab scroll for the shared `.app-content` scroller.
 * Keeps an in-memory map (seeded from session) so switch is sync-fast;
 * caller persists to sessionStorage via patch*Ui.
 */
export function useTabScroll(initial: Record<string, number> = {}) {
  const mapRef = useRef<Record<string, number>>({ ...initial });

  const save = useCallback((key: string) => {
    mapRef.current[key] = readScrollTop();
    return mapRef.current[key];
  }, []);

  const restore = useCallback((key: string) => {
    restoreScrollTop(mapRef.current[key] ?? 0);
  }, []);

  const peek = useCallback((key: string) => mapRef.current[key] ?? 0, []);

  const setStored = useCallback((key: string, y: number) => {
    mapRef.current[key] = y;
  }, []);

  return { save, restore, peek, setStored, mapRef };
}
