import type { RefObject, SyntheticEvent } from 'react';
import type { MenuEntry, MenuItem } from './Menu.tsx';
/** Whether a pointer event can request hover interactions.
 * @param event - current pointer, including mixed-input touch events.
 * @returns true for non-touch input with an available hover device.
 */
export declare function menuHoverAllowed(event: {
    pointerType: string;
}): boolean;
interface MenuSubmenu {
    entry: (MenuItem & {
        submenu: readonly MenuEntry[];
    }) | undefined;
    panelRef: RefObject<HTMLDivElement>;
    /** CSS anchor name of the root card's anchor box; the child card is placed against it. */
    parentAnchor: string;
    /** Whether the layout mode for the current child is known; the card stays hidden until it is. */
    measured: boolean;
    page: boolean;
    hidden: boolean;
    contains: (node: Node | null) => boolean;
    activeList: (focused: Node | null) => HTMLDivElement | null;
    /** Returns false when no visible child can handle the navigation. */
    returnToParent: () => boolean;
    openChild: (id: string, target: HTMLButtonElement, enter?: boolean) => void;
    focusParent: (id: string, target: HTMLButtonElement) => void;
    leave: () => void;
    cancelClose: () => void;
    collapseFrom: (event: SyntheticEvent<HTMLDivElement>) => void;
}
/** Manage a single child card without owning the root menu's document listeners.
 * @param options - current entries, root lifetime, and fallback focus destination.
 * @returns child rendering data and narrow interaction operations.
 */
export declare function useMenuSubmenu(options: {
    open: boolean;
    items: readonly MenuEntry[];
    footer: readonly MenuEntry[] | undefined;
    listRef: RefObject<HTMLDivElement>;
    refocusAnchor: () => void;
}): MenuSubmenu;
export {};
//# sourceMappingURL=useMenuSubmenu.d.ts.map