import React, { useState, useEffect, useCallback } from 'react';
import { X, Folder, ChevronRight, Home } from 'lucide-react';
import { fetchFolderContent, fetchBreadcrumbs } from '@/lib/api';
import { useI18n } from '@/components/i18n-context';
import type { FileRecord, FolderRecord, BreadcrumbItem } from '@/lib/types';

interface MoveDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (destinationFolderId: string | null) => Promise<void> | void;
  itemToMove: FileRecord | FolderRecord | null;
  itemType: 'file' | 'folder';
}

export default function MoveDialog({ isOpen, onClose, onConfirm, itemToMove, itemType }: MoveDialogProps) {
  const { t } = useI18n();
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fetchFolders = useCallback(async (parentId: string | null) => {
    setIsLoading(true);
    try {
      const data = await fetchFolderContent(parentId || undefined);
      const visibleFolders = data.folders.filter((f) =>
        itemType !== 'folder' || f.id !== itemToMove?.id
      );
      setFolders(visibleFolders);

      if (parentId) {
        const bc = await fetchBreadcrumbs(parentId);
        setBreadcrumbs(bc);
      } else {
        setBreadcrumbs([]);
      }
    } catch (error) {
      console.error(error);
    } finally {
      setIsLoading(false);
    }
  }, [itemType, itemToMove]);

  useEffect(() => {
    if (isOpen) {
      // Reset về thư mục gốc mỗi khi mở dialog
      setCurrentFolderId(null);
      fetchFolders(null);
    }
  }, [isOpen, fetchFolders]);

  // Cập nhật khi currentFolderId thay đổi trong dialog
  useEffect(() => {
    if (isOpen) {
      fetchFolders(currentFolderId);
    }
  }, [currentFolderId, isOpen, fetchFolders]);

  const handleConfirm = async () => {
    setIsSubmitting(true);
    await onConfirm(currentFolderId);
    setIsSubmitting(false);
  };

  if (!isOpen || !itemToMove) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden flex flex-col h-[60vh]">
        <div className="flex justify-between items-center p-4 border-b border-gray-100">
          <h2 className="font-semibold text-gray-800">
            {t(itemType === 'file' ? 'move.titleFile' : 'move.titleFolder')}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>
        
        {/* Breadcrumb trong dialog */}
        <div className="bg-gray-50 p-3 border-b flex flex-wrap items-center gap-1 text-sm text-gray-600">
          <button 
            onClick={() => setCurrentFolderId(null)}
            className="hover:text-blue-600 flex items-center transition-colors"
          >
            <Home size={16} />
          </button>
          {breadcrumbs.map((bc) => (
            <React.Fragment key={bc.id}>
              <ChevronRight size={16} className="text-gray-400" />
              <button 
                onClick={() => setCurrentFolderId(bc.id)}
                className="hover:text-blue-600 transition-colors truncate max-w-[100px]"
                title={bc.name}
              >
                {bc.name}
              </button>
            </React.Fragment>
          ))}
        </div>

        {/* Danh sách folder */}
        <div className="flex-grow overflow-y-auto p-2">
          {isLoading ? (
            <div className="text-center py-8 text-gray-500">{t('move.loading')}</div>
          ) : folders.length === 0 ? (
            <div className="text-center py-8 text-gray-400 italic">{t('move.empty')}</div>
          ) : (
            folders.map(folder => (
              <div 
                key={folder.id}
                onClick={() => setCurrentFolderId(folder.id)}
                className="flex items-center gap-3 p-3 hover:bg-gray-100 rounded-lg cursor-pointer transition-colors"
              >
                <Folder className="text-blue-500 flex-shrink-0" fill="currentColor" opacity={0.8} />
                <span className="font-medium text-gray-700 truncate">{folder.name}</span>
                <ChevronRight size={16} className="text-gray-300 ml-auto" />
              </div>
            ))
          )}
        </div>

        <div className="p-4 border-t border-gray-200 bg-gray-50 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            {t('move.cancel')}
          </button>
          <button
            onClick={handleConfirm}
            disabled={isSubmitting}
            className="px-4 py-2 text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {isSubmitting ? t('move.moving') : t('move.moveHere')}
          </button>
        </div>
      </div>
    </div>
  );
}
