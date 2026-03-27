'use client';

import { useState, useEffect, useCallback } from 'react';
import { FileText, Folder, Trash2, RotateCcw, Clock } from 'lucide-react';
import { useI18n } from '@/components/i18n-context';
import { useRequireAuth } from '@/hooks/use-require-auth';
import Sidebar from '@/components/sidebar';
import {
  formatSize, fetchTrash as fetchTrashApi,
  restoreFile, permanentDeleteFile, restoreFolder, permanentDeleteFolder,
  getApiErrorMessage,
} from '@/lib/api';
import type { TrashedFile, TrashedFolder } from '@/lib/types';

export default function TrashPage() {
  const { isReady, token } = useRequireAuth();
  const { t } = useI18n();

  const [trashedFiles, setTrashedFiles] = useState<TrashedFile[]>([]);
  const [trashedFolders, setTrashedFolders] = useState<TrashedFolder[]>([]);

  const fetchTrash = useCallback(async () => {
    if (!token) return;
    try {
      const data = await fetchTrashApi();
      setTrashedFiles(data.files);
      setTrashedFolders(data.folders);
    } catch {
      // 401 được xử lí tự động bởi axios response interceptor
    }
  }, [token]);

  useEffect(() => {
    fetchTrash();
  }, [fetchTrash]);

  const handleRestoreFile = async (id: string) => {
    try {
      await restoreFile(id);
      fetchTrash();
    } catch (error: unknown) {
      alert(getApiErrorMessage(error, 'Error restoring file'));
    }
  };

  const handlePermanentDeleteFile = async (id: string) => {
    if (!confirm(t('trash.confirmDeleteFile'))) return;
    try {
      await permanentDeleteFile(id);
      fetchTrash();
    } catch (error: unknown) {
      alert(getApiErrorMessage(error, 'Error deleting file'));
    }
  };

  const handleRestoreFolder = async (id: string) => {
    try {
      await restoreFolder(id);
      fetchTrash();
    } catch (error: unknown) {
      alert(getApiErrorMessage(error, 'Error restoring folder'));
    }
  };

  const handlePermanentDeleteFolder = async (id: string) => {
    if (!confirm(t('trash.confirmDeleteFolder'))) return;
    try {
      await permanentDeleteFolder(id);
      fetchTrash();
    } catch (error: unknown) {
      alert(getApiErrorMessage(error, 'Error deleting folder'));
    }
  };

  if (!isReady) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-500">{t('dashboard.loading')}</div>
      </div>
    );
  }

  const getDaysRemaining = (deletedAt: string) => {
    const deleted = new Date(deletedAt);
    const expiry = new Date(deleted.getTime() + 7 * 24 * 60 * 60 * 1000);
    const now = new Date();
    const remaining = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    return Math.max(0, remaining);
  };

  const totalItems = trashedFiles.length + trashedFolders.length;

  return (
    <div className="h-screen bg-white flex overflow-hidden">

      <Sidebar />

      {/* Main Area */}
      <main className="flex-1 flex flex-col min-w-0 bg-white relative">

        {/* Topbar */}
        <header className="h-16 border-b border-gray-100 flex items-center justify-between pl-14 pr-4 md:px-4 lg:px-6 bg-white w-full flex-shrink-0 z-10">
          <div className="flex items-center gap-4">
            <h2 className="text-xl font-bold flex items-center gap-2 text-gray-800">
              <Trash2 className="text-red-500" size={24} />
              {t('trash.title')}
            </h2>
          </div>
          <div className="text-sm font-medium text-gray-500 bg-gray-100 px-3 py-1.5 rounded-full">
            {t('trash.items', { count: String(totalItems) })}
          </div>
        </header>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto">
          {/* Info banner */}
          <div className="bg-amber-50 px-6 py-3 border-b border-amber-200 text-sm text-amber-800 flex items-center gap-2">
            <Clock size={16} />
            {t('trash.infoBanner')}
          </div>

          <div className="p-6">
            {totalItems === 0 ? (
              <div className="text-center py-20 bg-gray-50 rounded-2xl border-2 border-dashed border-gray-200 mt-4">
                <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center mx-auto mb-4 shadow-sm border border-gray-100">
                  <Trash2 className="text-gray-300" size={32} />
                </div>
                <p className="text-gray-500 font-medium tracking-wide">{t('trash.empty')}</p>
              </div>
            ) : (
              <div className="space-y-8">
                {/* Folders */}
                {trashedFolders.length > 0 && (
                  <div>
                    <h3 className="text-xs font-bold text-gray-400 mb-3 uppercase tracking-wider">{t('trash.folders')}</h3>
                    <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
                      <table className="w-full text-left border-collapse">
                        <tbody className="divide-y divide-gray-100">
                          {trashedFolders.map(folder => (
                            <tr key={folder.id} className="hover:bg-gray-50 transition-colors">
                              <td className="p-4 flex items-center gap-3">
                                <Folder className="w-6 h-6 text-gray-400 flex-shrink-0" fill="currentColor" opacity={0.5} />
                                <div>
                                  <span className="font-medium text-gray-800 block">{folder.name}</span>
                                  <span className="text-xs text-red-500 mt-0.5 block flex items-center gap-1">
                                    <Clock size={10} /> {t('trash.daysRemaining', { days: String(getDaysRemaining(folder.deletedAt)) })}
                                  </span>
                                </div>
                              </td>
                              <td className="p-4 text-right">
                                <div className="flex justify-end gap-2">
                                  <button
                                    onClick={() => handleRestoreFolder(folder.id)}
                                    className="p-2 text-green-600 bg-green-50 hover:bg-green-100 rounded-lg transition-colors flex items-center gap-1 text-sm font-medium"
                                  >
                                    <RotateCcw size={16} /> <span className="hidden sm:inline">{t('trash.restore')}</span>
                                  </button>
                                  <button
                                    onClick={() => handlePermanentDeleteFolder(folder.id)}
                                    className="p-2 text-red-600 bg-red-50 hover:bg-red-100 rounded-lg transition-colors flex items-center gap-1 text-sm font-medium"
                                  >
                                    <Trash2 size={16} /> <span className="hidden sm:inline">{t('trash.permanentDelete')}</span>
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Files */}
                {trashedFiles.length > 0 && (
                  <div>
                    <h3 className="text-xs font-bold text-gray-400 mb-3 uppercase tracking-wider">{t('trash.files')}</h3>
                    <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
                      <table className="w-full text-left border-collapse">
                        <tbody className="divide-y divide-gray-100">
                          {trashedFiles.map(file => (
                            <tr key={file.id} className="hover:bg-gray-50 transition-colors">
                              <td className="p-4 flex items-center gap-3">
                                <FileText className="w-6 h-6 text-gray-400 flex-shrink-0" />
                                <div>
                                  <span className="font-medium text-gray-800 block truncate max-w-[200px] sm:max-w-xs">{file.filename}</span>
                                  <div className="text-xs mt-0.5 flex flex-wrap items-center gap-2">
                                    <span className="text-gray-500 font-medium bg-gray-100 px-1.5 py-0.5 rounded">{formatSize(Number(file.size))}</span>
                                    <span className="text-red-500 flex items-center gap-1">
                                      <Clock size={10} /> {t('trash.daysRemaining', { days: String(getDaysRemaining(file.deletedAt)) })}
                                    </span>
                                  </div>
                                </div>
                              </td>
                              <td className="p-4 text-right whitespace-nowrap">
                                <div className="flex justify-end gap-2">
                                  <button
                                    onClick={() => handleRestoreFile(file.id)}
                                    className="p-2 text-green-600 bg-green-50 hover:bg-green-100 rounded-lg transition-colors flex items-center gap-1 text-sm font-medium"
                                  >
                                    <RotateCcw size={16} /> <span className="hidden sm:inline">{t('trash.restore')}</span>
                                  </button>
                                  <button
                                    onClick={() => handlePermanentDeleteFile(file.id)}
                                    className="p-2 text-red-600 bg-red-50 hover:bg-red-100 rounded-lg transition-colors flex items-center gap-1 text-sm font-medium"
                                  >
                                    <Trash2 size={16} /> <span className="hidden sm:inline">{t('trash.permanentDelete')}</span>
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
