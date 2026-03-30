import React from 'react';
import CreateFolderDialog from '@/components/create-folder-dialog';
import RenameDialog from '@/components/rename-dialog';
import MoveDialog from '@/components/move-dialog';
import ShareDialog from '@/components/share-dialog';
import FileDetailsDialog from '@/components/file-details-dialog';
import FilePreviewModal from '@/components/file-preview-modal';
import { useI18n } from '@/components/i18n-context';
import { renameItem, moveItem, getApiErrorMessage } from '@/lib/api';
import type { FileRecord, FolderRecord } from '@/lib/types';

type ActiveDialog = 'rename' | 'move' | 'share' | 'details' | 'batchMove' | 'none';

interface DashboardDialogsProps {
  showCreateFolder: boolean;
  setShowCreateFolder: React.Dispatch<React.SetStateAction<boolean>>;
  onCreateFolder: (name: string) => Promise<void>;
  activeDialog: ActiveDialog;
  setActiveDialog: React.Dispatch<React.SetStateAction<ActiveDialog>>;
  dialogItem: FileRecord | FolderRecord | null;
  dialogItemType: 'file' | 'folder';
  fetchContent: () => void;
  // Batch move
  batchExcludeIds: string[];
  batchMoveItemToMove: FolderRecord;
  onBatchMoveConfirm: (destFolderId: string | null) => Promise<void>;
  // Preview
  previewFileId: string | null;
  setPreviewFileId: React.Dispatch<React.SetStateAction<string | null>>;
}

export default function DashboardDialogs({
  showCreateFolder,
  setShowCreateFolder,
  onCreateFolder,
  activeDialog,
  setActiveDialog,
  dialogItem,
  dialogItemType,
  fetchContent,
  batchExcludeIds,
  batchMoveItemToMove,
  onBatchMoveConfirm,
  previewFileId,
  setPreviewFileId,
}: DashboardDialogsProps) {
  const { t } = useI18n();

  return (
    <>
      <CreateFolderDialog isOpen={showCreateFolder} onClose={() => setShowCreateFolder(false)} onConfirm={onCreateFolder} />

      <RenameDialog isOpen={activeDialog === 'rename'} onClose={() => setActiveDialog('none')}
        initialName={dialogItem ? ('name' in dialogItem ? dialogItem.name : dialogItem.filename) : ''} itemType={dialogItemType}
        onConfirm={async (newName) => { try { await renameItem(dialogItemType, dialogItem!.id, newName); setActiveDialog('none'); fetchContent(); } catch { alert(t('dashboard.renameError')); } }}
      />

      <MoveDialog isOpen={activeDialog === 'move'} onClose={() => setActiveDialog('none')} itemToMove={dialogItem} itemType={dialogItemType}
        onConfirm={async (destFolderId) => { try { await moveItem(dialogItemType, dialogItem!.id, destFolderId); setActiveDialog('none'); fetchContent(); } catch (error: unknown) { alert(getApiErrorMessage(error, t('dashboard.moveError'))); } }}
      />

      {/* Batch move dialog */}
      <MoveDialog isOpen={activeDialog === 'batchMove'} onClose={() => setActiveDialog('none')}
        itemToMove={batchMoveItemToMove}
        itemType="folder"
        excludeIds={batchExcludeIds}
        onConfirm={onBatchMoveConfirm}
      />

      <ShareDialog isOpen={activeDialog === 'share'} onClose={() => setActiveDialog('none')} onSuccess={fetchContent} item={dialogItem} itemType={dialogItemType} />

      <FileDetailsDialog isOpen={activeDialog === 'details'} onClose={() => setActiveDialog('none')} item={dialogItem} itemType={dialogItemType} />

      <FilePreviewModal fileId={previewFileId} onClose={() => setPreviewFileId(null)} />
    </>
  );
}
