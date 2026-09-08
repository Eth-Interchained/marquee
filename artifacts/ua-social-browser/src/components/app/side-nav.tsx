import {
  CalendarDays,
  FileText,
  Gauge,
  LayoutDashboard,
  Globe,
  Settings as SettingsIcon,
  Sparkles,
  Users,
  Fingerprint,
  SquareTerminal,
  Clapperboard,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { Section } from '@/types';

type NavItem = {
  id: Section;
  label: string;
  icon: LucideIcon;
  hint?: string;
};

const ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Overview', icon: LayoutDashboard },
  { id: 'network', label: 'Network', icon: Globe },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
  { id: 'studio', label: 'Studio', icon: Clapperboard },
  { id: 'composer', label: 'AI Composer', icon: Sparkles },
  { id: 'drafts', label: 'Review queue', icon: FileText },
  { id: 'calendar', label: 'Plan', icon: CalendarDays },
  { id: 'accounts', label: 'Accounts', icon: Users },
  { id: 'profiles', label: 'UA Profiles', icon: Fingerprint },
  { id: 'usage', label: 'Usage', icon: Gauge },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
];

export function SideNav({
  section,
  onSelect,
  draftCount,
  scheduledCount,
  accent,
}: {
  section: Section;
  onSelect: (section: Section) => void;
  draftCount: number;
  scheduledCount: number;
  accent: string;
}) {
  const badgeFor = (id: Section) => {
    if (id === 'drafts' && draftCount > 0) return String(draftCount);
    if (id === 'calendar' && scheduledCount > 0) return String(scheduledCount);
    return null;
  };

  return (
    <nav
      className="flex w-[212px] shrink-0 flex-col gap-1 border-r border-sidebar-border bg-sidebar p-3"
      aria-label="Workspace sections"
    >
      <p className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Social workspace
      </p>

      {ITEMS.map((item) => {
        const isActive = item.id === section;
        const badge = badgeFor(item.id);
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item.id)}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover-elevate',
              isActive
                ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                : 'text-muted-foreground',
            )}
            data-testid={`nav-${item.id}`}
          >
            {isActive ? (
              <span
                className="absolute inset-y-1.5 left-0 w-0.5 rounded-full"
                style={{ backgroundColor: accent }}
              />
            ) : null}
            <item.icon className="h-4 w-4 shrink-0" />
            <span className="flex-1 truncate">{item.label}</span>
            {badge ? (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                {badge}
              </span>
            ) : null}
          </button>
        );
      })}

      <div className="mt-auto rounded-md border border-sidebar-border bg-card/50 p-3 text-[11px] leading-relaxed text-muted-foreground">
        <p className="font-medium text-foreground">Human in the loop</p>
        <p className="mt-1">
          AI drafts and rewrites. Nothing publishes without your explicit
          review.
        </p>
      </div>
    </nav>
  );
}
