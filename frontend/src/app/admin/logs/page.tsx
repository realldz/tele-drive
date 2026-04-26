'use client';

import { useI18n } from '@/components/i18n-context';
import LogViewer from '../components/log-viewer';

export default function AdminLogsPage() {
  const { t } = useI18n();
  return <LogViewer t={t} />;
}
