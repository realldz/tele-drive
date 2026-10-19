import { Module } from '@nestjs/common';
import { FolderModule } from './folder/folder.module';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { SettingsModule } from './settings/settings.module';
import { AdminLogModule } from './admin-log/admin-log.module';
import { AdminDashboardModule } from './admin-dashboard/admin-dashboard.module';
import { FileModule } from './file/file.module';
import { ClientConfigModule } from './client-config/client-config.module';

@Module({
  imports: [
    AuthModule,
    UserModule,
    SettingsModule,
    FolderModule,
    FileModule,
    AdminLogModule,
    AdminDashboardModule,
    ClientConfigModule,
  ],
  exports: [
    AuthModule,
    UserModule,
    SettingsModule,
    FolderModule,
    FileModule,
    AdminLogModule,
    AdminDashboardModule,
    ClientConfigModule,
  ],
})
export class CoreAppModule {}
