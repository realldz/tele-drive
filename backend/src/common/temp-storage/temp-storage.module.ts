import { Module } from '@nestjs/common';
import { TEMP_STORAGE } from './temp-storage.interface';
import { LocalDiskTempStorage } from './local-disk-temp-storage';

@Module({
  providers: [
    {
      provide: TEMP_STORAGE,
      useClass: LocalDiskTempStorage,
    },
  ],
  exports: [TEMP_STORAGE],
})
export class TempStorageModule {}
