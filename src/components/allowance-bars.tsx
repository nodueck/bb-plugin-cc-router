import type { AllowanceWindow } from "../status-model";
import { dateTime, percent } from "./format";
import { UsageBar } from "./usage-bar";

export function AllowanceBars({ windows }: { windows: AllowanceWindow[] }) {
  if (windows.length === 0) {
    return <p className="cc-muted">No allowance data</p>;
  }
  return (
    <div className="cc-allowances">
      {windows.map(window => (
        <div className="cc-allowance" key={window.id}>
          <div className="cc-row cc-row-tight">
            <span>{window.label}</span>
            <strong>{percent(window.utilization)}</strong>
          </div>
          <UsageBar label={`${window.label} utilization`} utilization={window.utilization} />
          <div className="cc-muted cc-small">Resets: {dateTime(window.resetAtMs)}</div>
        </div>
      ))}
    </div>
  );
}
