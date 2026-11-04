import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PaginationQueryDto } from './pagination-query.dto';

describe('PaginationQueryDto', () => {
  it.each([
    ['true', true],
    ['false', false],
  ])('parses includeTotals=%s as %s', (input, expected) => {
    const dto = plainToInstance(PaginationQueryDto, { includeTotals: input });

    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.includeTotals).toBe(expected);
  });

  it('rejects an invalid includeTotals value', () => {
    const dto = plainToInstance(PaginationQueryDto, {
      includeTotals: 'sometimes',
    });

    expect(validateSync(dto)).not.toHaveLength(0);
  });
});
