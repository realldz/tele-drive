import { IsString, IsIn } from 'class-validator';

export class UpdateRoleDto {
  @IsString()
  @IsIn(['USER', 'ADMIN'])
  role: string;
}
