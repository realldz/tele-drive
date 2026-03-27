import { IsString } from 'class-validator';

export class UpdateQuotaDto {
  @IsString()
  quota: string;
}
