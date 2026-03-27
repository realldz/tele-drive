import { IsString, IsOptional } from 'class-validator';

export class UpdateBandwidthDto {
  @IsString()
  @IsOptional()
  dailyBandwidthLimit!: string | null;
}
