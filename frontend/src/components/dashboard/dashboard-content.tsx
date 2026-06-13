import { Folder, Loader2 } from 'lucide-react';
import { useI18n } from '@/providers/i18n-context';
import DashboardGridView from './dashboard-grid-view';
import DashboardListView from './dashboard-list-view';
import type { DashboardViewProps, SortField, SortDirection } from './dashboard-view-props';

interface DashboardContentProps extends DashboardViewProps {
  isLoadingContent: boolean;
  filteredFoldersCount: number;
  filteredFilesCount: number;
  viewMode: 'grid' | 'list';
  searchQuery: string;
  sortField: SortField;
  sortDirection: SortDirection;
  onSort: (field: SortField) => void;
  hasMore: boolean;
  loadMoreRef: React.RefObject<HTMLDivElement | null>;
}

export default function DashboardContent(props: DashboardContentProps) {
  const {
    isLoadingContent, visibleFolders, visibleFiles,
    filteredFoldersCount, filteredFilesCount,
    viewMode, searchQuery, sortField, sortDirection, onSort,
    hasMore, loadMoreRef,
  } = props;
  const { t } = useI18n();

  // Loading state
  if (isLoadingContent && visibleFolders.length === 0 && visibleFiles.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="animate-spin text-blue-500" size={32} />
      </div>
    );
  }

  // Empty state
  if (filteredFoldersCount === 0 && filteredFilesCount === 0) {
    return (
      <div className="text-center py-20 bg-gray-50/50 rounded-2xl border-2 border-dashed border-gray-200 mt-4">
        <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center mx-auto mb-4 shadow-sm border border-gray-100">
          <Folder className="text-gray-300" size={32} />
        </div>
        <p className="text-gray-500 font-medium">
          {searchQuery ? t('dashboard.noResults') : t('dashboard.emptyFolder')}
        </p>
      </div>
    );
  }

  return (
    <>
      {viewMode === 'grid'
        ? <DashboardGridView {...props} />
        : <DashboardListView {...props} sortField={sortField} sortDirection={sortDirection} onSort={onSort} />}

      {hasMore && (<div ref={loadMoreRef} className="py-4 text-center text-gray-400 text-sm">{t('dashboard.loading')}</div>)}
    </>
  );
}
