import { type ReactNode } from 'react';
import CloseButton from '@/components/atoms/close-button';

type ModalSize = 'sm' | 'md' | 'lg';
type ModalVariant = 'standard' | 'admin';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  /** Use instead of title when the heading needs icons or rich content */
  titleNode?: ReactNode;
  size?: ModalSize;
  variant?: ModalVariant;
  /** Rendered in a border-top footer strip with flex justify-end */
  footer?: ReactNode;
  dismissOnBackdrop?: boolean;
  children: ReactNode;
}

const SIZE_CLASSES: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
};

export default function Modal({
  isOpen,
  onClose,
  title,
  titleNode,
  size = 'md',
  variant = 'standard',
  footer,
  dismissOnBackdrop = true,
  children,
}: ModalProps) {
  if (!isOpen) return null;

  const isAdmin = variant === 'admin';
  const pad = isAdmin ? 'p-6' : 'p-4';

  const heading = titleNode
    ? titleNode
    : isAdmin
      ? <h3 className="text-lg font-bold text-gray-800">{title}</h3>
      : <h2 className="font-semibold text-gray-800">{title}</h2>;

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/50${isAdmin ? ' p-4' : ''}`}
      onClick={dismissOnBackdrop ? onClose : undefined}
    >
      <div
        className={`bg-white rounded-xl shadow-xl w-full ${SIZE_CLASSES[size]} overflow-hidden relative`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className={`flex justify-between items-center ${pad} border-b border-gray-100`}>
          {heading}
          <CloseButton
            onClick={onClose}
            className={isAdmin ? 'absolute top-6 right-6' : ''}
          />
        </div>

        {/* Body */}
        <div className={pad}>{children}</div>

        {/* Footer (optional) */}
        {footer && (
          <div className={`${pad} border-t border-gray-200 flex justify-end gap-2`}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
