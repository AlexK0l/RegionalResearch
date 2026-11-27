# Evidence-bound fleet category disclosure

Two user-captured HTML states of the same fleet drawer on 2026-11-27
showed 22 passenger vehicles, 76 trucks, 27 special vehicles. Before
collapse: 14 DOM vehicle rows in each group. After the truck group was
manually collapsed: 14, zero, 27. The truck's footer disappeared and the
two exact row-expander state classes changed from expanded to collapsed.
This proves shared rendering/window effects, not absence of vehicles.
No raw authenticated HTML, actual vehicle IDs or VINs are committed.

* Read both exact state classes of the unique visible item-expander in
  the observed transportCard:All drawer. Unknown/contradictory states
  cannot authorize a toggle.
* One bounded expansion action per positively counted pending category,
  only when its explicit state is collapsed and there are no rows or
  active footer. Recheck same verified company, unique category,
  group key, exact count, visible panel/list and state-specific target.
  No force clicks, guessed coordinates or private API calls.
* After a category is completely collected, optionally collapse it
  before continuing to another group, retaining every validated row
  in memory. A summary-completed category can be released once if the
  remaining drawer groups stall. Unverified groups are not collapsed
  by this optimization.
* Unknown or expanded-but-empty categories still use bounded existing
  hydration. No inference of zero; independent total, exact counts,
  stable group ID, ordered unique row prefix and model validation remain.
* Log explicit collapsed vs expanded-but-empty seed state and sanitized
  expansion/release outcomes. Existing shared hydration opt-out
  disables the new scheduler actions. Existing checkpoint and section
  budgets remain unchanged.

This is a DOM-grounded fix, not a live benchmark. It does not yet solve
all virtual-window/recycled-row layouts or prove every large fleet can
be fully traversed within the existing click/time bounds.
