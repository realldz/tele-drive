'use client';

import { useRef, useEffect, type ReactNode } from 'react';
import { Provider } from 'react-redux';
import { store, useAppDispatch } from '@/lib/store';
import { loadUploadConfig } from '@/lib/upload-config-slice';

/** Dispatch loadUploadConfig 1 lần duy nhất khi app mount */
function ConfigLoader() {
  const dispatch = useAppDispatch();
  const dispatched = useRef(false);

  useEffect(() => {
    if (!dispatched.current) {
      dispatched.current = true;
      dispatch(loadUploadConfig());
    }
  }, [dispatch]);

  return null;
}

export default function StoreProvider({ children }: { children: ReactNode }) {
  return (
    <Provider store={store}>
      <ConfigLoader />
      {children}
    </Provider>
  );
}
