import React, { useState } from 'react';
import CreateFolderDialog from '@/components/create-folder-dialog';
import RenameDialog from '@/components/rename-dialog';
import MoveDialog from '@/components/move-dialog';
import ShareDialog from '@/components/share-dialog';
import FileDetailsDialog from '@/components/file-details-dialog';
import FilePreviewModal from '@/components/file-preview-modal';
import { useI18n } from '@/components/i18n-context';
import { renameItem, moveItem, isConflictError } from '@/lib/api';
import type { FileRecord, FolderRecord } from '@/lib/types';
import toast from 'react-hot-toast';

type ActiveDialog = 'rename' | 'move' | 'share' | 'details' | 'batchMove' | 'none';

interface DashboardDialogsProps {
  showCreateFolder: boolean;
  setShowCreateFolder: React.Dispatch<React.SetStateAction<boolean>>;
  onCreateFolder: (name: string) => Promise<void>;
  createFolderError: string | null;
  setCreateFolderError: React.Dispatch<React.SetStateAction<string | null>>;
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
  // Move conflict handler (returns true if conflict was handled)
  onMoveConflict?: (itemId: string, itemType: 'file' | 'folder', error: unknown) => void;
}

export default function DashboardDialogs({
  showCreateFolder,
  setShowCreateFolder,
  onCreateFolder,
  createFolderError,
  setCreateFolderError,
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
  onMoveConflict,
}: DashboardDialogsProps) {
  const { t } = useI18n();
  const [renameError, setRenameError] = useState<string | null>(null);
  const clearRenameError = () => setRenameError(null);

  const handleSingleMove = async (destFolderId: string | null) => {
    if (!dialogItem) return;
    try {
      await moveItem(dialogItemType, dialogItem.id, destFolderId);
      setActiveDialog('none');
      fetchContent();
      toast.success(t('dashboard.moveSuccess'));
    } catch (error: unknown) {
      if (isConflictError(error) && onMoveConflict) {
        onMoveConflict(dialogItem.id, dialogItemType, error);
        setActiveDialog('none');
      } else {
        toast.error(t('dashboard.moveError'));
      }
    }
  };

  const handleRename = async (newName: string) => {
    if (!dialogItem) return;
    setRenameError(null);
    try {
      await renameItem(dialogItemType, dialogItem.id, newName);
      setActiveDialog('none');
      fetchContent();
    } catch (error: unknown) {
      if (isConflictError(error)) {
        setRenameError(t('rename.nameConflict'));
      } else {
        setRenameError(t('dashboard.renameError'));
      }
    }
  };

  return (
    <>
      <CreateFolderDialog isOpen={showCreateFolder}
        onClose={() => { setShowCreateFolder(false); setCreateFolderError(null); }}
        onConfirm={onCreateFolder}
        error={createFolderError ?? undefined}
        onClearError={() => setCreateFolderError(null)}
      />

      <RenameDialog isOpen={activeDialog === 'rename'} onClose={() => { setActiveDialog('none'); setRenameError(null); }}
        initialName={dialogItem ? ('name' in dialogItem ? dialogItem.name : dialogItem.filename) : ''} itemType={dialogItemType}
        onConfirm={handleRename} error={renameError ?? undefined} onClearError={clearRenameError}
      />

      <MoveDialog isOpen={activeDialog === 'move'} onClose={() => setActiveDialog('none')} itemToMove={dialogItem} itemType={dialogItemType}
        onConfirm={handleSingleMove}
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
