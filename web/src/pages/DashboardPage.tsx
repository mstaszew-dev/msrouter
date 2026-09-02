/**
 * Dashboard shell: tabbed layout over the observability overview and the
 * users/SQL console. The active user's role decides what the second tab can
 * do (read-only for viewers).
 */
import { useState } from 'react';

import { useAuth } from '../auth/AuthContext';
import { OverviewTab } from '../dashboard/OverviewTab';
import { UsersSqlTab } from '../dashboard/UsersSqlTab';

type Tab = 'overview' | 'users';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'users', label: 'Users & SQL' },
];

export function DashboardPage(): React.JSX.Element {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('overview');

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-slate-100">Dashboard</h1>
        <div role="tablist" aria-label="Dashboard sections" className="flex gap-1 rounded-lg border border-slate-800 bg-slate-900 p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${
                tab === t.id
                  ? 'bg-cyan-600/20 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div role="tabpanel">
        {tab === 'overview' ? <OverviewTab /> : <UsersSqlTab role={user?.role ?? 'viewer'} />}
      </div>
    </div>
  );
}
