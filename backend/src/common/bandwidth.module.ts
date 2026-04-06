import { Global, Module } from '@nestjs/common';
import { BandwidthLockService } from './bandwidth-lock.service';

@Global()
@Module({
  providers: [BandwidthLockService],
  exports: [BandwidthLockService],
})
export class BandwidthModule {}
