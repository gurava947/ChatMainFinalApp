'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/app/chat', label: 'Chats', icon: 'chat_bubble' },
  { href: '/app/updates', label: 'Updates', icon: 'add_circle' },
  { href: '/app/communities', label: 'Communities', icon: 'groups' },
  { href: '/app/calls', label: 'Calls', icon: 'call' }
];

export function TabBar({ unread }: { unread: number }) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className="sticky bottom-0 z-20 border-t border-[var(--line)] bg-[var(--surface)] px-2 pb-[max(8px,env(safe-area-inset-bottom))] md:pb-2"
    >
      <ul className="mx-auto flex max-w-[820px] items-stretch justify-around">
        {TABS.map((tab) => {
          const active = pathname.startsWith(tab.href);
          return (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className="relative flex flex-col items-center gap-1 rounded-[10px] px-1 py-2 text-[11px] transition-colors"
                style={{ color: active ? 'var(--accent)' : 'var(--text-dim)' }}
              >
                <i className={`material-symbols-outlined ${active ? 'filled' : ''}`} aria-hidden="true">
                  {tab.icon}
                </i>
                <span>{tab.label}</span>
                {tab.href === '/app/chat' && unread > 0 ? (
                  <span
                    className="absolute right-[18%] top-1 min-w-[18px] rounded-full px-[5px] text-center text-[10px] font-bold"
                    style={{ background: 'var(--accent)', color: '#04160b' }}
                  >
                    {unread > 99 ? '99+' : unread}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
