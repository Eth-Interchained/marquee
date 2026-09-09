import type { ReactNode } from 'react';

import type { BrowserState, Section, UAProfile, Workspace } from '@/types';

export type SectionProps = {
  state: BrowserState;
  updateState: (updater: (current: BrowserState) => BrowserState) => void;
  workspace: Workspace;
  profile: UAProfile | undefined;
  /**
   * Move to another section, optionally pointing at one post. The calendar and
   * the dashboard both list posts they cannot manage; handing the draft id
   * along is what turns those lists into a way in rather than a display.
   */
  onNavigate: (section: Section, options?: { draftId?: string }) => void;
};

export function SectionShell({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {description}
          </p>
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}
