import { FolderService } from './folder.service';

describe('FolderService.createBatch', () => {
  const makeService = () =>
    new FolderService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

  it('skips descendants after a parent fails, preserving independent branches', async () => {
    const service = makeService();
    const create = jest.spyOn(service, 'create').mockImplementation((name) => {
      if (name === 'bad') return Promise.reject(new Error('creation failed'));
      return Promise.resolve({ id: `${name}-id` } as never);
    });
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => {});

    const result = await service.createBatch(
      ['bad/child', 'good/child', 'bad', 'good'],
      'user-1',
      'parent-1',
    );

    expect(result).toEqual({
      bad: '',
      good: 'good-id',
      'bad/child': '',
      'good/child': 'child-id',
    });
    expect(create).toHaveBeenCalledTimes(3);
    expect(create).not.toHaveBeenCalledWith(
      'child',
      'user-1',
      'parent-1',
      'merge',
    );
  });
});
