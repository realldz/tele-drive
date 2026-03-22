import { Home, ChevronRight } from 'lucide-react';

interface BreadcrumbItem {
  id: string;
  name: string;
}

interface BreadcrumbsProps {
  items: BreadcrumbItem[];
  onNavigate: (folderId: string | undefined) => void;
  onDragOver?: (e: React.DragEvent, folderId: string | null) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent, folderId: string | null) => void;
  dragOverFolderId?: string | null;
}

export default function Breadcrumbs({ items, onNavigate, onDragOver, onDragLeave, onDrop, dragOverFolderId }: BreadcrumbsProps) {
  return (
    <div className="px-6 py-4 flex flex-wrap items-center gap-2 text-sm text-gray-600 font-medium border-b border-gray-50">
      <button
        onClick={() => onNavigate(undefined)}
        onDragOver={onDragOver ? (e) => onDragOver(e, null) : undefined}
        onDragLeave={onDragLeave}
        onDrop={onDrop ? (e) => onDrop(e, null) : undefined}
        className={`hover:text-blue-600 flex items-center gap-1 transition-colors px-2 py-1.5 rounded-md cursor-pointer ${
          dragOverFolderId === null ? 'bg-blue-50 text-blue-700 ring-2 ring-blue-200' : 'hover:bg-gray-50'
        }`}
      >
        <Home size={16} /> Drive Của Tôi
      </button>

      {items.map((bc) => (
        <div key={bc.id} className="flex items-center gap-2">
          <ChevronRight size={16} className="text-gray-400" />
          <button
            onClick={() => onNavigate(bc.id)}
            onDragOver={onDragOver ? (e) => onDragOver(e, bc.id) : undefined}
            onDragLeave={onDragLeave}
            onDrop={onDrop ? (e) => onDrop(e, bc.id) : undefined}
            className={`hover:text-blue-600 transition-colors px-2 py-1.5 rounded-md cursor-pointer ${
              dragOverFolderId === bc.id ? 'bg-blue-50 text-blue-700 ring-2 ring-blue-200' : 'hover:bg-gray-50'
            }`}
          >
            {bc.name}
          </button>
        </div>
      ))}
    </div>
  );
}
