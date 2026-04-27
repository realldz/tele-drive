import { of } from 'rxjs';
import { HttpException, HttpStatus } from '@nestjs/common';
import { BandwidthInterceptor } from './bandwidth.interceptor';

type MockPrisma = {
  folder: {
    findFirst: jest.Mock;
  };
  fileRecord: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
  };
};

type MockReflector = {
  get: jest.Mock;
};

type MockLockService = {
  lockBandwidth: jest.Mock;
  refundBandwidth: jest.Mock;
  reconcilePerFileCounters: jest.Mock;
};

type TestRequest = {
  params: Record<string, string>;
  user?: { userId: string };
  headers: Record<string, string>;
  requestId: string;
  ip: string;
  connection: { remoteAddress: string };
  s3UserId?: string;
  path?: string;
  query?: Record<string, string>;
};

type TestResponse = {
  _bwReconciled: boolean;
  _header?: string;
  socket?: { bytesWritten: number };
  write: jest.Mock<boolean, [unknown?, unknown?, unknown?]>;
  end: jest.Mock<unknown, [unknown?, unknown?, unknown?]>;
  getHeader: jest.Mock;
  setHeader: jest.Mock;
  on: jest.Mock<TestResponse, [string, () => void]>;
  emit: (event: string) => void;
};

type TestExecutionContext = {
  switchToHttp: () => {
    getRequest: () => TestRequest;
    getResponse: () => TestResponse;
  };
  getHandler: () => object;
};

