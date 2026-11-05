/**
 * @rewind/protocol — the contract shared by every part of the system.
 *
 * ARCHITECTURE.md §3: the daemon is Rust and the UI/extensions are TypeScript, so the artefacts
 * that must not drift between the two languages live here as language-neutral data:
 *
 *   schemas/     JSON Schema for the event model  → generated into Rust structs and TS types
 *   redaction/   the secret detector registry     → compiled by both redactor implementations
 *   prompts/     versioned LLM prompts            → loaded by the Rust AI module (AI.md §3)
 *
 * Hand-written duplicates of generated types are a review-blocking error.
 */

export * from './types.js';
export * from './redaction/redactor.js';
