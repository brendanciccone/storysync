export type FrozenProps = { variant?: "a" | "b" | "c" };

const COLORS = { a: "#111827", b: "#f59e0b", c: "#10b981" } as const;

export function Frozen({ variant = "a" }: FrozenProps) {
  return (
    <div style={{ background: COLORS[variant], padding: "10px", color: "#fff", fontFamily: "Arial, sans-serif" }}>
      {variant}
    </div>
  );
}
