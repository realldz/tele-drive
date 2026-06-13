'use client';

import { AlertCircle } from 'lucide-react';
import { useAdminLogs } from './use-admin-logs';
import LogFilterBar from './log-filter-bar';
import LogEntryList from './log-entry-list';

interface LogViewerProps {
  t: (key: string, vars?: Record<string, string | number>) => string;
}

export default function LogViewer({ t }: LogViewerProps) {
  const logs = useAdminLogs(t);

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">{t('admin.logs')}</h2>
        <p className="text-sm text-gray-500 mt-1">{t('admin.logsDescription')}</p>
      </div>

      <LogFilterBar
        t={t}
        files={logs.files}
        selectedFile={logs.selectedFile}
        setSelectedFile={logs.setSelectedFile}
        selectedMeta={logs.selectedMeta}
        loadingFiles={logs.loadingFiles}
        loadingEntries={logs.loadingEntries}
        level={logs.level}
        setLevel={logs.setLevel}
        search={logs.search}
        setSearch={logs.setSearch}
        limit={logs.limit}
        clampLimit={logs.clampLimit}
        newestFirst={logs.newestFirst}
        setNewestFirst={logs.setNewestFirst}
        preset={logs.preset}
        applyPreset={logs.applyPreset}
        filters={logs.filters}
        setFilters={logs.setFilters}
        onRefresh={() => { void logs.loadFiles(); void logs.loadEntries(); }}
      />

      {logs.error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 flex items-start gap-3">
          <AlertCircle size={18} className="mt-0.5 flex-shrink-0" />
          <span>{logs.error}</span>
        </div>
      )}

      <LogEntryList t={t} entries={logs.entries} loading={logs.loadingEntries} />
    </section>
  );
}
