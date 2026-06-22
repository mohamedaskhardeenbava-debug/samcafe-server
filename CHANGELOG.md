# Sam Cafe — Post-Migration Fix & Cleanup Log

This log tracks every change made during the MongoDB Atlas migration bugfix
and code-quality sweep. Organized by area, most important fixes first.

## Scope of this delivery

**Done, in this zip:** `server.js` (all migration-breaking bugs fixed),
the **entire admin panel** (`admin/src`), and the **entire user-facing
panel** (`samcafe/src`) — every page, component, hook, and utility file in
the whole codebase has been read and fixed where needed.

## Highlights — the most impactful fixes

These are the ones most likely to have been actively causing problems or
data loss before this fix:

1. **`server.js`**: `/combo`, `/combo_offers`, `theme`, and `tablePreferences`
   were all unreachable (404s or silently-broken singleton routes) —
   this was almost certainly the main thing "throwing errors" after migration.
2. **Events.js** (admin): the Delete button on an event card had **zero
   confirmation** — one misclick permanently deleted an event and all its
   bookings.
3. **Staffs.js** (admin): editing a staff member created a **duplicate
   record** instead of updating the original, orphaning all of that staff
   member's attendance/salary/training history.
4. **6 admin pages had a completely broken Export button** (Reservations,
   Celebrations, Catering, PreBookings, KitchenSchedules, ServiceSchedules) —
   a naming collision meant clicking Export called itself recursively
   instead of generating a spreadsheet.
5. **KitchenMise.js / ServiceMise.js** (admin): a failed save would
   silently re-apply the failed change instead of rolling back — staff
   would see a checkbox as "saved" when it actually wasn't.
6. **KitchenReports.js** (admin): the "Mise en Place" widget had been
   reading from an abandoned legacy collection and showing nothing for
   weeks/months.
7. **Ingredients.js / KitchenRecipe.js / StaffCareer.js** (admin):
   id-generation bugs that silently broke deletion for anything created
   through those forms (numeric vs. string id mismatch, or regenerating
   the id on every edit).
8. **FloatingBag.js** (user panel): order-placement failures were
   completely silent — the single most important action in the app had no
   error feedback at all.
9. **FavouriteCategories.js / FavouriteDishList.js** (user panel):
   favourited dishes from subcategory-organized menu sections could
   disappear or show a wrong title — confirmed live in your actual data.
10. **App.js** (user panel): a button on the Celebration form
    (`navigateToCatering`) silently did nothing due to a missing prop.

Full details for every change, including the ones not listed above, are
below — backend and admin panel first, user panel ("Part 2") starting
partway through this document.

---

## Backend (server.js)

### 🔴 Critical — broke the app after migration
- **`/combo` and `/combo_offers` were missing from `ARRAY_COLLECTIONS` entirely.**
  Both admin (`ComboOffers.js`) and the user panel (`ComboPage.js`, `App.js`)
  call these routes directly. They 404'd on every request after migration.
  Added both to `ARRAY_COLLECTIONS`.
- **`theme` and `tablePreferences` were misclassified as singleton collections.**
  Both are genuine arrays in `db.json` (theme has one row with `id:"1"`;
  tablePreferences has 5 distinct preference rows) and both panels call them
  with full array-style CRUD (`GET` list, `PUT /theme/1`, `POST`, `DELETE /:id`).
  The old singleton routes (`findOne({id:"singleton"})`) never matched any
  document, so every theme save silently no-op'd and table preference
  create/update/delete all failed. Moved both to `ARRAY_COLLECTIONS`.
- **Removed dead `comboOffers` (camelCase) collection** from the registry —
  nothing in either frontend calls it. The live collection both panels use is
  `combo_offers` (snake_case). Your `db.json` has both; `comboOffers` is stale
  duplicate data from an earlier naming convention. Left untouched in db.json
  (not deleting your data), but the server no longer serves routes for it.

### Notes (not fixed — flagged for you)
- `POST /campaign` (used by `admin/src/pages/Users.js` "send campaign" button)
  was never implemented server-side, even before migration. It's not a
  regression — it always silently failed via the button's catch block. Needs
  an actual SMS/email provider decision from you before it can be built.

---

## Frontend — Admin Panel

### admin/src/ThemeSettings.js
- Fixed `id: 1` (number) → `id: "1"` (string) in the theme save payload.
  `db.json` stores the theme row with a string id, and the PUT route matches
  on `req.params.id` (always a string from the URL). A numeric id would only
  bite on a *fresh* environment with no seeded theme yet — the very first
  save would store `id: 1` (number), and every subsequent `GET`/`PUT /theme/1`
  (string `"1"`) would never match it again, permanently breaking theme save.

### admin/src/index.js
- Removed dead `<ToastContainer />` import and render. It's a no-op
  (`() => null`) kept only for backward compatibility in `useToast.js`;
  rendering it does nothing. Removed the now-unused import too.

### admin/src/App.js
- **Removed the standalone `/callHistory` fetch and `adminData.callHistory` state.**
  This was real dead code, confirmed by full trace: the app actually has two
  separate "call history" concepts sharing one name —
  1. **The real, working feature**: every booking record (reservation,
     prebooking, catering order, celebration, event) carries its own embedded
     `callHistory: [isoTimestamp, ...]` array, appended to directly by
     `Topbar.js`'s "mark call done" action and by the call-log buttons inside
     `Reservations.js`, `Celebrations.js`, `Catering.js`, `PreBookings.js`.
     `CallHistory.js` and the inline call-history sections in the detail pages
     read this embedded array. This is fully intact and untouched.
  2. **A separate, standalone `callHistory` collection** in `db.json`/Mongo
     with its own structured docs (`type`, `referenceId`, `name`, `calledAt`,
     `notes`). `App.js` fetched this into `adminData.callHistory` on every
     login — but nothing in either panel ever reads `adminData.callHistory`.
     It was pure dead weight: one extra network round-trip on every login,
     stored in state, never rendered.
  - The 3 existing documents in this standalone collection reference a
    reservation id (`res_1778741765556`) that no longer exists in your
    `reservations` data — they're already orphaned. I did **not** delete
    them or remove the `/callHistory` route from `server.js` (removing the
    route would make them permanently unreachable in Atlas rather than just
    unused). If you don't need this standalone collection, you can safely
    delete it directly in Atlas; nothing in the app depends on it.
- **Removed dead `comboOffers` (camelCase) entry** from the socket
  `RESOURCE_KEY_MAP` — this matches the same dead collection removed from
  `server.js`'s registry above; the socket event for it will never fire.
- **Removed dead `callHistory` entry** from the same `RESOURCE_KEY_MAP`, for
  the same reason as above — nothing reads `adminData.callHistory` anymore.

