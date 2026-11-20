import { usageClass } from "./format";

/** Horizontal utilization bar, colored by how close it is to the limit. */
export function UsageBar({ label, utilization }: { label: string; utilization: number }) {
  const value = Math.round(Math.max(0, Math.min(1, utilization)) * 100);
  return (
    <div
      className="cc-bar"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
    >
      <div className={`cc-bar-fill ${usageClass(utilization)}`} style={{ width: `${value}%` }} />
    </div>
  );
}
