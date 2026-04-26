'use client';

import Link, { type LinkProps } from 'next/link';
import { forwardRef } from 'react';
import { useNavigation } from './navigation-loader';

type AnchorProps = React.AnchorHTMLAttributes<HTMLAnchorElement>;

type AppLinkProps = LinkProps & AnchorProps;

const AppLink = forwardRef<HTMLAnchorElement, AppLinkProps>(function AppLink(
  { onClick, href, ...props },
  ref,
) {
  const { startNavigation } = useNavigation();

  return (
    <Link
      ref={ref}
      href={href}
      {...props}
      onClick={(event) => {
        onClick?.(event);

        if (event.defaultPrevented) return;
        if (event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return;
        }

        startNavigation();
      }}
    />
  );
});

export default AppLink;
