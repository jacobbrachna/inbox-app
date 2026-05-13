'use client';
import { cn } from '@/lib/cn';

interface BadgeProps {
  color?: string;
  label: string;
  onRemove?: () => void;
  className?: string;
}

export function Badge({ color = '#6b7280', label, onRemove, className }: BadgeProps) {
  return (
    <span
      className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium text-white', className)}
      style={{ backgroundColor: color }}
    >
      {label}
      {onRemove && (
        <button onClick={onRemove} className="ml-0.5 hover:opacity-70">×</button>
      )}
    </span>
  );
}
