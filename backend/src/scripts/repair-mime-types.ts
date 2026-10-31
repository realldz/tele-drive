import { PrismaClient } from '@prisma/client';
import {
  isGenericMimeType,
  resolveMimeType,
} from '../common/utils/resolve-mime-type';

const BATCH_SIZE = 100;
const APPLY_FLAG = '--apply';

type Repair = {
  id: string;
  previousMimeType: string;
  resolvedMimeType: string;
};

async function main(): Promise<void> {
  const apply = process.argv.includes(APPLY_FLAG);
  const prisma = new PrismaClient();
  let cursor: string | undefined;
  let scanned = 0;
  let repairable = 0;
  let updated = 0;
  const resolvedCounts = new Map<string, number>();

  try {
    for (;;) {
      const files = await prisma.fileRecord.findMany({
        where: {
          OR: [
            { mimeType: { contains: 'octet-stream', mode: 'insensitive' } },
            {
              mimeType: { equals: 'binary/octet-stream', mode: 'insensitive' },
            },
            { mimeType: '' },
          ],
        },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, filename: true, mimeType: true },
      });
      if (files.length === 0) break;

      scanned += files.length;
      cursor = files.at(-1)?.id;
      const repairs: Repair[] = [];

      for (const file of files) {
        if (!isGenericMimeType(file.mimeType)) continue;
        const resolvedMimeType = resolveMimeType(file.filename, file.mimeType);
        if (isGenericMimeType(resolvedMimeType)) continue;
        repairs.push({
          id: file.id,
          previousMimeType: file.mimeType,
          resolvedMimeType,
        });
        resolvedCounts.set(
          resolvedMimeType,
          (resolvedCounts.get(resolvedMimeType) || 0) + 1,
        );
      }

      repairable += repairs.length;
      if (apply && repairs.length > 0) {
        const results = await prisma.$transaction(
          repairs.map((repair) =>
            prisma.fileRecord.updateMany({
              where: {
                id: repair.id,
                mimeType: repair.previousMimeType,
              },
              data: { mimeType: repair.resolvedMimeType },
            }),
          ),
        );
        updated += results.reduce((sum, result) => sum + result.count, 0);
      }
    }

    const summary = [...resolvedCounts.entries()].sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    );
    console.log(
      JSON.stringify(
        {
          mode: apply ? 'apply' : 'dry-run',
          scanned,
          repairable,
          updated,
          resolvedTypes: Object.fromEntries(summary),
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
