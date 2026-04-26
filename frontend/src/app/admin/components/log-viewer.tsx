'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import { fetchAdminLogFiles, formatBytes, getApiErrorMessage, readAdminLogs } from '@/lib/api';
import type { AdminLogEntry, AdminLogFile } from '@/lib/types';

interface LogViewerProps {
  t: (key: string, vars?: Record<string, string | number>) => string;
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

export default function LogViewer({ t }: LogViewerProps) {
  const [files, setFiles] = useState<AdminLogFile[]>([]);
  const [selectedFile, setSelectedFile] = useState('');
  const [entries, setEntries] = useState<AdminLogEntry[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState('');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(100);

  const selectedMeta = useMemo(
    () => files.find((file) => file.name === selectedFile) || null,
    [files, selectedFile],
  );

  const loadFiles = useCallback(async () => {
    setLoadingFiles(true);
    setError(null);
    try {
      const result = await fetchAdminLogFiles();
      setFiles(result);
      if (!selectedFile && result.length > 0) {
        setSelectedFile(result[0].name);
      }
      if (selectedFile && !result.some((file) => file.name === selectedFile)) {
        setSelectedFile(result[0]?.name || '');
      }
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, t('admin.logsLoadError')));
    } finally {
      setLoadingFiles(false);
    }
  }, [selectedFile, t]);

  const loadEntries = useCallback(async () => {
    if (!selectedFile) {
      setEntries([]);
      return;
    }

    setLoadingEntries(true);
    setError(null);
    try {
      const result = await readAdminLogs({
        file: selectedFile,
        limit,
        level: level || undefined,
        search: search.trim() || undefined,
      });
      setEntries(result.entries);
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, t('admin.logsLoadError')));
      setEntries([]);
    } finally {
      setLoadingEntries(false);
    }
  }, [selectedFile, limit, level, search, t]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">{t('admin.logs')}</h2>
        <p className="text-sm text-gray-500 mt-1">{t('admin.logsDescription')}</p>
      </div>

      <div className="bg-white border border-gray-200 rounded-2xl p-4 md:p-5 shadow-sm space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <label className="space-y-1">
            <span className="text-sm font-medium text-gray-700">{t('admin.logsFile')}</span>
            <select
              value={selectedFile}
              onChange={(e) => setSelectedFile(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 bg-white text-sm"
              disabled={loadingFiles || files.length === 0}
            >
              {files.map((file) => (
                <option key={file.name} value={file.name}>
                  {file.name}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1">
            <span className="text-sm font-medium text-gray-700">{t('admin.logsLevel')}</span>
            <select
              value={level}
              onChange={(e) => setLevel(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 bg-white text-sm"
            >
              <option value="">{t('admin.logsAllLevels')}</option>
              <option value="error">error</option>
              <option value="warn">warn</option>
              <option value="log">log</option>
              <option value="info">info</option>
              <option value="debug">debug</option>
              <option value="verbose">verbose</option>
            </select>
          </label>

          <label className="space-y-1">
            <span className="text-sm font-medium text-gray-700">{t('admin.logsLimit')}</span>
            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 bg-white text-sm"
            >
              {[50, 100, 200, 500].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1">
            <span className="text-sm font-medium text-gray-700">{t('admin.logsSearch')}</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('admin.logsSearchPlaceholder')}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-gray-500 flex flex-wrap items-center gap-3">
            {selectedMeta && (
              <>
                <span>{formatBytes(selectedMeta.sizeBytes)}</span>
                <span>{new Date(selectedMeta.modifiedAt).toLocaleString()}</span>
                <span className="inline-flex items-center rounded-full border border-gray-200 px-2 py-0.5 text-xs font-medium text-gray-600">
                  {selectedMeta.compressed
                    ? t('admin.logsArchived')
                    : t('admin.logsCurrent')}
                </span>
              </>
            )}
          </div>

          <button
            type="button"
            onClick={() => {
              void loadFiles();
              void loadEntries();
            }}
            disabled={loadingFiles || loadingEntries}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
          >
            {loadingEntries || loadingFiles ? (
              <Loader2 className="animate-spin" size={16} />
            ) : (
              <RefreshCw size={16} />
            )}
            {t('admin.logsRefresh')}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 flex items-start gap-3">
          <AlertCircle size={18} className="mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <span className="font-medium text-gray-900">{t('admin.logsEntries')}</span>
          <span className="text-sm text-gray-500">{entries.length}</span>
        </div>

        {loadingEntries ? (
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
              return (
                <details key={`${entry.timestamp || 'no-ts'}-${index}`} className="group">
                  <summary className="list-none cursor-pointer px-4 py-4 hover:bg-gray-50">
                    <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                      <div className="min-w-0 space-y-2">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                          <span>{entry.timestamp || '-'}</span>
                          <span
                            className={`inline-flex rounded-full border px-2 py-0.5 font-semibold ${LEVEL_COLORS[levelKey] || LEVEL_COLORS.unknown}`}
                          >
                            {entry.level || 'unknown'}
                          </span>
                          {entry.context && (
                            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-600">
                              {entry.context}
                            </span>
                          )}
                          {entry.ms && <span>{entry.ms}</span>}
                        </div>
                        <p className="text-sm text-gray-900 break-words whitespace-pre-wrap">
                          {entry.message}
                        </p>
                      </div>
                      {(entry.stack || entry.raw !== undefined) && (
                        <span className="text-xs text-blue-600 font-medium group-open:hidden">
                          {t('admin.logsExpand')}
                        </span>
                      )}
                    </div>
                  </summary>

                  {(entry.stack || entry.raw !== undefined) && (
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
    </section>
  );
}
