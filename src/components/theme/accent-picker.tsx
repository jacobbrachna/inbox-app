'use client';
import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/cn';

const STORAGE_KEY = 'inbox-accent-rgb';
const DEFAULT_RGB = '37, 99, 235';

const PRESETS: { name: string; rgb: string }[] = [
  { name: 'Blue',    rgb: '37, 99, 235'  },
  { name: 'Indigo',  rgb: '79, 70, 229'  },
  { name: 'Violet',  rgb: '124, 58, 237' },
  { name: 'Emerald', rgb: '5, 150, 105'  },
  { name: 'Teal',    rgb: '13, 148, 136' },
  { name: 'Rose',    rgb: '225, 29, 72'  },
  { name: 'Amber',   rgb: '217, 119, 6'  },
  { name: 'Slate',   rgb: '71, 85, 105'  },
];

function applyAccent(rgb: string) {
  document.documentElement.style.setProperty('--color-accent-rgb', rgb);
}

function rgbToHex(rgb: string): string {
  const [r, g, b] = rgb.split(',').map((s) => Number(s.trim()));
  if ([r, g, b].some(Number.isNaN)) return '#000000';
  return '#' + [r, g, b].map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('');
}

function hexToRgb(hex: string): string | null {
  const m = hex.replace('#', '').match(/^([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!m) return null;
  let h = m[0];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

export function AccentPicker() {
  const [current, setCurrent] = useState(DEFAULT_RGB);
  const [hex, setHex] = useState('');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        setCurrent(saved);
        setHex(rgbToHex(saved));
      } else {
        setHex(rgbToHex(DEFAULT_RGB));
      }
    } catch {}
    setMounted(true);
  }, []);

  function pick(rgb: string) {
    setCurrent(rgb);
    setHex(rgbToHex(rgb));
    applyAccent(rgb);
    try { localStorage.setItem(STORAGE_KEY, rgb); } catch {}
  }

  function onHexChange(value: string) {
    setHex(value);
    const rgb = hexToRgb(value);
    if (rgb) pick(rgb);
  }

  function reset() {
    pick(DEFAULT_RGB);
  }

  if (!mounted) return null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => {
          const active = p.rgb === current;
          return (
            <button
              key={p.name}
              onClick={() => pick(p.rgb)}
              title={p.name}
              aria-label={p.name}
              className={cn(
                'relative w-8 h-8 rounded-full border-2',
                active
                  ? 'border-[var(--color-text-primary)] scale-110'
                  : 'border-[var(--color-hairline)] hover:scale-105',
              )}
              style={{
                backgroundColor: `rgb(${p.rgb})`,
                transition: 'transform 180ms var(--ease-spring), border-color 140ms var(--ease-out-quart)',
              }}
            >
              {active && (
                <Check className="w-3.5 h-3.5 text-white absolute inset-0 m-auto drop-shadow-[0_1px_2px_rgba(0,0,0,0.4)]" strokeWidth={3} />
              )}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2 pt-1">
        <span
          className="w-7 h-7 rounded-md border border-[var(--color-hairline)]"
          style={{ backgroundColor: `rgb(${current})` }}
          aria-hidden
        />
        <input
          type="text"
          value={hex}
          onChange={(e) => onHexChange(e.target.value)}
          placeholder="#2563EB"
          className="mono text-[12px] px-3 py-1.5 bg-[var(--color-surface)] text-[var(--color-text-primary)] border border-[var(--color-hairline)] rounded-md outline-none focus:border-[var(--color-accent)] w-28"
          style={{ transition: 'border-color 140ms var(--ease-out-quart)' }}
          maxLength={7}
        />
        <button
          onClick={reset}
          className="text-[11px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] px-2 py-1 rounded hover:bg-[var(--color-card-hover)]"
          style={{ transition: 'all 140ms var(--ease-out-quart)' }}
        >
          Reset
        </button>
      </div>
    </div>
  );
}
