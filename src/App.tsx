import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { Ansi, summarize } from "./ansi";
import { diffLines } from "./diff";
import { getSessionId } from "./session";

const REPO = "https://github.com/get-convex/convex-daytona-rust-fixer";
const MAX_PROMPT = 500;
const EXAMPLES = [
  { label: "First 20 primes", prompt: "A CLI that prints the first 20 primes in a neat table" },
  {
    label: "Word frequency",
    prompt:
      "Word frequency counter for the text below, printing the top 5 words with a bar chart.\n\nThe quick brown fox jumps over the lazy dog. The dog sleeps. The fox runs away, and the quick dog follows the fox.",
  },
  { label: "Binary search tree", prompt: "A generic binary search tree with insert, remove and an in-order iterator, with a small demo in main" },
  {
    label: "Matrix",
    prompt: "A Matrix struct with add, multiply, transpose, determinant and identity methods. In main, only demonstrate multiply on two 2x2 matrices.",
  },
  { label: "Game of Life", prompt: "Conway's Game of Life: print 4 generations of a glider on a 10x10 grid using # and ." },
];

const sessionId = getSessionId();

export default function App() {
  const runs = useQuery(api.runs.list, { sessionId });
  const [selected, setSelected] = useState<Id<"runs"> | null>(null);
  const runId = selected ?? runs?.[0]?._id ?? null;

  return (
    <div className="page">
      <header className="header">
        <div className="brand">
          <h1>Rust Fixer</h1>
          <span className="badge">Convex + Daytona</span>
        </div>
        <a className="github" href={REPO} target="_blank" rel="noreferrer">
          View on GitHub
        </a>
      </header>

      <main className="main">
        <aside className="side">
          <p className="lede">
            Ask for a small Rust program. An LLM writes <code>main.rs</code>, a Daytona sandbox runs{" "}
            <code>cargo build</code>, and every compiler error goes back to the LLM until it compiles.
          </p>
          <PromptForm onStarted={setSelected} />
          {runs && runs.length > 0 && <History runs={runs} selected={runId} onSelect={setSelected} />}
        </aside>
        <div className="stage">
          {runId ? <RunView key={runId} runId={runId} /> : runs && <HowItWorks />}
        </div>
      </main>

      <footer className="footer">
        Public demo. Everything resets every 12 hours. Run your own:{" "}
        <a href={REPO} target="_blank" rel="noreferrer">
          {REPO.replace("https://", "")}
        </a>
      </footer>
    </div>
  );
}

