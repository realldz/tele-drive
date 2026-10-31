import { S3Controller } from './s3.controller';
import { S3Service } from './s3.service';
import { buildListPage } from './s3-list-pagination.util';

describe('ListObjects V1 pagination', () => {
  it('resumes with a raw marker across prefix-only pages', async () => {
    const service = new S3Service({} as never, {} as never);
    const list = jest
      .spyOn(service, 'listObjects')
      .mockImplementation(
        (_user, _bucket, _prefix, _delimiter, maxKeys, after) =>
          Promise.resolve(buildListPage([], ['a&b/', 'c/'], maxKeys!, after)),
      );
    const controller = new S3Controller(
      service,
      {} as never,
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
      send: jest.fn<unknown, [string]>().mockReturnThis(),
    };
    await controller.listObjects(
      's3',
      {
        s3UserId: 'user',
        query: { delimiter: '/', 'max-keys': '1', 'encoding-type': 'url' },
      } as never,
      res as never,
    );
    expect(res.send.mock.calls[0][0]).toContain(
      '<NextMarker>a%26b%2F</NextMarker>',
    );
    expect(res.send.mock.calls[0][0]).not.toContain('<NextContinuationToken>');
    await controller.listObjects(
      's3',
      {
        s3UserId: 'user',
        query: { delimiter: '/', 'max-keys': '1', marker: 'a&b/' },
      } as never,
      res as never,
    );
    expect(list.mock.calls[1][5]).toBe('a&b/');
    expect(res.send.mock.calls[1][0]).toContain(
      '<IsTruncated>false</IsTruncated>',
    );
    expect(res.send.mock.calls[1][0]).toContain('<Prefix>c/</Prefix>');
    expect(res.send.mock.calls[1][0]).not.toContain('<NextMarker>');
  });
});

it.each(['versions', 'uploads', 'location', 'versioning'])(
  'does not misreport %s as an object listing',
  async (operation) => {
    const service = new S3Service({} as never, {} as never);
    const list = jest.spyOn(service, 'listObjects');
    const controller = new S3Controller(
      service,
      {} as never,
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
      send: jest.fn<unknown, [string]>().mockReturnThis(),
    };
    await controller.listObjects(
      's3',
      { s3UserId: 'user', query: { [operation]: '' } } as never,
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(501);
    expect(list).not.toHaveBeenCalled();
  },
);
