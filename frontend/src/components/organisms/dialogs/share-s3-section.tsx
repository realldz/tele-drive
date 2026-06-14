'use client';

import { useState } from 'react';
import { Cloud, Copy, Check, Lock } from 'lucide-react';
import { useI18n } from '@/providers/i18n-context';
import { setS3PublicAccess } from '@/lib/api';
import { COPY_FEEDBACK_RESET_MS } from '@/lib/constants';
import toast from 'react-hot-toast';
import type { FolderRecord } from '@/lib/types';

interface ShareS3SectionProps {
  folder: FolderRecord;
  initialPublic: boolean;
  initialListObjects: boolean;
  onSuccess: () => void;
}

export default function ShareS3Section({ folder, initialPublic, initialListObjects, onSuccess }: ShareS3SectionProps) {
  const { t } = useI18n();
  const [isPublic, setIsPublic] = useState(initialPublic);
  const [isListObjects, setIsListObjects] = useState(initialListObjects);
  const [isToggling, setIsToggling] = useState(false);
  const [copied, setCopied] = useState(false);

  const publicUrl = `${window.location.origin}/public/${folder.userId}/${folder.name}`;

  const handleCopy = () => {
    navigator.clipboard.writeText(publicUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), COPY_FEEDBACK_RESET_MS);
  };

  const handleTogglePublic = async () => {
    setIsToggling(true);
    try {
      const newState = !isPublic;
      await setS3PublicAccess(folder.id, newState);
      setIsPublic(newState);
      onSuccess();
      toast.success(t(newState ? 's3.enableSuccess' : 's3.disableSuccess'));
    } catch {
      toast.error(t('s3.toggleError'));
    } finally {
      setIsToggling(false);
    }
  };

  const handleToggleListObjects = async () => {
    const newState = !isListObjects;
    try {
      await setS3PublicAccess(folder.id, true, newState);
      setIsListObjects(newState);
      onSuccess();
      toast.success(t(newState ? 's3.listObjectsEnabled' : 's3.listObjectsDisabled'));
    } catch {
      toast.error(t('s3.toggleError'));
    }
  };

  return (
    <>
      <div className="border-t border-gray-100 my-4" />
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
          <Cloud size={18} className="text-orange-500" />
          {t('s3.publicAccess')}
        </div>
        <p className="text-xs text-gray-500">{t('s3.publicAccessDesc')}</p>

        {isPublic ? (
          <div className="space-y-3">
            <div className="bg-orange-50 text-orange-700 p-3 rounded-lg border border-orange-200 text-xs">
              {t('s3.publicAccessWarning')}
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">{t('s3.publicAccessUrl')}</p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={publicUrl}
                  className="w-full border border-gray-300 rounded-lg p-2 bg-gray-50 outline-none text-gray-700 text-xs"
                />
                <button
                  onClick={handleCopy}
                  className="flex-shrink-0 bg-blue-600 hover:bg-blue-700 text-white p-2 rounded-lg transition-colors"
                  title={t('share.copy')}
                >
                  {copied ? <Check size={16} /> : <Copy size={16} />}
                </button>
              </div>
            </div>
            <label className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg cursor-pointer hover:bg-gray-100 transition-colors">
              <input
                type="checkbox"
                checked={isListObjects}
                onChange={handleToggleListObjects}
                className="w-4 h-4 text-orange-500 rounded border-gray-300 focus:ring-orange-400"
              />
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-700">{t('s3.listObjects')}</p>
                <p className="text-xs text-gray-500">{t('s3.listObjectsDesc')}</p>
              </div>
            </label>
            <button
              onClick={handleTogglePublic}
              disabled={isToggling}
              className="w-full text-red-600 hover:text-red-700 font-medium text-sm flex items-center justify-center gap-1 py-2 disabled:opacity-50"
            >
              <Lock size={16} /> {isToggling ? t('share.stopping') : t('s3.disablePublicAccess')}
            </button>
          </div>
        ) : (
          <button
            onClick={handleTogglePublic}
            disabled={isToggling}
            className="w-full bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white font-medium py-2.5 rounded-lg transition-colors text-sm flex items-center justify-center gap-2"
          >
            {isToggling ? t('share.creating') : t('s3.enablePublicAccess')}
          </button>
        )}
      </div>
    </>
  );
}
