/**
 * Every knob that protects the public demo lives here. They're sensible for
 * your own copy too: tweak them freely.
 */
import { HOUR, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api";

/** Labels every sandbox, so the reset cron only ever touches ours. */
export const APP_NAME = "convex-daytona-rust-fixer";

export const MAX_PROMPT_CHARS = 500;
/** Compile, read the errors, fix, repeat: at most this many times. */
export const MAX_ATTEMPTS = 4;
/** Caps what the LLM can write per attempt. */
export const MAX_OUTPUT_TOKENS = 4_000;
/** Refuse new runs while this many sandboxes are live. */
export const MAX_LIVE_SANDBOXES = 8;

/** Daytona pauses an idle sandbox after this, and deletes it after that. */
export const SANDBOX_AUTO_STOP_MINUTES = 10;
export const SANDBOX_AUTO_DELETE_MINUTES = 60;

/** Give up on a single `cargo build` after this long. */
export const BUILD_TIMEOUT_MS = 3 * 60_000;
/** The finished program gets this long to run, and this much output. */
export const RUN_TIMEOUT_SECONDS = 10;
export const MAX_PROGRAM_OUTPUT_BYTES = 10_000;

export const rateLimiter = new RateLimiter(components.rateLimiter, {
  // Session ids live in localStorage, so they're easy to spoof...
  runsPerSession: { kind: "fixed window", rate: 5, period: HOUR },
  // ...which is why this global cap is the real backstop.
  runsGlobal: { kind: "fixed window", rate: 60, period: HOUR },
});
