import {
  Injectable,
  Logger,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * Đăng ký user mới — hash password bằng bcrypt, tạo User.
   * User đầu tiên trong hệ thống tự động trở thành ADMIN.
   */
  async register(username: string, password: string) {
    // Kiểm tra username đã tồn tại chưa
    const existing = await this.prisma.user.findUnique({
      where: { username },
    });
    if (existing) {
      this.logger.warn(
        `Registration failed: username "${username}" already exists`,
      );
      throw new ConflictException('Username already exists');
    }

    // User đầu tiên → ADMIN, còn lại → USER
    const userCount = await this.prisma.user.count();
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
        role: user.role,
      },
    };
  }

  /**
   * Đăng nhập — verify password, trả về JWT token.
   */
  async login(username: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { username },
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