function PromptForm({ onStarted }: { onStarted: (runId: Id<"runs">) => void }) {
  const start = useMutation(api.runs.start);
  const [prompt, setPrompt] = useState("");
  const [strict, setStrict] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      onStarted(await start({ sessionId, prompt, strict }));
      setPrompt("");
    } catch (err) {
      setError(err instanceof ConvexError ? String(err.data) : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="ask" onSubmit={submit}>
      <textarea
        value={prompt}
        maxLength={MAX_PROMPT}
        rows={3}
        placeholder="Describe a small Rust program, e.g. a CLI that prints the first 20 primes"
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
        }}
      />
      <div className="examples">
        <span>Try:</span>
        {EXAMPLES.map((x) => (
          <button key={x.label} type="button" className="chip" onClick={() => setPrompt(x.prompt)}>
            {x.label}
          </button>
        ))}
      </div>
      <div className="ask-row">
        <label className="toggle" title="Warnings fail the build too, so the fix loop kicks in more often">
          <input type="checkbox" checked={strict} onChange={(e) => setStrict(e.target.checked)} />
          <span className="switch" />
          Strict mode <code>RUSTFLAGS="-D warnings"</code>
        </label>
        <span className="count">
          {prompt.length}/{MAX_PROMPT}
        </span>
        <button className="primary" disabled={busy || !prompt.trim()}>
          {busy ? "Starting…" : "Write it & compile"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function History(props: { runs: Doc<"runs">[]; selected: Id<"runs"> | null; onSelect: (id: Id<"runs">) => void }) {
  return (
    <nav className="history">
      <h3>Your runs</h3>
      {props.runs.map((run) => (
        <button
          key={run._id}
          className={`chip ${run._id === props.selected ? "active" : ""}`}
          onClick={() => props.onSelect(run._id)}
        >
          <span className={`dot ${run.status}`} />
          <span className="ellipsis">{run.prompt.split("\n")[0]}</span>
        </button>
      ))}
    </nav>
  );
}

const STATUS_TEXT: Record<Doc<"runs">["status"], string> = {
  starting: "Writing code",
  building: "Compiling",
  fixing: "Fixing errors",
  running: "Running",
  succeeded: "Compiled and ran",
  failed: "Failed",
};

function RunView({ runId }: { runId: Id<"runs"> }) {
  // One reactive query: run + attempts + sandbox state + the live cargo log.
  // Refresh mid-build and it picks up exactly where it was.
  const data = useQuery(api.runs.get, { sessionId, runId });
  const [picked, setPicked] = useState<number | null>(null);
  if (data === undefined) return null; // first load: usually a few ms
  if (data === null) return <p className="muted">Run not found. The demo resets every 12 hours.</p>;

  const { run, attempts, sandboxState, liveLog } = data;
  const current = attempts.find((a) => a.number === picked) ?? attempts.at(-1);
  const previous = current && attempts.find((a) => a.number === current.number - 1);

  return (
    <section className="run">
      <div className="run-head">
        <h2>{run.prompt}</h2>
        <span className={`pill ${run.status}`}>{STATUS_TEXT[run.status]}</span>
      </div>
      <div className="sandbox">
        <span className="label">Daytona sandbox</span>
        <span className={`state ${sandboxState ?? "pending"}`}>{sandboxState ?? "creating…"}</span>
        {run.sandboxCreateMs !== undefined && <span>ready in {secs(run.sandboxCreateMs)}</span>}
        {run.sandboxId && <code>{run.sandboxId.slice(0, 8)}</code>}
        {run.strict && <span className="strict">strict mode</span>}
      </div>

      <Timeline run={run} attempts={attempts} current={current?.number} onPick={setPicked} />

      {current && (
        <div className="panes">
          <CodePane key={current._id} attempt={current} previous={previous} />
          <BuildLog attempt={current} previous={previous} liveLog={liveLog} strict={run.strict} />
        </div>
      )}
      {(run.status === "running" || run.output !== undefined) && <ProgramOutput run={run} />}
      {run.error && <p className="error">{run.error}</p>}
    </section>
  );
}

function Timeline(props: {
  run: Doc<"runs">;
  attempts: Doc<"attempts">[];
  current?: number;
  onPick: (n: number) => void;
}) {
  const { run } = props;
  const ran = run.exitCode !== undefined;
  return (
    <ol className="timeline">
      {props.attempts.map((a) => (
        <li key={a._id}>
          <button className={`step ${a.status} ${a.number === props.current ? "current" : ""}`} onClick={() => props.onPick(a.number)}>
            <span className="icon">{{ writing: "✎", building: "⚙", passed: "✓", failed: "✗" }[a.status]}</span>
            <span>
              <strong>Attempt {a.number}</strong>
              <small>
                {a.status === "writing" && (a.number === 1 ? "writing code…" : "fixing code…")}
                {a.status === "building" && "cargo build…"}
                {a.status === "failed" && (summarize(a.log ?? "") || "build failed")}
                {a.status === "passed" && "compiled"}
                {a.buildMs !== undefined && ` · ${secs(a.buildMs)}`}
              </small>
            </span>
          </button>
        </li>
      ))}
      {(run.status === "running" || ran) && (
        <li>
          <div className={`step ${ran ? (run.exitCode === 0 ? "passed" : "failed") : "building"}`}>
            <span className="icon">▶</span>
            <span>
              <strong>Run</strong>
              <small>{ran ? `exit ${run.exitCode}` : "cargo run…"}</small>
            </span>
          </div>
        </li>
      )}
    </ol>
  );
}

function CodePane({ attempt, previous }: { attempt: Doc<"attempts">; previous?: Doc<"attempts"> }) {
  const writing = attempt.status === "writing";
  const canDiff = !!previous && !writing;
  const [showDiff, setShowDiff] = useState(true);
  const lines = canDiff && showDiff ? diffLines(previous.code.trimEnd(), attempt.code.trimEnd()) : null;
  const added = lines?.filter((l) => l.kind === "add").length ?? 0;
  const removed = lines?.filter((l) => l.kind === "del").length ?? 0;
  // Follow the code as it streams in. In diff mode, jump to the first change.
  const body = useAutoScroll<HTMLDivElement>(writing ? attempt.code : lines ? "diff" : "", lines ? ".add, .del" : undefined);

  return (
    <div className="pane">
      <div className="pane-head">
        <span>
          src/main.rs <em>attempt {attempt.number}</em>
        </span>
        {canDiff && (
          <div className="tabs">
            <button className={!showDiff ? "on" : ""} onClick={() => setShowDiff(false)}>
              Code
            </button>
            <button className={showDiff ? "on" : ""} onClick={() => setShowDiff(true)}>
              Diff vs {previous.number}{" "}
              <span className="plus">+{added}</span> <span className="minus">-{removed}</span>
            </button>
          </div>
        )}
      </div>
      <div className="pane-body code" ref={body}>
        {lines
          ? lines.map((l, i) => (
              <div key={i} className={`line ${l.kind}`}>
                <span className="gutter">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}</span>
                {l.text || " "}
              </div>
            ))
          : attempt.code.split("\n").map((text, i) => (
              <div key={i} className="line">
                <span className="gutter">{i + 1}</span>
                {text || " "}
              </div>
            ))}
        {writing && !attempt.code && <span className="muted">{"// thinking…"}</span>}
        {writing && <span className="cursor" />}
      </div>
    </div>
  );
}

