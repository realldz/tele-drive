'use client';

import { useEffect } from 'react';
import { X } from 'lucide-react';
import type { UserRole } from '@/lib/types';

interface EditUserForm {
  quotaGB: number | string;
  bandwidthLimitGB: number | string;
  role: string;
}

interface EditUserModalProps {
  user: { id: string; username: string; role: UserRole };
  currentUserId: string | undefined;
  form: EditUserForm;
  onFormChange: (form: EditUserForm) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  onSubmit: (e: React.FormEvent) => void;
  onClose: () => void;
}

export default function EditUserModal({ user, currentUserId, form, onFormChange, t, onSubmit, onClose }: EditUserModalProps) {
  const isSelf = currentUserId === user.id;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="edit-user-title">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden relative">
        <div className="p-6 border-b border-gray-100">
          <h3 id="edit-user-title" className="text-lg font-bold text-gray-800">{t('admin.editUser', { username: user.username })}</h3>
          <button className="absolute top-6 right-6 text-gray-400 hover:text-gray-600" onClick={onClose} aria-label={t('common.cancel')}><X size={20} /></button>
        </div>
        <form onSubmit={onSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('admin.roleLabel')}</label>
            <select value={form.role} onChange={(e) => onFormChange({ ...form, role: e.target.value })} disabled={isSelf}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring focus:ring-blue-100 outline-none disabled:bg-gray-100">
              <option value="USER">{t('admin.userRole')}</option><option value="ADMIN">{t('admin.adminRole')}</option>
            </select>
            {isSelf && <p className="text-xs text-orange-500 mt-1">{t('admin.cannotDemoteSelf')}</p>}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('admin.maxQuota')}</label>
            <input type="number" min="0" step="0.1" value={form.quotaGB} onChange={(e) => onFormChange({ ...form, quotaGB: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring focus:ring-blue-100 outline-none" required />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('admin.bandwidthLimit')}</label>
            <input type="number" min="0" step="0.1" value={form.bandwidthLimitGB} onChange={(e) => onFormChange({ ...form, bandwidthLimitGB: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring focus:ring-blue-100 outline-none" placeholder={t('admin.bandwidthNoLimit')} />
            <p className="text-xs text-gray-500 mt-1">{t('admin.zeroNoLimit')}</p>
          </div>
          <div className="flex justify-end gap-3 mt-6">
            <button type="button" onClick={onClose} className="px-4 py-2 text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg font-medium transition-colors">{t('admin.cancel')}</button>
            <button type="submit" className="px-4 py-2 text-white bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition-colors">{t('admin.save')}</button>
          </div>
        </form>
      </div>
    </div>
  );
}