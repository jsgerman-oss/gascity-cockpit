// Pure helpers for the "which city?" picker (PRD Story 2: multi-city switching).
//
// Chat used to ask for a city with a blind text box; with multiple cities under
// one supervisor that is guesswork. These order the supervisor's advertised
// cities for a QuickPick — running first, the workspace's own city floated to the
// top — and build each row's label. Kept vscode-free and unit-tested; the
// QuickPick wiring lives in `open-chat.ts`, which falls back to a text box when
// the list can't be fetched.
import { cityStatusText } from "../cities/index.ts";
import type { CityInfo } from "../api/index.ts";

/**
 * Order cities for the picker: running before stopped, the `preferred` city
 * (e.g. the open workspace folder) first among running, then alphabetical.
 * Returns a new array; does not mutate input.
 */
export function rankCitiesForPicker(cities: CityInfo[], preferred?: string): CityInfo[] {
  return [...cities].sort((a, b) => {
    const runningRank = Number(!a.running) - Number(!b.running);
    if (runningRank !== 0) return runningRank;
    if (preferred) {
      const preferredRank = Number(a.name !== preferred) - Number(b.name !== preferred);
      if (preferredRank !== 0) return preferredRank;
    }
    return a.name.localeCompare(b.name);
  });
}

/** A QuickPick-ready label for a city (label/description/detail + the name). */
export interface CityPickLabel {
  label: string;
  description: string;
  detail: string;
  name: string;
}

/** Build the picker label for one city. Pure. */
export function cityPickLabel(city: CityInfo): CityPickLabel {
  return {
    label: city.name,
    // The QuickPick row has room, so surface the error message inline.
    description: cityStatusText(city, { detail: true }),
    detail: city.path ?? "",
    name: city.name,
  };
}
