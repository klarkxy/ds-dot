/** Unified-diff row parsing and per-file body tokenization for markdown fences. @module dsh-client-ui-primitives/markdown/diff-fence */
import type { HighlightSpan } from './highlight.ts';
/** Fence info strings rendered as a unified diff instead of grammar-highlighted code. */
export declare const DIFF_FENCE_LANGUAGES: Set<string>;
/**
 * Whether a fence info string selects diff row rendering.
 * @param lang - the fence info string, case-insensitively compared.
 * @returns whether the fence is a unified diff.
 */
export declare function isDiffFenceLanguage(lang: string | undefined): boolean;
/** One unified-diff line, split so the marker column stays out of the tokenized body. */
export interface DiffRow {
    /** Row role, which selects the line's diff class. */
    kind: 'add' | 'del' | 'context' | 'hunk' | 'meta';
    /** The marker column, kept verbatim so copy reproduces the source. */
    marker: string;
    /** The code after the marker column, or the whole line for chrome rows. */
    body: string;
    /** The full source line, rendered as-is for hunk and meta rows. */
    raw: string;
    /** Index of the file section this row belongs to; -1 before any file header. */
    file: number;
}
/** Parsed fence: rows plus the language each file section names. */
export interface DiffFence {
    /** The fence rows in source order. */
    rows: DiffRow[];
    /** Inner language per file section, when the header names a known one. */
    languages: ReadonlyMap<number, string>;
}
/**
 * Split a unified diff into rows without losing a byte (copy reads the DOM).
 *
 * The hunk header's line budget ends a hunk, so a following `---` / `+++` file
 * header is chrome again — both for a concatenated `git diff` and for `diff -u`
 * output without `diff --git` lines. A malformed header keeps the row until the
 * next `diff --git`, matching how authored fences are rendered.
 * @param code - the fence body, display-trimmed.
 * @returns the rows and each file section's language.
 */
export declare function parseDiffFence(code: string): DiffFence;
/**
 * Whether a row carries code the body highlighter tokenizes.
 * @param row - the parsed row.
 * @returns whether the row has tokenizable body text.
 */
export declare function isDiffContent(row: DiffRow): boolean;
/**
 * Tokenize each file's old side (context and deletions) and new side (context
 * and additions) separately, so an unterminated comment or string in a removed
 * line cannot color the added lines and one file's grammar never applies to the
 * next. Context rows keep the old-side runs.
 * @param diff - parsed fence rows and per-file languages.
 * @returns token runs per content-row index, or `undefined` when no body has a
 * loaded grammar and the caller should render plain text.
 */
export declare function diffFenceTokens(diff: DiffFence): Map<number, readonly HighlightSpan[]> | undefined;
//# sourceMappingURL=diff-fence.d.ts.map