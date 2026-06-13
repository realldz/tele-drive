import { X } from 'lucide-react';
import { type ButtonHTMLAttributes } from 'react';

interface CloseButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  iconSize?: number;
  className?: string;
}

export default function CloseButton({ iconSize = 20, className = '', ...props }: CloseButtonProps) {
  return (
    <button
      type="button"
      className={`text-gray-400 hover:text-gray-600 transition-colors ${className}`.trim()}
      {...props}
    >
      <X size={iconSize} />
    </button>
  );
}
