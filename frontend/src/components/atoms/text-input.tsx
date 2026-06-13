import { type InputHTMLAttributes, forwardRef } from 'react';

interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
}

const TextInput = forwardRef<HTMLInputElement, TextInputProps>(
  ({ error = false, className = '', ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={[
          'w-full rounded-lg px-3 py-2 outline-none transition-colors border',
          'focus:ring-2',
          error
            ? 'border-red-500 focus:ring-red-500 focus:border-red-500'
            : 'border-gray-300 focus:ring-blue-500 focus:border-blue-500',
          className,
        ].filter(Boolean).join(' ')}
        {...props}
      />
    );
  },
);

TextInput.displayName = 'TextInput';
export default TextInput;
