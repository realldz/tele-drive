import { Module } from '@nestjs/common';
import { FolderService } from './folder.service';
import { FolderController } from './folder.controller';
import { FileModule } from '../file/file.module';
import { CryptoModule } from '../crypto/crypto.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [FileModule, CryptoModule, AuthModule],
  providers: [FolderService],
  controllers: [FolderController],
})
export class FolderModule {}
