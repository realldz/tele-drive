import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import TransferDownloadItem from '@/components/transfer/transfer-download-item';
import type { DownloadJob } from '@/providers/download-context';

vi.mock('@/lib/api', () => ({ formatBytes: vi.fn(), resolveTransferLink: vi.fn() }));

describe('TransferDownloadItem', () => {
  it('shows ZIP splitting as an active stage', () => {
    const job: DownloadJob = {
      jobId: 'job', status: 'splitting', totalFiles: 2, processedFiles: 2,
      totalSize: '100', parts: [], expiresAt: null, error: null, label: 'Files',
    };
    render(<TransferDownloadItem job={job} t={key => key} onCancel={vi.fn()} />);

    expect(screen.getByText(/downloadZip.splitting/)).toBeTruthy();
    expect(screen.getByTitle('downloadZip.cancel')).toBeTruthy();
  });
});
