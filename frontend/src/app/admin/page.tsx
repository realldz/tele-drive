'use client';

import { useEffect, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { Loader2 } from 'lucide-react';
import { 
  fetchAdminDashboardSummary, 
  getApiErrorMessage, 
  fetchSystemStats, 
  retryAllFailedBuffers,
  clearFailedZipJobs,
  type SystemStats 
} from '@/lib/api';
import type { AdminDashboardSummary } from '@/lib/types';
import { useI18n } from '@/components/i18n-context';
import AdminDashboardOverview from './components/admin-dashboard-overview';

export default function AdminDashboardPage() {
  const { t } = useI18n();
  const [summary, setSummary] = useState<AdminDashboardSummary | null>(null);
  const [systemStats, setSystemStats] = useState<SystemStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [clearingZips, setClearingZips] = useState(false);

  const fetchData = useCallback(() => {
    return Promise.all([fetchAdminDashboardSummary(), fetchSystemStats()])
      .then(([summaryData, statsData]) => {
        setSummary(summaryData);
        setSystemStats(statsData);
      })
      .catch((err: unknown) => {
        toast.error(getApiErrorMessage(err, t('admin.dashboardLoadError')));
      });
  }, [t]);

  useEffect(() => {
    fetchData().finally(() => setLoading(false));
  }, [fetchData]);

  // Auto refresh every 10 seconds for stats when page is active
  useEffect(() => {
    if (loading) return;
    const interval = setInterval(() => {
      Promise.all([fetchAdminDashboardSummary(), fetchSystemStats()])
        .then(([summaryData, statsData]) => {
          setSummary(summaryData);
          setSystemStats(statsData);
        })
        .catch((err) => console.error('Silent stats refresh failed', err));
    }, 10000);
    return () => clearInterval(interval);
  }, [loading]);

  const handleRetryAll = async () => {
    setRetrying(true);
    try {
      const res = await retryAllFailedBuffers();
      toast.success(t('admin.retriedCount', { count: res.retriedCount }));
      const stats = await fetchSystemStats();
      setSystemStats(stats);
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, 'Lỗi khi thử lại đồng bộ'));
    } finally {
      setRetrying(false);
    }
  };

  const handleClearZips = async () => {
    setClearingZips(true);
    try {
      const res = await clearFailedZipJobs();
      toast.success(t('admin.clearedZipJobsCount', { count: res.deletedCount }));
      const stats = await fetchSystemStats();
      setSystemStats(stats);
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, 'Lỗi khi xoá lịch sử ZIP'));
    } finally {
      setClearingZips(false);
    }
  };

  if (loading || !summary) {
    return <Loader2 className="animate-spin text-blue-500 mx-auto mt-8" size={24} />;
  }

  return (
    <AdminDashboardOverview 
      summary={summary} 
      systemStats={systemStats} 
      onRetryAll={handleRetryAll} 
      retrying={retrying}
      onClearZips={handleClearZips}
      clearingZips={clearingZips}
      t={t} 
    />
  );
}
