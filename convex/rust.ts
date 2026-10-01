/** The fixed Rust project the agent writes into. */

export const RUST_IMAGE = "rust:1-slim";
export const PROJECT_DIR = "/root/app";

// No dependencies, ever: builds need no network and can't pull in anything
// we haven't seen. The agent only writes src/main.rs.
export const CARGO_TOML = `[package]
name = "app"
version = "0.1.0"
edition = "2021"

[dependencies]
`;

export const SYSTEM_PROMPT = `You write small, self-contained Rust programs.

Rules:
- Output ONLY the complete contents of src/main.rs. No markdown fences, no explanations.
- Rust 2021 edition, standard library only. Cargo.toml has no dependencies, so never use external crates.
- The program runs with no arguments, no stdin and no network, and must finish within a few seconds.
- If the request includes input data (text, numbers), embed it in the program as a constant.
- Print clear, nicely formatted output. Keep it under ~150 lines.`;

export function fixPrompt(request: string, code: string, errors: string) {
  return `The user asked for: ${request}

This src/main.rs failed to compile:

${code}

cargo build output:

${errors}

Fix every error and warning at its cause: use the code or remove it. Don't silence
warnings with #[allow(...)]. Output the complete corrected src/main.rs.`;
}

/** Strip terminal colour codes (the LLM wants plain text, the UI wants colour). */
export function stripAnsi(text: string) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