### admin/src/components/layout/Topbar.js
- **Fixed an operator-precedence bug** in the chip-tooltip venue logic:
  `d.venue || d.venueName || d.tableNumber ? \`Table ${d.tableNumber}\` : null`
  was parsed as `(d.venue || d.venueName || d.tableNumber) ? ... : null` — so
  any booking with a `venue` or `venueName` set (and no `tableNumber`) showed
  the literal text "Table undefined" in the hover tooltip instead of the
  actual venue name. Confirmed this fires in practice: your `events`
  collection has populated `venue` values but no `tableNumber` field at all.
  Fixed to: `d.venue || d.venueName || (d.tableNumber ? \`Table ${d.tableNumber}\` : null)`.
- Fixed a typo: a button read "Mard Called" instead of "Mark Called".

### admin/src/components/layout/Sidebar.js
- Removed an unused `useRef` import and an unused `sidebarRef` ref that was
  declared but never read anywhere.

### admin/src/hooks/useStatusUpdate.js
- **Removed a silent-data-loss fallback pattern.** The hook tried `PATCH`
  first, and on *any* failure — network blip, validation error, anything —
  silently fell back to a full `PUT` using whatever `data` object was passed
  in when the hook was instantiated. That `data` snapshot can be stale by the
  time the fallback fires, so this could silently overwrite other fields that
  changed server-side in the meantime with old local values, while also
  masking the real error that triggered the fallback. This was a leftover
  workaround for old json-server versions that didn't support `PATCH`; your
  new Mongo-backed `server.js` supports `PATCH` reliably on every array
  collection, so the workaround is both unnecessary and risky now. Simplified
  to call `PATCH` directly and surface genuine failures to the user via toast.

---

## Frontend — Admin Panel — Events Pages

### Cross-cutting fix: removed the dangerous PATCH→stale-PUT fallback pattern
The same risky pattern from `useStatusUpdate.js` (see above) was duplicated
inline **10 times** across 5 files — every status update, table assignment,
and call-log action in the events module:

- `admin/src/pages/events/PreBookings.js` — status update, call logging (2)
- `admin/src/pages/events/CelebrationDetails.js` — status update (1)
- `admin/src/pages/events/Celebrations.js` — status update, call logging (2)
- `admin/src/pages/events/Catering.js` — status update, call logging (2)
- `admin/src/pages/events/Reservations.js` — status update, table
  assignment, call logging (3)

Each one tried `PATCH`, and on *any* error silently retried with a full
`PUT` built from a locally-captured, potentially-stale snapshot of the
record — masking real failures and risking overwriting concurrent changes
(e.g. a socket-pushed update from another device landing between the
optimistic update and the fallback firing). This was a json-server-era
workaround that's unnecessary now that `server.js` supports `PATCH`
reliably on every collection. All 10 sites now call `PATCH` directly; the
existing optimistic-update-then-rollback-on-error structure around each one
is untouched and still works correctly.

### Cross-cutting fix: `class=` → `className=` (78 occurrences, 17 files)
JSX requires `className`, not the raw HTML `class` attribute. React renders
`class` through to the DOM as-is for unrecognized props, so this was mostly
invisible visually, but it triggers "Unknown DOM property `class`. Did you
mean `className`?" warnings on every affected render and is inconsistent
with `className` used correctly everywhere else in the codebase. All 78
instances — concentrated in the 3D push-button `shadow`/`edge`/`front` spans
across `Orders.js`, `Dishes.js`, `Ingredients.js`, `Offers.js`, `Stocks.js`,
and the staff/kitchen/service page groups — were mechanically corrected to
`className`. No visual or behavioral change; pure console-warning cleanup
and code-standard consistency.


- **Fixed a validation-field-mismatch bug** in `addSize()`. The character/word
  limit check for a size's description (`isValidSizeDescription`) always
  validated the *category*-size description field (`sizeDescription`), even
  when adding a *subcategory* size — it should have validated
  `subSizeDescription` in that branch. Effect: an invalid subcategory size
  description (too long / too many words) silently passed validation and got
  saved, while an unrelated leftover value in the category-size field could
  incorrectly block a valid subcategory size from being added. Also removed a
  redundant shadowed `sizeObj` that was computed and discarded on every
  subcategory add.
- **Removed dead code**: `getMostAndLeastSelling()` and the `stats` variable
  that called it were computed on every row render but the result was never
  used anywhere in the JSX — the "most/least selling" feature isn't wired up
  to display at all. It was also broken for any category using subcategories
  (most of your menu), since it only looked at `category.dishes`, which is
  empty whenever dishes live inside `subCategories[].dishes` instead. Since
  it's confirmed unused, removed rather than fixed-but-still-invisible.
- **Fixed a missing `key` prop** on the subcategory table row inside the main
  category list (`category.subCategories.map(...)`). A bare `<tr>` with no
  key can cause React reconciliation glitches (wrong row updating, stale DOM)
  when subcategories are added, removed, or reordered. Added `key={sub.id}`.
- Fixed a typo: "Descripion" → "Description" in a subcategory size form label.

### admin/src/pages/Orders.js
- Removed an unused computed value (`allItemsCompleted`) in `OrderRow` —
  calculated on every render, never read.
- **Made the receipt-printer bridge URL configurable.** `printBill()` called
  a hardcoded `http://localhost:9001/print/bill` — a local print-bridge
  service (separate from your main API server, since browsers can't talk to
  receipt printers directly). Because it's an absolute URL, it bypassed the
  shared `api` client's `baseURL` entirely. This is a legitimate pattern for
  a local POS print helper, but hardcoding it means it'll silently fail on
  any machine where the bridge isn't on exactly that host/port. Changed to
  read `process.env.REACT_APP_PRINT_SERVER_URL`, falling back to the same
  `localhost:9001` default so your current local setup is unaffected.
- **Removed dead code**: `handleSplitAmount` / `handleSplitBill`, an older
  `prompt()`-based implementation of the bill-split feature, fully superseded
  by `applySplitAmount` / `applySplitBill` (the modal-based versions actually
  wired to the UI). Confirmed zero call sites for the removed pair before
  deleting.

