import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ReadLogQueryDto {
  @IsString()
  file!: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 100;

  @IsOptional()
  @IsString()
  level?: string;

  @IsOptional()
  @IsString()
  search?: string;
}
