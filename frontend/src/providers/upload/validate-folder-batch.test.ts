import { describe, expect, it } from 'vitest';
import { validateFolderBatch } from '@/providers/upload/validate-folder-batch';

describe('validateFolderBatch', () => {
  it('rejects a failed ancestor and a descendant created under the wrong parent', () => {
    const result = validateFolderBatch(
      ['root/sub', 'root'],
      { root: 'current-folder', 'root/sub': 'orphan-sub' },
      'current-folder',
    );
    expect(result.size).toBe(0);
  });

  it('keeps a complete folder hierarchy', () => {
    const result = validateFolderBatch(
      ['root/sub', 'root'],
      { root: 'root-id', 'root/sub': 'sub-id' },
      'current-folder',
    );
    expect(result.get('root/sub')).toBe('sub-id');
  });
});
