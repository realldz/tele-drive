'use client';

import { FileText, Folder, Trash2, RotateCcw, Clock, Loader2 } from 'lucide-react';
import { useI18n } from '@/providers/i18n-context';
import { formatSize } from '@/lib/api';
import Badge from '@/components/atoms/badge';
import { getDaysRemaining } from '@/hooks/use-trash';
import type { TrashedFile, TrashedFolder } from '@/lib/types';

interface TrashTableProps {
  folders: TrashedFolder[];
  files: TrashedFile[];
  selection: { isSelected: (id: string) => boolean };
  actionIds: Set<string>;
  isEmptying: boolean;
  isCleaning: boolean;
  onItemClick: (e: React.MouseEvent, item: TrashedFile | TrashedFolder) => void;
  onContextMenu: (e: React.MouseEvent, item: TrashedFile | TrashedFolder, type: 'file' | 'folder') => void;
  onRestoreFolder: (id: string) => void;
  onPermanentDeleteFolder: (id: string) => void;
  onRestoreFile: (id: string) => void;
  onPermanentDeleteFile: (id: string) => void;
}

export default function TrashTable({
  folders, files, selection, actionIds, isEmptying, isCleaning,
  onItemClick, onContextMenu,
  onRestoreFolder, onPermanentDeleteFolder, onRestoreFile, onPermanentDeleteFile,
}: TrashTableProps) {
  const { t } = useI18n();

  const rowClass = (id: string) =>
    `cursor-pointer transition-colors ${selection.isSelected(id) ? 'bg-blue-50' : 'hover:bg-gray-50'}`;

  const restoreBtn = (id: string, onClick: () => void) => (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      disabled={actionIds.has(id) || isEmptying}
      className="p-2 text-green-600 bg-green-50 hover:bg-green-100 disabled:opacity-50 disabled:hover:bg-green-50 rounded-lg transition-colors flex items-center gap-1 text-sm font-medium"
    >
      {actionIds.has(id) ? <Loader2 size={16} className="animate-spin" /> : <RotateCcw size={16} />}
      <span className="hidden sm:inline">{t('trash.restore')}</span>
    </button>
  );

  const deleteBtn = (id: string, onClick: () => void) => (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      disabled={actionIds.has(id) || isEmptying || isCleaning}
      className="p-2 text-red-600 bg-red-50 hover:bg-red-100 disabled:opacity-50 disabled:hover:bg-red-50 rounded-lg transition-colors flex items-center gap-1 text-sm font-medium"
    >
      {(actionIds.has(id) || isEmptying || isCleaning) ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
      <span className="hidden sm:inline">{t('trash.permanentDelete')}</span>
    </button>
  );

  const daysLeft = (deletedAt: string) => (
    <span className="text-red-500 flex items-center gap-1">
      <Clock size={10} /> {t('trash.daysRemaining', { days: String(getDaysRemaining(deletedAt)) })}
    </span>
  );

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
      <table className="w-full text-left border-collapse">
        <tbody className="divide-y divide-gray-100">
          {folders.map(folder => (
            <tr key={folder.id} data-selectable-id={folder.id}
              onClick={(e) => onItemClick(e, folder)}
              onContextMenu={(e) => onContextMenu(e, folder, 'folder')}
              className={rowClass(folder.id)}
            >
              <td className="p-4 flex items-center gap-3">
                <Folder className="w-6 h-6 text-gray-400 flex-shrink-0" fill="currentColor" opacity={0.5} />
                <div>
                  <span className="font-medium text-gray-800 block">{folder.name}</span>
                  <span className="text-xs mt-0.5 block">{daysLeft(folder.deletedAt)}</span>
                </div>
              </td>
              <td className="p-4 text-right">
                <div className="flex justify-end gap-2">
                  {restoreBtn(folder.id, () => onRestoreFolder(folder.id))}
                  {deleteBtn(folder.id, () => { if (confirm(t('trash.confirmDeleteFolder'))) onPermanentDeleteFolder(folder.id); })}
                </div>
              </td>
            </tr>
          ))}
          {files.map(file => (
            <tr key={file.id} data-selectable-id={file.id}
              onClick={(e) => onItemClick(e, file)}
              onContextMenu={(e) => onContextMenu(e, file, 'file')}
              className={rowClass(file.id)}
            >
              <td className="p-4 flex items-center gap-3">
                <FileText className="w-6 h-6 text-gray-400 flex-shrink-0" />
                <div>
                  <span className="font-medium text-gray-800 block truncate max-w-[200px] sm:max-w-xs">{file.filename}</span>
                  <div className="text-xs mt-0.5 flex flex-wrap items-center gap-2">
                    <Badge variant="default" className="font-medium">{formatSize(Number(file.size))}</Badge>
                    {daysLeft(file.deletedAt)}
                  </div>
                </div>
              </td>
              <td className="p-4 text-right whitespace-nowrap">
                <div className="flex justify-end gap-2">
                  {restoreBtn(file.id, () => onRestoreFile(file.id))}
                  {deleteBtn(file.id, () => { if (confirm(t('trash.confirmDeleteFile'))) onPermanentDeleteFile(file.id); })}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
