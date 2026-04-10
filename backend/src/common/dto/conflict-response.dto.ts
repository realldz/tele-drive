import { IsString } from 'class-validator';

export class ConflictResponseDto {
  @IsString()
  type!: 'file' | 'folder';

  @IsString()
  id!: string;

  @IsString()
  name!: string;

  @IsString()
  suggestedName!: string;

  @IsString()
  existingItemId!: string;
}
