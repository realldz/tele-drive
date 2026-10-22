import type { NextFunction, Request, Response } from 'express';
import { rejectBrotliRequestEncoding } from './reject-brotli-request.middleware';

type FakeRequestInit = {
  method?: string;
  url?: string;
  originalUrl?: string;
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
};

function makeRequest(init: FakeRequestInit = {}): Request {
  const url = init.url ?? '/api/v1/auth/login';
  return {
    method: init.method ?? 'POST',
    url,
    originalUrl: init.originalUrl ?? url,
    headers: init.headers ?? {},
    ip: init.ip ?? '127.0.0.1',
    requestId: 'req-test',
  } as unknown as Request;
}

type FakeResponse = {
  status: jest.Mock;
  json: jest.Mock;
};

function makeResponse(): FakeResponse {
  const res: FakeResponse = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

function asResponse(res: FakeResponse): Response {
  return res as unknown as Response;
}

describe('rejectBrotliRequestEncoding', () => {
  it('lets uncompressed requests through', () => {
    const next = jest.fn();
    const res = makeResponse();

    rejectBrotliRequestEncoding(makeRequest(), asResponse(res), next);

    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects a Brotli-encoded body with 415', () => {
    const next = jest.fn();
    const res = makeResponse();

    rejectBrotliRequestEncoding(
      makeRequest({ headers: { 'content-encoding': 'br' } }),
      asResponse(res),
      next as unknown as NextFunction,
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(415);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 415,
        path: '/api/v1/auth/login',
      }),
    );
  });

  it('rejects Brotli when chained with other encodings', () => {
    const next = jest.fn();
    const res = makeResponse();

    rejectBrotliRequestEncoding(
      makeRequest({ headers: { 'content-encoding': 'gzip, BR' } }),
      asResponse(res),
      next as unknown as NextFunction,
    );

    expect(res.status).toHaveBeenCalledWith(415);
  });

  it('keeps gzip and deflate bodies working', () => {
    for (const encoding of ['gzip', 'deflate']) {
      const next = jest.fn();
      const res = makeResponse();

      rejectBrotliRequestEncoding(
        makeRequest({ headers: { 'content-encoding': encoding } }),
        asResponse(res),
        next as unknown as NextFunction,
      );

      expect(next).toHaveBeenCalledWith();
      expect(res.status).not.toHaveBeenCalled();
    }
  });

  it('exempts S3 routes, where Content-Encoding is object metadata', () => {
    for (const path of ['/s3', '/s3/bucket/key', '/s3/bucket/key?uploads']) {
      const next = jest.fn();
      const res = makeResponse();

      rejectBrotliRequestEncoding(
        makeRequest({
          method: 'PUT',
          url: path,
          headers: { 'content-encoding': 'br' },
        }),
        asResponse(res),
        next as unknown as NextFunction,
      );

      expect(next).toHaveBeenCalledWith();
      expect(res.status).not.toHaveBeenCalled();
    }
  });

  it('exempts /api/s3 routes after the S3 url rewrite', () => {
    const next = jest.fn();
    const res = makeResponse();

    rejectBrotliRequestEncoding(
      makeRequest({
        method: 'PUT',
        url: '/s3/bucket/key',
        originalUrl: '/api/s3/bucket/key',
        headers: { 'content-encoding': 'br' },
      }),
      asResponse(res),
      next as unknown as NextFunction,
    );

    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });
});
