/** Portaled child menu presentation; interaction state belongs to useMenuSubmenu. */
import type { ReactNode } from 'react';
import { type useMenuSubmenu } from './useMenuSubmenu.ts';
/** Render one child list with a non-selecting back row in single-page placement.
 * @param props - active entry, submenu operations, and shared row presentation options.
 * @returns a body portal that preserves child DOM identity across placement changes.
 */
export declare function SubmenuPanel({ entry, submenu, compact, dense, contextual, backLabel, onSelect, onClose, afterSelection }: {
    entry: NonNullable<ReturnType<typeof useMenuSubmenu>['entry']>;
    submenu: ReturnType<typeof useMenuSubmenu>;
    compact: boolean;
    dense: boolean;
    contextual: boolean;
    backLabel: ReactNode;
    onSelect: ((id: string) => void) | undefined;
    onClose: () => void;
    afterSelection: () => void;
}): import("react").ReactPortal;
//# sourceMappingURL=SubmenuPanel.d.ts.map