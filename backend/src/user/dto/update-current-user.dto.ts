import { IsEmail, IsString, MaxLength, ValidateIf } from 'class-validator';

export class UpdateCurrentUserDto {
  @ValidateIf(
    (_, value: unknown) =>
      value !== undefined &&
      value !== null &&
      (typeof value !== 'string' || value.trim() !== ''),
  )
  @IsString()
  @IsEmail()
  @MaxLength(254)
  email?: string | null;
}
