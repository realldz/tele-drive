import { Edit2, Move, Share2, Trash2 } from 'lucide-react';

interface ContextMenuProps {
  x: number;
  y: number;
  itemType: 'file' | 'folder';
  onRename: () => void;
  onMove: () => void;
  onShare: () => void;
  onDelete: (e: React.MouseEvent) => void;
}

export default function ContextMenu({ x, y, itemType, onRename, onMove, onShare, onDelete }: ContextMenuProps) {
  return (
    <div
      className="fixed bg-white border border-gray-200 rounded-xl shadow-[0_10px_40px_-10px_rgba(0,0,0,0.15)] w-48 py-2 z-50 text-sm"
      style={{
        top: Math.min(y, window.innerHeight - 200),
        left: Math.min(x, window.innerWidth - 200),
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        onClick={onRename}
        className="w-full text-left px-4 py-2 hover:bg-gray-100 flex items-center gap-2 text-gray-700 cursor-pointer transition-colors"
      >
        <Edit2 size={16} /> Đổi tên
      </button>
      <button
        onClick={onMove}
        className="w-full text-left px-4 py-2 hover:bg-gray-100 flex items-center gap-2 text-gray-700 cursor-pointer transition-colors"
      >
        <Move size={16} /> Di chuyển
      </button>
      <button
        onClick={onShare}
        className="w-full text-left px-4 py-2 hover:bg-gray-100 flex items-center gap-2 text-blue-600 font-medium cursor-pointer transition-colors"
      >
        <Share2 size={16} /> Chia sẻ
      </button>
      <div className="border-t border-gray-100 my-1"></div>
      <button
        onClick={onDelete}
        className="w-full text-left px-4 py-2 hover:bg-gray-100 flex items-center gap-2 text-red-600 font-medium cursor-pointer transition-colors"
      >
        <Trash2 size={16} /> Xoá
      </button>
    </div>
  );
}
