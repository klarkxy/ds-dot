import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import type { MenuEntry, MenuItemButtonProps, MenuLabel, MenuSeparator } from './Menu.tsx';
/** Optional props that also accept `undefined`, so data rows can forward absent `MenuItem` fields. */
type OptionalProps<T, K extends keyof T> = {
    [P in K]?: T[P] | undefined;
};
/** Package-internal row props: the `MenuItemButton` row fields plus data- and child-row presentation. */
type MenuRowProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & Pick<MenuItemButtonProps, 'children'> & OptionalProps<MenuItemButtonProps, 'icon' | 'shortcut' | 'current' | 'disabledReason' | 'danger' | 'separatorBefore'> & {
    /** Whether this data row is the menu's current selection. */
    selected?: boolean;
    /** Selection marker: a trailing check, or the row fill. */
    selection?: 'check' | 'fill';
    /** Keep an empty icon column so grouped rows stay aligned. */
    reserveIcon?: boolean;
    /** Hide the icon from assistive technology; component rows keep it exposed. */
    decorativeIcon?: boolean;
    /** Pointer handlers on the row wrapper, used by submenu parents. */
    wrapperProps?: HTMLAttributes<HTMLDivElement> | undefined;
};
/** Render a focus-stable row with optional selection, shortcut, and disabled explanation.
 * @param props - row content, native button events, and optional pointer wrapper events.
 * @returns one menu item; explained disabled rows remain focusable but never activate.
 */
export declare function MenuRow({ children, icon, shortcut, current, disabled, disabledReason, danger, separatorBefore, selected, selection, reserveIcon, decorativeIcon, wrapperProps, ...button }: MenuRowProps): import("react").JSX.Element;
/** Mark icon columns within each separator-delimited data group.
 * @param entries - entries in one menu area.
 * @param contextual - whether to align grouped context-menu icons.
 * @returns entries that reserve a leading icon column.
 */
export declare function menuIconColumns(entries: readonly MenuEntry[], contextual: boolean): ReadonlySet<MenuEntry>;
/** Render a separator or group heading outside the keyboard walk.
 * @param entry - non-interactive menu entry.
 * @returns the corresponding element.
 */
export declare function renderMenuDecoration(entry: MenuSeparator | MenuLabel): ReactNode;
export {};
//# sourceMappingURL=MenuRow.d.ts.map