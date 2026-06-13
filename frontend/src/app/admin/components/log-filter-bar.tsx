'use client';

import { Loader2, RefreshCw } from 'lucide-react';
import { formatBytes } from '@/lib/api';
import { FILTER_FIELDS, createFilter, type FilterPreset, type FilterField, type LogFilter } from './use-admin-logs';
import type { AdminLogFile } from '@/lib/types';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

interface LogFilterBarProps {
  t: Translate;
  files: AdminLogFile[];
  selectedFile: string;
  setSelectedFile: (name: string) => void;
  selectedMeta: AdminLogFile | null;
  loadingFiles: boolean;
  loadingEntries: boolean;
  level: string;
  setLevel: (v: string) => void;
  search: string;
  setSearch: (v: string) => void;
  limit: number;
  clampLimit: (n: number) => void;
  newestFirst: boolean;
  setNewestFirst: (v: boolean) => void;
  preset: FilterPreset;
  applyPreset: (p: FilterPreset) => void;
  filters: LogFilter[];
  setFilters: React.Dispatch<React.SetStateAction<LogFilter[]>>;
  onRefresh: () => void;
}

const PRESETS: Array<[FilterPreset, string]> = [
  ['docker-noise', 'admin.logsPresetDockerNoise'],
  ['app', 'admin.logsPresetApp'],
  ['requests', 'admin.logsPresetRequests'],
  ['errors', 'admin.logsPresetErrors'],
  ['all', 'admin.logsPresetAll'],
];

export default function LogFilterBar(props: LogFilterBarProps) {
  const {
    t, files, selectedFile, setSelectedFile, selectedMeta, loadingFiles, loadingEntries,
    level, setLevel, search, setSearch, limit, clampLimit, newestFirst, setNewestFirst,
    preset, applyPreset, filters, setFilters, onRefresh,
  } = props;

  const patchFilter = (id: string, patch: Partial<LogFilter>) =>
    setFilters((cur) => cur.map((item) => (item.id === id ? { ...item, ...patch } : item)));

  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-4 md:p-5 shadow-sm space-y-4">
      <div className="flex flex-wrap gap-2">
        {PRESETS.map(([value, labelKey]) => (
          <button
            key={value}
            type="button"
            onClick={() => applyPreset(value)}
            className={`rounded-full border px-3 py-1.5 text-sm transition ${
              preset === value
                ? 'border-blue-600 bg-blue-50 text-blue-700'
                : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>

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
              <option key={file.name} value={file.name}>{file.name}</option>
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
          <input
            type="number"
            value={limit}
            min={1}
            max={5000}
            step={100}
            onChange={(e) => clampLimit(Number(e.target.value))}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
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

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-gray-700">{t('admin.logsFilters')}</span>
          <button
            type="button"
            onClick={() => setFilters((cur) => [...cur, createFilter('message', '', false)])}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            {t('admin.logsAddFilter')}
          </button>
        </div>

        {filters.length === 0 ? (
          <div className="text-sm text-gray-500">{t('admin.logsNoFilters')}</div>
        ) : (
          <div className="space-y-2">
            {filters.map((filter) => (
              <div key={filter.id} className="grid grid-cols-1 md:grid-cols-[90px_180px_1fr_110px] gap-2">
                <button
                  type="button"
                  onClick={() => patchFilter(filter.id, { negated: !filter.negated })}
                  className={`rounded-lg border px-3 py-2 text-sm font-semibold ${
                    filter.negated ? 'border-red-300 bg-red-50 text-red-700' : 'border-gray-300 bg-white text-gray-700'
                  }`}
                >
                  {filter.negated ? '!' : '='}
                </button>

                <select
                  value={filter.field}
                  onChange={(e) => patchFilter(filter.id, { field: e.target.value as FilterField })}
                  className="rounded-lg border border-gray-300 px-3 py-2 bg-white text-sm"
                >
                  {FILTER_FIELDS.map((field) => (
                    <option key={field} value={field}>{field}</option>
                  ))}
                </select>

                <input
                  value={filter.value}
                  onChange={(e) => patchFilter(filter.id, { value: e.target.value })}
                  placeholder={t('admin.logsFilterValuePlaceholder')}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />

                <button
                  type="button"
                  onClick={() => setFilters((cur) => cur.filter((item) => item.id !== filter.id))}
                  className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  {t('admin.logsRemoveFilter')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <label className="flex items-center gap-3 rounded-lg border border-gray-200 px-3 py-2">
        <input
          type="checkbox"
          checked={newestFirst}
          onChange={(e) => setNewestFirst(e.target.checked)}
          className="h-4 w-4 rounded border-gray-300"
        />
        <span className="text-sm text-gray-700">{t('admin.logsNewestFirst')}</span>
      </label>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-gray-500 flex flex-wrap items-center gap-3">
          {selectedMeta && (
            <>
              <span>{formatBytes(selectedMeta.sizeBytes)}</span>
              <span>{new Date(selectedMeta.modifiedAt).toLocaleString()}</span>
              <span className="inline-flex items-center rounded-full border border-gray-200 px-2 py-0.5 text-xs font-medium text-gray-600">
                {selectedMeta.compressed ? t('admin.logsArchived') : t('admin.logsCurrent')}
              </span>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={onRefresh}
          disabled={loadingFiles || loadingEntries}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
        >
          {loadingEntries || loadingFiles ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />}
          {t('admin.logsRefresh')}
        </button>
      </div>
    </div>
  );
}
