interface StatusBadgeProps {
  tone?: "neutral" | "cache" | "db" | "write" | "external" | "success";
  children: string;
}

export function StatusBadge({
  tone = "neutral",
  children,
}: StatusBadgeProps) {
  return <span className={`status-badge status-${tone}`}>{children}</span>;
}

