'use client';

import type { AdminDashboardSummary } from '@/lib/types';
import { formatBytes } from '@/lib/api';

interface AdminDashboardOverviewProps {
  summary: AdminDashboardSummary;
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

export default function AdminDashboardOverview({
  summary,
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
