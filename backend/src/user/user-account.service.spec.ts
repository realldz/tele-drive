import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UserService } from './user.service';

type MockPrisma = {
  user: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    update: jest.Mock;
  };
};

describe('UserService account email', () => {
  const createService = () => {
    const prisma: MockPrisma = {
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
    };

    const service = new UserService(prisma as never, {} as never);
    jest.spyOn(service['logger'], 'log').mockImplementation(() => {});
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => {});

    return { service, prisma };
  };

  const user = {
    id: 'user-1',
    username: 'alice',
    email: null,
    role: 'USER',
    quota: 15n,
    usedSpace: 0n,
    dailyBandwidthLimit: null,
    dailyBandwidthUsed: 0n,
    lastBandwidthReset: new Date('2026-07-19T00:00:00.000Z'),
    createdAt: new Date('2026-07-19T00:00:00.000Z'),
  };

  it('normalizes email for self update', async () => {
    const { service, prisma } = createService();
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.update.mockResolvedValue({
      ...user,
      email: 'alice@example.com',
    });

    const result = await service.updateMe(user.id, {
      email: ' Alice@Example.COM ',
    });

    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: {
        email: { equals: 'alice@example.com', mode: 'insensitive' },
        NOT: { id: user.id },
      },
      select: { id: true },
    });
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { email: 'alice@example.com' } }),
    );
    expect(result.email).toBe('alice@example.com');
  });

  it('uses same normalization path for admin update', async () => {
    const { service, prisma } = createService();
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.update.mockResolvedValue({
      ...user,
      email: 'admin-set@example.com',
    });

    await service.updateUserAccount(user.id, {
      email: ' Admin-Set@Example.COM ',
    });

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { email: 'admin-set@example.com' } }),
    );
  });

  it.each([
    ['empty string', ''],
    ['null', null],
  ])('clears email from %s', async (_, email) => {
    const { service, prisma } = createService();
    prisma.user.findUnique.mockResolvedValue({
      ...user,
      email: 'alice@example.com',
    });
    prisma.user.update.mockResolvedValue({ ...user, email: null });

    await service.updateMe(user.id, { email });

    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { email: null } }),
    );
  });

  it('rejects duplicate email owned by another user', async () => {
    const { service, prisma } = createService();
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.user.findFirst.mockResolvedValue({ id: 'user-2' });

    await expect(
      service.updateMe(user.id, { email: 'taken@example.com' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('allows saving current email without duplicate lookup', async () => {
    const { service, prisma } = createService();
    const existing = { ...user, email: 'alice@example.com' };
    prisma.user.findUnique.mockResolvedValue(existing);
    prisma.user.update.mockResolvedValue(existing);

    await service.updateMe(user.id, { email: ' Alice@Example.COM ' });

    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { email: 'alice@example.com' } }),
    );
  });

  it('maps exact unique constraint races to duplicate email error', async () => {
    const { service, prisma } = createService();
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.update.mockRejectedValue({ code: 'P2002' });

    await expect(
      service.updateMe(user.id, { email: 'race@example.com' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws when user does not exist', async () => {
    const { service, prisma } = createService();
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.updateUserAccount('missing-user', {
        email: 'missing@example.com',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
