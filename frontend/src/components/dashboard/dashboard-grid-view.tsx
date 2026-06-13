import { Folder, Globe, MoreVertical, Loader2, Download, CloudUpload, AlertTriangle } from 'lucide-react';
import { useI18n } from '@/providers/i18n-context';
import { getFileIcon } from '@/lib/file-icon';
import { formatBytes } from '@/lib/api';
import type { DashboardViewProps } from './dashboard-view-props';

export default function DashboardGridView({
  visibleFolders, visibleFiles, selection, downloadingFiles, actionLoading, dragOverFolderId,
  onItemClick, onDragStart, onDragOver, onDragLeave, onDrop, onContextMenu,
  onDownload, onDeleteStuckFile, onRetryBuffer,
}: DashboardViewProps) {
  const { t } = useI18n();

  return (
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
      {visibleFiles.map(file => (
        <div key={file.id} data-selectable-id={file.id} draggable onDragStart={(e) => onDragStart(e, file, 'file')}
          onClick={(e) => onItemClick(e, file, 'file')}
          onContextMenu={(e) => file.status !== 'uploading' && onContextMenu(e, file, 'file')}
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
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="font-semibold text-gray-800 text-sm truncate block" title={file.filename}>{file.filename}</span>
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
              <span className="text-xs text-gray-500 mt-1">
                {file.status === 'uploading' ? (
                  <span className="text-blue-500 font-medium flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> {t('dashboard.processing')}</span>
                ) : formatBytes(Number(file.size))}
              </span>
            </div>
          </div>
          <div className="flex gap-2 mt-auto">
            {file.status === 'uploading' ? (
              <button onClick={(e) => onDeleteStuckFile(e, file.id)} disabled={actionLoading.has(file.id)} className="w-full p-2 text-red-500 bg-red-50 rounded-lg hover:bg-red-100 transition-colors flex items-center justify-center gap-1 text-sm font-medium disabled:opacity-50">
                {actionLoading.has(file.id) ? <Loader2 size={14} className="animate-spin" /> : '×'} {t('dashboard.stuckDelete')}
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
  );
}
