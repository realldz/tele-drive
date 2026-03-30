import React from 'react';
import { Search, Plus, FolderPlus, File, FolderOpen, LayoutGrid, List } from 'lucide-react';
import { useI18n } from '@/components/i18n-context';

interface DashboardTopbarProps {
  showMobileSearch: boolean;
  setShowMobileSearch: React.Dispatch<React.SetStateAction<boolean>>;
  searchQuery: string;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  showNewMenu: boolean;
  setShowNewMenu: React.Dispatch<React.SetStateAction<boolean>>;
  newMenuRef: React.RefObject<HTMLDivElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  folderInputRef: React.RefObject<HTMLInputElement | null>;
  currentFolderId: string | undefined;
  addFiles: (files: FileList, folderId?: string) => void;
  addFolder: (files: FileList, folderId?: string) => void;
  viewMode: 'grid' | 'list';
  setViewMode: React.Dispatch<React.SetStateAction<'grid' | 'list'>>;
  setShowCreateFolder: React.Dispatch<React.SetStateAction<boolean>>;
}

export default function DashboardTopbar({
  showMobileSearch,
  setShowMobileSearch,
  searchQuery,
  setSearchQuery,
  showNewMenu,
  setShowNewMenu,
  newMenuRef,
  fileInputRef,
  folderInputRef,
  currentFolderId,
  addFiles,
  addFolder,
  viewMode,
  setViewMode,
  setShowCreateFolder,
}: DashboardTopbarProps) {
  const { t } = useI18n();

  return (
    <header className="h-16 border-b border-gray-100 flex items-center justify-between pl-14 pr-4 md:px-4 lg:px-6 bg-white w-full flex-shrink-0 z-10">
      <div className={`flex items-center gap-4 flex-1 ${showMobileSearch ? '' : 'hidden md:flex'}`}>
        <div className="relative max-w-xl w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
          <input
            type="text"
            placeholder={t('dashboard.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-gray-50 border border-gray-200 focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-50 rounded-xl outline-none transition-all text-sm font-medium"
          />
        </div>
      </div>

      <div className="flex items-center gap-2 ml-auto">
        <button onClick={() => setShowMobileSearch(!showMobileSearch)} className="md:hidden p-2 text-gray-500 hover:bg-gray-100 rounded-lg">
          <Search size={20} />
        </button>

        <div className="relative" ref={newMenuRef}>
          <button
            onClick={() => setShowNewMenu(!showNewMenu)}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded-lg font-medium transition-colors text-white text-sm shadow-sm"
          >
            <Plus size={16} /> <span className="hidden sm:inline">{t('dashboard.new')}</span>
          </button>
          {showNewMenu && (
            <div className="absolute right-0 mt-2 w-52 bg-white border border-gray-200 rounded-lg shadow-lg z-20 py-1">
              <button
                onClick={() => { setShowNewMenu(false); setShowCreateFolder(true); }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
              >
                <FolderPlus size={16} className="text-blue-500" /> {t('dashboard.newFolder')}
              </button>
              <div className="border-t border-gray-100 my-1" />
              <button
                onClick={() => { fileInputRef.current?.click(); setShowNewMenu(false); }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
              >
                <File size={16} className="text-gray-400" /> {t('upload.uploadFile')}
              </button>
              <button
                onClick={() => { folderInputRef.current?.click(); setShowNewMenu(false); }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
              >
                <FolderOpen size={16} className="text-gray-400" /> {t('upload.uploadFolder')}
              </button>
            </div>
          )}
        </div>

        <input ref={fileInputRef} type="file" multiple onChange={(e) => { if (e.target.files?.length) { addFiles(e.target.files, currentFolderId); e.target.value = ''; } }} hidden />
        <input ref={folderInputRef} type="file" {...{ webkitdirectory: '' } as React.InputHTMLAttributes<HTMLInputElement>} onChange={(e) => { if (e.target.files?.length) { addFolder(e.target.files, currentFolderId); e.target.value = ''; } }} hidden />

        <div className="flex bg-gray-50 p-1 rounded-lg border border-gray-200">
          <button onClick={() => setViewMode('grid')} className={`p-1.5 rounded-md transition-all ${viewMode === 'grid' ? 'bg-white shadow-sm text-blue-600' : 'text-gray-400 hover:text-gray-600'}`} title={t('dashboard.gridView')}>
            <LayoutGrid size={18} />
          </button>
          <button onClick={() => setViewMode('list')} className={`p-1.5 rounded-md transition-all ${viewMode === 'list' ? 'bg-white shadow-sm text-blue-600' : 'text-gray-400 hover:text-gray-600'}`} title={t('dashboard.listView')}>
            <List size={18} />
          </button>
        </div>
      </div>
    </header>
  );
}
