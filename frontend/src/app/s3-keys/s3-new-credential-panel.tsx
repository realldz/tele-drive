'use client';

import { useState } from 'react';
import { Copy, Check, Eye, EyeOff, AlertTriangle } from 'lucide-react';
import { COPY_FEEDBACK_RESET_MS } from '@/lib/constants';

type Translate = (key: string, vars?: Record<string, string | number>) => string;
type CopyTarget = 'key' | 'secret' | 'config';

interface NewCredential {
  accessKeyId: string;
  secretAccessKey: string;
  note: string;
}

interface S3NewCredentialPanelProps {
  t: Translate;
  cred: NewCredential;
  endpointUrl: string;
  maxConcurrent: number;
  recommendedChunkMB: number;
  onDismiss: () => void;
}

function awsConfigSnippet(
  accessKeyId: string,
  secretKey: string,
  endpointUrl: string,
  maxConcurrent: number,
  recommendedChunkMB: number,
) {
  return `aws configure --profile tele-drive
# Access Key ID: ${accessKeyId}
# Secret Access Key: ${secretKey}
# Default region name: us-east-1
# Default output format: json

# ~/.aws/config
[profile tele-drive]
region = us-east-1
s3 =
  addressing_style = path
  max_concurrent_requests = ${maxConcurrent}
  multipart_threshold = ${recommendedChunkMB}MB
  multipart_chunksize = ${recommendedChunkMB}MB
cli_read_timeout = 300
cli_connect_timeout = 300

# Then use with:
aws --profile tele-drive --endpoint-url ${endpointUrl} s3 ls
aws --profile tele-drive --endpoint-url ${endpointUrl} s3 cp ./file.txt s3://my-bucket/
aws --profile tele-drive --endpoint-url ${endpointUrl} s3 cp s3://my-bucket/file.txt ./`;
}

export default function S3NewCredentialPanel({
  t, cred, endpointUrl, maxConcurrent, recommendedChunkMB, onDismiss,
}: S3NewCredentialPanelProps) {
  const [secretVisible, setSecretVisible] = useState(false);
  const [copied, setCopied] = useState<CopyTarget | null>(null);

  const copyText = async (text: string, target: CopyTarget) => {
    await navigator.clipboard.writeText(text);
    setCopied(target);
    setTimeout(() => setCopied(null), COPY_FEEDBACK_RESET_MS);
  };

  const config = awsConfigSnippet(cred.accessKeyId, cred.secretAccessKey, endpointUrl, maxConcurrent, recommendedChunkMB);

  return (
    <div className="bg-amber-50 border-2 border-amber-400 rounded-xl p-5 space-y-4">
      <div className="flex items-center gap-2 text-amber-800">
        <AlertTriangle size={18} className="shrink-0" />
        <p className="font-semibold text-sm">{cred.note} {t('s3.newCredWarning')}</p>
      </div>

      <div>
        <label className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1 block">{t('s3.accessKeyId')}</label>
        <div className="flex items-center gap-2 bg-white border border-gray-300 rounded-lg px-3 py-2">
          <code className="flex-1 text-sm font-mono text-gray-900 break-all">{cred.accessKeyId}</code>
          <button onClick={() => copyText(cred.accessKeyId, 'key')} className="shrink-0 text-gray-400 hover:text-gray-700 transition-colors" title={t('s3.copy')}>
            {copied === 'key' ? <Check size={16} className="text-green-500" /> : <Copy size={16} />}
          </button>
        </div>
      </div>

      <div>
        <label className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1 block">{t('s3.secretAccessKey')}</label>
        <div className="flex items-center gap-2 bg-white border border-gray-300 rounded-lg px-3 py-2">
          <code className="flex-1 text-sm font-mono text-gray-900 break-all">
            {secretVisible ? cred.secretAccessKey : '•'.repeat(40)}
          </code>
          <button onClick={() => setSecretVisible((v) => !v)} className="shrink-0 text-gray-400 hover:text-gray-700 transition-colors" title={secretVisible ? 'Hide' : 'Show'}>
            {secretVisible ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
          <button onClick={() => copyText(cred.secretAccessKey, 'secret')} className="shrink-0 text-gray-400 hover:text-gray-700 transition-colors" title={t('s3.copy')}>
            {copied === 'secret' ? <Check size={16} className="text-green-500" /> : <Copy size={16} />}
          </button>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">{t('s3.awsConfig')}</label>
          <button onClick={() => copyText(config, 'config')} className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 transition-colors">
            {copied === 'config' ? <Check size={13} className="text-green-500" /> : <Copy size={13} />}
            {copied === 'config' ? t('s3.copied') : t('s3.copy')}
          </button>
        </div>
        <pre className="bg-gray-900 text-green-400 rounded-lg p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap">{config}</pre>
      </div>

      <button onClick={onDismiss} className="w-full text-sm text-amber-700 hover:text-amber-900 font-medium py-1 transition-colors">
        {t('s3.dismissCred')}
      </button>
    </div>
  );
}
