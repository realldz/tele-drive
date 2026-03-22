import React, { useState, useEffect } from 'react';
import { X, Copy, Check, Globe, Lock, Share2 } from 'lucide-react'; // Added Share2
import axios from 'axios';

// Define API_URL constant
const API_URL = 'http://localhost:3001';

interface ShareDialogProps {
  isOpen: boolean;
  onClose: () => void;
  item: any;
  itemType: 'file' | 'folder';
  token: string | null;
}

export default function ShareDialog({ isOpen, onClose, item, itemType, token }: ShareDialogProps) {
  const [isSharing, setIsSharing] = useState(false); // Replaced isGenerating
  const [copied, setCopied] = useState(false);

  // Derived state from item prop
  const isShared = item?.visibility === 'PUBLIC_LINK' || item?.shareToken;
  const shareToken = item?.shareToken;

  // Public URL logic
  const typeSegment = itemType === 'folder' ? 'share/folder' : 'share';
  const shareUrl = shareToken ? `${window.location.origin}/${typeSegment}/${shareToken}` : ''; // Updated base URL

  useEffect(() => {
    // Reset copied state when dialog opens or item changes
    if (isOpen && item) {
      setCopied(false);
    }
  }, [isOpen, item]);

  if (!isOpen || !item) return null;

  const handleShare = async () => {
    setIsSharing(true);
    try {
      const endpoint = itemType === 'folder' ? 'folders' : 'files';
      await axios.post(`${API_URL}/${endpoint}/${item.id}/share`, {}, {
        headers: { Authorization: `Bearer ${token}` }
      });
      // Reload page to reflect new share status and token
      window.location.reload();
    } catch (error) {
      alert('Lỗi tạo liên kết chia sẻ');
    } finally {
      setIsSharing(false);
    }
  };

  const handleUnshare = async () => {
    setIsSharing(true);
    try {
      const endpoint = itemType === 'folder' ? 'folders' : 'files';
      await axios.post(`${API_URL}/${endpoint}/${item.id}/unshare`, {}, {
        headers: { Authorization: `Bearer ${token}` }
      });
      // Reload page to reflect new share status
      window.location.reload();
    } catch (error) {
      alert('Lỗi thu hồi liên kết chia sẻ');
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
            Chia sẻ {itemType === 'folder' ? 'thư mục' : 'tập tin'}
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
                {item.filename || item.name}
              </h3>
              <p className="text-sm text-gray-500">
                Trạng thái: <span className={isShared ? 'text-green-600 font-medium' : 'text-gray-500 font-medium'}>
                  {isShared ? 'Đang chia sẻ công khai' : 'Riêng tư'}
                </span>
              </p>
            </div>
          </div>
          
          {isShared ? (
            <div className="space-y-4">
              <div className="bg-green-50 text-green-700 p-3 rounded-lg border border-green-200">
                {itemType === 'folder' ? 'Thư mục' : 'Tập tin'} đang được chia sẻ công khai. Bất kì ai có liên kết này đều có thể xem và tải xuống.
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
                  title="Sao chép"
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
                  <Lock size={16} /> {isSharing ? 'Đang hủy...' : 'Ngừng chia sẻ'}
                </button>
              </div>
            </div>
          ) : (
            <div className="text-center py-6">
              <div className="bg-gray-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
                <Lock size={32} className="text-gray-400" />
              </div>
              <h3 className="font-semibold text-gray-800 mb-2">{itemType === 'folder' ? 'Thư mục' : 'Tập tin'} đang riêng tư</h3>
              <p className="text-gray-500 mb-6 px-4">
                Tạo một liên kết công khai để chia sẻ {itemType === 'folder' ? 'thư mục' : 'tập tin'} này với người khác một cách an toàn.
              </p>
              <button
                onClick={handleShare}
                disabled={isSharing}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                {isSharing ? 'Đang tạo...' : 'Tạo liên kết chia sẻ'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
