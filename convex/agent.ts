/**
 * The agent: write main.rs, compile it in a Daytona sandbox, and if rustc
 * complains, feed the errors back to the LLM and try again.
 *
 * No action ever waits for cargo. Each step is a short action that kicks off
 * the next one, and runs.checkBuild watches the build in between:
 *
 *   begin ─▶ launchBuild ─▶ checkBuild ─┬─▶ runProgram ─▶ finish   (it compiled)
 *                 ▲                     └─▶ fix ─┐                 (it didn't)
 *                 └──────────────────────────────┘
 */
import { convexGateway } from "@convex-dev/ai-sdk-provider";
import { streamText } from "ai";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { env, internalAction, type ActionCtx } from "./_generated/server";
import { daytona } from "./daytona";
import {
  APP_NAME,
  MAX_OUTPUT_TOKENS,
  MAX_PROGRAM_OUTPUT_BYTES,
  RUN_TIMEOUT_SECONDS,
  SANDBOX_AUTO_DELETE_MINUTES,
  SANDBOX_AUTO_STOP_MINUTES,
} from "./limits";
import { CARGO_TOML, PROJECT_DIR, RUST_IMAGE, SYSTEM_PROMPT, fixPrompt, stripAnsi } from "./rust";

const MODEL = "anthropic/claude-sonnet-5";

/** Attempt 1: create the sandbox and write the first draft, in parallel. */
export const begin = internalAction({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    await failOnError(ctx, runId, async () => {
      const { run } = (await ctx.runQuery(internal.runs.getRun, { runId }))!;
      const createdAt = Date.now();
      const sandbox = daytona
        .createSandbox(ctx, {
          // A Docker image with cargo baked in, or your own pre-built snapshot.
          ...(env.RUST_SNAPSHOT ? { snapshot: env.RUST_SNAPSHOT } : { image: RUST_IMAGE }),
          labels: { app: APP_NAME },
          userKey: run.sessionId,
          autoStopInterval: SANDBOX_AUTO_STOP_MINUTES,
          autoDeleteInterval: SANDBOX_AUTO_DELETE_MINUTES,
          waitTimeoutMs: 3 * 60_000, // a cold image build can take a while
        })
        .then(async ({ sandboxId }) => {
          await ctx.runMutation(internal.runs.updateRun, {
            runId,
            sandboxId,
            sandboxCreateMs: Date.now() - createdAt,
          });
          await daytona.writeFile(ctx, { sandboxId, path: `${PROJECT_DIR}/Cargo.toml`, content: CARGO_TOML });
          return sandboxId;
        });
      const [sandboxId, attempt] = await Promise.all([sandbox, writeCode(ctx, run, 1, run.prompt)]);
      await launchBuild(ctx, run, sandboxId, attempt);
    });
  },
});

/** Attempts 2+: show the LLM what rustc said and let it try again. */
export const fix = internalAction({
  args: { runId: v.id("runs"), number: v.number() },
  handler: async (ctx, { runId, number }) => {
    await failOnError(ctx, runId, async () => {
      const state = await ctx.runQuery(internal.runs.getRun, { runId });
      if (!state || state.run.finished) return; // reset while we were away
      const previous = state.attempts[state.attempts.length - 1];
      const errors = stripAnsi(previous.log ?? "").slice(-8_000);
      const attempt = await writeCode(ctx, state.run, number, fixPrompt(state.run.prompt, previous.code, errors));
      await launchBuild(ctx, state.run, state.run.sandboxId!, attempt);
    });
  },
});

/** It compiled! Run it, with a timeout and an output cap. */
export const runProgram = internalAction({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    await failOnError(ctx, runId, async () => {
      const state = await ctx.runQuery(internal.runs.getRun, { runId });
      if (!state || state.run.finished) return;
      const { result, exitCode } = await daytona.run(ctx, {
        sandboxId: state.run.sandboxId!,
        cwd: PROJECT_DIR,
        envs: buildEnv(state.run),
        command: `bash -c 'timeout ${RUN_TIMEOUT_SECONDS} cargo run --quiet < /dev/null 2>&1 | head -c ${MAX_PROGRAM_OUTPUT_BYTES}; exit $\{PIPESTATUS[0]}'`,
        timeoutSeconds: RUN_TIMEOUT_SECONDS + 20,
      });
      await ctx.runMutation(internal.runs.updateRun, { runId, output: result, exitCode });
      await finish(ctx, runId);
    });
  },
});

/** Finish the run and delete its sandbox straight away: nothing left to do in it. */
export const cleanup = internalAction({
  args: { runId: v.id("runs"), error: v.optional(v.string()) },
  handler: async (ctx, { runId, error }) => finish(ctx, runId, error),
});

async function finish(ctx: ActionCtx, runId: Id<"runs">, error?: string) {
  await ctx.runMutation(internal.runs.finishRun, { runId, error });
  const state = await ctx.runQuery(internal.runs.getRun, { runId });
  const sandboxId = state?.run.sandboxId;
  if (sandboxId) await daytona.deleteSandbox(ctx, { sandboxId }).catch(() => {});
}

async function failOnError(ctx: ActionCtx, runId: Id<"runs">, step: () => Promise<void>) {
  try {
    await step();
  } catch (error) {
    console.error(error);
    await finish(ctx, runId, error instanceof Error ? error.message : String(error));
  }
}

/** Ask the LLM for main.rs, streaming it into the attempt row so the UI types along. */
async function writeCode(ctx: ActionCtx, run: Doc<"runs">, number: number, prompt: string) {
  const attemptId = await ctx.runMutation(internal.runs.createAttempt, { runId: run._id, number });
  // streamText doesn't throw on provider errors: it just ends empty. Catch them.
  let streamError: unknown;
  const result = streamText({
    model: convexGateway(MODEL),
    system: SYSTEM_PROMPT,
    prompt,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    onError: ({ error }) => {
      streamError = error;
    },
  });
  let code = "";
  let lastPatch = 0;
  for await (const chunk of result.textStream) {
    code += chunk;
    if (Date.now() - lastPatch > 250) {
      lastPatch = Date.now();
      await ctx.runMutation(internal.runs.updateAttempt, { attemptId, code });
    }
  }
  if (streamError || !code.trim()) {
    const message = streamError instanceof Error ? streamError.message : "the LLM returned no code";
    throw new Error(`Code generation failed: ${message}`);
  }
  code = code.replace(/^```[a-z]*\n?/, "").replace(/\n?```\s*$/, "") + "\n";
  await ctx.runMutation(internal.runs.updateAttempt, { attemptId, code });
  return { attemptId, code };
}

/** Write main.rs and start `cargo build` in the background. Returns immediately. */
async function launchBuild(
  ctx: ActionCtx,
  run: Doc<"runs">,
  sandboxId: string,
  attempt: { attemptId: Id<"attempts">; code: string },
) {
  await daytona.writeFile(ctx, { sandboxId, path: `${PROJECT_DIR}/src/main.rs`, content: attempt.code });
  const { executionId } = await daytona.runBackground(ctx, {
    sandboxId,
    cwd: PROJECT_DIR,
    envs: buildEnv(run),
    command: "cargo build 2>&1",
  });
  await ctx.runMutation(internal.runs.buildStarted, { attemptId: attempt.attemptId, executionId });
}

function buildEnv(run: Doc<"runs">): Record<string, string> {
  return {
    CARGO_TERM_COLOR: "always", // keep rustc's red and yellow for the UI
    ...(run.strict ? { RUSTFLAGS: "-D warnings" } : {}),
  };
}
