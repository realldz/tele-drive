import { Search } from 'lucide-react';
import { type InputHTMLAttributes } from 'react';

interface SearchInputProps extends InputHTMLAttributes<HTMLInputElement> {
  wrapperClassName?: string;
}

export default function SearchInput({ wrapperClassName = '', className = '', ...props }: SearchInputProps) {
  return (
    <div className={`relative ${wrapperClassName}`.trim()}>
      <Search
        className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
        size={16}
      />
      <input
        type="text"
        className={[
          'w-full pl-9 pr-4 py-2 bg-white border border-gray-200 rounded-lg outline-none',
          'focus:ring-2 focus:ring-blue-100 focus:border-blue-500 text-sm transition-all',
          className,
        ].filter(Boolean).join(' ')}
        {...props}
      />
    </div>
  );
}
