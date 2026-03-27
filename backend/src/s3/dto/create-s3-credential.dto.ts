import { IsString, IsOptional, MaxLength } from 'class-validator';

export class CreateS3CredentialDto {
  @IsString()
  @IsOptional()
  @MaxLength(100)
  label?: string;
}
