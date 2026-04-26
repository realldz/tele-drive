import { Global, Module } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BandwidthLockService } from './bandwidth-lock.service';
import { BandwidthInterceptor } from './bandwidth.interceptor';
import { PrismaModule } from '../prisma/prisma.module';
import { CryptoModule } from '../crypto/crypto.module';

@Global()
@Module({
  imports: [PrismaModule, CryptoModule],
  providers: [BandwidthLockService, BandwidthInterceptor, Reflector],
  exports: [BandwidthLockService, BandwidthInterceptor],
})
export class BandwidthModule {}
