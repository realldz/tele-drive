import { Module } from '@nestjs/common';
import { NameConflictService } from './name-conflict.service';

@Module({
  providers: [NameConflictService],
  exports: [NameConflictService],
})
export class NameConflictModule {}
