/** Render cargo's coloured output (ANSI escape codes) as spans. */

const COLORS: Record<number, string> = {
  31: "var(--red)", 91: "var(--red)",
  32: "var(--green)", 92: "var(--green)",
  33: "var(--yellow)", 93: "var(--yellow)",
  34: "var(--blue)", 94: "var(--blue)",
  35: "var(--purple)", 95: "var(--purple)",
  36: "var(--cyan)", 96: "var(--cyan)",
};

export function Ansi({ text }: { text: string }) {
  const parts = text.split(/\x1b\[([0-9;]*)m/); // eslint-disable-line no-control-regex
  const spans = [];
  let color: string | undefined;
  let bold = false;
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      for (const code of parts[i].split(";").map(Number)) {
        if (code === 0) [color, bold] = [undefined, false];
        else if (code === 1) bold = true;
        else if (code === 22) bold = false;
        else if (code === 39) color = undefined;
        else if (COLORS[code]) color = COLORS[code];
      }
    } else if (parts[i]) {
      spans.push(
        <span key={i} style={{ color, fontWeight: bold ? 600 : undefined }}>
          {parts[i]}
        </span>,
      );
    }
  }
  return <>{spans}</>;
}

export function stripAnsi(text: string) {
  return text.replace(/\x1b\[[0-9;]*m/g, ""); // eslint-disable-line no-control-regex
}

/** "3 errors, 1 warning" from cargo output. */
export function summarize(log: string) {
  const plain = stripAnsi(log);
  const errors = plain.match(/^error(\[E\d+\])?: (?!could not compile|aborting)/gm)?.length ?? 0;
  const warnings = plain.match(/^warning: (?!.*generated \d+ warning)/gm)?.length ?? 0;
  const s = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return [errors && s(errors, "error"), warnings && s(warnings, "warning")].filter(Boolean).join(", ");
}
