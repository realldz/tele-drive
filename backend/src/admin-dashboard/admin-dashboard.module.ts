import { Module } from '@nestjs/common';
import { AdminDashboardController } from './admin-dashboard.controller';
import { AdminDashboardService } from './admin-dashboard.service';
import { AdminBufferController } from './admin-buffer.controller';
import { TempStorageModule } from '../common/temp-storage/temp-storage.module';

@Module({
  imports: [TempStorageModule],
  controllers: [AdminDashboardController, AdminBufferController],
  providers: [AdminDashboardService],
})
export class AdminDashboardModule {}
