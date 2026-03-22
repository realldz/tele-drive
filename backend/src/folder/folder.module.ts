import { Module } from '@nestjs/common';
import { FolderService } from './folder.service';
import { FolderController } from './folder.controller';
import { FileModule } from '../file/file.module';

@Module({
  imports: [FileModule],
  providers: [FolderService],
  controllers: [FolderController],
})
export class FolderModule {}
