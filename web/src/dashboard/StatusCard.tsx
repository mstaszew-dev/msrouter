/**
 * A small status tile for one infrastructure component: colored status badge,
 * primary value, and optional detail line. Color encodes ComponentStatus:
 * green = up, red = down, gray = unconfigured/unknown.
 */
import type { ComponentStatus } from '@shared/schema';

const STATUS_STYLES: Record<ComponentStatus, string> = {
  up: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  down: 'bg-red-500/15 text-red-400 border-red-500/30',
  unconfigured: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
  unknown: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
};

export function StatusCard({
  title,
  status,
  value,
  detail,
  children,
}: {
  title: string;
  status: ComponentStatus;
  value?: string;
  detail?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-5" data-status={status}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-300">{title}</h3>
        <span
          className={`rounded-full border px-2 py-0.5 text-xs font-medium capitalize ${STATUS_STYLES[status]}`}
        >
          {status}
        </span>
      </div>
      {value !== undefined && <p className="mt-2 text-2xl font-semibold text-slate-100">{value}</p>}
      {detail && <p className="mt-1 text-xs text-slate-500">{detail}</p>}
      {children}
    </div>
  );
}
