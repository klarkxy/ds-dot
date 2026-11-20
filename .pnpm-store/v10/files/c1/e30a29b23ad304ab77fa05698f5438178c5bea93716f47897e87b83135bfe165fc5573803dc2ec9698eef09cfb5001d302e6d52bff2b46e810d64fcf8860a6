/** Shared compact presentation for draft and sent text quotes. */
import type { JSX } from 'react';
/** Optional whole-quote removal control supplied by an editable owner. */
export interface QuotePreviewRemoval {
    /** Localized accessible name for the removal button. */
    readonly label: string;
    /** Remove the complete owning quote node. */
    readonly onRemove: () => void;
}
/** Owner-supplied readable form of a quote whose exact text is long structured content. */
export interface QuoteSummary {
    /** Short inline label shown before `body` in place of the exact text; assistive technology reads `title` and `detail` instead. */
    readonly label: string;
    /** First popover line, such as a file path; also the label's accessible text. */
    readonly title: string;
    /** Secondary popover line, such as a line range. */
    readonly detail?: string | undefined;
    /** Main text, such as a user's comment, shown inline after `label` and in full in the popover. */
    readonly body: string;
}
/** Presentation inputs for one compact quote excerpt. */
export interface QuotePreviewProps {
    /** Exact selected text rendered inline and exposed in a popover while clipped, unless `summary` replaces it. */
    readonly text: string;
    /** Readable replacement for `text`: its label renders inline and its popover opens on every hover. */
    readonly summary?: QuoteSummary | undefined;
    /** Composer-only removal action; omit for inert sent quotes. */
    readonly removal?: QuotePreviewRemoval | undefined;
}
/**
 * Render one width-capped quote preview shared by editable drafts and sent messages.
 * Clipped excerpts open a content-sized, scrollable popover that fits within the viewport.
 * @param props - selected text, optional summary, and optional localized removal action.
 * @returns a non-navigating quote preview with a full-text popover only while clipped, or a summary popover.
 */
export declare function QuotePreview({ text, summary, removal }: QuotePreviewProps): JSX.Element;
//# sourceMappingURL=QuotePreview.d.ts.map