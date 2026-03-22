'use client';

import { useEffect, useState } from 'react';
import axios from 'axios';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth-context';
import {
  Key,
  Plus,
  Trash2,
  Copy,
  Check,
  Eye,
  EyeOff,
  Terminal,
  ArrowLeft,
  Loader2,
  ShieldCheck,
  AlertTriangle,
} from 'lucide-react';
import toast from 'react-hot-toast';

const API_URL = 'http://localhost:3001';

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
  const { token, user } = useAuth();

  const [credentials, setCredentials] = useState<S3Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [labelInput, setLabelInput] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);

  // Newly created credential (shown once)
  const [newCred, setNewCred] = useState<NewCredential | null>(null);
  const [secretVisible, setSecretVisible] = useState(false);
  const [copied, setCopied] = useState<'key' | 'secret' | 'config' | null>(null);

  // Deletion confirmation
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      router.push('/login');
      return;
    }
    fetchCredentials();
  }, [token]);

  const authHeaders = () => ({ Authorization: `Bearer ${token}` });

  async function fetchCredentials() {
    try {
      setLoading(true);
      const res = await axios.get(`${API_URL}/s3-credentials`, { headers: authHeaders() });
      setCredentials(res.data);
    } catch {
      toast.error('Failed to load S3 credentials');
    } finally {
      setLoading(false);
    }
  }

  async function createCredential() {
    if (creating) return;
    setCreating(true);
    try {
      const res = await axios.post(
        `${API_URL}/s3-credentials`,
        { label: labelInput.trim() || 'Default' },
        { headers: authHeaders() },
      );
      const created: NewCredential = res.data;
      setNewCred(created);
      setSecretVisible(false);
      setLabelInput('');
      setShowCreateForm(false);
      await fetchCredentials();
      toast.success('Access key created — save the secret now!');
    } catch (err: any) {
      toast.error(err?.response?.data?.message || 'Failed to create credential');
    } finally {
      setCreating(false);
    }
  }

  async function deleteCredential(id: string) {
    try {
      await axios.delete(`${API_URL}/s3-credentials/${id}`, { headers: authHeaders() });
      setCredentials((prev) => prev.filter((c) => c.id !== id));
      toast.success('Access key revoked');
    } catch {
      toast.error('Failed to revoke key');
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
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3">
          <button
            onClick={() => router.push('/')}
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors text-gray-500"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="flex items-center gap-2">
            <ShieldCheck size={20} className="text-blue-600" />
            <h1 className="text-lg font-semibold text-gray-900">S3 Access Keys</h1>
          </div>
          <span className="ml-auto text-sm text-gray-500">{user?.username}</span>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6 space-y-6">

        {/* Info banner */}
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 flex gap-3">
          <Terminal size={20} className="text-blue-600 shrink-0 mt-0.5" />
          <div className="text-sm text-blue-800">
            <p className="font-medium mb-1">Use Tele-Drive as an S3-compatible storage backend</p>
            <p className="text-blue-700">
              Create an access key below, then configure <code className="bg-blue-100 px-1 rounded">aws-cli</code>,{' '}
              <code className="bg-blue-100 px-1 rounded">s3cmd</code>, or any AWS SDK to use{' '}
              <code className="bg-blue-100 px-1 rounded font-mono">{endpointUrl}</code> as the endpoint URL.
            </p>
          </div>
        </div>

        {/* Newly created credential — shown once */}
        {newCred && (
          <div className="bg-amber-50 border-2 border-amber-400 rounded-xl p-5 space-y-4">
            <div className="flex items-center gap-2 text-amber-800">
              <AlertTriangle size={18} className="shrink-0" />
              <p className="font-semibold text-sm">
                {newCred.note} Copy these credentials now — the secret will not be shown again.
              </p>
            </div>

            {/* Access Key ID */}
            <div>
              <label className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1 block">
                Access Key ID
              </label>
              <div className="flex items-center gap-2 bg-white border border-gray-300 rounded-lg px-3 py-2">
                <code className="flex-1 text-sm font-mono text-gray-900 break-all">
                  {newCred.accessKeyId}
                </code>
                <button
                  onClick={() => copyText(newCred.accessKeyId, 'key')}
                  className="shrink-0 text-gray-400 hover:text-gray-700 transition-colors"
                  title="Copy"
                >
                  {copied === 'key' ? <Check size={16} className="text-green-500" /> : <Copy size={16} />}
                </button>
              </div>
            </div>

            {/* Secret Access Key */}
            <div>
              <label className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1 block">
                Secret Access Key
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
                  title="Copy"
                >
                  {copied === 'secret' ? <Check size={16} className="text-green-500" /> : <Copy size={16} />}
                </button>
              </div>
            </div>

            {/* aws-cli config snippet */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  aws-cli configuration
                </label>
                <button
                  onClick={() =>
                    copyText(awsConfigSnippet(newCred.accessKeyId, newCred.secretAccessKey), 'config')
                  }
                  className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 transition-colors"
                >
                  {copied === 'config' ? <Check size={13} className="text-green-500" /> : <Copy size={13} />}
                  {copied === 'config' ? 'Copied!' : 'Copy'}
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
              I have saved these credentials — dismiss
            </button>
          </div>
        )}

        {/* Create new key button / form */}
        {!showCreateForm ? (
          <button
            onClick={() => setShowCreateForm(true)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
          >
            <Plus size={16} />
            Create Access Key
          </button>
        ) : (
          <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
            <h3 className="font-medium text-gray-900 text-sm">New Access Key</h3>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Label (optional)</label>
              <input
                type="text"
                value={labelInput}
                onChange={(e) => setLabelInput(e.target.value)}
                placeholder="e.g. My laptop, CI/CD pipeline"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                maxLength={64}
                onKeyDown={(e) => e.key === 'Enter' && createCredential()}
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={createCredential}
                disabled={creating}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors text-sm font-medium"
              >
                {creating ? <Loader2 size={14} className="animate-spin" /> : <Key size={14} />}
                {creating ? 'Creating…' : 'Create'}
              </button>
              <button
                onClick={() => { setShowCreateForm(false); setLabelInput(''); }}
                className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Credentials list */}
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100">
            <h2 className="font-medium text-gray-900 text-sm">
              Active Keys {!loading && `(${credentials.length})`}
            </h2>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-10 text-gray-400">
              <Loader2 size={20} className="animate-spin mr-2" />
              Loading…
            </div>
          ) : credentials.length === 0 ? (
            <div className="text-center py-10 text-gray-400 text-sm">
              <Key size={32} className="mx-auto mb-2 opacity-30" />
              No access keys yet. Create one to get started.
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
                        Active
                      </span>
                    </div>
                    <div className="text-xs text-gray-500 font-mono mt-0.5">
                      {cred.accessKeyId}
                    </div>
                    <div className="text-xs text-gray-400 mt-0.5">
                      Created {new Date(cred.createdAt).toLocaleDateString()}
                    </div>
                  </div>

                  {deletingId === cred.id ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500">Revoke?</span>
                      <button
                        onClick={() => deleteCredential(cred.id)}
                        className="px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 transition-colors"
                      >
                        Yes
                      </button>
                      <button
                        onClick={() => setDeletingId(null)}
                        className="px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 rounded transition-colors"
                      >
                        No
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setDeletingId(cred.id)}
                      className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                      title="Revoke key"
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
            Usage Guide
          </h2>

          <div className="space-y-3 text-sm text-gray-700">
            <div>
              <p className="font-medium text-gray-800 mb-1">1. Configure aws-cli profile</p>
              <pre className="bg-gray-900 text-green-400 rounded-lg p-3 text-xs font-mono overflow-x-auto">
{`aws configure --profile tele-drive
# Enter your Access Key ID and Secret Access Key
# Region: us-east-1 (any value works)
# Output: json`}
              </pre>
            </div>

            <div>
              <p className="font-medium text-gray-800 mb-1">2. List buckets (root folders)</p>
              <pre className="bg-gray-900 text-green-400 rounded-lg p-3 text-xs font-mono overflow-x-auto">
{`aws --profile tele-drive \\
    --endpoint-url ${endpointUrl} \\
    s3 ls`}
              </pre>
            </div>

            <div>
              <p className="font-medium text-gray-800 mb-1">3. Upload a file</p>
              <pre className="bg-gray-900 text-green-400 rounded-lg p-3 text-xs font-mono overflow-x-auto">
{`aws --profile tele-drive \\
    --endpoint-url ${endpointUrl} \\
    s3 cp ./myfile.txt s3://my-bucket/myfile.txt`}
              </pre>
            </div>

            <div>
              <p className="font-medium text-gray-800 mb-1">4. Download a file</p>
              <pre className="bg-gray-900 text-green-400 rounded-lg p-3 text-xs font-mono overflow-x-auto">
{`aws --profile tele-drive \\
    --endpoint-url ${endpointUrl} \\
    s3 cp s3://my-bucket/myfile.txt ./downloaded.txt`}
              </pre>
            </div>

            <div>
              <p className="font-medium text-gray-800 mb-1">5. Upload large file (multipart)</p>
              <pre className="bg-gray-900 text-green-400 rounded-lg p-3 text-xs font-mono overflow-x-auto">
{`# aws-cli handles multipart automatically for files > 8MB
aws --profile tele-drive \\
    --endpoint-url ${endpointUrl} \\
    s3 cp ./largefile.iso s3://my-bucket/ \\
    --expected-size 5368709120`}
              </pre>
            </div>

            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-xs text-yellow-800">
              <strong>Note:</strong> Telegram limits individual file size to 2 GB. Tele-Drive handles
              large files via automatic chunking. The S3 endpoint is at{' '}
              <code className="bg-yellow-100 px-1 rounded font-mono">{endpointUrl}</code>.
              Presigned URLs and versioning are not supported.
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
