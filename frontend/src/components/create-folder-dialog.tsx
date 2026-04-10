'use client';

import React, { useState, useEffect } from 'react';
import { X, FolderPlus } from 'lucide-react';
import { useI18n } from '@/components/i18n-context';

interface CreateFolderDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (name: string) => Promise<void> | void;
  error?: string;
  onClearError?: () => void;
}

export default function CreateFolderDialog({ isOpen, onClose, onConfirm, error, onClearError }: CreateFolderDialogProps) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setName('');
      setIsSubmitting(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onConfirm(name.trim());
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center p-4 border-b border-gray-100">
          <h2 className="font-semibold text-gray-800 flex items-center gap-2">
            <FolderPlus size={20} className="text-blue-500" />
            {t('createFolder.title')}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-4">
          <input
            type="text"
            value={name}
            onChange={(e) => { setName(e.target.value); if (error) onClearError?.(); }}
            placeholder={t('createFolder.placeholder')}
            className={`w-full border rounded-lg p-2 focus:ring-2 focus:outline-none ${error ? 'border-red-500 focus:ring-red-500 focus:border-red-500' : 'border-gray-300 focus:ring-blue-500 focus:border-blue-500'}`}
            autoFocus
          />
          {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
          <div className="flex justify-end gap-2 mt-6">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200"
            >
              {t('createFolder.cancel')}
            </button>
            <button
              type="submit"
              disabled={!name.trim() || isSubmitting || !!error}
              className="px-4 py-2 text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
            >
              {isSubmitting ? t('createFolder.creating') : t('createFolder.create')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