describe('BandwidthInterceptor', () => {
  const createInterceptor = () => {
    const prisma: MockPrisma = {
      folder: {
        findFirst: jest.fn(),
      },
      fileRecord: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
    };
    const cryptoService = {
      verifyStreamCookieToken: jest.fn(),
      verifySignedToken: jest.fn(),
    };
    const reflector: MockReflector = {
      get: jest.fn().mockReturnValue(false),
    };
    const lockService: MockLockService = {
      lockBandwidth: jest.fn().mockResolvedValue({ requiresReset: false }),
      refundBandwidth: jest.fn().mockResolvedValue(undefined),
      reconcilePerFileCounters: jest.fn().mockResolvedValue(undefined),
    };

    const interceptor = new BandwidthInterceptor(
      prisma as never,
      cryptoService as never,
      reflector as never,
      lockService as never,
    );

    return { interceptor, prisma, cryptoService, reflector, lockService };
  };

  const createResponse = (): TestResponse => {
    const listeners = new Map<string, Array<() => void>>();
    const res: TestResponse = {
      _bwReconciled: false,
      _header: 'HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\n',
      socket: { bytesWritten: 0 },
      write: jest.fn(() => true),
      end: jest.fn(() => undefined),
      getHeader: jest.fn(),
      setHeader: jest.fn(),
      on: jest.fn((event: string, cb: () => void) => {
        const current = listeners.get(event) ?? [];
        current.push(cb);
        listeners.set(event, current);
        return res;
      }),
      emit: (event: string) => {
        for (const cb of listeners.get(event) ?? []) cb();
      },
    };

    return res;
  };

  const createExecutionContext = (req: TestRequest, res: TestResponse) =>
    ({
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
      }),
      getHandler: () => ({}),
    }) as TestExecutionContext as never;

  it('does not refund when the full response body is written', async () => {
    const { interceptor, prisma, lockService } = createInterceptor();
    prisma.fileRecord.findUnique.mockResolvedValue({
      size: 5n,
      downloadLimit24h: null,
      downloads24h: 0,
      bandwidthLimit24h: null,
      bandwidthUsed24h: 0n,
      lastDownloadReset: new Date(),
    });

    const req: TestRequest = {
      params: { id: 'file-1' },
      user: { userId: 'user-1' },
      headers: {},
      requestId: 'req-1',
      ip: '127.0.0.1',
      connection: { remoteAddress: '127.0.0.1' },
    };
    const res = createResponse();
    const context = createExecutionContext(req, res);

    await interceptor.intercept(context, {
      handle: () => {
        res.socket!.bytesWritten = Buffer.byteLength(res._header!, 'utf8');
        res.write(Buffer.from('hel'));
        res.socket!.bytesWritten += 3;
        res.end(Buffer.from('lo'));
        res.socket!.bytesWritten += 2;
        res.emit('close');
        return of(null);
      },
    });

    expect(lockService.lockBandwidth).toHaveBeenCalledWith(
      'user-1',
      5n,
      '127.0.0.1',
    );
    expect(lockService.refundBandwidth).not.toHaveBeenCalled();
    expect(lockService.reconcilePerFileCounters).toHaveBeenCalledWith(
      'file-1',
      5n,
      5n,
      true,
    );
  });

  it('refunds only the unwritten portion when the response closes early', async () => {
    const { interceptor, prisma, lockService } = createInterceptor();
    prisma.fileRecord.findUnique.mockResolvedValue({
      size: 10n,
      downloadLimit24h: null,
      downloads24h: 0,
      bandwidthLimit24h: null,
      bandwidthUsed24h: 0n,
      lastDownloadReset: new Date(),
    });

    const req: TestRequest = {
      params: { id: 'file-2' },
      user: { userId: 'user-2' },
      headers: {},
      requestId: 'req-2',
      ip: '127.0.0.2',
      connection: { remoteAddress: '127.0.0.2' },
    };
    const res = createResponse();
    const context = createExecutionContext(req, res);

    await interceptor.intercept(context, {
      handle: () => {
        res.socket!.bytesWritten = Buffer.byteLength(res._header!, 'utf8');
        res.write(Buffer.from('1234'));
        res.socket!.bytesWritten += 4;
        res.emit('close');
        return of(null);
      },
    });

    expect(lockService.refundBandwidth).toHaveBeenCalledWith(
      {
        userId: 'user-2',
        estimatedSize: 10n,
        ip: '127.0.0.2',
      },
      6n,
      false,
    );
    expect(lockService.reconcilePerFileCounters).toHaveBeenCalledWith(
      'file-2',
      4n,
      10n,
      true,
    );
  });

  it('falls back to counted bytes when Content-Length is missing', async () => {
    const { interceptor, prisma, lockService } = createInterceptor();
    prisma.fileRecord.findUnique.mockResolvedValue({
      size: 10n,
      downloadLimit24h: null,
      downloads24h: 0,
      bandwidthLimit24h: null,
      bandwidthUsed24h: 0n,
      lastDownloadReset: new Date(),
    });

    const req: TestRequest = {
      params: { id: 'file-fallback' },
      user: { userId: 'user-fallback' },
      headers: {},
      requestId: 'req-fallback',
      ip: '127.0.0.11',
      connection: { remoteAddress: '127.0.0.11' },
    };
    const res = createResponse();
    res.getHeader.mockReturnValue(undefined);
    const context = createExecutionContext(req, res);

    await interceptor.intercept(context, {
      handle: () => {
        res.socket!.bytesWritten = Buffer.byteLength(res._header!, 'utf8');
        res.write(Buffer.from('1234'));
        res.socket!.bytesWritten += 4;
        res.emit('close');
        return of(null);
      },
    });

    expect(lockService.refundBandwidth).toHaveBeenCalledWith(
      {
        userId: 'user-fallback',
        estimatedSize: 10n,
        ip: '127.0.0.11',
      },
      6n,
      false,
    );
    expect(lockService.reconcilePerFileCounters).toHaveBeenCalledWith(
      'file-fallback',
      4n,
      10n,
      true,
    );
  });

  it('subtracts response headers from socket bytes when reconciling', async () => {
    const { interceptor, prisma, lockService } = createInterceptor();
    prisma.fileRecord.findUnique.mockResolvedValue({
      size: 5n,
      downloadLimit24h: null,
      downloads24h: 0,
      bandwidthLimit24h: null,
      bandwidthUsed24h: 0n,
      lastDownloadReset: new Date(),
    });

    const req: TestRequest = {
      params: { id: 'file-socket' },
      user: { userId: 'user-socket' },
      headers: {},
      requestId: 'req-socket',
      ip: '127.0.0.13',
      connection: { remoteAddress: '127.0.0.13' },
    };
    const res = createResponse();
    res.getHeader.mockImplementation((name: string) =>
      name === 'content-length' ? '5' : undefined,
    );
    const context = createExecutionContext(req, res);

    await interceptor.intercept(context, {
      handle: () => {
        const headerBytes = Buffer.byteLength(res._header!, 'utf8');
        res.socket!.bytesWritten = headerBytes + 5;
        res.emit('close');
        return of(null);
      },
    });

    expect(lockService.refundBandwidth).not.toHaveBeenCalled();
    expect(lockService.reconcilePerFileCounters).toHaveBeenCalledWith(
      'file-socket',
      5n,
      5n,
      true,
    );
  });

  it('clamps written bytes to the locked range size', async () => {
    const { interceptor, prisma, lockService } = createInterceptor();
    prisma.fileRecord.findUnique.mockResolvedValue({
      size: 100n,
      downloadLimit24h: null,
      downloads24h: 0,
      bandwidthLimit24h: null,
      bandwidthUsed24h: 0n,
      lastDownloadReset: new Date(),
    });

    const req: TestRequest = {
      params: { id: 'file-3' },
      user: { userId: 'user-3' },
      headers: { range: 'bytes=0-4' },
      requestId: 'req-3',
      ip: '127.0.0.3',
      connection: { remoteAddress: '127.0.0.3' },
    };
    const res = createResponse();
    const context = createExecutionContext(req, res);

    await interceptor.intercept(context, {
      handle: () => {
        res.socket!.bytesWritten = Buffer.byteLength(res._header!, 'utf8');
        res.end(Buffer.from('1234567890'));
        res.socket!.bytesWritten += 10;
        res.emit('close');
        return of(null);
      },
    });

    expect(lockService.lockBandwidth).toHaveBeenCalledWith(
      'user-3',
      5n,
      '127.0.0.3',
    );
    expect(lockService.refundBandwidth).not.toHaveBeenCalled();
    expect(lockService.reconcilePerFileCounters).toHaveBeenCalledWith(
      'file-3',
      5n,
      5n,
      false,
    );
  });

  it('resolves S3 GetObject requests and skips download counting for range requests', async () => {
    const { interceptor, prisma, lockService } = createInterceptor();
    prisma.fileRecord.findUnique.mockResolvedValue({
      size: 8n,
      downloadLimit24h: null,
      downloads24h: 0,
      bandwidthLimit24h: null,
      bandwidthUsed24h: 0n,
      lastDownloadReset: new Date(),
    });

    prisma.folder.findFirst
      .mockResolvedValueOnce({ id: 'bucket-folder' })
      .mockResolvedValueOnce({ id: 'nested-folder' });
    prisma.fileRecord.findFirst.mockResolvedValue({ id: 's3-file' });

    const req: TestRequest & {
      s3UserId: string;
      path: string;
      query: Record<string, string>;
    } = {
      params: { bucket: 'media', key: 'videos/demo.mp4' },
      headers: { range: 'bytes=0-3' },
      requestId: 'req-s3',
      ip: '127.0.0.4',
      connection: { remoteAddress: '127.0.0.4' },
      s3UserId: 's3-user',
      path: '/s3/media/videos/demo.mp4',
      query: {},
    };
    const res = createResponse();
    const context = createExecutionContext(req, res);

    await interceptor.intercept(context, {
      handle: () => {
        res.socket!.bytesWritten = Buffer.byteLength(res._header!, 'utf8');
        res.end(Buffer.from('1234'));
        res.socket!.bytesWritten += 4;
        res.emit('close');
        return of(null);
      },
    });

    expect(prisma.folder.findFirst).toHaveBeenNthCalledWith(1, {
      where: {
        userId: 's3-user',
        name: 'media',
        parentId: null,
        deletedAt: null,
      },
      select: { id: true },
    });
    expect(prisma.fileRecord.findFirst).toHaveBeenCalledWith({
      where: {
        folderId: 'nested-folder',
        filename: 'demo.mp4',
        userId: 's3-user',
        deletedAt: null,
        status: 'complete',
      },
      select: { id: true },
    });
    expect(lockService.lockBandwidth).toHaveBeenCalledWith(
      's3-user',
      4n,
      '127.0.0.4',
    );
    expect(lockService.reconcilePerFileCounters).toHaveBeenCalledWith(
      's3-file',
      4n,
      4n,
      false,
    );
  });

  it('uses range size for file bandwidth pre-checks', async () => {
    const { interceptor, prisma, lockService } = createInterceptor();
    prisma.fileRecord.findUnique.mockResolvedValue({
      size: 100n,
      downloadLimit24h: null,
      downloads24h: 0,
      bandwidthLimit24h: 95n,
      bandwidthUsed24h: 90n,
      lastDownloadReset: new Date(),
    });

    const req: TestRequest = {
      params: { id: 'file-4' },
      user: { userId: 'user-4' },
      headers: { range: 'bytes=0-4' },
      requestId: 'req-4',
      ip: '127.0.0.5',
      connection: { remoteAddress: '127.0.0.5' },
    };
    const res = createResponse();
    const context = createExecutionContext(req, res);

    await interceptor.intercept(context, {
      handle: () => {
        res.end(Buffer.from('12345'));
        res.emit('close');
        return of(null);
      },
    });

    expect(lockService.lockBandwidth).toHaveBeenCalledWith(
      'user-4',
      5n,
      '127.0.0.5',
    );
  });

  it('skips bandwidth handling for S3 ListParts requests', async () => {
    const { interceptor, prisma, lockService } = createInterceptor();
    const req: TestRequest = {
      params: { bucket: 'media', key: 'videos/demo.mp4' },
      headers: {},
      requestId: 'req-list-parts',
      ip: '127.0.0.6',
      connection: { remoteAddress: '127.0.0.6' },
      s3UserId: 's3-user',
      path: '/s3/media/videos/demo.mp4',
      query: { uploadId: 'upload-123' },
    };
    const res = createResponse();
    const context = createExecutionContext(req, res);

    await interceptor.intercept(context, {
      handle: () => of('list-parts'),
    });

    expect(prisma.folder.findFirst).not.toHaveBeenCalled();
    expect(prisma.fileRecord.findFirst).not.toHaveBeenCalled();
    expect(prisma.fileRecord.findUnique).not.toHaveBeenCalled();
    expect(lockService.lockBandwidth).not.toHaveBeenCalled();
    expect(lockService.reconcilePerFileCounters).not.toHaveBeenCalled();
  });

  it('rejects when the requested range would exceed the file bandwidth limit', async () => {
    const { interceptor, prisma, lockService } = createInterceptor();
    prisma.fileRecord.findUnique.mockResolvedValue({
      size: 100n,
      downloadLimit24h: null,
      downloads24h: 0,
      bandwidthLimit24h: 94n,
      bandwidthUsed24h: 90n,
      lastDownloadReset: new Date(),
    });

    const req: TestRequest = {
      params: { id: 'file-5' },
      user: { userId: 'user-5' },
      headers: { range: 'bytes=0-4' },
      requestId: 'req-5',
      ip: '127.0.0.7',
      connection: { remoteAddress: '127.0.0.7' },
    };
    const res = createResponse();
    const context = createExecutionContext(req, res);

    await expect(
      interceptor.intercept(context, {
        handle: () => of(null),
      }),
    ).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });

    expect(lockService.lockBandwidth).not.toHaveBeenCalled();
  });
});
