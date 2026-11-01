/**
 * Behavior shared by every <dialog> in the app, so each one closes the same way:
 *  - Esc closes it (native), except that an open ⋮ menu inside it is dismissed first.
 *  - A click on the dimmed backdrop closes it. It must start AND end on the backdrop, so dragging a text
 *    selection out of a field and releasing outside does not dismiss it. A click that dismisses an open ⋮
 *    menu is not also a click on the backdrop.
 *  - Dialogs marked `data-persistent` (progress dialogs) ignore both.
 *  - When the last dialog closes and nothing has focus, focus goes back to the editor.
 *
 * This relies on dialogs having no padding of their own (`dialog { padding: 0 }`), so that a click whose
 * target is the dialog element itself can only be a click outside its content.
 */
export function initDialogs(focusEditor: () => void) {
  // Esc with a ⋮ menu open closes just the menu. Doing it on keydown stops the dialog's own cancel too.
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      const open = document.querySelectorAll<HTMLDialogElement>("dialog[open]");
      const top = open[open.length - 1];
      const popup = (top ?? document).querySelector(".popup");
      if (popup) {
        popup.remove();
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );

  document.querySelectorAll<HTMLDialogElement>("dialog").forEach((dialog) => {
    const persistent = dialog.hasAttribute("data-persistent");
    let pressedOnBackdrop = false;

    // A scrollbar belongs to the dialog element too, so "target is the dialog" is not enough:
    // the pointer must also be physically outside the dialog's box.
    const outside = (e: MouseEvent) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };

    dialog.addEventListener("pointerdown", (e) => {
      pressedOnBackdrop = e.target === dialog && outside(e);
    });

    dialog.addEventListener("click", (e) => {
      const fromBackdrop = pressedOnBackdrop && e.target === dialog && outside(e);
      pressedOnBackdrop = false;
      if (persistent || !fromBackdrop) return;
      if (dialog.querySelector(".popup")) return; // that click is dismissing the ⋮ menu
      dialog.close();
    });

    // Esc (and any other close request). Backstop for the keydown handler above.
    dialog.addEventListener("cancel", (e) => {
      if (persistent) return e.preventDefault();
      const popup = dialog.querySelector(".popup");
      if (popup) {
        e.preventDefault();
        popup.remove();
      }
    });

    dialog.addEventListener("close", () => {
      if (document.querySelector("dialog[open]")) return;
      const active = document.activeElement;
      if (!active || active === document.body) focusEditor();
    });
  });
}
