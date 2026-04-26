import { Module } from '@nestjs/common';
import { AdminLogController } from './admin-log.controller';
import { AdminLogService } from './admin-log.service';

@Module({
  controllers: [AdminLogController],
  providers: [AdminLogService],
})
export class AdminLogModule {}
