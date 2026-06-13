'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/providers/i18n-context';
import { useRequireAuth } from '@/hooks/use-require-auth';
import Sidebar from '@/components/sidebar';
import { Key, Plus, Trash2, Terminal, Loader2, KeyRound } from 'lucide-react';
import toast from 'react-hot-toast';
import { getAbsoluteApiUrl, fetchS3Credentials, createS3Credential, deleteS3Credential, getApiErrorMessage } from '@/lib/api';
import { useAppSelector } from '@/lib/store';
import S3NewCredentialPanel from './s3-new-credential-panel';
import S3UsageGuide from './s3-usage-guide';

interface S3Credential {
  id: string;
  accessKeyId: string;
  label: string;
  isActive: boolean;
  createdAt: string;
}

interface NewCredential extends S3Credential {
  secretAccessKey: string;
  note: string;
}

export default function S3KeysPage() {
  const { isReady } = useRequireAuth();
  const { t } = useI18n();
  const uploadConfig = useAppSelector(state => state.uploadConfig);

  const [credentials, setCredentials] = useState<S3Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [labelInput, setLabelInput] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newCred, setNewCred] = useState<NewCredential | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    if (isReady) loadCredentials();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady]);

  async function loadCredentials() {
    try {
      setLoading(true);
      setCredentials(await fetchS3Credentials());
    } catch {
      toast.error(t('s3.loadError'));
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    if (creating) return;
    setCreating(true);
    try {
      const created: NewCredential = await createS3Credential(labelInput.trim() || 'Default');
      setNewCred(created);
      setLabelInput('');
      setShowCreateForm(false);
      await loadCredentials();
      toast.success(t('s3.createSuccess'));
    } catch (err: unknown) {
      toast.error(getApiErrorMessage(err, t('s3.createError')));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteS3Credential(id);
      setCredentials((prev) => prev.filter((c) => c.id !== id));
      toast.success(t('s3.revokeSuccess'));
    } catch {
      toast.error(t('s3.revokeError'));
    } finally {
      setDeletingId(null);
    }
  }

  const endpointUrl = `${getAbsoluteApiUrl()}/s3`;
  const maxConcurrent = uploadConfig.maxConcurrentChunks;
  const recommendedChunk = uploadConfig.maxChunkSize;
  const recommendedChunkMB = Math.floor(recommendedChunk / (1024 * 1024));

  if (!isReady) return null;

  return (
    <div className="h-screen bg-white flex overflow-hidden">
      <Sidebar />

      <main className="flex-1 flex flex-col min-w-0 bg-white relative">
        <header className="h-16 border-b border-gray-100 flex items-center justify-between pl-14 pr-4 md:px-4 lg:px-6 bg-white w-full flex-shrink-0 z-10">
          <div className="flex items-center gap-2">
            <KeyRound size={22} className="text-blue-600" />
            <h2 className="text-xl font-bold text-gray-800">{t('s3.title')}</h2>
          </div>
          {!showCreateForm && (
            <button
              onClick={() => setShowCreateForm(true)}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
            >
              <Plus size={16} />
              <span className="hidden sm:inline">{t('s3.createKey')}</span>
            </button>
          )}
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-4xl mx-auto px-6 py-6 space-y-6">

            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 flex gap-3">
              <Terminal size={20} className="text-blue-600 shrink-0 mt-0.5" />
              <div className="text-sm text-blue-800">
                <p className="font-medium mb-1">{t('s3.infoBanner')}</p>
                <p className="text-blue-700">
                  {t('s3.infoDesc')}{' '}
                  <code className="bg-blue-100 px-1 rounded font-mono">{endpointUrl}</code>
                </p>
              </div>
            </div>

            {newCred && (
              <S3NewCredentialPanel
                t={t}
                cred={newCred}
                endpointUrl={endpointUrl}
                maxConcurrent={maxConcurrent}
                recommendedChunkMB={recommendedChunkMB}
                onDismiss={() => setNewCred(null)}
              />
            )}

            {showCreateForm && (
              <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
                <h3 className="font-medium text-gray-900 text-sm">{t('s3.newAccessKey')}</h3>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">{t('s3.labelOptional')}</label>
                  <input
                    type="text"
                    value={labelInput}
                    onChange={(e) => setLabelInput(e.target.value)}
                    placeholder="e.g. My laptop, CI/CD pipeline"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    maxLength={64}
                    onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                    autoFocus
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleCreate}
                    disabled={creating}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors text-sm font-medium"
                  >
                    {creating ? <Loader2 size={14} className="animate-spin" /> : <Key size={14} />}
                    {creating ? t('s3.creating') : t('s3.create')}
                  </button>
                  <button
                    onClick={() => { setShowCreateForm(false); setLabelInput(''); }}
                    className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                  >
                    {t('s3.cancel')}
                  </button>
                </div>
              </div>
            )}

            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100">
                <h2 className="font-medium text-gray-900 text-sm">
                  {t('s3.activeKeys')} {!loading && `(${credentials.length})`}
                </h2>
              </div>

              {loading ? (
                <div className="flex items-center justify-center py-10 text-gray-400">
                  <Loader2 size={20} className="animate-spin mr-2" />
                  {t('s3.loading')}
                </div>
              ) : credentials.length === 0 ? (
                <div className="text-center py-10 text-gray-400 text-sm">
                  <Key size={32} className="mx-auto mb-2 opacity-30" />
                  {t('s3.noKeys')}
                </div>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {credentials.map((cred) => (
                    <li key={cred.id} className="flex items-center gap-3 px-4 py-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm text-gray-900 truncate">{cred.label}</span>
                          <span className="shrink-0 text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">
                            {t('s3.active')}
                          </span>
                        </div>
                        <div className="text-xs text-gray-500 font-mono mt-0.5">{cred.accessKeyId}</div>
                        <div className="text-xs text-gray-400 mt-0.5">
                          {t('s3.created')} {new Date(cred.createdAt).toLocaleDateString()}
                        </div>
                      </div>

                      {deletingId === cred.id ? (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-500">{t('s3.revoke')}</span>
                          <button onClick={() => handleDelete(cred.id)} className="px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 transition-colors">
                            {t('s3.revokeYes')}
                          </button>
                          <button onClick={() => setDeletingId(null)} className="px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 rounded transition-colors">
                            {t('s3.revokeNo')}
                          </button>
                        </div>
                      ) : (
                        <button onClick={() => setDeletingId(cred.id)} className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors" title={t('s3.revokeKey')}>
                          <Trash2 size={16} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <S3UsageGuide
              t={t}
              endpointUrl={endpointUrl}
              maxConcurrent={maxConcurrent}
              recommendedChunk={recommendedChunk}
              recommendedChunkMB={recommendedChunkMB}
            />

          </div>
        </div>
      </main>
    </div>
  );
}
