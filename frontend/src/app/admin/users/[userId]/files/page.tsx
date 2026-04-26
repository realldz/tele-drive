'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import {
  fetchAdminUserBasic,
  fetchUserFiles,
  getApiErrorMessage,
  updateAdminUserFileDownloadPolicy,
} from '@/lib/api';
import type { AdminUserBasic, AdminUserFile } from '@/lib/types';
import { useI18n } from '@/components/i18n-context';
import AdminUserFilesList from '../../../components/admin-user-files-list';

interface DownloadPolicyForm {
  downloadLimit24h: string;
  bandwidthLimitGB: string;
}

export default function AdminUserFilesPage() {
  const params = useParams();
  const router = useRouter();
  const { t, locale } = useI18n();
  const userId = params.userId as string;
  const [user, setUser] = useState<AdminUserBasic | null>(null);
  const [files, setFiles] = useState<AdminUserFile[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [fileSearch, setFileSearch] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [actionLoading, setActionLoading] = useState<Set<string>>(new Set());

  const loadInitial = useCallback(
    async (search?: string) => {
      setLoading(true);
      setCursor(null);
      setHasMore(true);
      try {
        const [userData, fileData] = await Promise.all([
          fetchAdminUserBasic(userId),
          fetchUserFiles(userId, undefined, search),
        ]);
        setUser(userData);
        setFiles(fileData.data);
        setCursor(fileData.nextCursor);
        setHasMore(fileData.nextCursor !== null);
      } catch (err: unknown) {
        toast.error(getApiErrorMessage(err, t('admin.fetchUserFilesError')));
      } finally {
        setLoading(false);
      }
    },
    [userId, t],
  );

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const res = await fetchUserFiles(userId, cursor, fileSearch || undefined);
      setFiles((prev) => [...prev, ...res.data]);
      setCursor(res.nextCursor);
      setHasMore(res.nextCursor !== null);
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('admin.fetchUserFilesError')));
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, hasMore, userId, fileSearch, t]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  const handleSearch = useCallback(
    (value: string) => {
      setFileSearch(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        void loadInitial(value.trim() || undefined);
      }, 400);
    },
    [loadInitial],
  );

  if (!user) {
    return null;
  }

  return (
    <AdminUserFilesList
      user={user}
      files={files}
      locale={locale}
      t={t}
      loading={loading}
      loadingMore={loadingMore}
      hasMore={hasMore}
      fileSearch={fileSearch}
      onFileSearch={handleSearch}
      onLoadMore={loadMore}
      onBack={() => router.push('/admin/users')}
      onDeleteFile={() => {
        toast.error(t('admin.deleteFileError'));
      }}
      onSavePolicy={async (fileId, form: DownloadPolicyForm) => {
        const actionKey = `policy:${fileId}`;
        setActionLoading((prev) => new Set(prev).add(actionKey));
        try {
          const downloadLimit24h =
            form.downloadLimit24h.trim() === ''
              ? null
              : Number(form.downloadLimit24h);
          const bandwidthLimit24h =
            form.bandwidthLimitGB.trim() === ''
              ? null
              : Math.round(Number(form.bandwidthLimitGB) * 1024 ** 3).toString();

          const updated = await updateAdminUserFileDownloadPolicy(userId, fileId, {
            downloadLimit24h,
            bandwidthLimit24h,
          });

          setFiles((prev) =>
            prev.map((file) =>
              file.id === fileId
                ? {
                    ...file,
                    downloadLimit24h: updated.downloadLimit24h,
                    downloads24h: updated.downloads24h,
                    bandwidthLimit24h: updated.bandwidthLimit24h,
                    bandwidthUsed24h: updated.bandwidthUsed24h,
                    lastDownloadReset: updated.lastDownloadReset,
                  }
                : file,
            ),
          );
          toast.success(t('admin.policyUpdated'));
        } catch (err: unknown) {
          toast.error(getApiErrorMessage(err, t('admin.policyUpdateError')));
          throw err;
        } finally {
          setActionLoading((prev) => {
            const next = new Set(prev);
            next.delete(actionKey);
            return next;
          });
        }
      }}
      actionLoading={actionLoading}
    />
  );
}
