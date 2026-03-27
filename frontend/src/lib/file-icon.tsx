import { ImageIcon, Film, Music, FileText, FileIcon, FileArchive, FileCode, FileSpreadsheet } from 'lucide-react';
import type { ReactElement } from 'react';

/**
 * Returns a lucide-react icon element matching the given MIME type.
 * Centralised so every surface (dashboard, preview modal, admin) renders
 * the same icon for the same file type.
 */
export function getFileIcon(mimeType: string, className = 'w-5 h-5 text-gray-500'): ReactElement {
  if (mimeType === 'application/pdf')
    return <FileText className={className} style={{ color: '#ef4444' }} />;

  if (mimeType.startsWith('image/'))
    return <ImageIcon className={className} style={{ color: '#3b82f6' }} />;

  if (mimeType.startsWith('video/'))
    return <Film className={className} style={{ color: '#8b5cf6' }} />;

  if (mimeType.startsWith('audio/'))
    return <Music className={className} style={{ color: '#f59e0b' }} />;

  if (mimeType.startsWith('text/'))
    return <FileText className={className} />;

  if (
    mimeType.includes('zip') ||
    mimeType.includes('rar') ||
    mimeType.includes('tar') ||
    mimeType.includes('gzip') ||
    mimeType.includes('7z') ||
    mimeType.includes('compressed')
  )
    return <FileArchive className={className} style={{ color: '#f97316' }} />;

  if (
    mimeType.includes('javascript') ||
    mimeType.includes('json') ||
    mimeType.includes('xml') ||
    mimeType.includes('html') ||
    mimeType.includes('css') ||
    mimeType.includes('typescript')
  )
    return <FileCode className={className} style={{ color: '#10b981' }} />;

  if (
    mimeType.includes('spreadsheet') ||
    mimeType.includes('excel') ||
    mimeType.includes('csv')
  )
    return <FileSpreadsheet className={className} style={{ color: '#22c55e' }} />;

  return <FileIcon className={className} />;
}
