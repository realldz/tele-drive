'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth-context';
import { useI18n } from '@/components/i18n-context';
import Sidebar from '@/components/sidebar';
import {
  Key,
  Plus,
  Trash2,
  Copy,
  Check,
  Eye,
  EyeOff,
  Terminal,
  Loader2,
  KeyRound,
  AlertTriangle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { API_URL, fetchS3Credentials, createS3Credential, deleteS3Credential } from '@/lib/api';

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
  const router = useRouter();
  const { token } = useAuth();
  const { t } = useI18n();

  const [credentials, setCredentials] = useState<S3Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [labelInput, setLabelInput] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);

  // Newly created credential (shown once)
  const [newCred, setNewCred] = useState<NewCredential | null>(null);
  const [secretVisible, setSecretVisible] = useState(false);
  const [copied, setCopied] = useState<'key' | 'secret' | 'config' | null>(null);

  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      router.push('/login');
      return;
    }
    loadCredentials();
  }, [token]);

  async function loadCredentials() {
    try {
      setLoading(true);
      const data = await fetchS3Credentials();
      setCredentials(data);
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
      setSecretVisible(false);
      setLabelInput('');
      setShowCreateForm(false);
      await loadCredentials();
      toast.success(t('s3.createSuccess'));
    } catch (err: any) {
      toast.error(err?.response?.data?.message || t('s3.createError'));
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

  async function copyText(text: string, type: 'key' | 'secret' | 'config') {
    await navigator.clipboard.writeText(text);
    setCopied(type);
    setTimeout(() => setCopied(null), 2000);
  }

  const endpointUrl = 'http://localhost:3001/s3';

  function awsConfigSnippet(accessKeyId: string, secretKey: string) {
    return `aws configure --profile tele-drive
# Access Key ID: ${accessKeyId}
# Secret Access Key: ${secretKey}
# Default region name: us-east-1
# Default output format: json

# Then use with:
aws --profile tele-drive --endpoint-url ${endpointUrl} s3 ls
aws --profile tele-drive --endpoint-url ${endpointUrl} s3 cp ./file.txt s3://my-bucket/
aws --profile tele-drive --endpoint-url ${endpointUrl} s3 cp s3://my-bucket/file.txt ./`;
  }

  if (!token) return null;

  return (
    <div className="h-screen bg-white flex overflow-hidden">

      <Sidebar />

      {/* Main Area */}
      <main className="flex-1 flex flex-col min-w-0 bg-white relative">

        {/* Topbar */}
        <header className="h-16 border-b border-gray-100 flex items-center justify-between px-4 lg:px-6 bg-white w-full flex-shrink-0 z-10">
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

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-4xl mx-auto px-6 py-6 space-y-6">

            {/* Info banner */}
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

            {/* Newly created credential — shown once */}
            {newCred && (
              <div className="bg-amber-50 border-2 border-amber-400 rounded-xl p-5 space-y-4">
                <div className="flex items-center gap-2 text-amber-800">
                  <AlertTriangle size={18} className="shrink-0" />
                  <p className="font-semibold text-sm">
                    {newCred.note} {t('s3.newCredWarning')}
                  </p>
                </div>

                {/* Access Key ID */}
                <div>
                  <label className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1 block">
                    {t('s3.accessKeyId')}
                  </label>
                  <div className="flex items-center gap-2 bg-white border border-gray-300 rounded-lg px-3 py-2">
                    <code className="flex-1 text-sm font-mono text-gray-900 break-all">
                      {newCred.accessKeyId}
                    </code>
                    <button
                      onClick={() => copyText(newCred.accessKeyId, 'key')}
                      className="shrink-0 text-gray-400 hover:text-gray-700 transition-colors"
                      title={t('s3.copy')}
                    >
                      {copied === 'key' ? <Check size={16} className="text-green-500" /> : <Copy size={16} />}
                    </button>
                  </div>
                </div>

                {/* Secret Access Key */}
                <div>
                  <label className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1 block">
                    {t('s3.secretAccessKey')}
                  </label>
                  <div className="flex items-center gap-2 bg-white border border-gray-300 rounded-lg px-3 py-2">
                    <code className="flex-1 text-sm font-mono text-gray-900 break-all">
                      {secretVisible ? newCred.secretAccessKey : '•'.repeat(40)}
                    </code>
                    <button
                      onClick={() => setSecretVisible((v) => !v)}
                      className="shrink-0 text-gray-400 hover:text-gray-700 transition-colors"
                      title={secretVisible ? 'Hide' : 'Show'}
                    >
                      {secretVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                    <button
                      onClick={() => copyText(newCred.secretAccessKey, 'secret')}
                      className="shrink-0 text-gray-400 hover:text-gray-700 transition-colors"
                      title={t('s3.copy')}
                    >
                      {copied === 'secret' ? <Check size={16} className="text-green-500" /> : <Copy size={16} />}
                    </button>
                  </div>
                </div>

                {/* aws-cli config snippet */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                      {t('s3.awsConfig')}
                    </label>
                    <button
                      onClick={() =>
                        copyText(awsConfigSnippet(newCred.accessKeyId, newCred.secretAccessKey), 'config')
                      }
                      className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 transition-colors"
                    >
                      {copied === 'config' ? <Check size={13} className="text-green-500" /> : <Copy size={13} />}
                      {copied === 'config' ? t('s3.copied') : t('s3.copy')}
                    </button>
                  </div>
                  <pre className="bg-gray-900 text-green-400 rounded-lg p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap">
                    {awsConfigSnippet(newCred.accessKeyId, newCred.secretAccessKey)}
                  </pre>
                </div>

                <button
                  onClick={() => setNewCred(null)}
                  className="w-full text-sm text-amber-700 hover:text-amber-900 font-medium py-1 transition-colors"
                >
                  {t('s3.dismissCred')}
                </button>
              </div>
            )}

            {/* Create new key form (inline) */}
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

            {/* Credentials list */}
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
                          <span className="font-medium text-sm text-gray-900 truncate">
                            {cred.label}
                          </span>
                          <span className="shrink-0 text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">
                            {t('s3.active')}
                          </span>
                        </div>
                        <div className="text-xs text-gray-500 font-mono mt-0.5">
                          {cred.accessKeyId}
                        </div>
                        <div className="text-xs text-gray-400 mt-0.5">
                          {t('s3.created')} {new Date(cred.createdAt).toLocaleDateString()}
                        </div>
                      </div>

                      {deletingId === cred.id ? (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-500">{t('s3.revoke')}</span>
                          <button
                            onClick={() => handleDelete(cred.id)}
                            className="px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 transition-colors"
                          >
                            {t('s3.revokeYes')}
                          </button>
                          <button
                            onClick={() => setDeletingId(null)}
                            className="px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 rounded transition-colors"
                          >
                            {t('s3.revokeNo')}
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setDeletingId(cred.id)}
                          className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                          title={t('s3.revokeKey')}
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Usage guide */}
            <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
              <h2 className="font-medium text-gray-900 flex items-center gap-2">
                <Terminal size={16} className="text-gray-500" />
                {t('s3.usageGuide')}
              </h2>

              <div className="space-y-3 text-sm text-gray-700">
                <div>
                  <p className="font-medium text-gray-800 mb-1">{t('s3.step1')}</p>
                  <pre className="bg-gray-900 text-green-400 rounded-lg p-3 text-xs font-mono overflow-x-auto">
{`aws configure --profile tele-drive
# Enter your Access Key ID and Secret Access Key
# Region: us-east-1 (any value works)
# Output: json`}
                  </pre>
                </div>

                <div>
                  <p className="font-medium text-gray-800 mb-1">{t('s3.step2')}</p>
                  <pre className="bg-gray-900 text-green-400 rounded-lg p-3 text-xs font-mono overflow-x-auto">
{`aws --profile tele-drive \\
    --endpoint-url ${endpointUrl} \\
    s3 ls`}
                  </pre>
                </div>

                <div>
                  <p className="font-medium text-gray-800 mb-1">{t('s3.step3')}</p>
                  <pre className="bg-gray-900 text-green-400 rounded-lg p-3 text-xs font-mono overflow-x-auto">
{`aws --profile tele-drive \\
    --endpoint-url ${endpointUrl} \\
    s3 cp ./myfile.txt s3://my-bucket/myfile.txt`}
                  </pre>
                </div>

                <div>
                  <p className="font-medium text-gray-800 mb-1">{t('s3.step4')}</p>
                  <pre className="bg-gray-900 text-green-400 rounded-lg p-3 text-xs font-mono overflow-x-auto">
{`aws --profile tele-drive \\
    --endpoint-url ${endpointUrl} \\
    s3 cp s3://my-bucket/myfile.txt ./downloaded.txt`}
                  </pre>
                </div>

                <div>
                  <p className="font-medium text-gray-800 mb-1">{t('s3.step5')}</p>
                  <pre className="bg-gray-900 text-green-400 rounded-lg p-3 text-xs font-mono overflow-x-auto">
{`# aws-cli handles multipart automatically for files > 8MB
aws --profile tele-drive \\
    --endpoint-url ${endpointUrl} \\
    s3 cp ./largefile.iso s3://my-bucket/ \\
    --expected-size 5368709120`}
                  </pre>
                </div>

                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-xs text-yellow-800">
                  <strong>{t('s3.note')}</strong> Telegram limits individual file size to 2 GB. Tele-Drive handles
                  large files via automatic chunking. The S3 endpoint is at{' '}
                  <code className="bg-yellow-100 px-1 rounded font-mono">{endpointUrl}</code>.
                  Presigned URLs are supported (max 7 days expiry). Versioning is not supported.
                </div>
              </div>
            </div>

          </div>
        </div>
      </main>
    </div>
  );
}
