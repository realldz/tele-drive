'use client';

import { useState } from 'react';
import {
  ArrowLeft,
  FileSearch,
  Info,
  Loader2,
  Save,
  Search,
  Settings2,
  Trash2,
} from 'lucide-react';
import { LOCALE_DATE_MAP } from '@/components/i18n-context';
import { formatBytes } from '@/lib/api';
import { getFileIcon } from '@/lib/file-icon';
import FileDetailsDialog from '@/components/file-details-dialog';
import type { AdminUserBasic, AdminUserFile, FileRecord } from '@/lib/types';

interface DownloadPolicyForm {
  downloadLimit24h: string;
  bandwidthLimitGB: string;
}

interface AdminUserFilesListProps {
  user: AdminUserBasic;
  files: AdminUserFile[];
  locale: string;
  t: (key: string, params?: Record<string, string | number>) => string;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  fileSearch: string;
  onFileSearch: (value: string) => void;
  onLoadMore: () => void;
  onBack: () => void;
  onDeleteFile: (fileId: string) => void;
  onSavePolicy: (fileId: string, form: DownloadPolicyForm) => Promise<void>;
  actionLoading: Set<string>;
}

export default function AdminUserFilesList({
  user,
  files,
  locale,
  t,
  loading,
  loadingMore,
  hasMore,
  fileSearch,
  onFileSearch,
  onLoadMore,
  onBack,
  onDeleteFile,
  onSavePolicy,
  actionLoading,
}: AdminUserFilesListProps) {
  const [detailFile, setDetailFile] = useState<AdminUserFile | null>(null);
  const [editingFileId, setEditingFileId] = useState<string | null>(null);
  const [policyForm, setPolicyForm] = useState<DownloadPolicyForm>({
    downloadLimit24h: '',
    bandwidthLimitGB: '',
  });

  const detailFileAsRecord: FileRecord | null = detailFile
    ? {
        id: detailFile.id,
        filename: detailFile.filename,
        size: Number(detailFile.size),
        mimeType: detailFile.mimeType,
        status: 'complete',
        totalChunks: 0,
        folderId: null,
        userId: user.id,
        visibility: 'PRIVATE',
        shareToken: null,
        createdAt: detailFile.createdAt,
        updatedAt: detailFile.updatedAt,
      }
    : null;

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4">
          <button
            onClick={onBack}
            className="p-2 bg-gray-200 hover:bg-gray-300 rounded-full transition-colors"
          >
            <ArrowLeft size={20} />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              {t('admin.userFiles', { username: user.username })}
            </h1>
            <p className="text-sm text-gray-500 mt-1">{t('admin.userFilesInfo')}</p>
          </div>
        </div>

        <div className="text-sm text-gray-500 space-y-1">
          <div>
            {t('admin.usedQuota')}: {formatBytes(user.usedSpace)} / {formatBytes(user.quota)}
          </div>
          <div>
            {t('admin.role')}: <span className="font-medium text-gray-700">{user.role}</span>
          </div>
        </div>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
        <input
          type="text"
          placeholder={t('admin.searchFiles')}
          value={fileSearch}
          onChange={(e) => onFileSearch(e.target.value)}
          className="w-full pl-9 pr-4 py-2 bg-white border border-gray-200 rounded-lg outline-none focus:ring focus:ring-blue-100 text-sm"
        />
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[1100px]">
          <thead>
            <tr className="bg-gray-50 text-gray-600 text-sm">
              <th className="p-4 font-medium border-b">{t('admin.fileName')}</th>
              <th className="p-4 font-medium border-b">{t('admin.fileSize')}</th>
              <th className="p-4 font-medium border-b">{t('admin.downloads24h')}</th>
              <th className="p-4 font-medium border-b">{t('admin.bandwidthToday')}</th>
              <th className="p-4 font-medium border-b">{t('admin.lastDownloadReset')}</th>
              <th className="p-4 font-medium border-b text-right">{t('admin.options')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {files.map((file) => {
              const isEditing = editingFileId === file.id;
              const isSaving = actionLoading.has(`policy:${file.id}`);
              const isDeleting = actionLoading.has(`delete:${file.id}`);

              return (
                <>
                  <tr key={file.id} className="hover:bg-gray-50">
                    <td className="p-4 font-medium text-gray-800">
                      <div className="flex items-center gap-2">
                        {getFileIcon(file.mimeType, 'w-5 h-5')}
                        <span className="truncate max-w-[260px]">{file.filename}</span>
                        {file.isEncrypted && (
                          <span className="bg-green-100 text-green-700 text-[10px] px-1.5 py-0.5 rounded uppercase font-bold">
                            {t('admin.encrypted')}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="p-4 text-sm text-gray-600">{formatBytes(file.size)}</td>
                    <td className="p-4 text-sm text-gray-600">
                      {file.downloads24h} / {file.downloadLimit24h ?? t('admin.noLimit')}
                    </td>
                    <td className="p-4 text-sm text-gray-600">
                      {formatBytes(file.bandwidthUsed24h)} / {file.bandwidthLimit24h === null ? t('admin.noLimit') : formatBytes(file.bandwidthLimit24h)}
                    </td>
                    <td className="p-4 text-sm text-gray-500">
                      {new Date(file.lastDownloadReset).toLocaleString(
                        LOCALE_DATE_MAP[locale as keyof typeof LOCALE_DATE_MAP] || 'en-US',
                      )}
                    </td>
                    <td className="p-4 text-right whitespace-nowrap space-x-1">
                      <button
                        onClick={() => setDetailFile(file)}
                        className="p-2 text-blue-500 hover:bg-blue-50 rounded-lg transition-colors inline-block"
                        title={t('admin.fileDetails')}
                      >
                        <Info size={18} />
                      </button>
                      <button
                        onClick={() => {
                          setEditingFileId(file.id);
                          setPolicyForm({
                            downloadLimit24h:
                              file.downloadLimit24h === null ? '' : String(file.downloadLimit24h),
                            bandwidthLimitGB:
                              file.bandwidthLimit24h === null
                                ? ''
                                : (Number(file.bandwidthLimit24h) / 1024 ** 3).toString(),
                          });
                        }}
                        className="p-2 text-amber-500 hover:bg-amber-50 rounded-lg transition-colors inline-block"
                        title={t('admin.editDownloadPolicy')}
                      >
                        <Settings2 size={18} />
                      </button>
                      <button
                        onClick={() => onDeleteFile(file.id)}
                        disabled={isDeleting}
                        className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors inline-block disabled:opacity-50"
                        title={t('admin.deletePermanent')}
                      >
                        {isDeleting ? <Loader2 size={18} className="animate-spin" /> : <Trash2 size={18} />}
                      </button>
                    </td>
                  </tr>

                  {isEditing && (
                    <tr>
                      <td colSpan={6} className="p-4 bg-amber-50 border-t border-amber-100">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              {t('admin.downloadLimit24h')}
                            </label>
                            <input
                              type="number"
                              min="0"
                              value={policyForm.downloadLimit24h}
                              onChange={(e) =>
                                setPolicyForm((prev) => ({
                                  ...prev,
                                  downloadLimit24h: e.target.value,
                                }))
                              }
                              placeholder={t('admin.noLimit')}
                              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              {t('admin.bandwidthLimit24hFile')}
                            </label>
                            <input
                              type="number"
                              min="0"
                              step="0.1"
                              value={policyForm.bandwidthLimitGB}
                              onChange={(e) =>
                                setPolicyForm((prev) => ({
                                  ...prev,
                                  bandwidthLimitGB: e.target.value,
                                }))
                              }
                              placeholder={t('admin.noLimit')}
                              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                            />
                          </div>
                          <div className="flex gap-2 md:justify-end">
                            <button
                              type="button"
                              onClick={() => setEditingFileId(null)}
                              className="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50"
                            >
                              {t('admin.cancel')}
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
                                await onSavePolicy(file.id, policyForm);
                                setEditingFileId(null);
                              }}
                              disabled={isSaving}
                              className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700 disabled:opacity-60 flex items-center gap-2"
                            >
                              {isSaving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                              {t('admin.savePolicy')}
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}

            {loading && (
              <tr>
                <td colSpan={6} className="p-8 text-center">
                  <Loader2 className="animate-spin text-blue-500 mx-auto" size={24} />
                </td>
              </tr>
            )}

            {!loading && files.length === 0 && (
              <tr>
                <td colSpan={6} className="p-8 text-center text-gray-500 italic">
                  {t('admin.noFiles')}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {loadingMore && (
          <div className="py-3 text-center">
            <Loader2 className="animate-spin text-blue-500 mx-auto" size={16} />
          </div>
        )}

        {hasMore && !loadingMore && files.length > 0 && (
          <div className="py-3 text-center">
            <button
              onClick={onLoadMore}
              className="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium text-gray-600 transition-colors flex items-center gap-2 mx-auto"
            >
              <FileSearch size={16} /> {t('dashboard.loadMore')}
            </button>
          </div>
        )}
      </div>

      <FileDetailsDialog
        isOpen={!!detailFile}
        onClose={() => setDetailFile(null)}
        item={detailFileAsRecord}
        itemType="file"
      />
    </div>
  );
}
