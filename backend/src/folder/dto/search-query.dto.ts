import {
  IsInt,
  IsOptional,
  IsString,
  IsIn,
  IsDateString,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { FORMAT_CATEGORIES } from '../file-format-category';

/**
 * Query params for global search (`GET /folders/search`).
 * Mirrors PaginationQueryDto's cursor/limit/sort shape so the frontend reuses
 * the same dual-cursor pagination infra, plus the search-specific filters.
 */
export class SearchQueryDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsIn(['all', 'folder', 'file'])
  type?: 'all' | 'folder' | 'file';

  @IsOptional()
  @IsIn(FORMAT_CATEGORIES as unknown as string[])
  format?: string;

  @IsOptional()
  @IsDateString()
  createdFrom?: string;

  @IsOptional()
  @IsDateString()
  createdTo?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;

  @IsOptional()
  @IsString()
  sortField?: string;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDirection?: 'asc' | 'desc';
}
