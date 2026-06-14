'use client';

import { useI18n } from '@/providers/i18n-context';
import LogViewer from '@/app/admin/components/log-viewer';

export default function AdminLogsPage() {
  const { t } = useI18n();
  return <LogViewer t={t} />;
}
