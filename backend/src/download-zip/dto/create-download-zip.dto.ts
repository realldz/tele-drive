import { IsOptional, IsArray, IsString } from 'class-validator';

export class CreateDownloadZipDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  fileIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  folderIds?: string[];
}

export class CreateSharedDownloadZipDto extends CreateDownloadZipDto {
  @IsString()
  shareToken!: string;
}
