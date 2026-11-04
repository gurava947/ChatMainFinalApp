import { InLogo } from '@/components/brand';
import { isSupabaseConfigured } from '@/lib/supabase/env';

export function SupabaseNotice() {
  return (
    <p className="notice notice-error" role="alert">
      Supabase is not connected yet. Copy <code>inchat/.env.example</code> to <code>inchat/.env.local</code>, set the
      project URL and anon key, and enable <strong>Anonymous Sign-Ins</strong> in Supabase Authentication settings.
    </p>
  );
}

export function GuestShell({
  title,
  subtitle,
  children,
  footer
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const configured = isSupabaseConfigured();

  return (
    <main className="min-h-screen grid place-items-center p-5">
      <div className="w-full max-w-[420px] grid gap-4">
        <header className="flex items-center gap-3">
          <span className="tricolour-frame rounded-[16px]">
            <InLogo />
          </span>
          <div>
            <h1 className="text-lg font-semibold leading-tight">{title}</h1>
            <p className="text-sm text-[var(--text-dim)]">{subtitle}</p>
          </div>
        </header>

        {!configured ? <SupabaseNotice /> : null}

        <section className="panel p-5">
          {children}
          {footer ? <div className="mt-5 text-sm text-[var(--text-dim)]">{footer}</div> : null}
        </section>
      </div>
    </main>
  );
}
