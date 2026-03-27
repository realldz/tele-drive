import React, { useState, useEffect } from 'react';
import { X, Copy, Check, Globe, Lock, Share2 } from 'lucide-react';
import { shareItem, unshareItem } from '@/lib/api';
import { useI18n } from '@/components/i18n-context';
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

  // Local state đồng bộ với item prop, cập nhật khi share/unshare thành công
  const [isShared, setIsShared] = useState(false);
  const [shareToken, setShareToken] = useState<string | null>(null);

  // Sync local state khi item prop thay đổi (mở dialog mới, hoặc parent re-fetch)
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
      const updated = res.data;
      setIsShared(true);
      setShareToken(updated.shareToken);
      onSuccess();
      toast.success(t('share.createSuccess'));
    } catch (error) {
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
    } catch (error) {
      toast.error(t('share.revokeError'));
    } finally {
      setIsSharing(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden">
        <div className="flex justify-between items-center p-4 border-b border-gray-100">
          <h2 className="font-semibold text-gray-800 flex items-center gap-2">
            <Globe size={20} className="text-blue-500" />
            {t(itemType === 'folder' ? 'share.titleFolder' : 'share.titleFile')}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>

        <div className="p-6 text-sm">
          <div className="mb-6 flex gap-4">
            <div className={`p-4 rounded-xl flex items-center justify-center ${itemType === 'folder' ? 'bg-blue-50 text-blue-500' : 'bg-gray-100 text-gray-500'}`}>
              <Share2 size={24} />
            </div>
            <div>
              <h3 className="font-semibold text-gray-800 break-all line-clamp-2">
                {'filename' in item ? item.filename : item.name}
              </h3>
              <p className="text-sm text-gray-500">
                {t('share.status')}: <span className={isShared ? 'text-green-600 font-medium' : 'text-gray-500 font-medium'}>
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
                  className="text-red-600 hover:text-red-700 font-medium flex items-center gap-1"
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
        </div>
      </div>
    </div>
  );
}
