import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export const ADMIN_LOG_FILTER_FIELDS = [
  'timestamp',
  'level',
  'context',
  'message',
  'stack',
  'raw',
] as const;

export type AdminLogFilterField = (typeof ADMIN_LOG_FILTER_FIELDS)[number];

export class ReadLogQueryDto {
  @IsString()
  file!: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(5000)
  limit: number = 100;

  @IsOptional()
  @IsString()
  level?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  newestFirst?: boolean;

  @IsOptional()
  @IsString()
  filters?: string;
}
