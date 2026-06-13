import { api } from './client';
import type { AdminSetting } from '@/lib/types';

export async function fetchSettings(): Promise<AdminSetting[]> {
  const res = await api.get('/settings');
  return res.data;
}

export async function updateSetting(key: string, value: string) {
  return api.put(`/settings/${key}`, { value });
}
