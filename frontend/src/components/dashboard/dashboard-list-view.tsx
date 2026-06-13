import { Folder, Globe, MoreVertical, Loader2, Download, CloudUpload, AlertTriangle } from 'lucide-react';
import { useI18n, LOCALE_DATE_MAP } from '@/providers/i18n-context';
import { getFileIcon } from '@/lib/file-icon';
import { formatBytes } from '@/lib/api';
import type { DashboardViewProps, SortField, SortDirection } from './dashboard-view-props';

interface DashboardListViewProps extends DashboardViewProps {
  sortField: SortField;
  sortDirection: SortDirection;
  onSort: (field: SortField) => void;
}

export default function DashboardListView({
  visibleFolders, visibleFiles, selection, downloadingFiles, actionLoading, dragOverFolderId,
  sortField, sortDirection, onSort,
  onItemClick, onDragStart, onDragOver, onDragLeave, onDrop, onContextMenu,
  onDownload, onDeleteStuckFile, onRetryBuffer,
}: DashboardListViewProps) {
  const { t, locale } = useI18n();
  const formatDate = (d: string) => new Date(d).toLocaleDateString(LOCALE_DATE_MAP[locale]);
  const renderSortIcon = (field: SortField) => sortField !== field ? null : sortDirection === 'asc' ? '▲' : '▼';

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider border-b border-gray-200">
            <th className="p-3 md:p-4 font-semibold cursor-pointer select-none" onClick={() => onSort('name')}>
              <span className="flex items-center gap-1">{t('dashboard.name')} {renderSortIcon('name')}</span>
            </th>
            <th className="p-3 md:p-4 font-semibold hidden sm:table-cell">{t('dashboard.size')}</th>
            <th className="p-3 md:p-4 font-semibold hidden sm:table-cell cursor-pointer select-none" onClick={() => onSort('createdAt')}>
              <span className="flex items-center gap-1">{t('dashboard.createdDate')} {renderSortIcon('createdAt')}</span>
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
              <td className="p-3 md:p-4">
                <div className="flex items-center gap-3">
                  <div className="relative flex-shrink-0">
                    <Folder className="w-6 h-6 text-blue-500" fill="currentColor" opacity={0.8} />
                    {folder.visibility !== 'PRIVATE' && <Globe className="absolute -bottom-1 -right-1 w-3 h-3 text-green-600 bg-white rounded-full p-px" />}
                  </div>
                  <span className="font-medium text-gray-800">{folder.name}</span>
                </div>
              </td>
              <td className="p-3 md:p-4 text-sm text-gray-600 hidden sm:table-cell">-</td>
              <td className="p-3 md:p-4 text-sm text-gray-500 hidden sm:table-cell">{formatDate(folder.createdAt)}</td>
              <td className="p-3 md:p-4 text-right">
                <button onClick={(e) => { e.stopPropagation(); onContextMenu(e, folder, 'folder'); }}
                  className="md:opacity-0 md:group-hover:opacity-100 p-1.5 text-gray-500 hover:bg-gray-200 rounded-md transition-opacity inline-flex items-center">
                  <MoreVertical size={16} />
                </button>
              </td>
            </tr>
          ))}
          {visibleFiles.map(file => (
            <tr key={file.id} data-selectable-id={file.id} draggable onDragStart={(e) => onDragStart(e, file, 'file')}
              onClick={(e) => onItemClick(e, file, 'file')}
              onContextMenu={(e) => file.status !== 'uploading' && onContextMenu(e, file, 'file')}
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
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-medium text-gray-800 block truncate max-w-[150px] sm:max-w-xs md:max-w-sm">{file.filename}</span>
                      {file.status === 'buffered' && (
                        <span title={t('file.syncingToCloud')} className="flex-shrink-0 inline-flex items-center">
                          <CloudUpload className="w-4 h-4 text-blue-400 animate-pulse" />
                        </span>
                      )}
                      {file.status === 'buffer_failed' && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onRetryBuffer(file.id); }}
                          title={t('file.syncFailed')}
                          className="flex-shrink-0 inline-flex items-center cursor-pointer hover:scale-110 transition-transform"
                        >
                          <AlertTriangle className="w-4 h-4 text-amber-500" />
                        </button>
                      )}
                    </div>
                    {file.status === 'uploading' && (<span className="text-blue-500 text-xs font-medium flex items-center gap-1 mt-0.5"><Loader2 size={12} className="animate-spin" /> {t('dashboard.listProcessing')}</span>)}
                    <span className="text-xs text-gray-500 sm:hidden block mt-0.5">{formatBytes(Number(file.size))}</span>
                  </div>
                </div>
              </td>
              <td className="p-3 md:p-4 text-sm text-gray-600 hidden sm:table-cell">{file.status !== 'uploading' ? formatBytes(Number(file.size)) : '-'}</td>
              <td className="p-3 md:p-4 text-sm text-gray-500 hidden sm:table-cell">{formatDate(file.createdAt)}</td>
              <td className="p-3 md:p-4 text-right whitespace-nowrap">
                {file.status === 'uploading' ? (
                  <button onClick={(e) => onDeleteStuckFile(e, file.id)} disabled={actionLoading.has(file.id)} className="p-1.5 text-red-500 bg-red-50 hover:bg-red-100 rounded-md transition-colors disabled:opacity-50">
                    {actionLoading.has(file.id) ? <Loader2 size={16} className="animate-spin" /> : '×'}
                  </button>
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
  );
}
