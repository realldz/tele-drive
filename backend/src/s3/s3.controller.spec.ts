import { S3Controller } from './s3.controller';

describe('S3Controller', () => {
  const createController = () => {
    const s3Service = {
      buildErrorXml: jest.fn((code: string, message: string) => {
        return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
      }),
    };

    const controller = new S3Controller(
      s3Service as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const res = {
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
    };

    return { controller, s3Service, res };
  };

  it('maps retryable upstream errors to ServiceUnavailable', () => {
    const { controller, s3Service, res } = createController();
    const err = new Error(
      'request to http://nginx:8088/bot123/sendDocument failed, reason: socket hang up',
    );

    (controller as any).sendS3Error(res, err);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(s3Service.buildErrorXml).toHaveBeenCalledWith(
      'ServiceUnavailable',
      'A temporary upstream error occurred. Please retry.',
    );
  });

  it('preserves mapped S3 domain errors', () => {
    const { controller, s3Service, res } = createController();
    const err = new Error('NoSuchKey');

    (controller as any).sendS3Error(res, err);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(s3Service.buildErrorXml).toHaveBeenCalledWith(
      'NoSuchKey',
      'NoSuchKey',
    );
  });
});
