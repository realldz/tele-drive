import { type SelectHTMLAttributes, forwardRef } from 'react';

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  className?: string;
}

const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className = '', ...props }, ref) => {
    return (
      <select
        ref={ref}
        className={[
          'w-full rounded-lg border border-gray-300 px-3 py-2 bg-white outline-none text-sm',
          'focus:ring-2 focus:ring-blue-100 focus:border-blue-500',
          'disabled:bg-gray-100',
          className,
        ].filter(Boolean).join(' ')}
        {...props}
      />
    );
  },
);

Select.displayName = 'Select';
export default Select;
