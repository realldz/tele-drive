import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

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
  @IsString()
  context?: string;

  @IsOptional()
  @IsString()
  excludeContext?: string;

  @IsOptional()
  @IsString()
  excludePath?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  excludeHealthchecks?: boolean;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  newestFirst?: boolean;
}
