import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const runStatus = v.union(
  v.literal("starting"), // creating the sandbox + writing the first draft
  v.literal("building"), // cargo build is running
  v.literal("fixing"), // the LLM is fixing compiler errors
  v.literal("running"), // it compiled: running the binary
  v.literal("succeeded"),
  v.literal("failed"),
);

export const attemptStatus = v.union(
  v.literal("writing"),
  v.literal("building"),
  v.literal("passed"),
  v.literal("failed"),
);

export default defineSchema({
  // One row per "write me a Rust program" request.
  runs: defineTable({
    sessionId: v.string(),
    prompt: v.string(),
    /** RUSTFLAGS="-D warnings": warnings fail the build too. */
    strict: v.boolean(),
    status: runStatus,
    finished: v.boolean(),
    sandboxId: v.optional(v.string()),
    sandboxCreateMs: v.optional(v.number()),
    /** What the compiled program printed, and its exit code. */
    output: v.optional(v.string()),
    exitCode: v.optional(v.number()),
    error: v.optional(v.string()),
  })
    .index("by_session", ["sessionId"])
    .index("by_finished", ["finished"]),

  // One row per compile attempt. The UI renders these as the timeline.
  attempts: defineTable({
    runId: v.id("runs"),
    number: v.number(),
    /** src/main.rs. Streams in token by token while status is "writing". */
    code: v.string(),
    status: attemptStatus,
    /** The component's execution row for `cargo build` (live logs). */
    executionId: v.optional(v.string()),
    buildStartedAt: v.optional(v.number()),
    buildMs: v.optional(v.number()),
    /** Final compiler output, copied off the execution row when it finishes. */
    log: v.optional(v.string()),
  }).index("by_run", ["runId", "number"]),
});
