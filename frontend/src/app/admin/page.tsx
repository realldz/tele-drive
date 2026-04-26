'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Loader2 } from 'lucide-react';
import { fetchAdminDashboardSummary, getApiErrorMessage } from '@/lib/api';
import type { AdminDashboardSummary } from '@/lib/types';
import { useI18n } from '@/components/i18n-context';
import AdminDashboardOverview from './components/admin-dashboard-overview';

export default function AdminDashboardPage() {
  const { t } = useI18n();
  const [summary, setSummary] = useState<AdminDashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAdminDashboardSummary()
      .then(setSummary)
      .catch((err: unknown) => {
        toast.error(getApiErrorMessage(err, t('admin.dashboardLoadError')));
      })
      .finally(() => setLoading(false));
  }, [t]);

  if (loading || !summary) {
    return <Loader2 className="animate-spin text-blue-500 mx-auto mt-8" size={24} />;
  }

  return <AdminDashboardOverview summary={summary} t={t} />;
}
