'use client';

import { useEffect } from 'react';
import { Share2, Loader2, FileSearch } from 'lucide-react';
import { useI18n } from '@/providers/i18n-context';
import { useRequireAuth } from '@/hooks/use-require-auth';
import { useShared } from '@/hooks/use-shared';
import Sidebar from '@/components/sidebar';
import SharedTable from '@/components/organisms/shared/shared-table';

export default function SharedPage() {
  const { isReady, token } = useRequireAuth();
  const { t } = useI18n();

  const {
    folders, files, foldersHasMore, filesHasMore, loading, loadingMore, error,
    actionIds, fetchShared, loadMoreShared, revoke,
  } = useShared({ token, t });

  useEffect(() => {
    fetchShared();
  }, [fetchShared]);

  if (!isReady) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-500">{t('dashboard.loading')}</div>
      </div>
    );
  }

  const totalItems = folders.length + files.length;

  return (
    <div className="h-screen bg-white flex overflow-hidden">
      <Sidebar />

      <main className="flex-1 flex flex-col min-w-0 bg-white relative">
        <header className="h-16 border-b border-gray-100 flex items-center justify-between pl-14 pr-4 md:px-4 lg:px-6 bg-white w-full flex-shrink-0 z-10">
          <h2 className="text-xl font-bold flex items-center gap-2 text-gray-800">
            <Share2 className="text-blue-500" size={24} />
            {t('shared.title')}
          </h2>
          <div className="text-sm font-medium text-gray-500 bg-gray-100 px-3 py-1.5 rounded-full">
            {t('shared.items', { count: String(totalItems) })}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto relative">
          <div className="p-6">
            {loading && totalItems === 0 ? (
              <div className="py-20 text-center">
                <Loader2 className="animate-spin text-blue-500 mx-auto" size={24} />
              </div>
            ) : error ? (
              <div className="text-center py-20 bg-red-50 rounded-2xl border border-red-100 mt-4">
                <p className="text-red-600 font-medium mb-4">{error}</p>
                <button onClick={fetchShared} className="px-4 py-2 bg-white hover:bg-red-100 border border-red-200 rounded-lg text-sm font-medium text-red-600 transition-colors">
                  {t('shared.retry')}
                </button>
              </div>
            ) : totalItems === 0 ? (
              <div className="text-center py-20 bg-gray-50 rounded-2xl border-2 border-dashed border-gray-200 mt-4">
                <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center mx-auto mb-4 shadow-sm border border-gray-100">
                  <Share2 className="text-gray-300" size={32} />
                </div>
                <p className="text-gray-500 font-medium tracking-wide">{t('shared.empty')}</p>
              </div>
            ) : (
              <div className="space-y-8">
                <SharedTable
                  folders={folders} files={files}
                  actionIds={actionIds} onRevoke={revoke}
                />

                {(foldersHasMore || filesHasMore) && (
                  <div className="py-4 text-center">
                    {loadingMore ? (
                      <Loader2 className="animate-spin text-blue-500 mx-auto" size={20} />
                    ) : (
                      <button onClick={loadMoreShared} className="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium text-gray-600 transition-colors flex items-center gap-2 mx-auto">
                        <FileSearch size={16} /> {t('dashboard.loadMore')}
                      </button>
                    )}
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
