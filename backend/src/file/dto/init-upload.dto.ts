import { IsString, IsNumber, IsOptional, Min } from 'class-validator';

export class InitUploadDto {
  @IsString()
  filename: string;

  @IsNumber()
  @Min(1)
  size: number;

  @IsString()
  mimeType: string;

  @IsNumber()
  @Min(1)
  totalChunks: number;

  @IsString()
  @IsOptional()
  folderId?: string;
}
