'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchAdminLogFiles, getApiErrorMessage, readAdminLogs } from '@/lib/api';
import { ADMIN_LOGS_DEFAULT_LIMIT, ADMIN_LOGS_MAX_LIMIT } from '@/lib/constants';
import type { AdminLogEntry, AdminLogFile } from '@/lib/types';

export type FilterPreset = 'all' | 'errors' | 'app' | 'requests' | 'docker-noise';
export type FilterField = 'timestamp' | 'level' | 'context' | 'message' | 'stack' | 'raw';

export interface LogFilter {
  id: string;
  field: FilterField;
  value: string;
  negated: boolean;
}

export const FILTER_FIELDS: FilterField[] = ['timestamp', 'level', 'context', 'message', 'stack', 'raw'];

export function createFilter(field: FilterField = 'message', value = '', negated = false): LogFilter {
  return { id: `${field}-${Math.random().toString(36).slice(2, 10)}`, field, value, negated };
}

const DOCKER_NOISE_FILTERS = (): LogFilter[] => [
  createFilter('context', 'RequestLoggingInterceptor', true),
  createFilter('message', '/files/config', true),
  createFilter('message', '/api/files/config', true),
  createFilter('message', 'healthcheck', true),
  createFilter('message', 'kube-probe', true),
  createFilter('message', 'user-agent: wget', true),
];

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Admin log viewer state: file list, entry fetch, level/search/limit, and named filter presets. */
export function useAdminLogs(t: Translate) {
  const [files, setFiles] = useState<AdminLogFile[]>([]);
  const [selectedFile, setSelectedFile] = useState('');
  const [entries, setEntries] = useState<AdminLogEntry[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState('');
  const [search, setSearch] = useState('');
  const [newestFirst, setNewestFirst] = useState(true);
  const [limit, setLimit] = useState(ADMIN_LOGS_DEFAULT_LIMIT);
  const [preset, setPreset] = useState<FilterPreset>('docker-noise');
  const [filters, setFilters] = useState<LogFilter[]>(DOCKER_NOISE_FILTERS);

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
      if (!selectedFile && result.length > 0) setSelectedFile(result[0].name);
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
        newestFirst,
        filters: filters
          .map((f) => ({ field: f.field, value: f.value.trim(), negated: f.negated }))
          .filter((f) => f.value.length > 0),
      });
      setEntries(result.entries);
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, t('admin.logsLoadError')));
      setEntries([]);
    } finally {
      setLoadingEntries(false);
    }
  }, [selectedFile, limit, level, search, newestFirst, filters, t]);

  const applyPreset = useCallback((nextPreset: FilterPreset) => {
    setPreset(nextPreset);
    setNewestFirst(true);
    switch (nextPreset) {
      case 'all': setLevel(''); setFilters([]); break;
      case 'errors': setLevel('error'); setFilters([]); break;
      case 'app': setLevel(''); setFilters([createFilter('context', 'RequestLoggingInterceptor', true)]); break;
      case 'requests': setLevel(''); setFilters([createFilter('context', 'RequestLoggingInterceptor')]); break;
      case 'docker-noise': setLevel(''); setFilters(DOCKER_NOISE_FILTERS()); break;
    }
  }, []);

  const clampLimit = useCallback((raw: number) => {
    if (Number.isNaN(raw)) { setLimit(ADMIN_LOGS_DEFAULT_LIMIT); return; }
    setLimit(Math.min(ADMIN_LOGS_MAX_LIMIT, Math.max(1, raw)));
  }, []);

  useEffect(() => { loadFiles(); }, [loadFiles]);
  useEffect(() => { loadEntries(); }, [loadEntries]);

  return {
    files, selectedFile, setSelectedFile, selectedMeta,
    entries, loadingFiles, loadingEntries, error,
    level, setLevel, search, setSearch, newestFirst, setNewestFirst,
    limit, clampLimit, preset, applyPreset, filters, setFilters,
    loadFiles, loadEntries,
  };
}
