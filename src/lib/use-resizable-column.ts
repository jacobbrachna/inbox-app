import { useEffect, useRef, useState, useCallback } from 'react';
import { storage } from '@/lib/storage';

// Drag-to-resize for a column. During the drag we update the DOM width
// DIRECTLY via a ref (no React re-renders) — that's the only way to keep
// the drag smooth when the resized column contains lots of children.
// State only updates on mouseup so the rest of the app picks up the final value.
export function useResizableColumn(opts: {
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
}) {
  const { storageKey, defaultWidth, min, max } = opts;

  const [width, setWidth] = useState<number>(() => {
    const n = storage.columnWidth.get(storageKey);
    if (n === null) return defaultWidth;
    return Math.max(min, Math.min(max, n));
  });

  // ref → the resizable element. Updated directly during drag.
  const elRef = useRef<HTMLDivElement | null>(null);
  // ref-tracked current width so onMove can read it without closure staleness
  const widthRef = useRef(width);
  useEffect(() => { widthRef.current = width; }, [width]);

  useEffect(() => {
    storage.columnWidth.set(storageKey, width);
  }, [storageKey, width]);

  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthRef.current;
    let lastNext = startWidth;

    function onMove(ev: MouseEvent) {
      const next = Math.max(min, Math.min(max, startWidth + (ev.clientX - startX)));
      lastNext = next;
      // Direct DOM write — no React re-render. The element resizes synchronously
      // and the browser does layout once per frame.
      if (elRef.current) elRef.current.style.width = `${next}px`;
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Now commit to React state — re-render happens ONCE, on drag end.
      widthRef.current = lastNext;
      setWidth(lastNext);
    }
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [min, max]);

  return { width, startDrag, elRef };
}
