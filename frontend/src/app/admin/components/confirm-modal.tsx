'use client';

import { X, AlertTriangle } from 'lucide-react';

interface ConfirmModalProps {
  title: string;
  message: string;
  loading: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
  onConfirm: () => void;
  onClose: () => void;
}

export default function ConfirmModal({ title, message, loading, t, onConfirm, onClose }: ConfirmModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm overflow-hidden relative">
        <div className="p-6 border-b border-gray-100 flex items-start gap-3">
          <AlertTriangle className="text-red-500 flex-shrink-0 mt-0.5" size={24} />
          <div>
            <h3 id="confirm-title" className="text-lg font-bold text-gray-800">{title}</h3>
            <p className="text-sm text-gray-600 mt-1">{message}</p>
          </div>
          <button className="absolute top-4 right-4 text-gray-400 hover:text-gray-600" onClick={onClose} aria-label={t('common.cancel')}>
            <X size={18} />
          </button>
        </div>
        <div className="p-6 flex justify-end gap-3">
          <button type="button" onClick={onClose} disabled={loading} className="px-4 py-2 text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg font-medium transition-colors disabled:opacity-50">
            {t('common.no')}
          </button>
          <button type="button" onClick={onConfirm} disabled={loading} className="px-4 py-2 text-white bg-red-600 hover:bg-red-700 rounded-lg font-medium transition-colors disabled:opacity-50">
            {loading ? t('common.deleting') : t('common.yes')}
          </button>
        </div>
      </div>
    </div>
  );
}