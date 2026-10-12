/**
 * Small DOM helpers for the Play view: segmented radio controls and slide-in drawers.
 */

/** Handle returned by `bindSegmented`. */
export interface SegmentedControl {
  /** Marks the button whose `data-value` equals `value` as checked. */
  set(value: string): void;
  setDisabled(disabled: boolean): void;
}

/**
 * Wires a `.segmented` container of `button[data-value]` children as a radio group.
 *
 * @param root Container element (`role="radiogroup"`).
 * @param onChange Called with the chosen `data-value` when the user picks a different option.
 */
export function bindSegmented(
  root: HTMLElement,
  onChange: (value: string) => void,
): SegmentedControl {
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-value]'));
  buttons.forEach((b) => b.setAttribute('role', 'radio'));

  const set = (value: string): void => {
    buttons.forEach((b) => {
      const checked = b.dataset.value === value;
      b.setAttribute('aria-checked', String(checked));
      b.tabIndex = checked ? 0 : -1;
    });
  };

  buttons.forEach((b) => {
    b.addEventListener('click', () => {
      const value = b.dataset.value ?? '';
      if (b.getAttribute('aria-checked') === 'true') {
        return;
      }
      set(value);
      onChange(value);
    });
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const idx = buttons.indexOf(b);
      const next = buttons[(idx + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length];
      next.focus();
      next.click();
    });
  });

  return {
    set,
    setDisabled(disabled: boolean): void {
      buttons.forEach((b) => {
        b.disabled = disabled;
      });
    },
  };
}

/**
 * Opens and closes right-hand drawers (one at a time) with a shared scrim, restoring focus to the
 * element that opened the drawer.
 */
export class DrawerController {
  private readonly scrim: HTMLElement;
  private openDrawer: HTMLElement | null = null;
  private returnFocusTo: HTMLElement | null = null;

  constructor(scrim: HTMLElement) {
    this.scrim = scrim;
    scrim.addEventListener('click', () => this.close());
    document.querySelectorAll<HTMLElement>('[data-close-drawer]').forEach((btn) => {
      btn.addEventListener('click', () => this.close());
    });
  }

  public isOpen(): boolean {
    return this.openDrawer !== null;
  }

  public toggle(drawer: HTMLElement, opener: HTMLElement | null): void {
    if (this.openDrawer === drawer) {
      this.close();
    } else {
      this.open(drawer, opener);
    }
  }

  public open(drawer: HTMLElement, opener: HTMLElement | null): void {
    if (this.openDrawer && this.openDrawer !== drawer) {
      this.hide(this.openDrawer);
    }
    this.openDrawer = drawer;
    this.returnFocusTo = opener ?? (document.activeElement as HTMLElement | null);
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    this.scrim.hidden = false;
    drawer.querySelector<HTMLElement>('[data-close-drawer]')?.focus();
  }

  public close(): void {
    if (!this.openDrawer) {
      return;
    }
    this.hide(this.openDrawer);
    this.openDrawer = null;
    this.scrim.hidden = true;
    this.returnFocusTo?.focus();
    this.returnFocusTo = null;
  }

  private hide(drawer: HTMLElement): void {
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
  }
}
