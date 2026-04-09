import { Pencil, Brain, CircleHelp, CircleCheck, CircleX, Loader, Clock } from "lucide-react";

const stateIconMap = {
  busy: { icon: Pencil, color: "var(--accent)", className: "state-icon-busy" },
  thinking: { icon: Brain, color: "var(--accent)", className: "state-icon-busy" },
  waiting: { icon: CircleHelp, color: "var(--yellow)", className: "" },
  idle: { icon: CircleCheck, color: "var(--green)", className: "" },
  running: { icon: CircleCheck, color: "var(--green)", className: "" },
  history: { icon: Clock, color: "var(--text-muted)", className: "" },
  error: { icon: CircleX, color: "var(--red)", className: "" },
  starting: { icon: Loader, color: "var(--text-muted)", className: "state-icon-spin" },
};

export default function StateIcon({ state }) {
  const entry = stateIconMap[state] || stateIconMap.idle;
  const Icon = entry.icon;
  return <Icon size={12} style={{ color: entry.color, flexShrink: 0 }} className={entry.className} />;
}
