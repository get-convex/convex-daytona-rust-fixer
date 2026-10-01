# Rust Fixer: fix it until it compiles

Ask for a small Rust program. An LLM writes `src/main.rs`, a [Daytona](https://www.daytona.io) sandbox runs `cargo build`, and if rustc complains, the errors go straight back to the LLM until it compiles. Then the program runs and you see its output.

Built with [Convex](https://convex.dev) and the [`@daytona/convex`](https://www.convex.dev/components/daytona/convex) component.

![Attempt 1 failed, the LLM is fixing it while the compiler errors stay on screen](docs/fixing.png)

![Attempt 2 compiled, with the diff between attempts and the program output](docs/compiled.png)

**Try the live demo:** TODO: live demo link

## What it shows

- **Convex can't run a Rust compiler.** Convex actions run JavaScript: no shell, no disk, no `cargo`. You also don't want LLM-written code running next to your database and API keys. A Daytona sandbox is a separate, throwaway computer with Rust installed.
- **Reactive everything, no polling code in the UI.** The attempt timeline, the streaming `main.rs`, the live `cargo build` log and the sandbox state are all one `useQuery`. Refresh mid-build and it carries on where it was.
- **The scheduler as an agent loop.** No action ever sits waiting for cargo. Each step is a short function that schedules the next one.

## Run your own

```bash
git clone https://github.com/get-convex/convex-daytona-rust-fixer
cd convex-daytona-rust-fixer
npm install
npx convex dev --once   # creates your Convex project, then stops: DAYTONA_API_KEY isn't set yet
npx convex env set DAYTONA_API_KEY dtn_...   # https://app.daytona.io/dashboard/keys
npm run dev
```

`DAYTONA_API_KEY` is declared as a required env var in `convex/convex.config.ts`, so Convex refuses to push until it's set, and the code reads it as a typed `env.DAYTONA_API_KEY`.

The LLM goes through the [Convex AI Gateway](https://docs.convex.dev/ai-gateway/setup), which needs no API key but does need a paid Convex team. To use your own OpenAI key instead, `npm install @ai-sdk/openai`, run `npx convex env set OPENAI_API_KEY sk-...`, and change two lines in `convex/agent.ts`:

```ts
import { openai } from "@ai-sdk/openai"; // instead of convexGateway
    model: openai("gpt-5"),               // instead of convexGateway(MODEL)
```

To host the frontend on your Convex deployment too, run `npm run deploy` (it uses [`@convex-dev/static-hosting`](https://github.com/get-convex/static-hosting)).

### Faster first sandbox (optional)

Sandboxes are created from the `rust:1-slim` Docker image, because Daytona's default snapshot has no `cargo`. The very first create builds that image and took about 17 s. After that Daytona caches it and creates take about 1.5 s. If you'd rather never pay the cold start, make a snapshot once and point the app at it:

- Dashboard: [Snapshots](https://app.daytona.io/dashboard/snapshots) > Create Snapshot, name `rust-fixer`, image `rust:1-slim`.
- Or the Daytona CLI: `daytona snapshot create rust-fixer --image rust:1-slim`
- Or the TypeScript SDK: `await daytona.snapshot.create({ name: "rust-fixer", image: "rust:1-slim" })`

Then `npx convex env set RUST_SNAPSHOT rust-fixer`. The component can create sandboxes from a snapshot but can't create snapshots itself, which is why this step lives outside the app.

## How it works

| File | What it does |
|---|---|
| `convex/runs.ts` | The public `start` mutation (rate limits, caps), the `get` query the UI subscribes to, and `checkBuild`, which watches each build. |
| `convex/agent.ts` | The agent's steps: create the sandbox, write code, launch the build, fix, run, clean up. |
| `convex/rust.ts` | The fixed `Cargo.toml` (no dependencies), the system prompt and the fix prompt. |
| `convex/limits.ts` | Every abuse-protection knob in one place. |
| `convex/reset.ts`, `convex/crons.ts` | The 12-hour reset. |
| `src/App.tsx` | The UI: timeline, code with a diff between attempts, terminal, program output. |

The loop looks like this:

```
begin ─▶ launchBuild ─▶ checkBuild ─┬─▶ runProgram ─▶ finish   (it compiled)
              ▲                     └─▶ fix ─┐                 (it didn't)
              └──────────────────────────────┘
```

The interesting Daytona calls, from `convex/agent.ts`:

```ts
// A sandbox with Rust in it. Short-lived, labelled, scoped to the browser session.
const { sandboxId } = await daytona.createSandbox(ctx, {
  image: "rust:1-slim",
  labels: { app: "convex-daytona-rust-fixer" },
  userKey: run.sessionId,
  autoStopInterval: 10,
  autoDeleteInterval: 60,
});

// Start cargo build and return immediately. The component streams its
// output into a reactive execution row while it runs.
await daytona.writeFile(ctx, { sandboxId, path: "/root/app/src/main.rs", content: code });
const { executionId } = await daytona.runBackground(ctx, {
  sandboxId,
  cwd: "/root/app",
  envs: { CARGO_TERM_COLOR: "always", RUSTFLAGS: "-D warnings" },
  command: "cargo build 2>&1",
});
```

`runBackground` has no completion callback, so `checkBuild` in `convex/runs.ts` is a mutation that reads the execution row (a plain database read, no Daytona API call) and reschedules itself with backoff until cargo exits. Then it decides: run the program, ask the LLM for a fix, or give up after 4 attempts.

```ts
const execution = await daytona.getExecution(ctx, { executionId: attempt.executionId });
if (execution?.status === "running") {
  await ctx.scheduler.runAfter(next, internal.runs.checkBuild, { attemptId, delayMs: next });
  return;
}
```

The same `getExecution` call inside the `get` query is what streams the build log to the browser.

### Strict mode

Strict mode sets `RUSTFLAGS="-D warnings"`, so warnings such as dead code or unused variables fail the build too. The LLM isn't told about it up front: it writes code as it normally would, and the compiler is just pickier. That makes the fix loop kick in more often (try the "Matrix" example). It's on by default.

### Other choices worth knowing

- **Standard library only.** `Cargo.toml` is fixed with no dependencies, so builds need no network and the LLM can't pull in crates.
- **No extended thinking.** Reasoning is turned off, so code starts streaming in about a second. The compiler does the reviewing.
- **The program runs with a 10 second timeout and 10 KB of output**, no stdin and no arguments. Then the sandbox is deleted straight away.

## Abuse protection

This runs as a public demo, and every run costs real Daytona and LLM money. All limits live in [`convex/limits.ts`](convex/limits.ts):

- An anonymous session id (a UUID in localStorage) scopes your runs and sandboxes (`userKey`).
- Rate limits with [`@convex-dev/rate-limiter`](https://www.convex.dev/components/rate-limiter): 5 runs per hour per session, 60 per hour overall. Session ids are easy to spoof, so the global limit is the real backstop.
- At most 8 live sandboxes at once.
- Prompts up to 500 characters, LLM output capped at 4,000 tokens, at most 4 compile attempts, a 3 minute build timeout.
- Sandboxes are labelled `app: convex-daytona-rust-fixer`, stop after 10 idle minutes and auto-delete after 60. The app deletes each one as soon as its run is done anyway.
- Every 12 hours a cron (`convex/crons.ts`) deletes every sandbox this app created that's still around and wipes the app's tables. Run it by hand any time with `npx convex run reset:resetDemo`.

## Links

- [`@daytona/convex` component](https://www.convex.dev/components/daytona/convex)
- [Daytona docs](https://www.daytona.io/docs)
- [Convex docs](https://docs.convex.dev)

## License

Apache-2.0. See [LICENSE](LICENSE).
