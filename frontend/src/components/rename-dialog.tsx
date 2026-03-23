import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { useI18n } from '@/components/i18n-context';

interface RenameDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (newName: string) => Promise<void> | void;
  initialName: string;
  itemType: 'file' | 'folder';
}

export default function RenameDialog({ isOpen, onClose, onConfirm, initialName, itemType }: RenameDialogProps) {
  const { t } = useI18n();
  const [name, setName] = useState(initialName);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Sync name state when dialog opens with a different item
  useEffect(() => {
    if (isOpen) {
      setName(initialName);
    }
  }, [isOpen, initialName]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim() && name !== initialName) {
      setIsSubmitting(true);
      await onConfirm(name.trim());
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm overflow-hidden">
        <div className="flex justify-between items-center p-4 border-b border-gray-100">
          <h2 className="font-semibold text-gray-800">{t(itemType === 'file' ? 'rename.titleFile' : 'rename.titleFolder')}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-4">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full border border-gray-300 rounded-lg p-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            autoFocus
          />
          <div className="flex justify-end gap-2 mt-6">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200"
            >
              {t('rename.cancel')}
            </button>
            <button
              type="submit"
              disabled={!name.trim() || name === initialName || isSubmitting}
              className="px-4 py-2 text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
            >
              {isSubmitting ? t('rename.processing') : t('rename.confirm')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
