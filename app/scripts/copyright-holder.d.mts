// Hand-written declarations for copyright-holder.mjs so the sanitizer can be
// imported from typechecked Vitest specs (src/lib/copyrightHolder.test.ts).
// Keep in sync with copyright-holder.mjs.
export declare const COPYRIGHT_HOLDER_OVERRIDES: Readonly<Record<string, string>>;

export declare function copyrightHolder(pkg: {
  name: string;
  author?: string | { name?: string | undefined } | undefined;
}): string;
