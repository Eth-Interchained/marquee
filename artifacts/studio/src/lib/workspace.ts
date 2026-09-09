import type {
  Activity,
  BrowserState,
  Draft,
  UAProfile,
  Workspace,
} from '@/types';

export {
  PLATFORMS,
  PLATFORM_LABEL,
  PLATFORM_LIMIT,
  PLATFORM_ORIGIN,
  platformProfile,
} from '@/lib/platforms';

export function createId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function findWorkspace(
  state: BrowserState,
  workspaceId: string,
): Workspace | undefined {
  return state.workspaces.find((workspace) => workspace.id === workspaceId);
}

export function activeWorkspace(state: BrowserState): Workspace | undefined {
  return findWorkspace(state, state.activeWorkspaceId) ?? state.workspaces[0];
}

export function profileForWorkspace(
  state: BrowserState,
  workspace: Workspace | undefined,
): UAProfile | undefined {
  if (!workspace) return undefined;
  return state.uaProfiles.find((profile) => profile.id === workspace.profileId);
}

export function draftsForWorkspace(
  state: BrowserState,
  workspaceId: string,
): Draft[] {
  return state.drafts
    .filter((draft) => draft.workspaceId === workspaceId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function logActivity(
  state: BrowserState,
  entry: Omit<Activity, 'id' | 'timestamp'>,
): Activity[] {
  const activity: Activity = {
    ...entry,
    id: createId('activity'),
    timestamp: new Date().toISOString(),
  };
  return [activity, ...state.activity].slice(0, 40);
}

/**
 * Activity timestamps are written as ISO strings, but the seeded entries use
 * human phrases. Render whichever form is present without throwing.
 */
export function relativeTime(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;

  const deltaSeconds = Math.round((parsed - Date.now()) / 1000);
  const absolute = Math.abs(deltaSeconds);

  if (absolute < 60) return deltaSeconds >= 0 ? 'in a moment' : 'just now';

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['minute', 60],
    ['hour', 3600],
    ['day', 86400],
    ['week', 604800],
    ['month', 2592000],
    ['year', 31536000],
  ];

  let unit: Intl.RelativeTimeFormatUnit = 'minute';
  let divisor = 60;
  for (const [candidate, seconds] of units) {
    if (absolute >= seconds) {
      unit = candidate;
      divisor = seconds;
    }
  }

  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  return formatter.format(Math.round(deltaSeconds / divisor), unit);
}

export function formatDateTime(value: string | null): string {
  if (!value) return 'Unscheduled';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** `datetime-local` inputs need a zero-offset local string, not an ISO string. */
export function toLocalInputValue(value: string | null): string {
  const source = value ? new Date(value) : new Date(Date.now() + 3600000);
  if (Number.isNaN(source.getTime())) return '';
  const offset = source.getTimezoneOffset() * 60000;
  return new Date(source.getTime() - offset).toISOString().slice(0, 16);
}

export function fromLocalInputValue(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function initialsFor(name: string): string {
  return name
    .split(/[\s.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}
