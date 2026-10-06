/**
 * Minimal glob matcher for config rules and .editorconfig sections.
 * Supports `*`, `**`, `?`, `[...]` and `{a,b}` — the subset those files use.
 * A hand-rolled matcher keeps the plugin dependency-free in this layer.
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached) return cached;

  let pattern = "";
  for (let index = 0; index < glob.length; index++) {
    const character = glob[index]!;
    if (character === "*") {
      if (glob[index + 1] === "*") {
        index++;
        if (glob[index + 1] === "/") {
          index++;
          pattern += "(?:.*/)?";
        } else {
          pattern += ".*";
        }
      } else {
        pattern += "[^/]*";
      }
    } else if (character === "?") {
      pattern += "[^/]";
    } else if (character === "{") {
      pattern += "(?:";
    } else if (character === "}") {
      pattern += ")";
    } else if (character === ",") {
      pattern += "|";
    } else if (character === "[") {
      const close = glob.indexOf("]", index);
      if (close === -1) {
        pattern += "\\[";
      } else {
        pattern += glob.slice(index, close + 1);
        index = close;
      }
    } else {
      pattern += escapeRegExp(character);
    }
  }

  const regexp = new RegExp(`^${pattern}$`);
  cache.set(glob, regexp);
  return regexp;
}

export function matchesGlob(glob: string, candidate: string): boolean {
  const pattern = globToRegExp(glob.startsWith("**/") ? glob : `**/${glob}`);
  return pattern.test(candidate);
}

/**
 * `.editorconfig` semantics: a pattern without `/` matches the basename at any
 * depth (`*.java`), otherwise it is anchored at the section's directory.
 */
export function matchesEditorConfigGlob(
  glob: string,
  relativePath: string,
): boolean {
  const normalised = relativePath.replace(/^\.\//, "");
  if (glob.includes("/")) return globToRegExp(glob).test(normalised);
  const basename = normalised.slice(normalised.lastIndexOf("/") + 1);
  return globToRegExp(glob).test(basename);
}
