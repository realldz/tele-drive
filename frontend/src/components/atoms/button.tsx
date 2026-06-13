import { type ButtonHTMLAttributes, type ReactNode } from 'react';
import Spinner from '@/components/atoms/spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'outline' | 'ghost' | 'success' | 'subtle';
export type ButtonSize = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  loading?: boolean;
  leftIcon?: ReactNode;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50',
  secondary:
    'text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors',
  danger:
    'text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors disabled:opacity-50',
  outline:
    'text-gray-600 bg-white border border-gray-300 hover:bg-gray-50 rounded-lg transition-colors',
  ghost:
    'text-gray-400 hover:text-gray-600 rounded transition-colors',
  success:
    'text-green-600 bg-green-50 hover:bg-green-100 rounded-lg transition-colors disabled:opacity-50',
  subtle:
    'text-gray-500 bg-transparent hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  md: 'px-4 py-2 text-sm font-medium',
  sm: 'px-3 py-1.5 text-sm font-medium',
};

export default function Button({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  loading = false,
  leftIcon,
  children,
  disabled,
  className = '',
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={[
        'inline-flex items-center justify-center gap-2',
        SIZE_CLASSES[size],
        VARIANT_CLASSES[variant],
        fullWidth ? 'w-full' : '',
        className,
      ].filter(Boolean).join(' ')}
      {...props}
    >
      {loading ? <Spinner size={16} className="text-current" /> : leftIcon}
      {children}
    </button>
  );
}
