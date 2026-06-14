'use client';

import { Loader2 } from 'lucide-react';
import type { AdminLogEntry } from '@/lib/types';

interface LogEntryListProps {
  t: (key: string, vars?: Record<string, string | number>) => string;
  entries: AdminLogEntry[];
  loading: boolean;
}

const LEVEL_COLORS: Record<string, string> = {
  error: 'bg-red-100 text-red-700 border-red-200',
  warn: 'bg-amber-100 text-amber-700 border-amber-200',
  log: 'bg-blue-100 text-blue-700 border-blue-200',
  info: 'bg-blue-100 text-blue-700 border-blue-200',
  debug: 'bg-slate-100 text-slate-700 border-slate-200',
  verbose: 'bg-violet-100 text-violet-700 border-violet-200',
  unknown: 'bg-gray-100 text-gray-700 border-gray-200',
};

function formatUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

export default function LogEntryList({ t, entries, loading }: LogEntryListProps) {
  return (
    <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
        <span className="font-medium text-gray-900">{t('admin.logsEntries')}</span>
        <span className="text-sm text-gray-500">{entries.length}</span>
      </div>

      {loading ? (
        <div className="py-16 text-center text-gray-500">
          <Loader2 className="animate-spin mx-auto mb-3 text-blue-500" size={24} />
          {t('admin.logsLoading')}
        </div>
      ) : entries.length === 0 ? (
        <div className="py-16 text-center text-gray-500">{t('admin.logsNoEntries')}</div>
      ) : (
        <div className="divide-y divide-gray-100">
          {entries.map((entry, index) => {
            const levelKey = (entry.level || 'unknown').toLowerCase();
            const hasDetails = entry.stack || entry.raw !== undefined;
            return (
              <details key={`${entry.timestamp || 'no-ts'}-${index}`} className="group">
                <summary className="list-none cursor-pointer px-4 py-4 hover:bg-gray-50">
                  <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                        <span>{entry.timestamp || '-'}</span>
                        <span className={`inline-flex rounded-full border px-2 py-0.5 font-semibold ${LEVEL_COLORS[levelKey] || LEVEL_COLORS.unknown}`}>
                          {entry.level || 'unknown'}
                        </span>
                        {entry.context && (
                          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-600">{entry.context}</span>
                        )}
                        {entry.ms && <span>{entry.ms}</span>}
                      </div>
                      <p className="text-sm text-gray-900 break-words whitespace-pre-wrap">{entry.message}</p>
                    </div>
                    {hasDetails && (
                      <span className="text-xs text-blue-600 font-medium group-open:hidden">{t('admin.logsExpand')}</span>
                    )}
                  </div>
                </summary>

                {hasDetails && (
                  <div className="px-4 pb-4 space-y-3 bg-gray-50 border-t border-gray-100">
                    {entry.stack && (
                      <pre className="overflow-x-auto rounded-lg bg-slate-950 text-slate-100 p-3 text-xs whitespace-pre-wrap break-words">
                        {entry.stack}
                      </pre>
                    )}
                    {entry.raw !== undefined && typeof entry.raw !== 'string' && (
                      <pre className="overflow-x-auto rounded-lg bg-slate-900 text-slate-100 p-3 text-xs whitespace-pre-wrap break-words">
                        {formatUnknown(entry.raw)}
                      </pre>
                    )}
                    {typeof entry.raw === 'string' && entry.raw !== entry.message && (
                      <pre className="overflow-x-auto rounded-lg bg-slate-900 text-slate-100 p-3 text-xs whitespace-pre-wrap break-words">
                        {formatUnknown(entry.raw)}
                      </pre>
                    )}
                  </div>
                )}
              </details>
            );
          })}
        </div>
      )}
    </div>
  );
}
