import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class UpdateFileDownloadPolicyDto {
  @IsOptional()
  @Transform(({ value }) =>
    value === null || value === '' || value === undefined
      ? null
      : Number(value),
  )
  @IsInt()
  @Min(0)
  @Max(1000000)
  downloadLimit24h?: number | null;

  @IsOptional()
  @IsString()
  bandwidthLimit24h?: string | null;
}
