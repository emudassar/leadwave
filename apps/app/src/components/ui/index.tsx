/**
 * The primitives every screen is built from.
 *
 * One file rather than twenty: these are small, they share the same tokens, and
 * keeping them together is what stops a second, slightly-different Button from
 * appearing three screens later.
 */
import * as React from 'react';
import * as RadixSwitch from '@radix-ui/react-switch';
import * as RadixTabs from '@radix-ui/react-tabs';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import * as RadixDialog from '@radix-ui/react-dialog';
import * as RadixSelect from '@radix-ui/react-select';
import * as RadixSeparator from '@radix-ui/react-separator';
import { Slot } from '@radix-ui/react-slot';
import { Check, ChevronDown, Loader2, X } from 'lucide-react';
import { cn, initials } from '@/lib/utils';

// ─── Button ──────────────────────────────────────────────────────────────────

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent' | 'outline';
type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    'bg-brand-600 text-white hover:bg-brand-500 active:bg-brand-700 shadow-sm disabled:bg-brand-600/50',
  secondary:
    'bg-surface-raised text-text border border-line hover:border-line-strong hover:bg-surface-sunken',
  outline: 'border border-line-strong text-text hover:bg-surface-sunken',
  ghost: 'text-text-muted hover:text-text hover:bg-surface-sunken',
  danger: 'bg-red-600 text-white hover:bg-red-500 active:bg-red-700',
  accent: 'bg-amber-accent text-[#1a1205] hover:brightness-110 active:brightness-95 font-semibold',
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-md',
  md: 'h-9.5 px-4 text-sm gap-2 rounded-md',
  lg: 'h-11 px-6 text-[15px] gap-2 rounded-lg',
  icon: 'h-9 w-9 rounded-md',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'secondary', size = 'md', loading, asChild, children, disabled, ...props },
  ref,
) {
  const classes = cn(
    'inline-flex items-center justify-center font-medium whitespace-nowrap transition-colors',
    'disabled:pointer-events-none disabled:opacity-55',
    buttonVariants[variant],
    buttonSizes[size],
    className,
  );

  /**
   * `asChild` hands the styling to whatever is inside — usually a <Link>. Radix's
   * Slot accepts exactly one element child, so the spinner is not injected here;
   * a button that is really a link has nothing to be pending about anyway.
   */
  if (asChild) {
    return (
      <Slot ref={ref} className={classes} {...props}>
        {children}
      </Slot>
    );
  }

  return (
    <button ref={ref} disabled={disabled || loading} className={classes} {...props}>
      {loading ? <Loader2 className="size-4 animate-spin" /> : null}
      {children}
    </button>
  );
});

// ─── Card ────────────────────────────────────────────────────────────────────

export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return <div className={cn('card', className)} {...props} />;
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn('flex items-start justify-between gap-4 p-5 pb-3', className)}>
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold tracking-tight">{title}</h3>
        {description ? (
          <p className="mt-1 text-[13px] leading-relaxed text-text-muted">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

// ─── Badge ───────────────────────────────────────────────────────────────────

type BadgeTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'ai';

const badgeTones: Record<BadgeTone, string> = {
  neutral: 'bg-surface-sunken text-text-muted border-line',
  brand: 'bg-brand-600/12 text-brand-600 dark:text-brand-300 border-brand-600/25',
  success: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border-emerald-500/25',
  warning: 'bg-amber-500/12 text-amber-700 dark:text-amber-300 border-amber-500/25',
  danger: 'bg-red-500/12 text-red-700 dark:text-red-300 border-red-500/25',
  ai: 'bg-linear-to-r from-brand-600/15 to-cyan-500/15 text-brand-700 dark:text-brand-300 border-brand-500/25',
};

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }): React.ReactElement {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        badgeTones[tone],
        className,
      )}
      {...props}
    />
  );
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

