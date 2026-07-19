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
      onClick={(e) => { e.stopPropagation(); copyLink(type, token); }}
      className="p-2 text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors flex items-center gap-1 text-sm font-medium"
    >
      <Copy size={16} />
      <span className="hidden sm:inline">{t('shared.copyLink')}</span>
    </button>
  );

  const openBtn = (onClick: () => void) => (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="p-2 text-gray-600 bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors flex items-center gap-1 text-sm font-medium"
    >
      <ExternalLink size={16} />
      <span className="hidden sm:inline">{t('shared.open')}</span>
    </button>
  );

  const revokeBtn = (id: string, onClick: () => void) => (
    <button
      onClick={(e) => { e.stopPropagation(); if (confirm(t('shared.confirmRevoke'))) onClick(); }}
      disabled={actionIds.has(id)}
      className="p-2 text-red-600 bg-red-50 hover:bg-red-100 disabled:opacity-50 disabled:hover:bg-red-50 rounded-lg transition-colors flex items-center gap-1 text-sm font-medium"
    >
      {actionIds.has(id) ? <Loader2 size={16} className="animate-spin" /> : <XCircle size={16} />}
      <span className="hidden sm:inline">{t('shared.revoke')}</span>
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
      <table className="w-full text-left border-collapse">
        <tbody className="divide-y divide-gray-100">
          {folders.map(folder => (
            <tr key={folder.id} className="hover:bg-gray-50 transition-colors">
              <td className="p-4 flex items-center gap-3">
                <Folder className="w-6 h-6 text-gray-400 flex-shrink-0" fill="currentColor" opacity={0.5} />
                <div>
                  <span className="font-medium text-gray-800 block">{folder.name}</span>
                  <div className="text-xs mt-0.5 flex flex-wrap items-center gap-2">
                    {folder.shareToken ? linkBadge : null}
                    {folder.s3PublicAccess ? s3Badge : null}
                  </div>
                </div>
              </td>
              <td className="p-4 text-right whitespace-nowrap">
                <div className="flex justify-end gap-2">
                  {folder.shareToken ? copyBtn('folder', folder.shareToken) : null}
                  {folder.shareToken ? openBtn(() => openLink('folder', folder.shareToken!)) : null}
                  {revokeBtn(folder.id, () => onRevoke(folder, 'folder'))}
                </div>
              </td>
            </tr>
          ))}
          {files.map(file => (
            <tr key={file.id} className="hover:bg-gray-50 transition-colors">
              <td className="p-4 flex items-center gap-3">
                <FileText className="w-6 h-6 text-gray-400 flex-shrink-0" />
                <div>
                  <span className="font-medium text-gray-800 block truncate max-w-[200px] sm:max-w-xs">{file.filename}</span>
                  <div className="text-xs mt-0.5 flex flex-wrap items-center gap-2">
                    <Badge variant="default" className="font-medium">{formatSize(Number(file.size))}</Badge>
                    {file.shareToken ? linkBadge : null}
                  </div>
                </div>
              </td>
              <td className="p-4 text-right whitespace-nowrap">
                <div className="flex justify-end gap-2">
                  {file.shareToken ? copyBtn('file', file.shareToken) : null}
                  {file.shareToken ? openBtn(() => openLink('file', file.shareToken!)) : null}
                  {revokeBtn(file.id, () => onRevoke(file, 'file'))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
