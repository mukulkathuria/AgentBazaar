import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-blue-700 text-white hover:bg-blue-800 disabled:bg-gray-500',
  secondary: 'border border-gray-500 bg-white text-gray-900 hover:bg-gray-100 disabled:text-gray-500',
  danger: 'bg-red-700 text-white hover:bg-red-800 disabled:bg-gray-500',
};

export function buttonClass(variant: Variant = 'primary', extra = ''): string {
  return `inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold no-underline disabled:cursor-not-allowed ${VARIANTS[variant]} ${extra}`;
}

export function Button({
  variant = 'primary',
  className = '',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button type={type} className={buttonClass(variant, className)} {...props} />;
}

export const inputClass =
  'block w-full rounded-md border border-gray-500 bg-white px-3 py-2 text-base text-gray-900 placeholder:text-gray-600 aria-[invalid=true]:border-red-700';

export interface FieldA11y {
  id: string;
  'aria-invalid': boolean;
  'aria-describedby': string | undefined;
}

/** Label, hint and error wired to the control through `aria-describedby` / `aria-invalid`. */
export function Field({
  id,
  label,
  hint,
  error,
  className = '',
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: string;
  error?: string;
  className?: string;
  children: (a11y: FieldA11y) => ReactNode;
}) {
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`space-y-1 ${className}`}>
      <label htmlFor={id} className="block text-sm font-medium text-gray-900">
        {label}
      </label>
      {children({ id, 'aria-invalid': Boolean(error), 'aria-describedby': describedBy })}
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-gray-700">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-sm font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

const TONES = {
  error: 'border-red-700 bg-red-50 text-red-900',
  warning: 'border-amber-600 bg-amber-50 text-amber-950',
  info: 'border-blue-700 bg-blue-50 text-blue-950',
  success: 'border-green-700 bg-green-50 text-green-900',
} as const;

export function Alert({
  tone = 'error',
  title,
  children,
}: {
  tone?: keyof typeof TONES;
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-md border-l-4 p-4 ${TONES[tone]}`}>
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className="mt-1 text-sm">{children}</div>}
    </div>
  );
}

export function ErrorState({ title, message, children }: { title: string; message: string; children?: ReactNode }) {
  return (
    <div className="my-8 space-y-4">
      <h1 className="text-2xl font-bold">{title}</h1>
      <Alert>{message}</Alert>
      {children}
    </div>
  );
}

export function Badge({ children, tone = 'info' }: { children: ReactNode; tone?: keyof typeof TONES }) {
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold ${TONES[tone]}`}>{children}</span>;
}

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-8 space-y-3">
      <h2 id={id} className="text-xl font-bold">
        {title}
      </h2>
      {children}
    </section>
  );
}
