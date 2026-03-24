'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { UploadCloud } from 'lucide-react';
import { useI18n } from '@/components/i18n-context';
import { useUpload } from '@/components/upload-context';

// Recursively read all files from a FileSystemDirectoryEntry
async function readAllEntries(entry: FileSystemEntry, basePath: string = ''): Promise<File[]> {
  if (entry.isFile) {
    return new Promise<File[]>((resolve) => {
      (entry as FileSystemFileEntry).file((file) => {
        // Attach relative path via defineProperty so it survives being passed around
        Object.defineProperty(file, 'webkitRelativePath', {
          value: basePath ? `${basePath}/${file.name}` : file.name,
          writable: false,
        });
        resolve([file]);
      }, () => resolve([]));
    });
  }

  if (entry.isDirectory) {
    const dirReader = (entry as FileSystemDirectoryEntry).createReader();
    const entries = await new Promise<FileSystemEntry[]>((resolve) => {
      const allEntries: FileSystemEntry[] = [];
      const readBatch = () => {
        dirReader.readEntries((batch) => {
          if (batch.length === 0) {
            resolve(allEntries);
          } else {
            allEntries.push(...batch);
            readBatch();
          }
        }, () => resolve(allEntries));
      };
      readBatch();
    });

    const dirPath = basePath ? `${basePath}/${entry.name}` : entry.name;
    const files: File[] = [];
    for (const child of entries) {
      const childFiles = await readAllEntries(child, dirPath);
      files.push(...childFiles);
    }
    return files;
  }

  return [];
}

export default function GlobalDropZone() {
  const { t } = useI18n();
  const { addFiles, addFolder, currentFolderId } = useUpload();
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer?.types.includes('Files')) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragOver(false);

    if (!e.dataTransfer) return;

    const items = e.dataTransfer.items;
    const hasFolder = items && Array.from(items).some(item => {
      const entry = item.webkitGetAsEntry?.();
      return entry?.isDirectory;
    });

    if (hasFolder && items) {
      // Read folder entries recursively
      const allFiles: File[] = [];
      for (const item of Array.from(items)) {
        const entry = item.webkitGetAsEntry?.();
        if (entry) {
          const files = await readAllEntries(entry);
          allFiles.push(...files);
        }
      }

      if (allFiles.length > 0) {
        // Pass File[] directly — addFolder accepts FileList | File[]
        addFolder(allFiles, currentFolderId);
      }
    } else {
      // Simple file drop
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        addFiles(files, currentFolderId);
      }
    }
  }, [addFiles, addFolder, currentFolderId]);

  useEffect(() => {
    document.addEventListener('dragenter', handleDragEnter);
    document.addEventListener('dragleave', handleDragLeave);
    document.addEventListener('dragover', handleDragOver);
    document.addEventListener('drop', handleDrop);

    return () => {
      document.removeEventListener('dragenter', handleDragEnter);
      document.removeEventListener('dragleave', handleDragLeave);
      document.removeEventListener('dragover', handleDragOver);
      document.removeEventListener('drop', handleDrop);
    };
  }, [handleDragEnter, handleDragLeave, handleDragOver, handleDrop]);

  if (!isDragOver) return null;

  return (
    <div className="fixed inset-0 z-[100] bg-blue-500/20 backdrop-blur-sm flex items-center justify-center pointer-events-none">
      <div className="bg-white rounded-2xl shadow-2xl p-12 flex flex-col items-center gap-4 border-2 border-dashed border-blue-400">
        <UploadCloud className="w-16 h-16 text-blue-500" />
        <p className="text-lg font-semibold text-gray-800">{t('upload.dropOverlay')}</p>
      </div>
    </div>
  );
}
