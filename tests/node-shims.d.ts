// Minimal typing for the Node built-in used by fixture-based tests (the project has no @types/node).
declare module 'node:fs' {
  export function readFileSync(path: string): Uint8Array & { buffer: ArrayBuffer; byteOffset: number; byteLength: number };
}
