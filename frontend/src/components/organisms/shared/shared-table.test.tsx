import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SharedTable from '@/components/organisms/shared/shared-table';
import type { FileRecord, FolderRecord } from '@/lib/types';

vi.mock('@/providers/i18n-context', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/api', () => ({ formatSize: () => '1 B' }));
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

const sharedFolder: FolderRecord = {
  id: 'folder-1', name: 'Folder', parentId: null, userId: 'user-1',
  visibility: 'PUBLIC_LINK', shareToken: 'folder-token', s3PublicAccess: true,
  s3PublicListObjects: false, createdAt: '', updatedAt: '',
};
const sharedFile: FileRecord = {
  id: 'file-1', filename: 'file.txt', size: 1, mimeType: 'text/plain',
  status: 'complete', totalChunks: 1, folderId: null, userId: 'user-1',
  visibility: 'PUBLIC_LINK', shareToken: 'file-token', createdAt: '', updatedAt: '',
};

afterEach(cleanup);

describe('SharedTable', () => {
  it('uses responsive list rows instead of a clipped table layout', () => {
    const { container } = render(
      <SharedTable folders={[sharedFolder]} files={[sharedFile]} actionIds={new Set()} onRevoke={vi.fn()} />,
    );

    expect(container.querySelector('table')).toBeNull();
    const rows = [...container.querySelectorAll('li')];
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.className.includes('flex-col') && row.className.includes('sm:flex-row'))).toBe(true);
  });

  it('gives every action an accessible name and exposes revoke progress', () => {
    const { container } = render(
      <SharedTable folders={[sharedFolder]} files={[]} actionIds={new Set(['folder-1'])} onRevoke={vi.fn()} />,
    );

    const buttons = [...container.querySelectorAll('button')];
    expect(buttons).toHaveLength(3);
    expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual([
      'shared.copyLink', 'shared.open', 'shared.revoke',
    ]);
    expect(buttons[2].getAttribute('aria-busy')).toBe('true');
  });
});
