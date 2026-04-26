'use client';

import { useState } from 'react';
import { useAuth } from '@/components/auth-context';
import AppLink from '@/components/app-link';
import { useI18n } from '@/components/i18n-context';
import { useNavigation } from '@/components/navigation-loader';
import GuestLanguageSwitcher from '@/components/guest-language-switcher';
import { LogIn, Loader2 } from 'lucide-react';
import { getApiErrorMessage } from '@/lib/api';
import { useAppNavigate } from '@/hooks/use-app-navigate';

export default function LoginPage() {
  const { login } = useAuth();
  const { isNavigating } = useNavigation();
  const navigate = useAppNavigate();
  const { t } = useI18n();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isNavigating || !username.trim() || !password.trim()) return;

    setError('');
    setLoading(true);

    try {
      await login(username, password);
      navigate.push('/');
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, t('login.failed')));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <GuestLanguageSwitcher />
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-8">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-slate-900">Tele-Drive</h1>
          <p className="text-gray-500 mt-2">{t('login.title')}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('login.username')}</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-4 py-2.5 outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="username"
              autoFocus
              disabled={loading}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('login.password')}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-4 py-2.5 outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="password"
              disabled={loading}
            />
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2.5 rounded-lg text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !username.trim() || !password.trim()}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-medium py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            {loading ? (
              <Loader2 size={18} className="animate-spin" />
            ) : (
              <LogIn size={18} />
            )}
            {loading ? t('login.submitting') : t('login.submit')}
          </button>
        </form>

        <p className="text-center text-sm text-gray-500 mt-6">
          {t('login.noAccount')}{' '}
          <AppLink href="/register" className="text-blue-600 hover:underline font-medium">
            {t('login.register')}
          </AppLink>
        </p>
      </div>
    </div>
  );
}
