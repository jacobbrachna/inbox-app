'use client';
import { useEffect, useState } from 'react';
import { Sun, Moon } from 'lucide-react';
import { storage } from '@/lib/storage';

type Theme = 'dark' | 'light';

function applyTheme(theme: Theme) {
  if (theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  document.documentElement.style.colorScheme = theme;
}

function readCurrent(): Theme {
  if (typeof window === 'undefined') return 'light';
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('light');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setTheme(readCurrent());
    setMounted(true);
  }, []);

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    const commit = () => {
      setTheme(next);
      applyTheme(next);
      storage.theme.set(next);
    };
    // Browser-native cross-fade when supported. Falls back to the standard
    // CSS transitions on :root/body/card defined in globals.css.
    const doc = document as Document & {
      startViewTransition?: (cb: () => void) => unknown;
    };
    if (typeof doc.startViewTransition === 'function' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      doc.startViewTransition(commit);
    } else {
      commit();
    }
  }

  if (!mounted) return <span className="w-8 h-8" aria-hidden />;

  const Icon = theme === 'dark' ? Sun : Moon;
  const label = theme === 'dark' ? 'Switch to light' : 'Switch to dark';

  return (
    <button
      onClick={toggle}
      title={label}
      aria-label={label}
      className="inline-flex items-center justify-center w-8 h-8 rounded-full text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-2)]"
      style={{ transition: 'all 180ms var(--ease-out-quart)' }}
    >
      <Icon className="w-4 h-4" style={{ transition: 'transform 280ms var(--ease-spring)' }} />
    </button>
  );
}
