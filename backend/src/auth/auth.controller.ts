import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { Public } from './public.decorator';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import type { AuthenticatedRequest } from '../common/types/request';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register')
  async register(@Body() body: RegisterDto) {
    return this.authService.register(body.username, body.password);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: LoginDto) {
    return this.authService.login(body.username, body.password);
  }

  @Get('profile')
  async getProfile(@Req() req: AuthenticatedRequest) {
    return this.authService.getProfile(req.user.userId);
  }
}
