import { type ReactNode } from 'react';

export type BadgeVariant = 'default' | 'success' | 'danger' | 'warning' | 'admin' | 'count' | 'mono';

interface BadgeProps {
  variant?: BadgeVariant;
  children: ReactNode;
  className?: string;
}

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  default: 'bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full text-xs font-medium',
  success: 'bg-green-100 text-green-700 px-2 py-0.5 rounded-full text-xs font-medium',
  danger: 'bg-red-100 text-red-700 px-2 py-0.5 rounded-full text-xs font-medium',
  warning: 'bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full text-xs font-medium',
  admin: 'bg-purple-100 text-purple-700 px-2 py-1 rounded-full text-xs font-semibold',
  count: 'bg-gray-100 text-gray-500 px-3 py-1.5 rounded-full text-sm font-medium',
  mono: 'bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded font-mono text-[10px]',
};

export default function Badge({ variant = 'default', children, className = '' }: BadgeProps) {
  return (
    <span className={`inline-flex items-center ${VARIANT_CLASSES[variant]} ${className}`.trim()}>
      {children}
    </span>
  );
}
