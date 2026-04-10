import { Module } from '@nestjs/common';
import { FolderService } from './folder.service';
import { FolderController } from './folder.controller';
import { FileModule } from '../file/file.module';
import { CryptoModule } from '../crypto/crypto.module';
import { AuthModule } from '../auth/auth.module';
import { NameConflictModule } from '../common/name-conflict.module';

@Module({
  imports: [FileModule, CryptoModule, AuthModule, NameConflictModule],
  providers: [FolderService],
  controllers: [FolderController],
})
export class FolderModule {}
