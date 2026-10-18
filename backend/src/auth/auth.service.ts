import {
  Injectable,
  Logger,
  UnauthorizedException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly settingsService: SettingsService,
  ) {}

  /**
   * Đăng ký user mới — hash password bằng bcrypt, tạo User.
   * User đầu tiên trong hệ thống tự động trở thành ADMIN.
   */
  async register(username: string, password: string) {
    // Kiểm tra username đã tồn tại chưa
    const existing = await this.prisma.user.findFirst({
      where: { username: { equals: username, mode: 'insensitive' } },
    });
    if (existing) {
      this.logger.warn(
        `Registration failed: username "${username}" already exists`,
      );
      throw new ConflictException('Username already exists');
    }

    // User đầu tiên → ADMIN, còn lại → USER
    // Admin có thể bật/tắt tính năng đăng ký qua System Settings (REGISTRATION_ENABLED).
    const [registrationEnabled, userCount] = await Promise.all([
      this.settingsService.getCachedSetting(
        'REGISTRATION_ENABLED',
        true,
        (v) => v !== 'false',
      ),
      this.prisma.user.count(),
    ]);
    if (!registrationEnabled && userCount > 0) {
      // Vẫn cho phép tạo user đầu tiên (bootstrap admin) kể cả khi đăng ký đã bị tắt.
      this.logger.warn(
        `Registration rejected: registration is disabled (attempted username "${username}")`,
      );
      throw new ForbiddenException('Registration is currently disabled');
    }
    const role = userCount === 0 ? 'ADMIN' : 'USER';

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await this.prisma.user.create({
      data: {
        username,
        password: hashedPassword,
        role,
      },
    });

    if (role === 'ADMIN') {
      this.logger.log(
        `First user registered as ADMIN: "${username}" (id: ${user.id})`,
      );
    } else {
      this.logger.log(
        `User registered: "${username}" (id: ${user.id}, role: ${role})`,
      );
    }

    // Trả về JWT luôn sau khi đăng ký
    const payload = { sub: user.id, username: user.username, role: user.role };
    return {
      access_token: this.jwtService.sign(payload),
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
      },
    };
  }

  /**
   * Trạng thái cho phép đăng ký (public — dùng cho UI login/register).
   */
  async isRegistrationEnabled(): Promise<boolean> {
    return this.settingsService.getCachedSetting(
      'REGISTRATION_ENABLED',
      true,
      (v) => v !== 'false',
    );
  }

  /**
   * Đăng nhập — verify password, trả về JWT token.
   */
  async login(username: string, password: string) {
    const user = await this.prisma.user.findFirst({
      where: { username: { equals: username, mode: 'insensitive' } },
    });
    if (!user) {
      this.logger.warn(`Login failed: user "${username}" not found`);
      throw new UnauthorizedException('Invalid credentials');
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      this.logger.warn(`Login failed: invalid password for user "${username}"`);
      throw new UnauthorizedException('Invalid credentials');
    }

    this.logger.log(
      `User logged in: "${username}" (id: ${user.id}, role: ${user.role})`,
    );

    const payload = { sub: user.id, username: user.username, role: user.role };
    return {
      access_token: this.jwtService.sign(payload),
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
      },
    };
  }

  /**
   * Lấy profile user hiện tại từ JWT payload.
   */
  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        quota: true,
        usedSpace: true,
        dailyBandwidthLimit: true,
        dailyBandwidthUsed: true,
        lastBandwidthReset: true,
        createdAt: true,
      },
    });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    return user;
  }
}
