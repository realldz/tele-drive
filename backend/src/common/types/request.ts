import { Request } from 'express';

export interface AuthenticatedRequest extends Request {
  user: { userId: string; role: string };
}

export interface S3AuthenticatedRequest extends Request {
  s3UserId?: string | null;
}