function BuildLog(props: { attempt: Doc<"attempts">; previous?: Doc<"attempts">; liveLog: string; strict: boolean }) {
  // While the LLM writes a fix, keep showing the errors it's fixing.
  const fixing = props.attempt.status === "writing" && props.previous;
  const attempt = fixing ? props.previous! : props.attempt;
  const log = attempt.status === "building" ? props.liveLog : (attempt.log ?? "");
  const body = useAutoScroll<HTMLPreElement>(log + attempt.status);
  return (
    <div className="pane terminal">
      <div className="pane-head">
        <span className="dots">
          <i />
          <i />
          <i />
        </span>
        <span>
          cargo build <em>attempt {attempt.number}</em>
        </span>
      </div>
      <pre className="pane-body" ref={body}>
        <span className="prompt">$ </span>
        {props.strict && <span className="env">RUSTFLAGS="-D warnings" </span>}
        cargo build{"\n"}
        {attempt.status === "writing" ? <span className="muted">waiting for main.rs…</span> : <Ansi text={log} />}
        {attempt.status === "building" && <span className="cursor" />}
        {attempt.status === "passed" && <span className="ok">{"\n"}✓ build succeeded</span>}
        {attempt.status === "failed" && (
          <span className="bad">
            {"\n"}✗ build failed{fixing ? ": the LLM is fixing it now…" : ""}
          </span>
        )}
      </pre>
    </div>
  );
}

function ProgramOutput({ run }: { run: Doc<"runs"> }) {
  const done = run.exitCode !== undefined;
  return (
    <div className={`pane terminal output ${done && run.exitCode !== 0 ? "failed" : ""}`}>
      <div className="pane-head">
        <span>Program output</span>
        {done && <span className="exit">{run.exitCode === 124 ? "timed out after 10s" : `exit ${run.exitCode}`}</span>}
      </div>
      <pre className="pane-body">
        <span className="prompt">$ </span>cargo run{"\n"}
        {done ? run.output || <span className="muted">(no output)</span> : <span className="cursor" />}
      </pre>
    </div>
  );
}

function HowItWorks() {
  return (
    <ol className="how">
      <li>
        <strong>1. Write</strong>An LLM writes <code>src/main.rs</code>, standard library only.
      </li>
      <li>
        <strong>2. Compile</strong>A throwaway Daytona sandbox runs <code>cargo build</code>. Convex can't run a Rust
        compiler, and you wouldn't want LLM code next to your database anyway.
      </li>
      <li>
        <strong>3. Fix</strong>Compiler errors go back to the LLM. Up to 4 attempts, then the program runs.
      </li>
    </ol>
  );
}

/** Keep a panel scrolled to the bottom as text arrives, or to the first `target` element. */
function useAutoScroll<T extends HTMLElement>(content: string, target?: string) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !content) return;
    const focus = target ? el.querySelector<HTMLElement>(target) : null;
    el.scrollTop = focus ? focus.offsetTop - 100 : el.scrollHeight;
  }, [content, target]);
  return ref;
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
