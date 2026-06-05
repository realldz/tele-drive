import { Module } from '@nestjs/common';
import { AdminDashboardController } from './admin-dashboard.controller';
import { AdminDashboardService } from './admin-dashboard.service';
import { AdminSystemController } from './admin-system.controller';
import { TempStorageModule } from '../common/temp-storage/temp-storage.module';

@Module({
  imports: [TempStorageModule],
  controllers: [AdminDashboardController, AdminSystemController],
  providers: [AdminDashboardService],
})
export class AdminDashboardModule {}
