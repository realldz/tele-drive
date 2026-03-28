import { Module } from '@nestjs/common';
import { FolderService } from './folder.service';
import { FolderController } from './folder.controller';
import { FileModule } from '../file/file.module';
import { CryptoModule } from '../crypto/crypto.module';

@Module({
  imports: [FileModule, CryptoModule],
  providers: [FolderService],
  controllers: [FolderController],
})
export class FolderModule {}
