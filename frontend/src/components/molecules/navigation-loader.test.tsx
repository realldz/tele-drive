import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NavigationLoader from '@/components/molecules/navigation-loader';

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

describe('NavigationLoader', () => {
  afterEach(() => cleanup());

  it('does not start navigation when a link click is prevented by React', () => {
    const { container, getByRole } = render(
      <NavigationLoader>
        <a href="/login" onClick={event => event.preventDefault()}>Login</a>
      </NavigationLoader>,
    );
    fireEvent.click(getByRole('link', { name: 'Login' }));
    expect((container.firstElementChild as HTMLElement).style.opacity).toBe('0');
  });
});
