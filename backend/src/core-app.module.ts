import { Module } from '@nestjs/common';
import { FolderModule } from './folder/folder.module';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { SettingsModule } from './settings/settings.module';
import { AdminLogModule } from './admin-log/admin-log.module';
import { AdminDashboardModule } from './admin-dashboard/admin-dashboard.module';

@Module({
  imports: [
    AuthModule,
    UserModule,
    SettingsModule,
    FolderModule,
    AdminLogModule,
    AdminDashboardModule,
  ],
  exports: [
    AuthModule,
    UserModule,
    SettingsModule,
    FolderModule,
    AdminLogModule,
    AdminDashboardModule,
  ],
})
export class CoreAppModule {}
