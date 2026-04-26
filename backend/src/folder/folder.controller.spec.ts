import 'reflect-metadata';
import { FolderController } from './folder.controller';
import { BandwidthInterceptor } from '../common/bandwidth.interceptor';

describe('FolderController metadata', () => {
  const descriptor = Object.getOwnPropertyDescriptor(
    FolderController.prototype,
    'generateShareFolderDownloadToken',
  );
  const handler =
    descriptor?.value as FolderController['generateShareFolderDownloadToken'];

  it('marks shared folder download-token route as bandwidth check-only', () => {
    expect(Reflect.getMetadata('BANDWIDTH_CHECK_ONLY', handler)).toBe(true);
  });

  it('attaches BandwidthInterceptor to shared folder download-token route', () => {
    const interceptors = Reflect.getMetadata(
      '__interceptors__',
      handler,
    ) as Array<typeof BandwidthInterceptor>;

    expect(interceptors).toEqual(
      expect.arrayContaining([BandwidthInterceptor]),
    );
  });
});
