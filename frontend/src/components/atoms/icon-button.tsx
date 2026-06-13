import { type ButtonHTMLAttributes, type ReactNode } from 'react';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  className?: string;
}

export default function IconButton({ children, className = '', ...props }: IconButtonProps) {
  return (
    <button
      type="button"
      className={`p-1.5 text-gray-500 hover:bg-gray-100 rounded-md transition-colors ${className}`.trim()}
      {...props}
    >
      {children}
    </button>
  );
}
