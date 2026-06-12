import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { PrismaService } from '../prisma/prisma.service';

@Controller()
export class GrpcCoreController {
  constructor(private readonly prisma: PrismaService) {}

  @GrpcMethod('CoreService', 'Ping')
  ping() {
    return { timestamp: Date.now() };
  }

  @GrpcMethod('CoreService', 'ReportChunkResults')
  reportChunkResults() {
    return { accepted: 0 };
  }

  @GrpcMethod('CoreService', 'GetFileMetadata')
  getFileMetadata() {
    return {};
  }

  @GrpcMethod('CoreService', 'BatchCheckChunkStatus')
  batchCheckChunkStatus() {
    return { entries: [] };
  }

  @GrpcMethod('CoreService', 'ReportUploadFailed')
  reportUploadFailed() {
    return {};
  }

  @GrpcMethod('CoreService', 'ReportDeleteSuccess')
  reportDeleteSuccess() {
    return {};
  }

  @GrpcMethod('CoreService', 'ReportDeleteFailed')
  reportDeleteFailed() {
    return {};
  }

  @GrpcMethod('CoreService', 'ReportFileCorrupted')
  reportFileCorrupted() {
    return {};
  }

  @GrpcMethod('CoreService', 'ReportZipReady')
  reportZipReady() {
    return {};
  }

  @GrpcMethod('CoreService', 'ReportZipFailed')
  reportZipFailed() {
    return {};
  }

  @GrpcMethod('CoreService', 'ReportBotUnauthorized')
  reportBotUnauthorized() {
    return {};
  }

  @GrpcMethod('CoreService', 'ReportEmergencyCleanup')
  reportEmergencyCleanup() {
    return {};
  }

  @GrpcMethod('CoreService', 'CheckDiskSpace')
  checkDiskSpace() {
    return { freeBytes: 0, totalBytes: 0, usagePercent: 0 };
  }

  @GrpcMethod('CoreService', 'ReportCronStats')
  reportCronStats() {
    return {};
  }
}