const fieldStyles =
  'w-full rounded-md border border-line bg-surface-raised px-3 text-sm text-text placeholder:text-text-subtle ' +
  'transition-colors focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn(fieldStyles, 'h-9.5', className)} {...props} />;
  },
);

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(fieldStyles, 'min-h-20 resize-y py-2 leading-relaxed', className)}
      {...props}
    />
  );
});

export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: string | null;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn('space-y-1.5', className)}>
      {label ? (
        <label className="flex items-center gap-1 text-[13px] font-medium text-text">
          {label}
          {required ? <span className="text-red-500">*</span> : null}
        </label>
      ) : null}
      {children}
      {error ? (
        <p className="text-[12px] text-red-600 dark:text-red-400">{error}</p>
      ) : hint ? (
        <p className="text-[12px] leading-relaxed text-text-subtle">{hint}</p>
      ) : null}
    </div>
  );
}

// ─── Switch ──────────────────────────────────────────────────────────────────

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  className,
}: {
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
  disabled?: boolean;
  className?: string;
}): React.ReactElement {
  return (
    <RadixSwitch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={cn(
        'relative h-6 w-10.5 shrink-0 cursor-pointer rounded-full border border-transparent transition-colors',
        'data-[state=checked]:bg-brand-600 data-[state=unchecked]:bg-line-strong',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      <RadixSwitch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-5" />
    </RadixSwitch.Root>
  );
}

export function ToggleRow({
  title,
  description,
  checked,
  onCheckedChange,
  disabled,
  badge,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
  disabled?: boolean;
  badge?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{title}</p>
          {badge}
        </div>
        {description ? (
          <p className="mt-0.5 text-[13px] leading-relaxed text-text-muted">{description}</p>
        ) : null}
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </div>
  );
}

// ─── Select ──────────────────────────────────────────────────────────────────

export function Select<T extends string>({
  value,
  onValueChange,
  options,
  placeholder = 'Select…',
  className,
  disabled,
}: {
  value: T | undefined;
  onValueChange: (value: T) => void;
  options: Array<{ value: T; label: string; description?: string }>;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <RadixSelect.Root value={value} onValueChange={(v) => onValueChange(v as T)} disabled={disabled}>
      <RadixSelect.Trigger
        className={cn(
          fieldStyles,
          'flex h-9.5 items-center justify-between gap-2 text-left data-[placeholder]:text-text-subtle',
          className,
        )}
      >
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon>
          <ChevronDown className="size-4 text-text-subtle" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={6}
          className="z-50 max-h-72 min-w-(--radix-select-trigger-width) overflow-hidden rounded-lg border border-line bg-surface-raised shadow-[var(--shadow-lift)]"
        >
          <RadixSelect.Viewport className="p-1">
            {options.map((option) => (
              <RadixSelect.Item
                key={option.value}
                value={option.value}
                className="relative flex cursor-pointer select-none flex-col gap-0.5 rounded-md px-2.5 py-2 pr-8 text-sm outline-none data-[highlighted]:bg-surface-sunken"
              >
                <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                {option.description ? (
                  <span className="text-[12px] text-text-subtle">{option.description}</span>
                ) : null}
                <RadixSelect.ItemIndicator className="absolute right-2.5 top-2.5">
                  <Check className="size-4 text-brand-500" />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}

// ─── Tabs ────────────────────────────────────────────────────────────────────

export const Tabs = RadixTabs.Root;

export function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof RadixTabs.List>): React.ReactElement {
  return (
    <RadixTabs.List
      className={cn('flex items-center gap-1 border-b border-line', className)}
      {...props}
    />
  );
}

export function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof RadixTabs.Trigger>): React.ReactElement {
  return (
    <RadixTabs.Trigger
      className={cn(
        'relative -mb-px cursor-pointer px-3 py-2.5 text-[13.5px] font-medium text-text-muted transition-colors',
        'hover:text-text data-[state=active]:text-text',
        'after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-transparent',
        'data-[state=active]:after:bg-brand-600',
        className,
      )}
      {...props}
    />
  );
}

export const TabsContent = RadixTabs.Content;

// ─── Dialog ──────────────────────────────────────────────────────────────────

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
}): React.ReactElement {
  const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl' };
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in" />
        <RadixDialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2',
            'rounded-xl border border-line bg-surface-raised shadow-[var(--shadow-lift)]',
            'max-h-[calc(100vh-4rem)] overflow-y-auto',
            widths[size],
          )}
        >
          <div className="flex items-start justify-between gap-4 p-5 pb-3">
            <div>
              <RadixDialog.Title className="text-base font-semibold tracking-tight">
                {title}
              </RadixDialog.Title>
              {description ? (
                <RadixDialog.Description className="mt-1 text-[13px] leading-relaxed text-text-muted">
                  {description}
                </RadixDialog.Description>
              ) : null}
            </div>
            <RadixDialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close">
                <X className="size-4" />
              </Button>
            </RadixDialog.Close>
          </div>
          {children ? <div className="px-5 pb-5">{children}</div> : null}
          {footer ? (
            <div className="flex items-center justify-end gap-2 border-t border-line bg-surface-sunken/60 px-5 py-3">
              {footer}
            </div>
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

// ─── Tooltip ─────────────────────────────────────────────────────────────────

export function TooltipProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return <RadixTooltip.Provider delayDuration={220}>{children}</RadixTooltip.Provider>;
}

export function Tooltip({
  content,
  children,
  side = 'top',
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}): React.ReactElement {
  if (!content) return <>{children}</>;
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          className="z-50 max-w-64 rounded-md bg-[#16161d] px-2.5 py-1.5 text-[12px] leading-relaxed text-white shadow-lg dark:bg-[#2a2a38]"
        >
          {content}
          <RadixTooltip.Arrow className="fill-[#16161d] dark:fill-[#2a2a38]" />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}

// ─── Misc ────────────────────────────────────────────────────────────────────

export const Separator = RadixSeparator.Root;

export function Avatar({
  src,
  name,
  size = 36,
  ring,
  className,
}: {
  src?: string | null;
  name?: string | null;
  size?: number;
  ring?: string;
  className?: string;
}): React.ReactElement {
  const [failed, setFailed] = React.useState(false);
  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-sunken text-text-muted',
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, size * 0.36),
        boxShadow: ring ? `0 0 0 2px ${ring}` : undefined,
      }}
    >
      {src && !failed ? (
        <img
          src={src}
          alt=""
          className="size-full object-cover"
          onError={() => setFailed(true)}
          loading="lazy"
        />
      ) : (
        <span className="font-semibold">{initials(name)}</span>
      )}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }): React.ReactElement {
  return <div className={cn('animate-pulse rounded-md bg-surface-sunken', className)} />;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-xl border border-dashed border-line px-6 py-14 text-center',
        className,
      )}
    >
      {icon ? (
        <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-surface-sunken text-text-subtle">
          {icon}
        </div>
      ) : null}
      <p className="text-[15px] font-semibold tracking-tight">{title}</p>
      {description ? (
        <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-text-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/** A horizontal meter for "812 of 1,000 used". */
export function Meter({
  value,
  max,
  tone = 'brand',
  className,
}: {
  value: number;
  max: number | null;
  tone?: 'brand' | 'warning' | 'danger';
  className?: string;
}): React.ReactElement {
  const ratio = max === null || max === 0 ? 0 : Math.min(1, value / max);
  const tones = {
    brand: 'bg-brand-600',
    warning: 'bg-amber-accent',
    danger: 'bg-red-500',
  };
  const effective = max !== null && ratio >= 0.9 ? 'danger' : max !== null && ratio >= 0.75 ? 'warning' : tone;
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken', className)}>
      <div
        className={cn('h-full rounded-full transition-[width] duration-500', tones[effective])}
        style={{ width: `${Math.max(ratio * 100, value > 0 ? 3 : 0)}%` }}
      />
    </div>
  );
}
