'use client';

import { Terminal } from 'lucide-react';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

interface S3UsageGuideProps {
  t: Translate;
  endpointUrl: string;
  maxConcurrent: number;
  recommendedChunk: number;
  recommendedChunkMB: number;
}

export default function S3UsageGuide({
  t, endpointUrl, maxConcurrent, recommendedChunk, recommendedChunkMB,
}: S3UsageGuideProps) {
  return (
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
    --expected-size ${recommendedChunk}`}
          </pre>
        </div>

        <div>
          <p className="font-medium text-gray-800 mb-1">{t('s3.step6')}</p>
          <p className="text-xs text-gray-600 mb-2">{t('s3.step6Desc')}</p>
          <pre className="bg-gray-900 text-green-400 rounded-lg p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap">
            {`[profile tele-drive]
region = us-east-1
s3 =
  addressing_style = path
  max_concurrent_requests = ${maxConcurrent}
  multipart_threshold = ${recommendedChunkMB}MB
  multipart_chunksize = ${recommendedChunkMB}MB
cli_read_timeout = 300
cli_connect_timeout = 300`}
          </pre>
          <p className="text-xs text-gray-500 mt-2">{t('s3.step6Note', { maxChunkMB: recommendedChunkMB })}</p>
        </div>

        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-xs text-yellow-800">
          <strong>{t('s3.note')}</strong> {t('s3.noteContent')}{' '}
          <code className="bg-yellow-100 px-1 rounded font-mono">{endpointUrl}</code>.
          {t('s3.notePresigned')}
        </div>
      </div>
    </div>
  );
}
