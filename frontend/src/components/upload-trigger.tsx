'use client';

import { useRef } from 'react';
import { UploadCloud } from 'lucide-react';
import { useI18n } from '@/components/i18n-context';
import { useUpload } from '@/components/upload-context';

export default function UploadTrigger({ folderId }: { folderId?: string }) {
  const { t } = useI18n();
  const { addFiles, addFolder } = useUpload();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    addFiles(files, folderId);
    e.target.value = '';
  };

  const handleFolderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    addFolder(files, folderId);
    e.target.value = '';
  };

  return (
    <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:bg-gray-50 transition-colors">
      <div className="flex flex-col items-center justify-center space-y-3">
        <UploadCloud className="w-10 h-10 text-gray-400" />
        <p className="text-sm font-medium text-gray-700">{t('upload.dragDrop')}</p>
        <p className="text-xs text-gray-500">{t('upload.supportInfo')}</p>
        <div className="flex gap-3 mt-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-500 transition-colors cursor-pointer"
          >
            {t('upload.chooseFiles')}
          </button>
          <button
            onClick={() => folderInputRef.current?.click()}
            className="px-4 py-2 bg-white text-gray-700 text-sm font-medium rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors cursor-pointer"
          >
            {t('upload.chooseFolder')}
          </button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={handleFileChange}
        className="hidden"
      />
      <input
        ref={folderInputRef}
        type="file"
        // @ts-expect-error webkitdirectory is non-standard but widely supported
        webkitdirectory=""
        onChange={handleFolderChange}
        className="hidden"
      />
    </div>
  );
}
