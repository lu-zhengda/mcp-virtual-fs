/**
 * Pure path utilities for the virtual filesystem.
 * No external dependencies — all functions are stateless.
 */

const MAX_PATH_LENGTH = 4096;

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathError";
  }
}

/** Normalize a path: resolve `.`/`..`, ensure leading `/`, strip trailing `/`. */
export function normalizePath(input: string): string {
  if (!input) return "/";

  // Ensure leading slash
  const p = input.startsWith("/") ? input : "/" + input;

  const segments = p.split("/");
  const resolved: string[] = [];

  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      resolved.pop();
    } else {
      resolved.push(seg);
    }
  }

  return "/" + resolved.join("/");
}

/** Get the parent path: `/a/b/c` → `/a/b`, `/a` → `/` */
export function parentPath(p: string): string {
  const normalized = normalizePath(p);
  if (normalized === "/") return "/";
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === 0 ? "/" : normalized.slice(0, lastSlash);
}

/** Get the basename: `/a/b/c.ts` → `c.ts`, `/` → `/` */
export function basename(p: string): string {
  const normalized = normalizePath(p);
  if (normalized === "/") return "/";
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

/** Get all ancestor paths: `/a/b/c` → `["/", "/a", "/a/b"]` */
export function ancestorPaths(p: string): string[] {
  const normalized = normalizePath(p);
  if (normalized === "/") return [];

  const segments = normalized.split("/").filter(Boolean);
  const ancestors: string[] = ["/"];

  for (let i = 0; i < segments.length - 1; i++) {
    ancestors.push("/" + segments.slice(0, i + 1).join("/"));
  }

  return ancestors;
}

/** Validate a path. Throws PathError on invalid input. Returns the normalized path. */
export function validatePath(input: string): string {
  if (typeof input !== "string") {
    throw new PathError("Path must be a string");
  }
  if (input.length > MAX_PATH_LENGTH) {
    throw new PathError(`Path exceeds maximum length of ${MAX_PATH_LENGTH}`);
  }
  if (input.includes("\0")) {
    throw new PathError("Path must not contain null bytes");
  }

  const normalized = normalizePath(input);

  // After normalization, double slashes are impossible, but check raw input
  // for obviously malformed paths that sneak in unusual characters
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(input)) {
    throw new PathError("Path must not contain control characters");
  }

  return normalized;
}
