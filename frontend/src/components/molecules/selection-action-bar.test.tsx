import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SelectionActionBar from '@/components/molecules/selection-action-bar';

vi.mock('@/providers/i18n-context', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

describe('SelectionActionBar', () => {
  it('stays inside narrow viewports and wraps dashboard actions', () => {
    const { container, getByRole } = render(
      <SelectionActionBar
        selectedCount={3}
        onClear={vi.fn()}
        onMove={vi.fn()}
        onDownload={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    const positioner = container.firstElementChild as HTMLElement;
    const bar = positioner.firstElementChild as HTMLElement;
    const actions = getByRole('button', { name: 'selection.moveSelected' }).parentElement as HTMLElement;

    expect(positioner.className).toContain('inset-x-3');
    expect(bar.className).toContain('max-w-full');
    expect(actions.className).toContain('grid-cols-2');
    expect(actions.className).toContain('md:flex');
  });

  it('keeps long trash actions shrinkable in the mobile grid', () => {
    const { getByRole } = render(
      <SelectionActionBar
        selectedCount={2}
        variant="trash"
        onClear={vi.fn()}
        onRestore={vi.fn()}
        onPermanentDelete={vi.fn()}
      />,
    );

    const permanentDelete = getByRole('button', { name: 'selection.permanentDeleteSelected' });
    const actions = permanentDelete.parentElement as HTMLElement;

    expect(actions.className).toContain('grid-cols-2');
    expect(permanentDelete.className).toContain('min-w-0');
    expect(permanentDelete.className).not.toContain('whitespace-nowrap');
  });
});
