import { transferApi } from './client';

// /transfer/config phục vụ bởi data plane (Go) → transferApi.
export async function fetchUploadConfig() {
  const res = await transferApi.get('/transfer/config');
  return res.data;
}
