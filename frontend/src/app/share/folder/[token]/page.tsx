'use client';

import { useParams } from 'next/navigation';
import { AlertCircle, ChevronRight, Home, UserCircle2, LayoutGrid, List, Download } from 'lucide-react';
import { useI18n } from '@/providers/i18n-context';
import { useAuth } from '@/providers/auth-context';
import SelectionActionBar from '@/components/molecules/selection-action-bar';
import ContextMenu from '@/components/molecules/context-menu';
import GuestLanguageSwitcher from '@/components/guest-language-switcher';
import FileGrid from '@/components/file-grid';
import SharedFolderPreviewModal from './shared-folder-preview-modal';
import { useSharedFolder } from './use-shared-folder';

export default function SharedFolderPage() {
  const params = useParams();
  const token = params.token as string;
  const { t } = useI18n();
  const { user } = useAuth();

  const {
    rootFolder, folders, files, breadcrumbs, error, isLoading,
    hasMore, loadMoreRef, downloadingFiles, previewFile, setPreviewFile,
    viewMode, setViewMode, sortField, sortDirection, handleSort,
    selection, contextMenu, setCurrentFolderId,
    handleDownload, handleBatchDownload, openContextMenu, handleItemClick,
  } = useSharedFolder(token);

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
        <GuestLanguageSwitcher />
        <div className="flex flex-col items-center bg-white p-8 rounded-2xl shadow-sm">
          <div className="w-16 h-16 bg-red-100 text-red-500 rounded-full flex items-center justify-center mb-4">
            <AlertCircle size={32} />
          </div>
          <h2 className="text-xl font-semibold text-gray-800 mb-2">{t('shareFolder.cannotAccess')}</h2>
          <p className="text-gray-500">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-8">
      <GuestLanguageSwitcher />
      <div className="max-w-5xl mx-auto bg-white shadow-sm rounded-2xl overflow-hidden border border-gray-100">
        {/* Header */}
        <div className="bg-slate-900 justify-between items-center text-white p-6 flex">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Tele-Drive</h1>
            <p className="text-slate-400 text-sm mt-1">
              {t('shareFolder.sharedBy')}: <span className="text-slate-200">{rootFolder?.user?.username || t('shareFolder.user')}</span>
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleBatchDownload}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-semibold bg-blue-600 hover:bg-blue-500 rounded-lg text-white transition-colors cursor-pointer shadow-sm hover:scale-102 active:scale-98"
            >
              <Download size={16} />
              <span className="hidden sm:inline">{t('downloadZip.downloadAll')}</span>
            </button>
            <div className="flex bg-slate-800 p-1 rounded-lg">
              <button
                onClick={() => setViewMode('grid')}
                className={`p-1.5 rounded-md transition-all ${viewMode === 'grid' ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                title={t('dashboard.gridView')}
              >
                <LayoutGrid size={18} />
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={`p-1.5 rounded-md transition-all ${viewMode === 'list' ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                title={t('dashboard.listView')}
              >
                <List size={18} />
              </button>
            </div>
            {user && (
              <div className="flex items-center gap-2 text-slate-300 text-sm bg-slate-800 px-3 py-2 rounded-lg">
                <UserCircle2 size={16} />
                <span className="font-medium">{user.username}</span>
              </div>
            )}
          </div>
        </div>

        <div className="p-6">
          {/* Breadcrumbs */}
          <div className="flex items-center text-sm text-gray-600 mb-6 bg-gray-50 px-4 py-3 rounded-xl overflow-x-auto">
            <button
              onClick={() => setCurrentFolderId(undefined)}
              className="hover:text-blue-600 transition-colors flex items-center gap-1 font-medium whitespace-nowrap"
            >
              <Home size={16} /> {t('shareFolder.shareHome')}
            </button>

            {breadcrumbs.map((crumb, index) => (
              <div key={crumb.id} className="flex items-center whitespace-nowrap">
                <ChevronRight size={16} className="mx-1 text-gray-400" />
                <button
                  onClick={() => setCurrentFolderId(crumb.id)}
                  className={`hover:text-blue-600 transition-colors ${index === breadcrumbs.length - 1 ? 'text-gray-900 font-semibold' : 'font-medium'}`}
                >
                  {crumb.name}
                </button>
              </div>
            ))}
          </div>

          {/* Content */}
          <FileGrid
            folders={folders}
            files={files}
            viewMode={viewMode}
            sortField={sortField}
            sortDirection={sortDirection}
            onSort={handleSort}
            downloadingFiles={downloadingFiles}
            hasMore={hasMore}
            loadMoreRef={loadMoreRef}
            isLoadingContent={isLoading}
            emptyMessage={t('shareFolder.emptyFolder')}
            onItemClick={handleItemClick}
            onDownload={handleDownload}
            selection={selection}
            onContextMenu={openContextMenu}
          />
        </div>
      </div>

      <SharedFolderPreviewModal
        shareToken={token}
        file={previewFile}
        onClose={() => setPreviewFile(null)}
      />

      {contextMenu.isOpen && contextMenu.item && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} itemType={contextMenu.type}
          selectionCount={selection.selectedCount}
          onDownload={handleBatchDownload}
        />
      )}

      <SelectionActionBar
        selectedCount={selection.selectedCount}
        onClear={selection.clearSelection}
        variant="shared"
        onDownload={handleBatchDownload}
      />
    </div>
  );
}
