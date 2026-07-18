'use client';

import { useI18n } from '@/providers/i18n-context';
import {
  SEARCH_FORMAT_CATEGORIES,
  SEARCH_TIME_PRESETS,
} from '@/lib/constants';
import type { SearchFilters } from '@/hooks/use-global-search';
import type { SearchTypeFilter, SearchTimePresetKey } from '@/lib/constants';

interface SearchFilterBarProps {
  filters: SearchFilters;
  setFilters: React.Dispatch<React.SetStateAction<SearchFilters>>;
}

const TYPES: SearchTypeFilter[] = ['all', 'folder', 'file'];

/**
 * Filter controls for search mode: type segmented control, format-category
 * dropdown, time-range preset + custom date pickers. Emits changes up to
 * useGlobalSearch via setFilters. Format is disabled when type=folder (folders
 * have no format). Custom dates override the preset in the hook's resolver.
 */
export default function SearchFilterBar({ filters, setFilters }: SearchFilterBarProps) {
  const { t } = useI18n();

  const setType = (type: SearchTypeFilter) =>
    // Clear format when switching to folders — folders have no format concept.
    setFilters(prev => ({ ...prev, type, format: type === 'folder' ? null : prev.format }));

  const setFormat = (format: string) =>
    setFilters(prev => ({ ...prev, format: format || null }));

  const setPreset = (timePreset: SearchTimePresetKey) =>
    setFilters(prev => ({ ...prev, timePreset, customFrom: null, customTo: null }));

  const setCustom = (key: 'customFrom' | 'customTo', value: string) =>
    setFilters(prev => ({ ...prev, [key]: value || null }));

  const formatDisabled = filters.type === 'folder';

  return (
    <div className="flex flex-wrap items-center gap-3 px-2 md:px-6 py-3 border-b border-gray-100 bg-gray-50/60">
      {/* Type segmented control */}
      <div className="flex bg-white p-1 rounded-lg border border-gray-200">
        {TYPES.map(type => (
          <button
            key={type}
            onClick={() => setType(type)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
              filters.type === type
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t(`search.type.${type}`)}
          </button>
        ))}
      </div>

      {/* Format category dropdown */}
      <label className="flex items-center gap-2 text-sm">
        <span className="text-gray-500">{t('search.format.label')}</span>
        <select
          value={filters.format ?? ''}
          onChange={e => setFormat(e.target.value)}
          disabled={formatDisabled}
          className="px-2 py-1.5 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <option value="">{t('search.format.all')}</option>
          {SEARCH_FORMAT_CATEGORIES.map(cat => (
            <option key={cat} value={cat}>{t(`search.format.${cat}`)}</option>
          ))}
        </select>
      </label>

      {/* Time preset dropdown */}
      <label className="flex items-center gap-2 text-sm">
        <span className="text-gray-500">{t('search.time.label')}</span>
        <select
          value={filters.customFrom || filters.customTo ? 'custom' : filters.timePreset}
          onChange={e => {
            if (e.target.value === 'custom') {
              // Switch to custom mode by seeding an empty range; user picks dates.
              setFilters(prev => ({ ...prev, timePreset: 'all', customFrom: '', customTo: '' }));
            } else {
              setPreset(e.target.value as SearchTimePresetKey);
            }
          }}
          className="px-2 py-1.5 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:border-blue-500"
        >
          {SEARCH_TIME_PRESETS.map(p => (
            <option key={p.key} value={p.key}>{t(`search.time.${p.key}`)}</option>
          ))}
          <option value="custom">{t('search.time.custom')}</option>
        </select>
      </label>

      {/* Custom date range — shown only when either custom bound is set (non-null) */}
      {(filters.customFrom !== null || filters.customTo !== null) && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-gray-500">{t('search.time.from')}</span>
          <input
            type="date"
            value={filters.customFrom ?? ''}
            onChange={e => setCustom('customFrom', e.target.value)}
            className="px-2 py-1.5 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:border-blue-500"
          />
          <span className="text-gray-500">{t('search.time.to')}</span>
          <input
            type="date"
            value={filters.customTo ?? ''}
            onChange={e => setCustom('customTo', e.target.value)}
            className="px-2 py-1.5 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:border-blue-500"
          />
        </div>
      )}
    </div>
  );
}
