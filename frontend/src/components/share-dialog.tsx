import React, { useState, useEffect } from 'react';
import { X, Copy, Check, Globe, Lock, Share2, Cloud } from 'lucide-react';
import { shareItem, unshareItem, setS3PublicAccess } from '@/lib/api';
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

  const [isS3Public, setIsS3Public] = useState(false);
  const [isTogglingS3, setIsTogglingS3] = useState(false);
  const [isS3ListObjects, setIsS3ListObjects] = useState(false);

  // Sync local state khi item prop thay đổi (mở dialog mới, hoặc parent re-fetch)
  useEffect(() => {
    if (isOpen && item) {
      setIsShared(item.visibility === 'PUBLIC_LINK' || !!item.shareToken);
      setShareToken(item.shareToken || null);
      setIsS3Public(!!('s3PublicAccess' in item && item.s3PublicAccess));
      setIsS3ListObjects(!!('s3PublicListObjects' in item && item.s3PublicListObjects));
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
    setTimeout(() => setCopied(false), 2000);
  };

  const handleToggleS3PublicAccess = async () => {
    if (!item) return;
    setIsTogglingS3(true);
    try {
      const newState = !isS3Public;
      await setS3PublicAccess(item.id, newState);
      setIsS3Public(newState);
      onSuccess();
      toast.success(t(newState ? 's3.enableSuccess' : 's3.disableSuccess'));
    } catch {
      toast.error(t('s3.toggleError'));
    } finally {
      setIsTogglingS3(false);
    }
  };

  const handleToggleS3ListObjects = async () => {
    if (!item) return;
    const newState = !isS3ListObjects;
    try {
      await setS3PublicAccess(item.id, true, newState);
      setIsS3ListObjects(newState);
      onSuccess();
      toast.success(t(newState ? 's3.listObjectsEnabled' : 's3.listObjectsDisabled'));
    } catch {
      toast.error(t('s3.toggleError'));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
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

          {itemType === 'folder' && 'parentId' in item && item.parentId === null && (
            <>
              <div className="border-t border-gray-100 my-4" />
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
                  <Cloud size={18} className="text-orange-500" />
                  {t('s3.publicAccess')}
                </div>
                <p className="text-xs text-gray-500">{t('s3.publicAccessDesc')}</p>

                {isS3Public ? (
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
                          value={`${window.location.origin}/public/${item.userId}/${item.name}`}
                          className="w-full border border-gray-300 rounded-lg p-2 bg-gray-50 outline-none text-gray-700 text-xs"
                        />
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(`${window.location.origin}/public/${item.userId}/${item.name}`);
                            setCopied(true);
                            setTimeout(() => setCopied(false), 2000);
                          }}
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
                        checked={isS3ListObjects}
                        onChange={handleToggleS3ListObjects}
                        className="w-4 h-4 text-orange-500 rounded border-gray-300 focus:ring-orange-400"
                      />
                      <div className="flex-1">
                        <p className="text-sm font-medium text-gray-700">{t('s3.listObjects')}</p>
                        <p className="text-xs text-gray-500">{t('s3.listObjectsDesc')}</p>
                      </div>
                    </label>
                    <button
                      onClick={handleToggleS3PublicAccess}
                      disabled={isTogglingS3}
                      className="w-full text-red-600 hover:text-red-700 font-medium text-sm flex items-center justify-center gap-1 py-2"
                    >
                      <Lock size={16} /> {isTogglingS3 ? t('share.stopping') : t('s3.disablePublicAccess')}
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={handleToggleS3PublicAccess}
                    disabled={isTogglingS3}
                    className="w-full bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white font-medium py-2.5 rounded-lg transition-colors text-sm flex items-center justify-center gap-2"
                  >
                    {isTogglingS3 ? t('share.creating') : t('s3.enablePublicAccess')}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
