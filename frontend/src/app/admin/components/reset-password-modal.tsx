'use client';

import { useEffect } from 'react';
import { X } from 'lucide-react';

interface ResetPasswordForm {
  newPassword: string;
  confirmPassword: string;
}

interface ResetPasswordModalProps {
  username: string;
  form: ResetPasswordForm;
  onFormChange: (form: ResetPasswordForm) => void;
  loading: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
  onSubmit: (e: React.FormEvent) => void;
  onClose: () => void;
}

export default function ResetPasswordModal({ username, form, onFormChange, loading, t, onSubmit, onClose }: ResetPasswordModalProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="reset-pw-title">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden relative">
        <div className="p-6 border-b border-gray-100">
          <h3 id="reset-pw-title" className="text-lg font-bold text-gray-800">{t('admin.resetPasswordTitle', { username })}</h3>
          <button className="absolute top-6 right-6 text-gray-400 hover:text-gray-600" onClick={onClose} aria-label={t('common.cancel')}><X size={20} /></button>
        </div>
        <form onSubmit={onSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('password.newPassword')}</label>
            <input type="password" value={form.newPassword} onChange={(e) => onFormChange({ ...form, newPassword: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring focus:ring-blue-100 outline-none" required minLength={4} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('password.confirmNewPassword')}</label>
            <input type="password" value={form.confirmPassword} onChange={(e) => onFormChange({ ...form, confirmPassword: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring focus:ring-blue-100 outline-none" required minLength={4} />
          </div>
          <div className="flex justify-end gap-3 mt-6">
            <button type="button" onClick={onClose} className="px-4 py-2 text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg font-medium transition-colors">{t('admin.cancel')}</button>
            <button type="submit" disabled={loading} className="px-4 py-2 text-white bg-orange-600 hover:bg-orange-700 disabled:opacity-50 rounded-lg font-medium transition-colors">
              {loading ? t('password.changing') : t('admin.resetPasswordButton')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}