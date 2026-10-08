// A status line on a terminal, saying where a long run has got to.
//
// map, snap and diff read each component's documentation one at a time, and
// a large library on a slow docgen takes several seconds a component: 134
// components took 12 minutes to map and 30 to snap. Under --json nothing was
// printed until the end, so a run looked hung for all of it. The line goes to
// stderr, so stdout stays the JSON alone, and only to a terminal, as ora's
// spinners do, so logs and CI stay quiet. STORYSYNC_PROGRESS=1 asks for the
// same as plain lines anywhere else, for an agent or a CI log that follows a
// long run from its stderr.

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

/**
 * How progress is shown on `stream`: redrawn in place on a terminal, as a
 * line each where STORYSYNC_PROGRESS asks for it and it can't be redrawn,
 * or not at all. STORYSYNC_PROGRESS=0 turns it off on a terminal too.
 */
export function progressMode(stream: StatusStream, env: NodeJS.ProcessEnv = process.env): "redraw" | "lines" | "off" {
  const asked = env.STORYSYNC_PROGRESS?.trim().toLowerCase();
  if (asked === "0" || asked === "false") return "off";
  if (isInteractive(stream, env)) return "redraw";
  return asked ? "lines" : "off";
}

/**
 * Takes a terminal that reports 0 columns as 80 wide. A pty that `script`,
 * or an agent's harness, opens without a size can report 0, and ora divides
 * by it: a spinner then counts its one line as infinitely many and clears
 * them forever, writing without end (941MB in five minutes, seen live).
 */
export function widenZeroWidthTerminal(stream: StatusStream = process.stderr): void {
  if (stream.isTTY && !stream.columns) stream.columns = 80;
}

/** Clears the terminal's current line and returns to its start. */
const CLEAR_LINE = "\r\u001b[2K";

/** The signals that end a run from outside: Ctrl-C, kill, and a closed terminal. */
const ENDING_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/** What a line listens to so it is cleared however the run ends: the process, or a test's stand-in. */
export type ProcessEvents = Pick<NodeJS.Process, "pid" | "on" | "off" | "listenerCount" | "kill">;

/**
 * One line, redrawn in place. A line wider than the terminal wraps, and the
 * redraw then clears only its last row, so it is cut to fit. A terminal that
 * reports no width, as one `script` opens can, is taken as 80 columns.
 *
 * While it is drawn, the line is cleared however the process ends, so the
 * shell's prompt doesn't land on the end of it: on exit, and on a signal
 * that would end the process. Ctrl-C during map --json left "map 3/10 ..."
 * there. With no other listener for the signal, it is raised again once
 * the line is cleared, so the process still ends by it as it would have.
 * With another, as snap's and Playwright's, that one ends the run.
 */
export class StatusLine {
  private shown = "";
  private readonly mode: "redraw" | "lines" | "off";
  private listening = false;

  constructor(
    private readonly stream: StatusStream = process.stderr,
    env: NodeJS.ProcessEnv = process.env,
    private readonly events: ProcessEvents = process,
  ) {
    this.mode = progressMode(stream, env);
  }

  show(text: string): void {
    if (this.mode === "off") return;
    if (this.mode === "lines") {
      this.stream.write(`${text}\n`);
      return;
    }
    const width = Math.max((this.stream.columns || 80) - 1, 10);
    const line = text.length > width ? `${text.slice(0, width - 1)}…` : text;
    this.stream.write(`${CLEAR_LINE}${line}`);
    this.shown = line;
    this.listen(true);
  }

  /** Clears the line, leaving the cursor where it started. */
  clear(): void {
    if (!this.shown) return;
    this.stream.write(CLEAR_LINE);
    this.shown = "";
    this.listen(false);
  }

  private readonly onExit = (): void => this.clear();

  private readonly onSignal = (signal: NodeJS.Signals): void => {
    // Called still when a listener before it, in the same emit, cleared it.
    if (!this.listening) return;
    const alone = this.events.listenerCount(signal) === 1;
    this.clear();
    if (alone) this.events.kill(this.events.pid, signal);
  };

  private listen(on: boolean): void {
    if (on === this.listening) return;
    this.listening = on;
    const method = on ? "on" : "off";
    this.events[method]("exit", this.onExit);
    for (const signal of ENDING_SIGNALS) this.events[method](signal, this.onSignal);
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
