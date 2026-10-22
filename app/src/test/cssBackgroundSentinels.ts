// #1773: lets the cascade guards read which `background` declaration WON
// against the real app.css under jsdom.
//
// jsdom does not resolve `var()`: a `background` shorthand referencing a
// token computes to its initial value, so every such rule looks identical.
// This rewrites each `var(--token, …)` inside a `background`/`background-color`
// value to a unique literal colour per token name. Selectors, source order and
// media blocks are untouched, so jsdom's own cascade still picks the winner;
// `backgroundColor === sentinel('--token')` then means "the rule painting that
// token won". `background: none` stays as written.

const BACKGROUND_DECL = /(\bbackground(?:-color)?\s*:)([^;{}]*)/g;

export interface BackgroundSentinels {
  css: string;
  /** Serialised computed `backgroundColor` of a winning `var(--name)` declaration. */
  sentinel(name: string): string;
}

export function withBackgroundSentinels(css: string): BackgroundSentinels {
  const colours = new Map<string, string>();
  const colourFor = (name: string): string => {
    let colour = colours.get(name);
    if (colour === undefined) {
      const n = colours.size + 1;
      colour = `rgb(1, ${Math.floor(n / 256)}, ${n % 256})`;
      colours.set(name, colour);
    }
    return colour;
  };

  const rewritten = css.replace(BACKGROUND_DECL, (_m, prop: string, value: string) => {
    return prop + replaceVars(value, colourFor);
  });

  return {
    css: rewritten,
    sentinel(name: string): string {
      const colour = colours.get(name);
      if (colour === undefined) {
        throw new Error(`no background declaration in the stylesheet references ${name}`);
      }
      return colour;
    },
  };
}

// Balanced-paren scan so a fallback containing its own parentheses is
// replaced whole.
function replaceVars(value: string, colourFor: (name: string) => string): string {
  let out = '';
  let i = 0;
  while (i < value.length) {
    const start = value.indexOf('var(', i);
    if (start === -1) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, start);
    let depth = 0;
    let end = start;
    for (; end < value.length; end++) {
      if (value[end] === '(') depth++;
      else if (value[end] === ')' && --depth === 0) break;
    }
    if (end >= value.length) throw new Error(`unbalanced var() in background value: ${value}`);
    const name = /^var\(\s*(--[\w-]+)/.exec(value.slice(start))?.[1];
    if (name === undefined) throw new Error(`unparseable var() in background value: ${value}`);
    out += colourFor(name);
    i = end + 1;
  }
  return out;
}
