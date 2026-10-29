import { useEffect, useState } from 'react';

/**
 * #1854: the narrow bottom sheet's top edge in viewport px, so a viewport
 * scope can leave out the map band the sheet covers. Null when disabled (the
 * wide layout, where the sheet is a side column), when `.app-bottom-sheet` is
 * absent, or where nothing can observe it.
 */
export function useSheetTop(enabled: boolean): number | null {
  const [top, setTop] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled || typeof ResizeObserver !== 'function') return;
    const el = document.querySelector<HTMLElement>('.app-bottom-sheet');
    if (!el) return;
    const read = () => setTop(el.getBoundingClientRect().top);
    const ro = new ResizeObserver(read);
    ro.observe(el);
    window.addEventListener('resize', read);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', read);
    };
  }, [enabled]);

  return enabled ? top : null;
}
