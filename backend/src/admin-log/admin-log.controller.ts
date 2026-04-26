import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { AdminLogService } from './admin-log.service';
import { ReadLogQueryDto } from './dto/read-log-query.dto';

@UseGuards(AdminGuard)
@Controller('admin/logs')
export class AdminLogController {
  constructor(private readonly adminLogService: AdminLogService) {}

  @Get('files')
  listFiles() {
    return this.adminLogService.listLogFiles();
  }

  @Get('read')
  readLogs(@Query() query: ReadLogQueryDto) {
    return this.adminLogService.readLogFile(query);
  }
}
