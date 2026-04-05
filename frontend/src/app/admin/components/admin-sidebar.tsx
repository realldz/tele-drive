'use client';

import { ShieldAlert, X, LogOut, User, Users, Settings, ArrowLeft } from 'lucide-react';
import { useI18n } from '@/components/i18n-context';
import type { UserRole } from '@/lib/types';

interface UserInfo {
  id: string;
  username: string;
  role: UserRole | string;
}

interface AdminSidebarProps {
  activeTab: 'USERS' | 'SETTINGS' | 'USER_FILES';
  setActiveTab: (tab: 'USERS' | 'SETTINGS' | 'USER_FILES') => void;
  user: UserInfo | null;
  onLogout: () => void;
  onBackHome: () => void;
  isMobileOpen: boolean;
  setIsMobileOpen: (v: boolean) => void;
}

export default function AdminSidebar({
  activeTab, setActiveTab, user, onLogout, onBackHome,
  isMobileOpen, setIsMobileOpen,
}: AdminSidebarProps) {
  const { t } = useI18n();

  return (
    <>
      {isMobileOpen && <div className="fixed inset-0 bg-black/50 z-20 md:hidden" onClick={() => setIsMobileOpen(false)} />}

      <aside className={`fixed md:static inset-y-0 left-0 w-64 bg-slate-900 border-r border-slate-800 flex flex-col transition-transform duration-300 z-30 ${isMobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
        <div className="p-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight text-white">Tele-Drive</h1>
          <button className="md:hidden text-slate-400 hover:text-white" onClick={() => setIsMobileOpen(false)}><X size={24} /></button>
        </div>
        <div className="px-6 mb-4">
          <div className="inline-flex items-center gap-2 bg-amber-500/20 text-amber-500 px-3 py-1.5 rounded-lg text-sm font-bold tracking-wide border border-amber-500/30">
            <ShieldAlert size={16} /> {t('admin.panel')}
          </div>
        </div>
        <nav className="flex-1 px-4 space-y-2 overflow-y-auto mt-2">
          <button onClick={() => setActiveTab('USERS')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left font-medium transition-colors ${activeTab === 'USERS' || activeTab === 'USER_FILES' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-300 hover:bg-white/5 hover:text-white'}`}>
            <Users size={20} /> {t('admin.users')}
          </button>
          <button onClick={() => setActiveTab('SETTINGS')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left font-medium transition-colors ${activeTab === 'SETTINGS' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-300 hover:bg-white/5 hover:text-white'}`}>
            <Settings size={20} /> {t('admin.systemSettings')}
          </button>
          <div className="pt-4 mt-4 border-t border-slate-800" />
          <button onClick={onBackHome} className="w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left font-medium text-slate-300 hover:bg-white/5 hover:text-white transition-colors">
            <ArrowLeft size={20} /> {t('admin.backHome')}
          </button>
        </nav>
        <div className="p-4 border-t border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center flex-shrink-0"><User size={20} className="text-slate-400" /></div>
            <div className="overflow-hidden">
              <p className="font-medium text-white truncate text-sm">{user?.username}</p>
              <button onClick={onLogout} className="text-xs text-slate-400 hover:text-white transition-colors flex items-center gap-1 mt-1"><LogOut size={12} /> {t('admin.logout')}</button>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}