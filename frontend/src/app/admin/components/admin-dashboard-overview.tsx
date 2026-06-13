'use client';

import type { AdminDashboardSummary } from '@/lib/types';
import { formatBytes, type SystemStats } from '@/lib/api';
import { Loader2 } from 'lucide-react';

interface AdminDashboardOverviewProps {
  summary: AdminDashboardSummary;
  systemStats: SystemStats | null;
  onRetryAll: () => Promise<void>;
  retrying: boolean;
  onClearZips: () => Promise<void>;
  clearingZips: boolean;
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

const formatUptime = (sec: number) => {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
      <div className="text-xs font-medium text-slate-500 uppercase">{label}</div>
      <div className="mt-2 text-2xl font-bold text-slate-900">{value}</div>
    </div>
  );
}

export default function AdminDashboardOverview({
  summary,
  systemStats,
  onRetryAll,
  retrying,
  onClearZips,
  clearingZips,
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
      {systemStats?.buffer && (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-gray-100 pb-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">{t('admin.bufferDashboard')}</h2>
              <p className="text-sm text-gray-500">{t('admin.bufferStatsDescription')}</p>
            </div>
            {systemStats.buffer.failedCount > 0 && (
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
              <div className="mt-2 text-2xl font-bold text-slate-900">{systemStats.buffer.bufferedCount}</div>
            </div>
            
            <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
              <div className="text-xs font-medium text-slate-500 uppercase">{t('admin.bufferFailedCount')}</div>
              <div className="mt-2 text-2xl font-bold text-slate-900 flex items-center gap-2">
                <span>{systemStats.buffer.failedCount}</span>
                {systemStats.buffer.failedCount > 0 && (
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-ping" />
                )}
              </div>
            </div>

            <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
              <div className="text-xs font-medium text-slate-500 uppercase">{t('admin.tempStorageUsed')}</div>
              <div className="mt-2 text-2xl font-bold text-slate-900">
                {formatBytes(Number(systemStats.buffer.tempStorageUsedBytes))}
              </div>
            </div>

            <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
              <div className="text-xs font-medium text-slate-500 uppercase">{t('admin.oldestBufferedAge')}</div>
              <div className="mt-2 text-2xl font-bold text-slate-900">
                {systemStats.buffer.oldestBufferedAgeMs > 0 
                  ? formatAge(systemStats.buffer.oldestBufferedAgeMs)
                  : '-'}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ZIP Dashboard */}
      {systemStats?.zip && (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-gray-100 pb-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">{t('admin.zipDashboard')}</h2>
              <p className="text-sm text-gray-500">{t('admin.zipStatsDescription')}</p>
            </div>
            {systemStats.zip.failedCount > 0 && (
              <button
                onClick={onClearZips}
                disabled={clearingZips}
                className="inline-flex items-center justify-center bg-red-600 hover:bg-red-700 text-white font-medium text-sm px-4 py-2 rounded-xl transition-colors disabled:opacity-50 cursor-pointer"
              >
                {clearingZips ? (
                  <>
                    <Loader2 size={16} className="animate-spin mr-2" />
                    {t('dashboard.processing')}
                  </>
                ) : (
                  t('admin.clearFailedZips')
                )}
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
              <div className="text-xs font-medium text-slate-500 uppercase">{t('admin.activeZipJobs')}</div>
              <div className="mt-2 text-2xl font-bold text-slate-900">{systemStats.zip.activeCount}</div>
            </div>
            
            <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
              <div className="text-xs font-medium text-slate-500 uppercase">{t('admin.readyZipJobs')}</div>
              <div className="mt-2 text-2xl font-bold text-slate-900">{systemStats.zip.readyCount}</div>
            </div>

            <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
              <div className="text-xs font-medium text-slate-500 uppercase">{t('admin.failedZipJobs')}</div>
              <div className="mt-2 text-2xl font-bold text-slate-900 flex items-center gap-2">
                <span>{systemStats.zip.failedCount}</span>
                {systemStats.zip.failedCount > 0 && (
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-ping" />
                )}
              </div>
            </div>

            <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
              <div className="text-xs font-medium text-slate-500 uppercase">{t('admin.zipTempStorageUsed')}</div>
              <div className="mt-2 text-2xl font-bold text-slate-900">
                {formatBytes(Number(systemStats.zip.tempStorageUsedBytes))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Go Transfer Service */}
      {systemStats?.go && (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 space-y-6">
          <div className="border-b border-gray-100 pb-4">
            <h2 className="text-lg font-semibold text-gray-900">{t('admin.goServiceDashboard')}</h2>
            <p className="text-sm text-gray-500">{t('admin.goServiceDescription')}</p>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-3">{t('admin.goWorkerPool')}</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <MetricTile label={t('admin.goPoolSize')} value={String(systemStats.go.workerPool.size)} />
              <MetricTile label={t('admin.goActiveJobs')} value={String(systemStats.go.workerPool.activeJobs)} />
              <MetricTile label={t('admin.goPendingQueue')} value={String(systemStats.go.workerPool.pendingQueue)} />
              <MetricTile label={t('admin.goDelayedQueue')} value={String(systemStats.go.workerPool.delayedQueue)} />
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-3">{t('admin.goTelegram')}</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <MetricTile label={t('admin.goBotCount')} value={String(systemStats.go.telegram.botCount)} />
              <MetricTile
                label={t('admin.goSemaphore')}
                value={`${systemStats.go.telegram.semaphoreUsed} / ${systemStats.go.telegram.semaphoreCapacity}`}
              />
              <MetricTile
                label={t('admin.goBufferUsed')}
                value={`${formatBytes(systemStats.go.storage.bufferUsedBytes)} / ${formatBytes(systemStats.go.storage.bufferCapacityBytes)}`}
              />
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                <div className="text-xs font-medium text-slate-500 uppercase">{t('admin.goGrpcStatus')}</div>
                <div className="mt-2 text-2xl font-bold text-slate-900 flex items-center gap-2">
                  <span className={`w-2.5 h-2.5 rounded-full ${systemStats.go.grpc.coreConnected ? 'bg-green-500' : 'bg-red-500'}`} />
                  <span>{systemStats.go.grpc.coreConnected ? t('admin.goConnected') : t('admin.goDisconnected')}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* NestJS Process */}
      {systemStats?.nestjs && (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 space-y-6">
          <div className="border-b border-gray-100 pb-4">
            <h2 className="text-lg font-semibold text-gray-900">{t('admin.nestjsDashboard')}</h2>
            <p className="text-sm text-gray-500">{t('admin.nestjsDescription')}</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <MetricTile label={t('admin.nestjsUptime')} value={formatUptime(systemStats.nestjs.uptime)} />
            <MetricTile label={t('admin.nestjsMemoryRss')} value={formatBytes(Number(systemStats.nestjs.memoryRss))} />
            <MetricTile label={t('admin.nestjsHeapUsed')} value={formatBytes(Number(systemStats.nestjs.memoryHeapUsed))} />
            <MetricTile label={t('admin.nestjsHeapTotal')} value={formatBytes(Number(systemStats.nestjs.memoryHeapTotal))} />
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
