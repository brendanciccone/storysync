// A status line on a terminal, saying where a long run has got to.
//
// map, snap and diff read each component's documentation one at a time, and
// a large library on a slow docgen takes several seconds a component: 134
// components took 12 minutes to map and 30 to snap. Under --json nothing was
// printed until the end, so a run looked hung for all of it. The line goes to
// stderr, so stdout stays the JSON alone, and only to a terminal, as ora's
// spinners do, so logs and CI stay quiet.

export interface StatusStream {
  isTTY?: boolean;
  columns?: number;
  write(chunk: string): unknown;
}

/**
 * Whether `stream` is a terminal a line can be redrawn on: the test ora
 * makes before it spins. Not under CI, whose log keeps every redraw.
 */
export function isInteractive(stream: StatusStream, env: NodeJS.ProcessEnv = process.env): boolean {
  return !!stream.isTTY && env.TERM !== "dumb" && !("CI" in env);
}

/** Clears the terminal's current line and returns to its start. */
const CLEAR_LINE = "\r\u001b[2K";

/**
 * One line, redrawn in place. A line wider than the terminal wraps, and the
 * redraw then clears only its last row, so it is cut to fit. A terminal that
 * reports no width, as one `script` opens can, is taken as 80 columns.
 */
export class StatusLine {
  private shown = "";
  private readonly enabled: boolean;

  constructor(private readonly stream: StatusStream = process.stderr, env: NodeJS.ProcessEnv = process.env) {
    this.enabled = isInteractive(stream, env);
  }

  show(text: string): void {
    if (!this.enabled) return;
    const width = Math.max((this.stream.columns || 80) - 1, 10);
    const line = text.length > width ? `${text.slice(0, width - 1)}…` : text;
    this.stream.write(`${CLEAR_LINE}${line}`);
    this.shown = line;
  }

  /** Clears the line, leaving the cursor where it started. */
  clear(): void {
    if (!this.shown) return;
    this.stream.write(CLEAR_LINE);
    this.shown = "";
  }

  /**
   * Runs `print` with the line cleared, then draws it again, so text written
   * to the same terminal, on stdout or stderr, doesn't land on the end of it.
   */
  around(print: () => void): void {
    const last = this.shown;
    this.clear();
    print();
    if (last) this.show(last);
  }
}

/**
 * A command's progress through its components, and through the variants of
 * the one it is on: "snap 12/134 UI Base/Command, variant 3/32".
 */
export class Progress {
  private current = "";

  constructor(private readonly command: string, private readonly line: StatusLine = new StatusLine()) {}

  component(position: number, total: number, label: string): void {
    this.current = `${this.command} ${position}/${total} ${label}`;
    this.line.show(this.current);
  }

  variant(position: number, total: number): void {
    this.line.show(`${this.current}, variant ${position}/${total}`);
  }

  /** Prints through `print` without writing over the line. */
  print(print: () => void): void {
    this.line.around(print);
  }

  /** Clears the line, before the result is printed or on the way out. */
  done(): void {
    this.line.clear();
  }
}
