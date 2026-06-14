import { type ReactNode } from 'react';

interface ErrorBannerProps {
  children: ReactNode;
  className?: string;
}

export default function ErrorBanner({ children, className = '' }: ErrorBannerProps) {
  return (
    <div
      className={`bg-red-50 border border-red-200 text-red-700 px-4 py-2.5 rounded-lg text-sm ${className}`.trim()}
    >
      {children}
    </div>
  );
}
