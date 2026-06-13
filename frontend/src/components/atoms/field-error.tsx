interface FieldErrorProps {
  message?: string | null;
}

export default function FieldError({ message }: FieldErrorProps) {
  if (!message) return null;
  return <p className="text-sm text-red-600 mt-1">{message}</p>;
}
