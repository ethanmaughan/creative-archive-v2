/**
 * Minimal glob matcher for mode scope patterns (§3). Deliberately tiny: scope decides what
 * the agent can touch, so the matcher is something you can read in full and reason about
 * rather than a dependency whose edge cases you infer from its test suite.
 *
 * Supported:
 *   `**`  matches any number of path segments
 *   `*`   matches any characters within one segment
 *   everything else is literal
 *
 * Paths are archive-relative POSIX paths with no leading slash.
 *
 * Note `sessions/**` matches paths strictly *under* `sessions/`, not `sessions` itself —
 * a scope granting a directory grants its contents.
 */

const REGEX_SPECIAL = /[.+^${}()|[\]\\]/g;

function translate(pattern: string): RegExp {
  let out = '';
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i]!;

    if (char === '*') {
      const isDoubleStar = pattern[i + 1] === '*';

      if (isDoubleStar) {
        // `**/` consumes zero or more whole segments so `**/*.md` matches a top-level file.
        if (pattern[i + 2] === '/') {
          out += '(?:[^/]+/)*';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
      continue;
    }

    out += char.replace(REGEX_SPECIAL, '\\$&');
    i += 1;
  }

  return new RegExp(`^${out}$`);
}

const cache = new Map<string, RegExp>();

export function matchesGlob(pattern: string, path: string): boolean {
  let regex = cache.get(pattern);
  if (!regex) {
    regex = translate(pattern);
    cache.set(pattern, regex);
  }
  return regex.test(path);
}

export function matchesAnyGlob(patterns: readonly string[], path: string): boolean {
  return patterns.some((pattern) => matchesGlob(pattern, path));
}
