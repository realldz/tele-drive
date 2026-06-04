'use client';

import type { AdminDashboardSummary } from '@/lib/types';
import { formatBytes, type BufferStats } from '@/lib/api';
import { Loader2 } from 'lucide-react';

interface AdminDashboardOverviewProps {
  summary: AdminDashboardSummary;
  bufferStats: BufferStats | null;
  onRetryAll: () => Promise<void>;
  retrying: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
}

function StatCard({
  title,
  value,
  subtitle,
}: {
  title: string;
  value: string;
  subtitle?: string;
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
      <div className="text-sm font-medium text-gray-500">{title}</div>
      <div className="mt-2 text-3xl font-bold text-gray-900">{value}</div>
      {subtitle && <div className="mt-2 text-sm text-gray-500">{subtitle}</div>}
    </div>
  );
}

const formatAge = (ms: number) => {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h`;
};

export default function AdminDashboardOverview({
  summary,
  bufferStats,
  onRetryAll,
  retrying,
  t,
}: AdminDashboardOverviewProps) {
  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">{t('admin.dashboard')}</h1>
        <p className="text-sm text-gray-500 mt-1">{t('admin.dashboardDescription')}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard
          title={t('admin.totalUsers')}
          value={String(summary.totalUsers)}
          subtitle={`${summary.totalAdmins} ${t('admin.adminRole')}`}
        />
        <StatCard
          title={t('admin.totalFiles')}
          value={String(summary.totalFiles)}
          subtitle={`${summary.totalFolders} ${t('admin.totalFolders').toLowerCase()}`}
        />
        <StatCard
          title={t('admin.totalUsedSpace')}
          value={formatBytes(summary.totalUsedSpace)}
          subtitle={`${formatBytes(summary.totalQuota)} ${t('admin.totalQuota').toLowerCase()}`}
        />
        <StatCard
          title={t('admin.uploadsInProgress')}
          value={String(summary.totalUploadsInProgress)}
          subtitle={`${summary.totalS3Credentials} ${t('admin.activeS3Keys').toLowerCase()}`}
        />
      </div>

      {/* Buffer Dashboard */}
      {bufferStats && (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-gray-100 pb-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">{t('admin.bufferDashboard')}</h2>
              <p className="text-sm text-gray-500">{t('admin.bufferStatsDescription')}</p>
            </div>
            {bufferStats.failedCount > 0 && (
              <button
                onClick={onRetryAll}
                disabled={retrying}
                className="inline-flex items-center justify-center bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm px-4 py-2 rounded-xl transition-colors disabled:opacity-50 cursor-pointer"
              >
                {retrying ? (
                  <>
                    <Loader2 size={16} className="animate-spin mr-2" />
                    {t('dashboard.processing')}
                  </>
                ) : (
                  t('admin.retryAllFailed')
                )}
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
              <div className="text-xs font-medium text-slate-500 uppercase">{t('admin.bufferedCount')}</div>
              <div className="mt-2 text-2xl font-bold text-slate-900">{bufferStats.bufferedCount}</div>
            </div>
            
            <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
              <div className="text-xs font-medium text-slate-500 uppercase">{t('admin.bufferFailedCount')}</div>
              <div className="mt-2 text-2xl font-bold text-slate-900 flex items-center gap-2">
                <span>{bufferStats.failedCount}</span>
                {bufferStats.failedCount > 0 && (
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-ping" />
                )}
              </div>
            </div>

            <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
              <div className="text-xs font-medium text-slate-500 uppercase">{t('admin.tempStorageUsed')}</div>
              <div className="mt-2 text-2xl font-bold text-slate-900">
                {formatBytes(Number(bufferStats.tempStorageUsedBytes))}
              </div>
            </div>

            <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
              <div className="text-xs font-medium text-slate-500 uppercase">{t('admin.oldestBufferedAge')}</div>
              <div className="mt-2 text-2xl font-bold text-slate-900">
                {bufferStats.oldestBufferedAgeMs > 0 
                  ? formatAge(bufferStats.oldestBufferedAgeMs)
                  : '-'}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 xl:col-span-2">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            {t('admin.topUsersByUsage')}
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm min-w-[500px]">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="py-3 pr-4">{t('admin.account')}</th>
                  <th className="py-3 pr-4">{t('admin.usedQuota')}</th>
                  <th className="py-3">{t('admin.role')}</th>
                </tr>
              </thead>
              <tbody>
                {summary.topUsersByUsage.map((user) => (
                  <tr key={user.id} className="border-b border-gray-100 last:border-b-0">
                    <td className="py-3 pr-4 font-medium text-gray-800">{user.username}</td>
                    <td className="py-3 pr-4 text-gray-600">
                      {formatBytes(user.usedSpace)} / {formatBytes(user.quota)}
                    </td>
                    <td className="py-3 text-gray-500">{user.role}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">{t('admin.quickStats')}</h2>
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-500">{t('admin.trashFiles')}</span>
            <span className="font-semibold text-gray-900">{summary.totalTrashFiles}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-500">{t('admin.trashFolders')}</span>
            <span className="font-semibold text-gray-900">{summary.totalTrashFolders}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-500">{t('admin.totalFolders')}</span>
            <span className="font-semibold text-gray-900">{summary.totalFolders}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-500">{t('admin.activeS3Keys')}</span>
            <span className="font-semibold text-gray-900">{summary.totalS3Credentials}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
