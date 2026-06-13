import { api } from './client';

export async function fetchUploadConfig() {
  const res = await api.get('/transfer/config');
  return res.data;
}
