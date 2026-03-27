import { IsString, IsOptional, MaxLength } from 'class-validator';

export class CreateFolderDto {
  @IsString()
  @MaxLength(255)
  name: string;

  @IsString()
  @IsOptional()
  parentId?: string;
}
