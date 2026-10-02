// Inline styles keep the example unambiguous: what renders is what gets
// measured, with no build-time class resolution in between. storysync works
// the same way with Tailwind, CSS modules, or styled-components — it reads the
// computed result rather than the authoring format.

export type ButtonProps = {
  variant?: "primary" | "danger" | "outline";
  size?: "sm" | "lg";
  disabled?: boolean;
  children?: React.ReactNode;
};

const VARIANTS = {
  primary: { background: "#2563eb", color: "#ffffff", border: "0px solid transparent" },
  danger: { background: "#dc2626", color: "#ffffff", border: "0px solid transparent" },
  outline: { background: "transparent", color: "#111827", border: "2px solid #9ca3af" },
} as const;

const SIZES = {
  sm: { fontSize: "12px", padding: "4px 8px", borderRadius: "3px" },
  lg: { fontSize: "18px", padding: "12px 24px", borderRadius: "9px" },
} as const;

export function Button({
  variant = "primary", size = "sm", disabled = false, children = "Button",
}: ButtonProps) {
  return (
    <button
      disabled={disabled}
      style={{
        ...VARIANTS[variant],
        ...SIZES[size],
        opacity: disabled ? 0.4 : 1,
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        fontFamily: "Inter, sans-serif",
        fontWeight: 600,
      }}
    >
      {children}
    </button>
  );
}
