import React, { useCallback } from 'react';
import { Folder, Download, Trash2, MoreVertical, Loader2, Globe, ChevronUp, ChevronDown } from 'lucide-react';
import { useI18n, LOCALE_DATE_MAP } from '@/components/i18n-context';
import { getFileIcon } from '@/lib/file-icon';
import { formatBytes } from '@/lib/api';
import type { FileRecord, FolderRecord } from '@/lib/types';

type SortField = 'name' | 'createdAt';
type SortDirection = 'asc' | 'desc';

interface DashboardContentProps {
  isLoadingContent: boolean;
  folders: FolderRecord[];
  files: FileRecord[];
  visibleFolders: FolderRecord[];
  visibleFiles: FileRecord[];
  filteredFoldersCount: number;
  filteredFilesCount: number;
  viewMode: 'grid' | 'list';
  searchQuery: string;
  sortField: SortField;
  sortDirection: SortDirection;
  onSort: (field: SortField) => void;
  selection: {
    isSelected: (id: string) => boolean;
  };
  downloadingFiles: Set<string>;
  dragOverFolderId: string | null;
  hasMore: boolean;
  loadMoreRef: React.RefObject<HTMLDivElement | null>;
  onItemClick: (e: React.MouseEvent, item: FileRecord | FolderRecord, type: 'file' | 'folder') => void;
  onDragStart: (e: React.DragEvent, item: FileRecord | FolderRecord, type: 'file' | 'folder') => void;
  onDragOver: (e: React.DragEvent, folderId: string | null) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent, targetFolderId: string | null) => void;
  onContextMenu: (e: React.MouseEvent, item: FileRecord | FolderRecord, type: 'file' | 'folder') => void;
  onDownload: (fileId: string, filename: string) => void;
  onDeleteStuckFile: (e: React.MouseEvent, id: string) => void;
}