### admin/src/pages/UserDetails.js
- Removed unused imports: `api`, `useEffect`, `useState` — none were used
  anywhere in this file (it's a pure read-only detail view).

### admin/src/pages/Favourites.js
- **Wired up Price column sorting.** The sort logic already supported
  `sortConfig.key === "price"`, but the table header had no `onClick` to
  trigger it — only the Name column was clickable. Added the missing
  handler and sort-arrow indicator, matching the Name column's pattern.

### Cross-cutting fix: sort-direction arrows showing on the wrong column
In `Favourites.js`, `Stocks.js`, `Users.js`, and `Orders.js`, sortable
column headers each render a directional arrow (▲/▼), but on any page with
**more than one** sortable column, several of these arrows checked only
`sortConfig.direction`, not *which* column was actually being sorted. The
effect: every sortable column's arrow could light up simultaneously, or the
wrong column would show the arrow while a different column was actually
controlling the sort — confusing, since there's only ever one active sort
key. `Stocks.js` was the worst case (6 sortable columns all sharing the same
unguarded arrow logic). Fixed all 12 occurrences across the 4 files to check
`sortConfig.key === "<thatColumn>"` first, matching the one place in the
codebase that already did this correctly (`Orders.js`'s Status column,
which was the reference pattern for the fix). `Ingredients.js` and
`Dishes.js` have only one sortable column each, so their equivalent code was
left as-is — with a single possible sort key, the "always show" behavior
isn't actually a bug there.

### admin/src/pages/OfferDetails.js
- Removed a locally-duplicated `CustomDropdown` component and replaced it
  with the real shared one (`admin/src/components/CustomDropdown.js`). The
  local copy silently dropped the `label` prop — it destructured `label` but
  never rendered it — so the "Dish" and "Status" floating labels never
  appeared on this page's edit-mode dropdowns, even though every other page
  using the real shared component showed labels correctly.

### Cross-cutting fix: consolidated 13 duplicate `CustomDropdown` components
This turned out to be a much bigger version of the `OfferDetails.js` issue
above. **13 files** each had their own pasted copy of `CustomDropdown`,
byte-for-byte identical to each other and to the one in `OfferDetails.js` —
all missing the `label` render, and all missing `hasError` support entirely
(the prop wasn't even destructured, so passing it did nothing):

- `admin/src/pages/staffs/StaffTraining.js`, `Staffs.js`, `StaffCareer.js`
- `admin/src/pages/kitchen/KitchenSchedules.js`, `KitchenGrooming.js`
- `admin/src/pages/Stocks.js`, `Offers.js`, `Dishes.js`
- `admin/src/pages/events/PreBookings.js`, `Events.js`, `Catering.js`
- `admin/src/pages/service/ServiceGrooming.js`, `ServiceSchedules.js`

Confirmed real impact by checking actual call sites: **11 of the 13 files**
pass a `label` prop to their local dropdown that silently never rendered,
and **9 of the 13** pass `hasError` for form-validation styling that was
completely inert — so the red-border/red-label invalid-field indicator you
built for required dropdown fields wasn't working on any of those pages, in
the same way it does correctly on text inputs nearby. All 13 were replaced
with an import of the real shared `CustomDropdown`, which already supports
both props correctly (plus `disabled` and `className`, also now available
for free). No JSX call sites needed changes — the shared component's props
are a superset of what these pages were already passing.
  - **Left untouched, by design**: 3 other files with their *own*,
    differently-named local dropdown variants that do correctly render
    `label` (just with different inline styling/sizing):
    `kitchen/KitchenAssign.js`, `service/ServiceAssign.js`, and
    `events/Reservations.js` (the last one doesn't take a `label` prop at
    all, by design). These aren't broken, so consolidating them carries
    visual-regression risk without a way for me to visually verify the
    result — left as-is rather than guessing.

---

## Frontend — Admin Panel — Remaining Pages

### admin/src/pages/OrderDetails.js
- **Fixed the Price column showing the line total instead of the unit
  price.** Both the "Price" and "Subtotal" columns rendered the same
  `itemTotal` value. Invisible for single-quantity items (price × 1 = the
  total), but for any item with quantity > 1 it showed an inflated,
  incorrect per-unit price. Confirmed real impact: 49 order line items in
  your current data have quantity > 1. Price now correctly resolves to
  `item.price` (or `itemTotal / quantity` as a fallback) while Subtotal
  keeps showing the line total.

### admin/src/pages/Dashboard.js
- **Fixed a stale-data bug**: the `categorySales` pie-chart data (used to
  resolve a category/subcategory id to its display name) read
  `adminData.categories` inside its `useMemo`, but didn't list it as a
  dependency — only `baseFilteredOrders` was listed. If a category got
  renamed while the dashboard was open on an unchanged date range, the pie
  chart would keep showing the old name until something else (like changing
  the date filter) forced a recompute. Added `adminData.categories` to the
  dependency array.
- **Removed dead code**: `getThisMonthDates()`, plus the `monthDates` and
  `workingDays` values derived from it, ran on every single render but were
  never used anywhere — `workingDays` was even listed as a `useMemo`
  dependency for `staffStats` despite never being referenced inside that
  calculation. All three removed.

### admin/src/pages/DishDetails.js
- Fixed invalid HTML: the Nutrition table's `<thead>` contained two bare
  `<th>` elements not wrapped in a `<tr>`. Browsers tolerate this visually,
  but it's invalid markup and inconsistent with every other table in the
  codebase. Wrapped in a proper `<tr>`.

### admin/src/pages/IngredientDetails.js
- Removed dead code in `saveIngredient()`: `oldId`/`newId` were always set
  equal to each other (ingredient ids are never regenerated on edit, per the
  existing code comment), so the `if (oldId !== newId)` re-navigation branch
  could never run. Simplified to a single `oldId`.
- **Hardened the "Used In" category checkboxes against undefined data.**
  The checkbox `checked` state correctly defaulted to `[]` when
  `usedInCategories` was missing, but the `onChange` handlers that build the
  updated array did not — `[...localIngredient.usedInCategories, id]` would
  throw if that field were ever absent. Every ingredient in your current
  data happens to have this field, so it wasn't live, but it's one bad
  record away from crashing the page. Added the same `|| []` guard used by
  the `checked` prop right next to it, in both the subcategory and
  category-level checkbox handlers, plus the read-only tag-list view.
- Fixed the same invalid-HTML `<thead>` issue as `DishDetails.js` (bare
  `<th>` elements not wrapped in a `<tr>`) in the Nutrition table.

### Cross-cutting fix: native `alert()` / `window.confirm()` → toast pattern
The codebase has an established toast-based pattern for warnings
(`toast.warning(...)`) and destructive confirmations (`toast.confirm(msg,
onConfirm)`), used consistently almost everywhere (and explicitly documented
as an intentional past fix in `Users.js`'s header comment: "alert() → toast
(industry standard)"). Two spots had reverted to native browser dialogs,
which look and behave inconsistently with the rest of the UI:
- `admin/src/pages/events/PreBookings.js` — a raw `alert()` on empty-export
  guard, changed to `toast.warning(...)`.
- `admin/src/pages/ComboOffers.js` — a blocking `window.confirm()` on
  delete, changed to the non-blocking `toast.confirm(msg, onConfirm)`
  pattern used by `Categories.js` and others.

---

## Noted, Not Changed (flagged for your awareness)

### Admin login is not connected to real authentication
`server.js` has a complete, working JWT + bcrypt login system
(`POST /auth/register`, `POST /auth/login`, a `requireAuth` middleware) —
but nothing calls it. `admin/src/pages/Login.js` checks a hardcoded
`admin@samcafe.com` / `admin123` directly in client-side code (visible to
anyone who opens devtools), and no API route in `server.js` actually applies
`requireAuth`, so every endpoint is reachable without a token. This is
pre-existing — not something the Atlas migration touched. Per your
confirmation this app only runs on a local/private network right now, it's
left as-is. If you ever expose this beyond a local network, this is the
first thing to lock down — the JWT machinery to do it already exists in
`server.js`; it just needs to be wired to the admin login form and applied
to routes.

### Two separate print-bridge services both hardcode port 9001
Discovered while packaging this delivery (outside `admin/src`, so not part
of the line-by-line sweep above, but directly relevant to the
`REACT_APP_PRINT_SERVER_URL` fix in `Orders.js`): `admin/kot-printer/` and
`samcafe/kot-printer/` are **two different local printer-bridge services**
— `admin`'s handles bill printing (`/print/bill`), `samcafe`'s handles
kitchen order ticket printing (`/print/kot`) — but both independently
`app.listen(9001, ...)`. If you ever need both running on the same machine
at the same time, only one can actually bind to port 9001; the second to
start will crash on launch. Not changed, since picking a new port means
also updating whatever printer hardware/network setup currently points at
9001 — that needs your input. If/when you want this resolved, the fix is
straightforward: give one of them a different port (e.g. 9002) and update
`REACT_APP_PRINT_SERVER_URL` accordingly for whichever panel needs it.

---

## Frontend — Admin Panel — Events Detail Pages

### admin/src/pages/events/PreBookingDetails.js
- **Hardened a division-by-zero risk** in the pre-ordered items table. The
  unit-price fallback computed `Number(item.totalPrice) / item.quantity`
  whenever `item.unitPrice` was missing, with no guard for `item.quantity`
  being `0` or absent — confirmed several real pre-booking items in your
  data have no `quantity` field at all, though they're saved by always
  having `unitPrice` present too, so the division was never actually
  reached. Hardened anyway to fall back safely (using `totalPrice` directly)
  if a future record ever lacks both fields, matching the safer pattern
  `CateringDetails.js` already uses.

### admin/src/pages/events/CelebrationDetails.js
- Removed locally-duplicated `fmtTime` / `fmtDateTime` helpers — confirmed
  byte-identical to the shared versions in `utils/dateUtils.js`, which the
  sibling detail pages (`CateringDetails.js`, `ReservationDetails.js`,
  `PreBookingDetails.js`) already import instead of redefining. Replaced
  with the shared import.

### Cross-cutting fix: missing `key` prop on main list table rows
Three of the five large events list pages had their primary data-table row
— the one rendered once per booking inside `.map()` — missing a `key`
prop entirely:
- `admin/src/pages/events/Catering.js`
- `admin/src/pages/events/PreBookings.js`
- `admin/src/pages/events/Reservations.js`

This is the same class of bug fixed earlier in `Categories.js`, but here it
sits on the main, most-frequently-re-rendered table in each of these pages
(re-sorted, re-filtered, and re-paginated constantly), so it's a more
impactful instance of the same root issue: without a stable key, React can
misattribute DOM state across rows when the underlying list changes order or
length — for example, a tooltip or hover state staying attached to the wrong
row after a sort. Added `key={item.id}` to each. `Celebrations.js` already
had this correct; `Events.js`'s flagged instance turned out to be a static
single total-row, not part of a list, so no key was needed there. Verified
via a full second sweep that no other `.map()`-rendered table row in the
admin panel is missing a key (4 other candidates found were all
section-header rows already covered by a keyed parent `React.Fragment`).

### admin/src/pages/events/Celebrations.js
- **Fixed a duplicate-`className` bug on the guest-name cell.** The inner
  clickable name span had two `className` attributes on the same element —
  `className="evt-clb-name"` followed immediately by a stray
  `key={item.id} className="evt-clb-row clickable"`. In JSX, the second
  attribute silently wins, so every guest name in the celebrations table was
  rendered with the *table row's* class name (`evt-clb-row`) instead of its
  intended `evt-clb-name` styling — a real, visible styling regression on
  every row. Also removed the stray `key` prop, which was meaningless here
  (the actual list key correctly lives on the parent `<tr>`). Fixed to a
  single, correct `className="evt-clb-name clickable"`.

### admin/src/pages/events/Reservations.js, PreBookings.js, Catering.js
- Removed redundant, unnecessary `key` props on inner `<span>` elements
  inside each row (e.g. `<span key={item.id} className="...">`). These
  elements aren't themselves produced by a `.map()` — the real, correct list
  key already lives on the parent `<tr>` — so the inner `key` did nothing
  except add noise. Confirmed harmless to remove (no duplicate-className
  side effect here, unlike the similar-looking `Celebrations.js` bug above).

### admin/src/pages/events/PreBookings.js
- **Fixed a missing form field**: the "Add PreBooking" modal had a section
  labeled "Source" that actually rendered Status buttons (Pending/Confirmed)
  — the real `SOURCE_OPTIONS` constant (Phone/WhatsApp/In Person/User App)
  was declared but never rendered anywhere in the component. Effect: every
  pre-booking created through this modal was silently saved with
  `source: "Phone"` (the form's default) regardless of how the booking was
  actually made, with no way for staff to correct it. Added the missing
  Source picker alongside the existing (correctly-functioning, just
  mislabeled) Status picker, matching the working "Source & Status" pattern
  already used in `Reservations.js` and `Celebrations.js`.

### admin/src/pages/events/Events.js — 🔴 Critical UX/safety fix
- **The "Delete" button on an event card deleted the event with zero
  confirmation.** The codebase already had a complete, correctly-built
  delete-confirmation flow for events — a `confirmDeleteId` state, a proper
  "Are you sure? All associated bookings will also be removed." modal, and a
  `confirmDelete()` function with optimistic update + rollback-on-failure
  and cleanup of the event's bookings. But the Delete button was wired to a
  separate, simpler `handleDelete(evt.id)` that ran immediately on click —
  bypassing the confirmation modal entirely, and without the bookings
  cleanup or rollback safety net. **One misclick permanently deleted an
  event with no warning.** Fixed the button to call
  `setConfirmDeleteId(evt.id)`, which correctly opens the existing
  confirmation modal. Removed `handleDelete`, now fully unreachable —
  `confirmDelete` covers everything it did and more.
- Confirmed the regular (non-specialized) "Create New Event" form is fully
  built and correctly wired for *editing* existing events, but there's no
  button anywhere in the UI that opens it in *create* mode — `setShowForm(true)`
  is only ever called from `openEdit()`. The only "Create Event" button on
  the page opens the specialized-event form instead. Not changed (this may
  be intentional — perhaps regular events are meant to be seeded directly
  rather than created via this UI) but flagged below for your awareness.

---

## Frontend — Admin Panel — Ingredients & Stock

### admin/src/pages/Ingredients.js
- **Fixed a latent data-integrity bug in `handleSave()`.** The "edit
  ingredient" code path generates `id: isEditMode ? formData.id :
  generateIngredientId(...)` — previously it called
  `generateIngredientId(...)` unconditionally, even in edit mode. Since the
  save then does `PUT /ingredients/{payload.id}`, and the server's generic
  PUT route upserts when no document matches that id, this would have
  created a brand-new duplicate ingredient document on every edit instead of
  updating the original — leaving the original orphaned in the database.
  **In practice this specific form is currently add-only** — nothing in this
  file ever calls `setIsEditMode(true)`, so `isEditMode` is always `false`
  here and the buggy branch was unreachable (the real, working edit flow
  lives in `IngredientDetails.js`, which already preserved the id
  correctly). Fixing it here removes a landmine for if/when this modal gets
  wired up for inline editing, which the "Edit Ingredient" title and "Save
  Changes" button text suggest was the intent.
- Removed a duplicate `toast.error("Failed to delete ingredient")` call that
  fired twice in the delete-failure rollback path.

### admin/src/pages/Stocks.js
- **Fixed the "Disabled In" column silently missing dishes that live under a
  subcategory.** `getDisabledLabel()` only checked `category.dishes` when
  resolving which dish names to display for a partially-disabled ingredient
  — it never looked inside `category.subCategories[].dishes`. Since most of
  your menu organizes dishes under subcategories rather than directly on the
  category, this meant the stock page's disabled-dish indicator showed "—"
  (nothing) for the majority of cases where an ingredient actually was
  disabled for one or more specific dishes. Fixed to flatten both locations,
  matching the already-correct equivalent logic in `IngredientDetails.js`.
- Removed an empty, content-less `<label></label>` left over in the Edit
  Stock modal — visually a no-op, but dead markup.

---

## Frontend — Admin Panel — Kitchen & Service Operations

### admin/src/pages/kitchen/KitchenMise.js, admin/src/pages/service/ServiceMise.js
- **Fixed a real save-failure rollback bug, found identically in both
  files.** The mise-en-place verification checkbox optimistically updates
  local state, then saves to the server. On failure, the `catch` block was
  supposed to roll the UI back to the pre-toggle state — but it mistakenly
  re-applied the *same failed update* (`updated`) instead of the original
  (`prevData`). Effect: if a save failed (network blip, server hiccup), the
  checkbox stayed visually checked/verified even though the database never
  actually recorded it — a silent mismatch between what staff see on screen
  and what's actually saved, with only a toast (easy to miss) as the only
  sign anything went wrong. Found by comparing against the sibling
  `KitchenGrooming.js`, which has the same optimistic-update pattern but
  correctly captures and rolls back to `prevData`. Fixed both to match.
  Confirmed via a full codebase sweep that no other file has this pattern.

### admin/src/pages/kitchen/KitchenRecipe.js, admin/src/pages/staffs/StaffCareer.js
- **Fixed an id type mismatch that silently broke deletion for newly created
  records, found identically in both files.** New recipes and career
  postings were created with `id: Date.now()` — a JavaScript *number* — but
  every existing id in your database (confirmed against `db.json`) is
  stored as a *string* (e.g. `"1773947787821"`). The server's delete route
  does an exact-match Mongo query, `findOneAndDelete({ id: req.params.id })`,
  where `req.params.id` is always a string (URL params are always strings in
  Express). A document whose `id` field is the JS number `1773947787821`
  will never match a query for the string `"1773947787821"` — so any recipe
  or career posting created through these forms could be added successfully
  but **never deleted again**, always failing with a silent 404 caught by
  the error toast. Fixed both to generate `id: String(Date.now())`. Scanned
  the rest of the codebase for the same pattern — every other id-generation
  site already uses a template literal (e.g. `` `offer_${Date.now()}` ``),
  which produces a string automatically, so no other instances exist.

### admin/src/pages/kitchen/KitchenReports.js — 🔴 Permanently broken widget fixed
- **The "Mise en Place" report widget has been showing nothing since the app
  moved to per-area collection naming.** This file destructured `mise` from
  `adminData` and used it for the "today's tasks" report. But `mise` is a
  separate, *legacy* collection — its most recent entry is from 19 May —
  while the actual live collection `KitchenMise.js` reads and writes is
  `kitchenMise` (currently up to date). Since the report logic only ever
  looks at *today's* date, and `mise` will never have a current entry again
  (nothing writes to it anymore), this widget has been silently empty for as
  long as the app has used the `kitchenMise` naming. Fixed the destructure to
  read the live `kitchenMise` collection instead. Checked the equivalent
  `ServiceReports.js` for the same mistake — it already correctly reads
  `serviceMise`, so this was isolated to the kitchen reports page.

### Cross-cutting fix: Export button crashed/did nothing on 6 pages — 🔴 Critical
- **Found a serious naming-collision bug repeated in 6 files.** Each one
  imports the shared `exportToExcel` utility, then separately declares its
  own *local* function also named `exportToExcel` to build that page's
  specific row data before calling the shared one. In JavaScript, that local
  declaration shadows the import for the rest of the file — so the line
  meant to call the shared utility (`exportToExcel({ rows, sheetName,
  fileName })`) was actually calling **itself**, recursively, with the wrong
  signature. Clicking "Export" on any of these pages would either throw
  "Maximum call stack size exceeded" or otherwise fail silently — in no
  case would it ever actually produce a spreadsheet.
  - `admin/src/pages/kitchen/KitchenSchedules.js`
  - `admin/src/pages/service/ServiceSchedules.js`
  - `admin/src/pages/events/PreBookings.js`
  - `admin/src/pages/events/Celebrations.js`
  - `admin/src/pages/events/Catering.js`
  - `admin/src/pages/events/Reservations.js`

  Fixed by renaming each local wrapper function to `handleExport`, leaving
  the actual shared `exportToExcel` import and call untouched. Confirmed via
  a full codebase scan that no other file has a local declaration shadowing
  any of its own imports — these 6 were the only instances.

### admin/src/pages/kitchen/KitchenSchedules.js — data-loss risk fixed
- **Fixed a riskier-than-necessary "move expired schedules" routine.** On
  every page load, this deleted *every* schedule (including still-valid
  upcoming ones), then re-created the upcoming ones via fresh `POST` calls,
  archiving only the truly expired ones. If the re-creation step failed
  partway through — a network blip, the server restarting — upcoming,
  still-valid schedules would be permanently lost, since they'd already
  been deleted but never successfully recreated. The sibling
  `ServiceSchedules.js` has a meaningfully safer version of the same
  routine: it only ever deletes the genuinely expired items, never touches
  upcoming records, and tracks per-item success so a partial failure can't
  silently lose data. Replaced `KitchenSchedules.js`'s version with that
  safer pattern.

### admin/src/pages/service/ServiceSchedules.js
- Removed a duplicate `toast.error("Failed to add schedule...")` call that
  fired twice in a row in the add-schedule failure path.

### admin/src/pages/service/TableManagement.js
- **Made the table QR code URL configurable instead of a hardcoded
  production domain.** `getQRValue()` always pointed every generated,
  displayed, and exported QR code at `https://samcafe.vercel.app`,
  regardless of where the user-facing panel is actually deployed (local
  dev, a different host, a future domain change). Changed to read
  `process.env.REACT_APP_USER_PANEL_URL`, falling back to the original
  Vercel URL so current behavior is unchanged unless you set the env var.

---

## Frontend — Admin Panel — Staff Management

### admin/src/pages/staffs/Staffs.js — 🔴 Critical data-integrity bug
- **Editing an existing staff member created a brand-new duplicate record
  instead of updating the original — and this one is live and reachable**
  (unlike the similar-looking but dormant cases found earlier in
  `Ingredients.js` and `Dishes.js`). `handleSave()` generated a fresh
  `id: generateStaffId(formData.name)` unconditionally, even when editing
  (`isEditMode === true`, set by the working Edit button on this page).
  Since `updateStaff(id, payload)` does `PUT /staff/{id}` using that
  freshly-generated id, and no document matches a brand-new id, the server
  upserts a new document — leaving the **original** staff record (with all
  its attendance, salary, training, and grooming history attached)
  completely untouched and orphaned, with a disconnected duplicate now
  sitting alongside it. Fixed to preserve `formData.id` when editing,
  matching the same fix already applied to `Ingredients.js`. Checked your
  current `db.json` for any staff name duplicates this might have already
  caused — none found, so this hadn't bitten you yet, but it would have on
  the next staff edit.

### admin/src/pages/staffs/StaffCareer.js
- Fixed an index-based `key={i}` on the career-posting cards with the
  stable `key={job.id}` instead — index keys risk React reconciliation bugs
  when cards are added or removed. (Caught and fixed a related slip in my
  own first pass at this fix, where removing the index parameter broke the
  ribbon-number display that also depended on it — restored the index
  parameter for the numbering while keeping `job.id` as the actual key.)

### admin/src/pages/staffs/StaffAttendance.js
- **Fixed an invalid toast method call.** The auto-mark-absent failure
  handler called `toast.warn(...)`, but only `toast.warning(...)` exists on
  the shared toast API — `warn` would throw `TypeError: toast.warn is not a
  function` inside the catch block, silently swallowing the very error
  message it was meant to surface. Fixed to `toast.warning(...)` with the
  correct single-message argument signature.

### admin/src/pages/staffs/Staffs.js (additional fixes)
- Fixed a missing `key` prop on the main staff table row — same class of
  bug as `Categories.js` and the events list pages.
- Fixed a copy-paste typo in the staff preview modal: the "Date of Joining"
  row showed `₹{formData.joiningDate}` — a rupee symbol prepended to a date,
  clearly copied from the Salary row directly below it.

---

# Part 2: User Panel (samcafe) Fix Log

This continues directly from the backend + admin panel sweep above. Same
approach throughout: read every file, fix confirmed real bugs, remove
confirmed dead code, flag anything that needs a product decision rather
than guessing.

---

## Shared / foundational files

### samcafe/src/Untitled-1.txt
- Deleted. A 1.6MB stray scratch/draft data dump sitting inside `src/`,
  not imported anywhere. Dead weight in the repo.

### src/index.js
- Removed dead `<ToastContainer />` import and render — same no-op pattern
  already fixed in the admin panel's `index.js`. The real toast container
  renders inline inside `ToastProvider` in `Usetoast.js`.

### src/components/PrinterReceipt.js
- Fixed invalid HTML: the receipt's item-table header row (`<th>` cells)
  was placed directly inside `<tbody>` instead of `<thead>`.

### src/components/placeOrder.js
- Made the KOT print-bridge URL configurable instead of hardcoded
  (`process.env.REACT_APP_PRINT_SERVER_URL`, same fix already made in the
  admin panel's `Orders.js` for bill printing).

### src/UserPanel/shared/normalizeBagItem.js
- Fixed an operator-precedence bug: `Array.isArray(...) ? ... : null || {}`
  only applied the `{}` fallback when `category.dishes` wasn't an array at
  all — if it *was* an array but `.find()` didn't locate the dish in it,
  the result was `undefined` instead of `{}`, which would throw on the
  `dish.basePrice` / `dish.name` accesses right after. Traced every current
  call site and none currently hits this narrow case, but hardened it
  since it's a real, cheap-to-fix fragility.

### src/UserPanel/shared/CloseButton.js
- Fixed a copy-paste `alt="home-btn"` on the close icon → `alt="close"`.

## src/UserPanel pages

### src/UserPanel/IngredientDetail.js
- Removed a dead, unguarded destructure (`const { kcal, protein, fat,
  fibre } = ingredient.nutritionPer100g`) — none of these were used; the
  render reads the same values via the safely-optional-chained
  `ingredient.nutritionPer100g?.[key]` instead. The removed line would also
  have thrown if `nutritionPer100g` were ever missing, unlike the guarded
  access used everywhere else this field is read.

### src/UserPanel/FavouriteCategories.js, FavouriteDishList.js — real, live bug
- **Favourited dishes from a subcategory-organized menu section could
  disappear from (or show a wrong title on) the Favourites page.** Both
  files looked up a favourited dish's category via
  `foodData.categories.find(c => c.id === dish.categoryId)` — a top-level-
  only search. But dishes (and therefore favourites) commonly carry a
  *subcategory* id as their `categoryId`, not the parent category's id.
  Confirmed this is live in your actual data: a real user has a "Cold
  Coffee" dish favourited, and `cold_coffee` is a subcategory under
  `beverages`, not a top-level category.
  - In `FavouriteCategories.js`, this meant the category card for any such
    group **never rendered at all** — `.find()` returned `undefined`,
    `.filter(Boolean)` silently dropped it, so favourited cold-coffee
    drinks were invisible in the grouped category view.
  - In `FavouriteDishList.js` (the page those cards link to), the dishes
    still rendered correctly (a separate, direct filter), but the page
    title fell back to the generic "Favourites" instead of "Cold Coffee".
  Both fixed with a shared `findCategoryOrSubCategory` helper that checks
  subcategories too.
- `FavouriteDishList.js`: replaced a native `alert()` on the delete-failure
  path with the existing, working toast system (`useToast` /
  `components/Usetoast.js`) — consistent with how errors are surfaced
  everywhere else in this panel.

### src/UserPanel/FloatingBag.js — important UX fix
- **Order-placement failures were completely silent.** If `placeOrder(bag)`
  threw (network error, server error, anything), the catch block only
  logged to the console — no toast, no message, nothing visible. The user
  would click "Place Order" and the bag sheet would just... stay open, with
  no indication anything went wrong. Added `toast.error(...)` so a failed
  order is actually communicated. This is the single most important
  user-facing action in the app, so getting failure feedback right here
  matters more than almost anywhere else in this panel.

### src/UserPanel/FavouriteCombo.js
- Replaced a native `alert()` on the delete-failure path with the toast
  system, same as `FavouriteDishList.js` above.

### src/UserPanel/FavouriteDishDetail.js — real bug
- **Fixed a categoryId mismatch when a favourited dish is found nested in a
  subcategory.** The category-resolution fallback tagged the dish with
  `categoryId: cat.id` (the *parent* category's id) instead of `sub.id`
  (the subcategory's own id) — the opposite of the convention used
  consistently elsewhere in this codebase (`OffersGrid.js`,
  `CateringForm.js`, `PreBooking.js` all correctly use `sub.id` for this
  exact case). This `categoryId` gets passed forward into the dish
  customize flow, where a wrong id could cause that flow to fail to
  re-locate the dish's actual subcategory container. Fixed to `sub.id`.

### src/UserPanel/ThankYou.js — dead code cleanup
- **Removed a large amount of confirmed-dead conditional logic.**
  `orderPlaced` was hardcoded to `true` and never changed — confirmed this
  page is only ever mounted at the single `/thank-you` route, only reached
  after a successful order via `FloatingBag.js`'s post-success navigation,
  so every `!orderPlaced` branch was permanently unreachable. This included
  a whole "empty bag, please add a dish" warning block, an Edit column on
  the order table (and the `handleEdit` function that powered it, now also
  fully unreachable), and a duplicate "Order Another" button. Also removed
  the `onOrderPlaced` prop, which was accepted but never actually called
  anywhere in the component. The page's behavior is unchanged — it always
  rendered the `orderPlaced === true` branch before, so removing the dead
  alternatives doesn't change what anyone sees.

### src/UserPanel/FoodCategory.js — flagged for your decision, not changed

**Four fully-built data sections are computed but never rendered anywhere
on the page.** `derivePopularDishes`, `deriveCrowdPicks`, `deriveEvents`,
and `deriveFavouriteCombos` are complete, working functions — not stubs —
that compute real data from your live `categories`/`orders`/`events`:
top-ordered dishes, unique-order "crowd pick" dishes, upcoming published
events, and most-ordered combo suggestions. All four are called in the
component's main `useEffect` and stored in state (`popularDishes`,
`crowdPicks`, `upcomingEvents`, `favouriteCombos`) — but none of those four
state variables are ever read in the JSX. Only `promoItems` (from
`derivePromoItems`) is actually rendered, via the `PromoCarousel` at the
top of the page. This looks like either genuinely abandoned feature work,
or sections that were built and then disconnected from the UI at some
point. Per your direction, left as-is — not deleted, not wired up. If you
want this resolved later: either remove the four dead derive-functions and
their state, or build the UI sections to actually display them (the data
shape for each is already in a render-ready format).

A smaller, related note: throughout this file, dishes nested inside a
subcategory are tagged with `_catId` set to the **parent** category's id
(never the subcategory's own id) when building navigation `categoryId`
values — a separate `_subId`/`subCategoryId` field is computed in two
places but never actually used. In the one place this currently matters
(`handlePromoClick` → `FoodListExpanded`), it doesn't cause a visible bug,
because `FoodListExpanded.js` has its own robust fallback dish-lookup that
finds the dish by id regardless of which category id it's given. Not
changed, since it isn't currently causing a problem, but worth knowing if
you ever build new navigation off `dish._catId` that lands on a page
without that same fallback robustness.

### src/UserPanel/FoodList.js
- **Hardened against a crash when a category/subcategory has zero dishes.**
  `visible[1]` (the actively-displayed dish) is computed via modulo
  indexing into `slides` (`category.dishes`); if `slides.length === 0`,
  this becomes `slides[NaN]` → `undefined`, and the very next lines
  (`visible[1].name`, `.basePrice`, `.description`, `.id`) would throw. Not
  currently live — checked your full category/subcategory list and none
  are currently empty — but it's a real risk the moment a new category or
  subcategory is created in the admin panel before any dishes are added to
  it. Extended the existing "category not found" guard to also catch the
  empty-dishes case, showing a clean "No dishes available" message instead
  of crashing.
- Traced this carefully end-to-end first: confirmed every current
  navigation path into this page (`FoodCategory.js` → flat categories only,
  `SubCategoryPage.js` → real subcategory ids) always passes a leaf-level
  id with actual dishes, so this was about hardening against a future data
  state, not an active bug today.

### src/UserPanel/Welcome.js — real bugs, first-impression page
- **`handleSignup` had no `catch` clause at all.** If account creation
  failed for any reason — network error, server error — the error
  propagated uncaught with zero feedback: no toast, not even a console
  log. The Sign Up button would just appear to silently do nothing. Added
  proper error handling with a toast message, consistent with the rest of
  the app.
- **The initial `/users` fetch (used to power login) only logged failures
  to the console.** If that background fetch failed silently on page load,
  a legitimate existing user trying to log in would see the misleading "No
  account exists with this mobile number" message — because `users` was
  empty, not because the account didn't exist. Added a toast so a failed
  connection is communicated honestly instead of masquerading as a bad
  phone number.
- Confirmed `handleLogin` itself doesn't need try/catch — it's pure
  client-side filtering against already-fetched state, no network call of
  its own.

### src/UserPanel/ReservationForm.js — real bug
- **Fixed a validation bug that contradicted the UI's own label.** The
  "Preferred Time" field is explicitly marked "(optional)" right next to
  it, but `validate()` set `e.time = "Pick a time"` unconditionally
  whenever it was empty — meaning a user who correctly left it blank (as
  the UI told them they could) would hit a confusing validation error
  blocking submission. This also meant the "date cannot be in the past"
  check was nested inside the time check and only ran when time was
  filled — though that check turns out to already be unreachable in
  practice, since `UserDatePicker`'s `min` prop prevents selecting a past
  date at the UI level in the first place. Fixed by removing the bogus
  required-time check and making the past-date check independent (kept as
  a defensive backstop even though the date picker already prevents it).

### src/UserPanel/FoodItem.js
- **Hardened against a confirmed-real data gap.** `category.dishes.find(...)`
  was called without a fallback. Checked your live `db.json`: 5 top-level
  categories (`starters`, `soups`, `beverages`, `desserts`, `sandwichs` —
  the ones that use subcategories) have **no `dishes` field at all**, not
  even an empty array. If `category` here ever resolves to one of those
  top-level objects rather than its subcategory, this would throw
  `Cannot read properties of undefined (reading 'find')`. Added the same
  `|| []` guard used everywhere else this field is read defensively. Traced
  every current navigation path into this page and didn't find one that
  currently triggers it, but given it's a real, confirmed gap in your data
  (not a hypothetical), it's worth fixing regardless of current reachability.
  Note: this is a data-shape inconsistency in `db.json` itself, not
  something fixable in this codebase — those 5 categories could have
  `dishes: []` added directly in MongoDB if you want the data fully
  consistent, though nothing currently depends on it being present.

### src/UserPanel/ComboPage.js
- **Fixed a real bug in the "save favourite combo" failure path.** On
  error, only `console.error` ran — no toast, and `setShowAddFavConfirm(false)`
  was only called on the success path, not in `finally`, so a failed save
  left the confirmation modal open with the loading state cleared and zero
  indication anything went wrong. Added a toast and properly close the
  modal on failure too.

## Remaining large UserPanel forms

### src/UserPanel/PreBooking.js
- Reviewed in full; no bugs found. Confirmed "Preferred Time" is correctly
  labeled and validated as required here (unlike `ReservationForm.js`,
  where it was mislabeled "(optional)" but enforced as required — see that
  entry above). Error handling already correctly surfaces failures inline
  via `errors._submit`, no silent-failure issue like other forms had.

### src/UserPanel/CelebrationForm.js
- Replaced a native `alert()` on the submit-failure path with the toast
  system, consistent with the rest of the app.
- Reviewed the rest of the file in full; the "Preferred Time" field here is
  also correctly labeled and validated as required, no mismatch.

### src/UserPanel/CateringForm.js
- Reviewed in full; no bugs found. Well-built, consistent error handling
  (`errors._submit` pattern), correct subcategory/event-food dish
  filtering, and correctly required/optional field labeling throughout.

### src/App.js
- Removed a debug `console.log("SYNC EVENT:", ...)` left in production
  code — fired on every single socket sync event. The admin panel codebase
  was confirmed completely free of leftover `console.log` calls during
  that sweep; this was the one inconsistency in samcafe.

### src/UserPanel/ComboPage.js — additional fix
- **Fixed a real staleness gap**: combo offer discount rules
  (`comboOfferRules`, fetched from `/combo_offers`) were only loaded once
  on mount, with no live refresh. If an admin updated combo pricing/
  discounts while a customer had this page open, they'd keep seeing the
  old rules until navigating away and back (remounting the component).
  Added a socket listener for `combo_offers` changes, matching the
  live-sync pattern already established elsewhere (`App.js`'s `fetchMenu`
  socket handler, the admin panel's equivalent patterns).

### src/App.js — real bug: duplicate ToastProvider
- **`ToastProvider` was wrapping the app twice** — once in `index.js`
  (`<ToastProvider><ToastProvider>` — sorry, `<ToastProvider><App /></ToastProvider>`)
  and a second, redundant time inside `App.js`'s own render output. Since
  React Context always resolves to the *nearest* ancestor `Provider`, every
  component calling `useToast()` was actually reading from the inner
  (App.js) provider — meaning the outer one in `index.js` was running a
  completely separate, unused toast state machine for no reason. Not a
  visible bug (toasts still worked correctly via the inner provider), but
  genuinely wasteful and confusing — `Usetoast.js`'s own header comment
  explicitly says to wrap the provider "once." Removed the redundant inner
  wrap and the now-unused import, keeping the single wrap in `index.js` as
  the documented setup location.

### src/App.js — additional fixes
- Removed the now-dead `onOrderPlaced` prop passed to `<ThankYou>` —
  `ThankYou.js` no longer accepts it after the dead-code cleanup documented
  above.
- **Fixed a real, live bug**: `<CelebrationForm>` never received a
  `navigateToCatering` prop, even though `CelebrationForm.js` calls
  `navigateToCatering()` directly when a user exceeds the 20-guest cap and
  clicks "use our Catering service →". Since the prop was `undefined`,
  `onClick={undefined}` is simply a no-op in React — no error, just a
  button that silently did nothing. Wired it up to navigate to
  `/events/catering`.
- Noted but not changed: `bag`/`setBag` are passed to `CelebrationForm`,
  `PreBooking`, and `CateringForm`, but none of the three actually use
  them. Harmless (React ignores unused props) and not worth touching three
  route definitions to trim props with zero functional effect.

### src/UserPanel/EventsPage.js — real bug
- **Fixed a wrong field name that broke phone pre-fill.** The event
  enrollment form pre-fills Name and Email from the logged-in user, but
  used `currentUser?.phone` for the phone field — every user record in
  this app stores the field as `mobile`, never `phone` (confirmed against
  `db.json` and consistent with how it's used correctly everywhere else in
  the codebase). `currentUser?.phone` was always `undefined`, so the Phone
  field never pre-filled, forcing every user to manually re-type a number
  they'd already given at signup. Fixed both occurrences (initial form
  state and the `openEnroll` reset) to read `currentUser?.mobile`.
- Otherwise reviewed in full — this is sophisticated, careful code with
  several documented prior bug fixes already in its own comments (stable-id
  patterns to avoid infinite re-render loops, a capacity-calculation fix).
  No other issues found.

---

## Summary

All 53 files in `samcafe/src` plus the two `components/`-level files have
been read and fixed where needed. Combined with the earlier backend +
admin panel pass, the full Sam Cafe codebase (`server.js`, `admin/`,
`samcafe/`) has now had a complete bug-hunt and cleanup sweep.

The most impactful fixes in this panel:

1. **`App.js`**: a button (`navigateToCatering`) that silently did nothing
   due to a missing prop — affects anyone who hits the 20-guest cap on the
   Celebration form.
2. **`FavouriteCategories.js` / `FavouriteDishList.js`**: a live bug where
   favourited dishes from subcategory-organized menu sections (confirmed
   real in your data — "Cold Coffee") could disappear or show a wrong
   title.
3. **`FloatingBag.js`**: order-placement failures were completely silent —
   now show a toast. This is the single most important action in the app.
4. **`Welcome.js`**: account creation had zero error handling at all; a
   misleading "no account exists" message could show after a failed
   background fetch.
5. **`ReservationForm.js`**: a validation bug that directly contradicted
   the UI's own "(optional)" label on the Preferred Time field.
6. **`EventsPage.js`**: a wrong field name (`phone` vs `mobile`) silently
   broke pre-filling the phone number for logged-in users.
7. **`App.js`**: a duplicate `ToastProvider` wrap (harmless but wasteful).
8. Three `alert()` calls replaced with the app's real toast system across
   `FavouriteDishList.js`, `FavouriteCombo.js`, `CelebrationForm.js`.

Flagged but not changed, per your direction: four fully-built data sections
in `FoodCategory.js` (Popular Dishes, Crowd Picks, Events, Favourite Combo
suggestions) that are computed but never rendered anywhere.
