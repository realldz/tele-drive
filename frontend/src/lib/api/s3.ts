import { api } from './client';

export async function fetchS3Credentials() {
  const res = await api.get('/s3-credentials');
  return res.data;
}

export async function createS3Credential(label: string) {
  const res = await api.post('/s3-credentials', { label });
  return res.data;
}

export async function deleteS3Credential(id: string) {
  return api.delete(`/s3-credentials/${id}`);
}
