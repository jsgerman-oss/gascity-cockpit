// Public surface of the shared city-presentation helpers (cockpit-1ll.16).
//
// Every pane that renders cities — the Fleet tree (`../status`), the Beads
// explorer (`../beads`, `../views`), and the chat city-picker (`../chat`) —
// imports from here so a city reads the same everywhere. Stays `vscode`-free.
export {
  CITY_PLACEHOLDER,
  cityStatusKind,
  cityStatusText,
  type CityStatusKind,
} from "./presentation.ts";