export default function DashboardContent({
  isLoadingContent,
  folders,
  files,
  visibleFolders,
  visibleFiles,
  filteredFoldersCount,
  filteredFilesCount,
  viewMode,
  searchQuery,
  sortField,
  sortDirection,
  onSort,
  selection,
  downloadingFiles,
  dragOverFolderId,
  hasMore,
  loadMoreRef,
  onItemClick,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onContextMenu,
  onDownload,
  onDeleteStuckFile,
}: DashboardContentProps) {
  const { t, locale } = useI18n();

  const formatDate = useCallback((d: string) => new Date(d).toLocaleDateString(LOCALE_DATE_MAP[locale]), [locale]);

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return null;
    return sortDirection === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />;
  };

  // Loading state
  if (isLoadingContent && folders.length === 0 && files.length === 0) {
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
        <p className="text-gray-500 font-medium">{searchQuery ? t('dashboard.noResults') : t('dashboard.emptyFolder')}</p>
      </div>
    );
  }

  return (
    <>
      {/* Folders */}
      {filteredFoldersCount > 0 && (
        <div className="mb-8">
          <h2 className="text-sm font-bold text-gray-500 mb-4 uppercase tracking-wider">{t('dashboard.folders')}</h2>
          {viewMode === 'grid' ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
              {visibleFolders.map(folder => (
                <div key={folder.id} data-selectable-id={folder.id}
                  onClick={(e) => onItemClick(e, folder, 'folder')}
                  draggable
                  onDragStart={(e) => onDragStart(e, folder, 'folder')} onDragOver={(e) => onDragOver(e, folder.id)}
                  onDragLeave={onDragLeave} onDrop={(e) => onDrop(e, folder.id)}
                  onContextMenu={(e) => onContextMenu(e, folder, 'folder')}
                  className={`p-4 bg-white border rounded-xl shadow-sm cursor-pointer transition-all group relative flex items-center justify-between ${
                    selection.isSelected(folder.id)
                      ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200'
                      : dragOverFolderId === folder.id
                        ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200'
                        : 'border-gray-200 hover:shadow-md hover:border-blue-300'
                  }`}
                >
                  <div className="flex items-center truncate pr-2">
                    <div className="relative mr-3 flex-shrink-0">
                      <Folder className="w-8 h-8 text-blue-500" fill="currentColor" opacity={0.8} />
                      {folder.visibility !== 'PRIVATE' && <Globe className="absolute -bottom-1 -right-1 w-3.5 h-3.5 text-green-600 bg-white rounded-full p-px" />}
                    </div>
                    <span className="font-semibold text-gray-700 truncate">{folder.name}</span>
                  </div>
                  <div className="flex items-center md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                    <button onClick={(e) => { e.stopPropagation(); onContextMenu(e, folder, 'folder'); }} className="p-1.5 text-gray-500 hover:bg-gray-100 rounded-md">
                      <MoreVertical size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider border-b border-gray-200">
                    <th className="p-3 md:p-4 font-semibold cursor-pointer select-none" onClick={() => onSort('name')}>
                      <span className="flex items-center gap-1">{t('dashboard.name')} <SortIcon field="name" /></span>
                    </th>
                    <th className="p-3 md:p-4 font-semibold hidden sm:table-cell cursor-pointer select-none" onClick={() => onSort('createdAt')}>
                      <span className="flex items-center gap-1">{t('dashboard.createdDate')} <SortIcon field="createdAt" /></span>
                    </th>
                    <th className="p-3 md:p-4 font-semibold text-right whitespace-nowrap">{t('dashboard.options')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {visibleFolders.map(folder => (
                    <tr key={folder.id} data-selectable-id={folder.id}
                      onClick={(e) => onItemClick(e, folder, 'folder')}
                      draggable
                      onDragStart={(e) => onDragStart(e, folder, 'folder')} onDragOver={(e) => onDragOver(e, folder.id)}
                      onDragLeave={onDragLeave} onDrop={(e) => onDrop(e, folder.id)}
                      onContextMenu={(e) => onContextMenu(e, folder, 'folder')}
                      className={`cursor-pointer transition-colors group ${
                        selection.isSelected(folder.id)
                          ? 'bg-blue-50'
                          : dragOverFolderId === folder.id ? 'bg-blue-50' : 'hover:bg-gray-50'
                      }`}
                    >
                      <td className="p-3 md:p-4 flex items-center gap-3">
                        <div className="relative flex-shrink-0">
                          <Folder className="w-6 h-6 text-blue-500" fill="currentColor" opacity={0.8} />
                          {folder.visibility !== 'PRIVATE' && <Globe className="absolute -bottom-1 -right-1 w-3 h-3 text-green-600 bg-white rounded-full p-px" />}
                        </div>
                        <span className="font-medium text-gray-800">{folder.name}</span>
                      </td>
                      <td className="p-3 md:p-4 text-sm text-gray-500 hidden sm:table-cell">{formatDate(folder.createdAt)}</td>
                      <td className="p-3 md:p-4 text-right">
                        <button onClick={(e) => { e.stopPropagation(); onContextMenu(e, folder, 'folder'); }}
                          className="md:opacity-0 md:group-hover:opacity-100 p-1.5 text-gray-500 hover:bg-gray-200 rounded-md transition-opacity inline-flex items-center">
                          <MoreVertical size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Files */}
      {filteredFilesCount > 0 && (
        <div>
          <h2 className="text-sm font-bold text-gray-500 mb-4 uppercase tracking-wider">{t('dashboard.files')}</h2>
          {viewMode === 'grid' ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
              {visibleFiles.map(file => (
                <div key={file.id} data-selectable-id={file.id} draggable onDragStart={(e) => onDragStart(e, file, 'file')}
                  onClick={(e) => onItemClick(e, file, 'file')}
                  onContextMenu={(e) => file.status === 'complete' && onContextMenu(e, file, 'file')}
                  className={`p-4 bg-white border rounded-xl shadow-sm transition-all group flex flex-col justify-between cursor-pointer ${
                    selection.isSelected(file.id)
                      ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200'
                      : 'border-gray-200 hover:shadow-md hover:border-blue-300'
                  }`}
                >
                  <div className="flex items-start mb-4">
                    <div className="relative w-10 h-10 rounded-lg bg-gray-50 flex items-center justify-center mr-3 border border-gray-100 flex-shrink-0">
                      {getFileIcon(file.mimeType, 'w-5 h-5')}
                      {file.visibility !== 'PRIVATE' && <Globe className="absolute -bottom-1 -right-1 w-3.5 h-3.5 text-green-600 bg-white rounded-full p-px" />}
                    </div>
                    <div className="overflow-hidden flex-1">
                      <span className="font-semibold text-gray-800 text-sm truncate block" title={file.filename}>{file.filename}</span>
                      <span className="text-xs text-gray-500 mt-1">
                        {file.status === 'uploading' ? (
                          <span className="text-blue-500 font-medium flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> {t('dashboard.processing')}</span>
                        ) : formatBytes(Number(file.size))}
                      </span>
                    </div>
                  </div>
                  <div className="flex gap-2 mt-auto">
                    {file.status === 'uploading' ? (
                      <button onClick={(e) => onDeleteStuckFile(e, file.id)} className="w-full p-2 text-red-500 bg-red-50 rounded-lg hover:bg-red-100 transition-colors flex items-center justify-center gap-1 text-sm font-medium">
                        <Trash2 size={14} /> {t('dashboard.stuckDelete')}
                      </button>
                    ) : (
                      <>
                        <button onClick={(e) => { e.stopPropagation(); onContextMenu(e, file, 'file'); }} className="p-2 text-gray-500 bg-gray-50 border border-gray-100 rounded-lg hover:bg-gray-100 transition-colors">
                          <MoreVertical size={16} />
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); if (!downloadingFiles.has(file.id)) onDownload(file.id, file.filename); }}
                          disabled={downloadingFiles.has(file.id)}
                          className={`flex-1 flex items-center justify-center gap-1 border border-gray-100 bg-gray-50 hover:bg-blue-50 hover:text-blue-700 hover:border-blue-100 text-gray-700 p-2 rounded-lg font-semibold text-sm transition-colors ${downloadingFiles.has(file.id) ? 'opacity-50 pointer-events-none' : ''}`}
                        >
                          {downloadingFiles.has(file.id) ? (<><Loader2 size={14} className="animate-spin" /> {t('dashboard.downloading')}</>) : (<><Download size={14} /> {t('dashboard.download')}</>)}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider border-b border-gray-200">
                    <th className="p-3 md:p-4 font-semibold cursor-pointer select-none" onClick={() => onSort('name')}>
                      <span className="flex items-center gap-1">{t('dashboard.fileName')} <SortIcon field="name" /></span>
                    </th>
                    <th className="p-3 md:p-4 font-semibold hidden sm:table-cell">{t('dashboard.size')}</th>
                    <th className="p-3 md:p-4 font-semibold hidden sm:table-cell cursor-pointer select-none" onClick={() => onSort('createdAt')}>
                      <span className="flex items-center gap-1">{t('dashboard.createdDate')} <SortIcon field="createdAt" /></span>
                    </th>
                    <th className="p-3 md:p-4 font-semibold text-right">{t('dashboard.options')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {visibleFiles.map(file => (
                    <tr key={file.id} data-selectable-id={file.id} draggable onDragStart={(e) => onDragStart(e, file, 'file')}
                      onClick={(e) => onItemClick(e, file, 'file')}
                      onContextMenu={(e) => file.status === 'complete' && onContextMenu(e, file, 'file')}
                      className={`cursor-pointer transition-colors group ${
                        selection.isSelected(file.id) ? 'bg-blue-50' : 'hover:bg-gray-50'
                      }`}
                    >
                      <td className="p-3 md:p-4">
                        <div className="flex items-center gap-3">
                          <div className="relative flex-shrink-0">
                            {getFileIcon(file.mimeType, 'w-5 h-5')}
                            {file.visibility !== 'PRIVATE' && <Globe className="absolute -bottom-1 -right-1 w-3 h-3 text-green-600 bg-white rounded-full p-px" />}
                          </div>
                          <div>
                            <span className="font-medium text-gray-800 block truncate max-w-[150px] sm:max-w-xs md:max-w-sm">{file.filename}</span>
                            {file.status === 'uploading' && (<span className="text-blue-500 text-xs font-medium flex items-center gap-1 mt-0.5"><Loader2 size={12} className="animate-spin" /> {t('dashboard.listProcessing')}</span>)}
                            <span className="text-xs text-gray-500 sm:hidden block mt-0.5">{formatBytes(Number(file.size))}</span>
                          </div>
                        </div>
                      </td>
                      <td className="p-3 md:p-4 text-sm text-gray-600 hidden sm:table-cell">{file.status === 'complete' ? formatBytes(Number(file.size)) : '-'}</td>
                      <td className="p-3 md:p-4 text-sm text-gray-500 hidden sm:table-cell">{formatDate(file.createdAt)}</td>
                      <td className="p-3 md:p-4 text-right whitespace-nowrap">
                        {file.status === 'uploading' ? (
                          <button onClick={(e) => onDeleteStuckFile(e, file.id)} className="p-1.5 text-red-500 bg-red-50 hover:bg-red-100 rounded-md transition-colors"><Trash2 size={16} /></button>
                        ) : (
                          <div className="flex justify-end gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                            <button onClick={(e) => { e.stopPropagation(); if (!downloadingFiles.has(file.id)) onDownload(file.id, file.filename); }}
                              disabled={downloadingFiles.has(file.id)} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded-md transition-colors disabled:opacity-50"><Download size={16} /></button>
                            <button onClick={(e) => { e.stopPropagation(); onContextMenu(e, file, 'file'); }} className="p-1.5 text-gray-500 hover:bg-gray-200 rounded-md transition-opacity"><MoreVertical size={16} /></button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {hasMore && (<div ref={loadMoreRef} className="py-4 text-center text-gray-400 text-sm">{t('dashboard.loading')}</div>)}
    </>
  );
}
