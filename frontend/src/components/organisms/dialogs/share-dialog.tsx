'use client';

import { useState, useEffect } from 'react';
import { Copy, Check, Globe, Lock, Share2 } from 'lucide-react';
import { shareItem, unshareItem } from '@/lib/api';
import { useI18n } from '@/providers/i18n-context';
import { COPY_FEEDBACK_RESET_MS } from '@/lib/constants';
import Modal from '@/components/molecules/modal';
import ShareS3Section from '@/components/organisms/dialogs/share-s3-section';
import toast from 'react-hot-toast';
import type { FileRecord, FolderRecord } from '@/lib/types';

interface ShareDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  item: FileRecord | FolderRecord | null;
  itemType: 'file' | 'folder';
}

export default function ShareDialog({ isOpen, onClose, onSuccess, item, itemType }: ShareDialogProps) {
  const { t } = useI18n();
  const [isSharing, setIsSharing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isShared, setIsShared] = useState(false);
  const [shareToken, setShareToken] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && item) {
      setIsShared(item.visibility === 'PUBLIC_LINK' || !!item.shareToken);
      setShareToken(item.shareToken || null);
      setCopied(false);
    }
  }, [isOpen, item]);

  if (!isOpen || !item) return null;

  const typeSegment = itemType === 'folder' ? 'share/folder' : 'share';
  const shareUrl = shareToken ? `${window.location.origin}/${typeSegment}/${shareToken}` : '';

  const handleShare = async () => {
    setIsSharing(true);
    try {
      const res = await shareItem(itemType, item.id);
      setIsShared(true);
      setShareToken(res.data.shareToken);
      onSuccess();
      toast.success(t('share.createSuccess'));
    } catch {
      toast.error(t('share.createError'));
    } finally {
      setIsSharing(false);
    }
  };

  const handleUnshare = async () => {
    setIsSharing(true);
    try {
      await unshareItem(itemType, item.id);
      setIsShared(false);
      setShareToken(null);
      onSuccess();
      toast.success(t('share.revokeSuccess'));
    } catch {
      toast.error(t('share.revokeError'));
    } finally {
      setIsSharing(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), COPY_FEEDBACK_RESET_MS);
  };

  const isRootFolder = itemType === 'folder' && 'parentId' in item && item.parentId === null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      titleNode={
        <span className="font-semibold text-gray-800 flex items-center gap-2">
          <Globe size={20} className="text-blue-500" />
          {t(itemType === 'folder' ? 'share.titleFolder' : 'share.titleFile')}
        </span>
      }
      size="md"
    >
      <div className="text-sm">
        <div className="mb-6 flex gap-4">
          <div className={`p-4 rounded-xl flex items-center justify-center ${itemType === 'folder' ? 'bg-blue-50 text-blue-500' : 'bg-gray-100 text-gray-500'}`}>
            <Share2 size={24} />
          </div>
          <div>
            <h3 className="font-semibold text-gray-800 break-all line-clamp-2">
              {'filename' in item ? item.filename : item.name}
            </h3>
            <p className="text-sm text-gray-500">
              {t('share.status')}:{' '}
              <span className={isShared ? 'text-green-600 font-medium' : 'text-gray-500 font-medium'}>
                {isShared ? t('share.public') : t('share.private')}
              </span>
            </p>
          </div>
        </div>

        {isShared ? (
          <div className="space-y-4">
            <div className="bg-green-50 text-green-700 p-3 rounded-lg border border-green-200">
              {t(itemType === 'folder' ? 'share.publicInfoFolder' : 'share.publicInfoFile')}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={shareUrl}
                className="w-full border border-gray-300 rounded-lg p-2.5 bg-gray-50 outline-none text-gray-700"
              />
              <button
                onClick={handleCopy}
                className="flex items-center justify-center gap-1 bg-blue-600 hover:bg-blue-700 text-white p-2.5 rounded-lg transition-colors"
                title={t('share.copy')}
              >
                {copied ? <Check size={20} /> : <Copy size={20} />}
              </button>
            </div>
            <div className="flex justify-between items-center pt-2">
              <button
                onClick={handleUnshare}
                disabled={isSharing}
                className="text-red-600 hover:text-red-700 font-medium flex items-center gap-1 disabled:opacity-50"
              >
                <Lock size={16} /> {isSharing ? t('share.stopping') : t('share.stopSharing')}
              </button>
            </div>
          </div>
        ) : (
          <div className="text-center py-6">
            <div className="bg-gray-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
              <Lock size={32} className="text-gray-400" />
            </div>
            <h3 className="font-semibold text-gray-800 mb-2">{t(itemType === 'folder' ? 'share.privateFolder' : 'share.privateFile')}</h3>
            <p className="text-gray-500 mb-6 px-4">
              {t(itemType === 'folder' ? 'share.privateDescFolder' : 'share.privateDescFile')}
            </p>
            <button
              onClick={handleShare}
              disabled={isSharing}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              {isSharing ? t('share.creating') : t('share.createLink')}
            </button>
          </div>
        )}

        {isRootFolder && (
          <ShareS3Section
            folder={item as FolderRecord}
            initialPublic={!!('s3PublicAccess' in item && item.s3PublicAccess)}
            initialListObjects={!!('s3PublicListObjects' in item && item.s3PublicListObjects)}
            onSuccess={onSuccess}
          />
        )}
      </div>
    </Modal>
  );
}
