'use client';

import { useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { Home, Trash2, KeyRound, ShieldAlert, LogOut, User, HardDrive, Menu, X, KeySquare } from 'lucide-react';
import { useAuth } from '@/components/auth-context';
import { useI18n } from '@/components/i18n-context';
import LanguageSwitcher from '@/components/language-switcher';
import { formatSize, changePassword } from '@/lib/api';
import toast from 'react-hot-toast';

interface SidebarProps {
  children?: React.ReactNode;
}

export default function Sidebar({ children }: SidebarProps) {
  const { user, logout, quotaInfo } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [pwForm, setPwForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [pwLoading, setPwLoading] = useState(false);

  const handleLogout = () => {
    logout();
    router.push('/login');
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pwForm.newPassword !== pwForm.confirmPassword) {
      toast.error(t('password.mismatch'));
      return;
    }
    if (pwForm.newPassword.length < 4) {
      toast.error(t('password.tooShort'));
      return;
    }
    setPwLoading(true);
    try {
      await changePassword(pwForm.currentPassword, pwForm.newPassword);
      toast.success(t('password.changeSuccess'));
      setShowChangePassword(false);
      setPwForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
    } catch (err: any) {
      const msg = err.response?.data?.message || t('password.changeError');
      toast.error(msg);
    } finally {
      setPwLoading(false);
    }
  };

  const quotaPercentage = quotaInfo ? Math.min((quotaInfo.usedSpace / quotaInfo.quota) * 100, 100) : 0;

  const navItems = [
    { href: '/', label: t('sidebar.home'), icon: Home },
    { href: '/trash', label: t('sidebar.trash'), icon: Trash2 },
    { href: '/s3-keys', label: t('sidebar.s3Keys'), icon: KeyRound },
  ];

  return (
    <>
      {/* Mobile Sidebar Overlay */}
      {isMobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-20 md:hidden"
          onClick={() => setIsMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`fixed md:static inset-y-0 left-0 w-64 bg-slate-900 border-r border-slate-800 flex flex-col transition-transform duration-300 z-30 ${isMobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
        <div className="p-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            Tele-Drive
          </h1>
          <button className="md:hidden text-slate-400 hover:text-white" onClick={() => setIsMobileOpen(false)}>
            <X size={24} />
          </button>
        </div>

        <nav className="flex-1 px-4 space-y-2 overflow-y-auto">
          {/* Extra slot for page-specific buttons (e.g. New Folder) */}
          {children}

          {navItems.map((item) => {
            const isActive = pathname === item.href;
            return (
              <button
                key={item.href}
                onClick={() => { router.push(item.href); setIsMobileOpen(false); }}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left font-medium transition-colors ${isActive ? 'bg-white/10 text-white' : 'hover:bg-white/5 text-slate-300'}`}
              >
                <item.icon size={20} /> {item.label}
              </button>
            );
          })}

          {user?.role === 'ADMIN' && (
            <>
              <div className="pt-4 mt-4 border-t border-slate-800"></div>
              <button
                onClick={() => { router.push('/admin'); setIsMobileOpen(false); }}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left font-medium transition-colors ${pathname === '/admin' ? 'bg-white/10 text-amber-400' : 'hover:bg-white/5 text-amber-400'}`}
              >
                <ShieldAlert size={20} /> Admin Panel
              </button>
            </>
          )}
        </nav>

        <div className="p-4 border-t border-slate-800">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center flex-shrink-0">
              <User size={20} className="text-slate-400" />
            </div>
            <div className="overflow-hidden">
              <p className="font-medium text-white truncate text-sm">{user?.username}</p>
              <div className="flex items-center gap-3 mt-1">
                <button onClick={() => setShowChangePassword(true)} className="text-xs text-slate-400 hover:text-white transition-colors flex items-center gap-1">
                  <KeySquare size={12} /> {t('password.change')}
                </button>
                <button onClick={handleLogout} className="text-xs text-slate-400 hover:text-white transition-colors flex items-center gap-1">
                  <LogOut size={12} /> {t('sidebar.logout')}
                </button>
              </div>
            </div>
          </div>

          <LanguageSwitcher />

          {quotaInfo && (
            <div className="bg-slate-800 rounded-lg p-3 mt-3">
              <div className="flex justify-between items-center mb-2 text-xs text-slate-300">
                <span className="flex items-center gap-1"><HardDrive size={12} /> {t('sidebar.used')}</span>
                <span>{quotaPercentage.toFixed(1)}%</span>
              </div>
              <div className="w-full bg-slate-700 rounded-full h-1.5 mb-2">
                <div
                  className={`h-1.5 rounded-full transition-all ${quotaPercentage > 90 ? 'bg-red-500' : 'bg-blue-500'}`}
                  style={{ width: `${quotaPercentage}%` }}
                />
              </div>
              <div className="text-[10px] text-slate-400 text-center font-medium">
                {formatSize(quotaInfo.usedSpace)} / {formatSize(quotaInfo.quota)}
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* Mobile menu button — rendered outside sidebar for pages to position */}
      <button
        className="fixed top-4 left-4 p-2 text-gray-600 hover:bg-gray-100 rounded-lg md:hidden z-10"
        onClick={() => setIsMobileOpen(true)}
        style={{ display: isMobileOpen ? 'none' : undefined }}
      >
        <Menu size={24} />
      </button>

      {/* Change Password Modal */}
      {showChangePassword && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden relative">
            <div className="p-6 border-b border-gray-100">
              <h3 className="text-lg font-bold text-gray-800">{t('password.changeTitle')}</h3>
              <button className="absolute top-6 right-6 text-gray-400 hover:text-gray-600" onClick={() => { setShowChangePassword(false); setPwForm({ currentPassword: '', newPassword: '', confirmPassword: '' }); }}>
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleChangePassword} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('password.currentPassword')}</label>
                <input
                  type="password"
                  value={pwForm.currentPassword}
                  onChange={(e) => setPwForm({ ...pwForm, currentPassword: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring focus:ring-blue-100 outline-none"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('password.newPassword')}</label>
                <input
                  type="password"
                  value={pwForm.newPassword}
                  onChange={(e) => setPwForm({ ...pwForm, newPassword: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring focus:ring-blue-100 outline-none"
                  required
                  minLength={4}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('password.confirmNewPassword')}</label>
                <input
                  type="password"
                  value={pwForm.confirmPassword}
                  onChange={(e) => setPwForm({ ...pwForm, confirmPassword: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring focus:ring-blue-100 outline-none"
                  required
                  minLength={4}
                />
              </div>
              <div className="flex justify-end gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => { setShowChangePassword(false); setPwForm({ currentPassword: '', newPassword: '', confirmPassword: '' }); }}
                  className="px-4 py-2 text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg font-medium transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={pwLoading}
                  className="px-4 py-2 text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg font-medium transition-colors"
                >
                  {pwLoading ? t('password.changing') : t('password.changeButton')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
