/**
 * sessionVocabulary — the single source for the non-model vocabularies a Claude
 * Code session can be configured with: permission modes and thinking effort.
 *
 * WHY A PLAIN MODULE, not a constant on TopBar.jsx:
 * these lists had been copied into FOUR files (TopBar, shell/Inspector,
 * NewSessionDialog, Settings ▸ Defaults) and two of the copies had silently
 * drifted — Inspector labelled `acceptEdits` "Auto-edit" and ordered `plan`
 * last, and NewSessionDialog offered only four of the six effort levels while
 * its comment claimed it mirrored TopBar. Adding a level in one place left other
 * surfaces quietly disagreeing about what a session can be.
 *
 * The first fix exported them from TopBar.jsx, and that immediately proved the
 * point in the other direction: a test that module-mocked TopBar (a heavy UI
 * component) starved Inspector of its vocabulary, and hand-listing fixture
 * values in the mock would have re-created the very duplication the export
 * exists to delete. So the definitions live here, where a consumer can import
 * them without dragging a React tree — the same shape `modelCatalog.js` already
 * has for the model list.
 *
 * TopBar.jsx re-exports both names unchanged, so existing imports keep working
 * (see the note there). New consumers should import from this module.
 */

/**
 * The CANONICAL permission-mode vocabulary.
 *
 * Ids are the wire values Claude Code's `--permission-mode` accepts — do not
 * "tidy" them, and do not add one without checking pty_manager accepts it.
 *
 * Labels and order are settled: `acceptEdits` reads "Accept Edits" (it tracks
 * the id, which keeps it legible next to a transcript or a `--permission-mode`
 * flag) and `plan` sits second. Inspector previously rendered "Auto-edit" with
 * `plan` last; that was resolved in favour of this list, because a setting that
 * changes its name depending on which panel you are looking at costs more than
 * the four characters saved.
 *
 * Consumers needing a `value` key instead of `id` should map at their own usage
 * site — `PERMISSION_MODES.map(({ id, label }) => ({ value: id, label }))` —
 * rather than forking the list.
 */
export const PERMISSION_MODES = [
  { id: "default", label: "Ask" },
  { id: "plan", label: "Plan" },
  { id: "acceptEdits", label: "Accept Edits" },
  { id: "bypassPermissions", label: "Bypass" },
];

/**
 * The CANONICAL thinking-effort vocabulary. All six levels, in ascending order.
 *
 * Auto's id MUST be the empty string, not "auto". It mirrors App.jsx's effort
 * state (initialised to "" and persisted to localStorage key "cockpit-effort")
 * and pty_manager.py's _ALLOWED_EFFORT_LEVELS, which RAISES ValueError on
 * anything outside {"", "low", "medium", "high", "xhigh", "max"}. A friendlier
 * "auto" string here would break session creation for the rest of the
 * workspace's life — it survives restart and there is no recovery UI. The empty
 * string is meaningful, not a missing value.
 *
 * A consumer that renders a SUBSET of these is a bug, not a preference: it shows
 * a menu that misrepresents what a session can be. NewSessionDialog shipped
 * without `xhigh` and `max` for exactly that reason.
 */
export const EFFORT_OPTIONS = [
  { id: "", label: "Auto" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "XHigh" },
  { id: "max", label: "Max" },
];

/**
 * Resolve a stored vocabulary id to something safe to DISPLAY.
 *
 * The same defect the model pill carried for weeks (R-169: `modelList.find(...)
 * || modelList[0]` rendered "Opus 5" while the session spawned `sonnet`) applies
 * verbatim to these lists, and it is NOT hypothetical here. `pty_manager.py`'s
 * _ALLOWED_PERMISSION_MODES accepts `auto` and `dontAsk`; PERMISSION_MODES above
 * lists neither. A workspace holding `cockpit-permission-mode: "auto"` therefore
 * rendered "Ask" — the FIRST entry — while every session it launched carried
 * "auto". Same shape, one vocabulary over, and these values all come from
 * localStorage, which survives restart and has no recovery UI.
 *
 * So: `|| options[0]` is banned for a SET value. An unrecognised id is returned
 * AS ITSELF with `known: false`, and the caller flags it. An EMPTY id is a
 * genuine "nothing chosen" and still resolves to the first option — that is what
 * EFFORT_OPTIONS' `{ id: "" }` entry means, and it is a real choice, not a miss.
 */
export function resolveVocabChoice(id, options) {
  const option = options.find((o) => o.id === id);
  if (option) return { option, label: option.label, known: true };
  // "" (and null/undefined) are unset, not unrecognised — no lie is possible.
  if (!id) return { option: options[0], label: options[0].label, known: true };
  return { option: null, label: id, known: false };
}
