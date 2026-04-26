'use client';

import { useState } from 'react';
import { Menu } from 'lucide-react';
import { useI18n } from '@/components/i18n-context';
import { useRequireAuth } from '@/hooks/use-require-auth';
import { useNavigation } from '@/components/navigation-loader';
import { useAppNavigate } from '@/hooks/use-app-navigate';
import AdminSidebar from './components/admin-sidebar';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const navigate = useAppNavigate();
  const { isNavigating } = useNavigation();
  const { isReady, user, logout } = useRequireAuth({ requiredRole: 'ADMIN' });
  const { t } = useI18n();
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  if (!isReady) return null;

  return (
    <div className="h-screen bg-gray-50 flex overflow-hidden">
      <AdminSidebar
        user={user}
        onLogout={() => {
          if (!isNavigating) {
            logout();
            navigate.push('/login');
          }
        }}
        onBackHome={() => {
          if (!isNavigating) {
            navigate.push('/');
          }
        }}
        isMobileOpen={isMobileSidebarOpen}
        setIsMobileOpen={setIsMobileSidebarOpen}
      />

      <main className="flex-1 flex flex-col min-w-0 bg-gray-50 relative">
        <header className="md:hidden h-16 border-b border-gray-200 flex items-center px-4 bg-white flex-shrink-0 z-10 w-full">
          <button
            className="p-2 -ml-2 text-gray-600 hover:bg-gray-100 rounded-lg"
            onClick={() => setIsMobileSidebarOpen(true)}
          >
            <Menu size={24} />
          </button>
          <h2 className="text-lg font-bold ml-2 text-gray-800">{t('admin.panel')}</h2>
        </header>

        <div className="flex-1 overflow-auto p-4 md:p-6 lg:p-8">{children}</div>
      </main>
    </div>
  );
}
