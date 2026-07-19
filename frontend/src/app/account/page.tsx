'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { KeyRound, Loader2, Mail, UserRound } from 'lucide-react';
import toast from 'react-hot-toast';
import Sidebar from '@/components/sidebar';
import { useRequireAuth } from '@/hooks/use-require-auth';
import { changePassword, formatBytes, getApiErrorMessage, updateCurrentUser } from '@/lib/api';
import { useAuth } from '@/providers/auth-context';
import { useI18n } from '@/providers/i18n-context';

export default function AccountPage() {
  const { isReady } = useRequireAuth();
  const { user, quotaInfo, refreshUser } = useAuth();
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [emailSaving, setEmailSaving] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });

  useEffect(() => {
    setEmail(user?.email ?? '');
  }, [user?.email]);

  const normalizedEmail = email.trim();
  const savedEmail = user?.email ?? '';
  const emailChanged = normalizedEmail !== savedEmail;
  const usagePercent = useMemo(() => {
    if (!quotaInfo || quotaInfo.quota === 0) return 0;
    return Math.min((quotaInfo.usedSpace / quotaInfo.quota) * 100, 100);
  }, [quotaInfo]);

  async function handleEmailSubmit(e: FormEvent) {
    e.preventDefault();
    if (!emailChanged || emailSaving) return;

    setEmailSaving(true);
    try {
      await updateCurrentUser({ email: normalizedEmail || null });
      await refreshUser();
      toast.success(normalizedEmail ? t('account.saveSuccess') : t('account.clearSuccess'));
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('account.saveError')));
    } finally {
      setEmailSaving(false);
    }
  }

  async function handlePasswordSubmit(e: FormEvent) {
    e.preventDefault();
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      toast.error(t('password.mismatch'));
      return;
    }
    if (passwordForm.newPassword.length < 6) {
      toast.error(t('password.tooShort'));
      return;
    }

    setPasswordSaving(true);
    try {
      await changePassword(passwordForm.currentPassword, passwordForm.newPassword);
      setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      toast.success(t('password.changeSuccess'));
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('password.changeError')));
    } finally {
      setPasswordSaving(false);
    }
  }

  if (!isReady) return null;

  return (
    <div className="h-screen bg-white flex overflow-hidden">
      <Sidebar />

      <main className="flex-1 flex flex-col min-w-0 bg-white relative">
        <header className="h-16 border-b border-gray-100 flex items-center justify-between pl-14 pr-4 md:px-4 lg:px-6 bg-white w-full flex-shrink-0 z-10">
          <div className="flex items-center gap-2">
            <UserRound size={22} className="text-blue-600" />
            <h2 className="text-xl font-bold text-gray-800">{t('account.title')}</h2>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
            <section className="bg-white border border-gray-200 rounded-xl p-4 md:p-6">
              <div className="flex items-center gap-2 mb-4">
                <UserRound size={18} className="text-slate-500" />
                <h3 className="font-semibold text-gray-900">{t('account.profile')}</h3>
              </div>
              <label htmlFor="account-username" className="block text-sm font-medium text-gray-700 mb-1">
                {t('account.username')}
              </label>
              <input
                id="account-username"
                value={user?.username ?? ''}
                readOnly
                aria-describedby="account-username-help"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p id="account-username-help" className="text-xs text-gray-500 mt-1">
                {t('account.usernameReadonly')}
              </p>
            </section>

            <section className="bg-white border border-gray-200 rounded-xl p-4 md:p-6">
              <div className="flex items-center gap-2 mb-4">
                <Mail size={18} className="text-slate-500" />
                <h3 className="font-semibold text-gray-900">{t('account.email')}</h3>
              </div>
              <form onSubmit={handleEmailSubmit} className="space-y-4">
                <div>
                  <label htmlFor="account-email" className="block text-sm font-medium text-gray-700 mb-1">
                    {t('account.emailAddress')}
                  </label>
                  <input
                    id="account-email"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={t('account.emailPlaceholder')}
                    aria-describedby="account-email-help"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    maxLength={254}
                  />
                  <p id="account-email-help" className="text-xs text-gray-500 mt-1">
                    {t('account.emailHelp')}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="submit"
                    disabled={!emailChanged || emailSaving}
                    className="min-h-11 px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors text-sm font-medium flex items-center gap-2"
                  >
                    {emailSaving && <Loader2 size={14} className="animate-spin" />}
                    {emailSaving ? t('account.saving') : t('account.save')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEmail('')}
                    disabled={!email || emailSaving}
                    className="min-h-11 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-50 rounded-lg transition-colors font-medium"
                  >
                    {t('account.clearEmail')}
                  </button>
                </div>
              </form>
            </section>

            <section className="bg-white border border-gray-200 rounded-xl p-4 md:p-6">
              <div className="flex items-center gap-2 mb-4">
                <KeyRound size={18} className="text-slate-500" />
                <h3 className="font-semibold text-gray-900">{t('account.security')}</h3>
              </div>
              <form onSubmit={handlePasswordSubmit} className="space-y-4">
                <div>
                  <label htmlFor="current-password" className="block text-sm font-medium text-gray-700 mb-1">
                    {t('password.currentPassword')}
                  </label>
                  <input
                    id="current-password"
                    type="password"
                    autoComplete="current-password"
                    value={passwordForm.currentPassword}
                    onChange={(e) => setPasswordForm({ ...passwordForm, currentPassword: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="new-password" className="block text-sm font-medium text-gray-700 mb-1">
                    {t('password.newPassword')}
                  </label>
                  <input
                    id="new-password"
                    type="password"
                    autoComplete="new-password"
                    value={passwordForm.newPassword}
                    onChange={(e) => setPasswordForm({ ...passwordForm, newPassword: e.target.value })}
                    aria-describedby="new-password-help"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    required
                    minLength={6}
                  />
                  <p id="new-password-help" className="text-xs text-gray-500 mt-1">
                    {t('account.passwordHelp')}
                  </p>
                </div>
                <div>
                  <label htmlFor="confirm-password" className="block text-sm font-medium text-gray-700 mb-1">
                    {t('password.confirmNewPassword')}
                  </label>
                  <input
                    id="confirm-password"
                    type="password"
                    autoComplete="new-password"
                    value={passwordForm.confirmPassword}
                    onChange={(e) => setPasswordForm({ ...passwordForm, confirmPassword: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    required
                    minLength={6}
                  />
                </div>
                <button
                  type="submit"
                  disabled={passwordSaving}
                  className="min-h-11 px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors text-sm font-medium flex items-center gap-2"
                >
                  {passwordSaving && <Loader2 size={14} className="animate-spin" />}
                  {passwordSaving ? t('password.changing') : t('password.changeButton')}
                </button>
              </form>
            </section>

            {quotaInfo && (
              <section className="bg-white border border-gray-200 rounded-xl p-4 md:p-6">
                <h3 className="font-semibold text-gray-900 mb-4">{t('account.usage')}</h3>
                <div className="flex justify-between items-center mb-2 text-sm text-gray-600">
                  <span>{t('sidebar.used')}</span>
                  <span>{usagePercent.toFixed(1)}%</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2 mb-2">
                  <div className="h-2 rounded-full bg-blue-500" style={{ width: `${usagePercent}%` }} />
                </div>
                <p className="text-xs text-gray-500">
                  {formatBytes(quotaInfo.usedSpace)} / {formatBytes(quotaInfo.quota)}
                </p>
              </section>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
