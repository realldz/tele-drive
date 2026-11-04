'use client';

import { FileText, Folder, Link2, Cloud, Copy, ExternalLink, XCircle, Loader2 } from 'lucide-react';
import { useI18n } from '@/providers/i18n-context';
import { formatSize } from '@/lib/api';
import Badge from '@/components/atoms/badge';
import type { FileRecord, FolderRecord } from '@/lib/types';
import toast from 'react-hot-toast';

interface SharedTableProps {
  folders: FolderRecord[];
  files: FileRecord[];
  actionIds: Set<string>;
  onRevoke: (item: FolderRecord | FileRecord, type: 'folder' | 'file') => void;
}

/** Public URL for a shared item — folder link differs from file link. */
function buildShareUrl(type: 'folder' | 'file', token: string): string {
  const seg = type === 'folder' ? 'share/folder' : 'share';
  return `${window.location.origin}/${seg}/${token}`;
}

/**
 * Shared-items table. Folders then files as rows. Each row shows a badge for how
 * it's shared (public link vs S3-public-only) and inline actions: copy link
 * (hidden for S3-only folders — no token to copy), open, revoke.
 */
export default function SharedTable({
  folders, files, actionIds, onRevoke,
}: SharedTableProps) {
  const { t } = useI18n();

  const copyLink = async (type: 'folder' | 'file', token: string) => {
    try {
      await navigator.clipboard.writeText(buildShareUrl(type, token));
      toast.success(t('shared.linkCopied'));
    } catch {
      toast.error(t('shared.copyError'));
    }
  };

  // Open the public share page in a new tab. Token-gated like copy — an
  // S3-public-only folder has no share page, so no open button for it.
  const openLink = (type: 'folder' | 'file', token: string) =>
    window.open(buildShareUrl(type, token), '_blank', 'noopener,noreferrer');

  const copyBtn = (type: 'folder' | 'file', token: string) => (
    <button
      type="button"
      aria-label={t('shared.copyLink')}
      onClick={(e) => { e.stopPropagation(); copyLink(type, token); }}
      className="p-2 text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors flex items-center gap-1 text-sm font-medium"
    >
      <Copy size={16} />
      <span className="sr-only sm:not-sr-only">{t('shared.copyLink')}</span>
    </button>
  );

  const openBtn = (onClick: () => void) => (
    <button
      type="button"
      aria-label={t('shared.open')}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="p-2 text-gray-600 bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors flex items-center gap-1 text-sm font-medium"
    >
      <ExternalLink size={16} />
      <span className="sr-only sm:not-sr-only">{t('shared.open')}</span>
    </button>
  );

  const revokeBtn = (id: string, onClick: () => void) => (
    <button
      type="button"
      aria-label={t('shared.revoke')}
      aria-busy={actionIds.has(id)}
      onClick={(e) => { e.stopPropagation(); if (confirm(t('shared.confirmRevoke'))) onClick(); }}
      disabled={actionIds.has(id)}
      className="p-2 text-red-600 bg-red-50 hover:bg-red-100 disabled:opacity-50 disabled:hover:bg-red-50 rounded-lg transition-colors flex items-center gap-1 text-sm font-medium"
    >
      {actionIds.has(id) ? <Loader2 size={16} className="animate-spin" /> : <XCircle size={16} />}
      <span className="sr-only sm:not-sr-only">{t('shared.revoke')}</span>
    </button>
  );

  const linkBadge = (
    <Badge variant="default" className="font-medium flex items-center gap-1">
      <Link2 size={10} /> {t('shared.badgeLink')}
    </Badge>
  );
  const s3Badge = (
    <Badge variant="default" className="font-medium flex items-center gap-1">
      <Cloud size={10} /> {t('shared.badgeS3')}
    </Badge>
  );

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
      <ul className="divide-y divide-gray-100">
        {folders.map(folder => (
          <li key={folder.id} className="p-4 flex flex-col gap-3 transition-colors hover:bg-gray-50 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <Folder className="h-6 w-6 flex-shrink-0 text-gray-400" fill="currentColor" opacity={0.5} />
              <div className="min-w-0">
                <span className="block break-words font-medium text-gray-800">{folder.name}</span>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs">
                  {folder.shareToken ? linkBadge : null}
                  {folder.s3PublicAccess ? s3Badge : null}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap justify-end gap-2 sm:flex-shrink-0">
              {folder.shareToken ? copyBtn('folder', folder.shareToken) : null}
              {folder.shareToken ? openBtn(() => openLink('folder', folder.shareToken!)) : null}
              {revokeBtn(folder.id, () => onRevoke(folder, 'folder'))}
            </div>
          </li>
        ))}
        {files.map(file => (
          <li key={file.id} className="p-4 flex flex-col gap-3 transition-colors hover:bg-gray-50 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <FileText className="h-6 w-6 flex-shrink-0 text-gray-400" />
              <div className="min-w-0">
                <span className="block break-all font-medium text-gray-800 sm:max-w-xs sm:truncate">{file.filename}</span>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant="default" className="font-medium">{formatSize(Number(file.size))}</Badge>
                  {file.shareToken ? linkBadge : null}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap justify-end gap-2 sm:flex-shrink-0">
              {file.shareToken ? copyBtn('file', file.shareToken) : null}
              {file.shareToken ? openBtn(() => openLink('file', file.shareToken!)) : null}
              {revokeBtn(file.id, () => onRevoke(file, 'file'))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
