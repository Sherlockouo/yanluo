/** Shared first-run localStorage keys (keep imports acyclic). */

export const ONBOARD_STORAGE_KEY = "yanluo-onboarded";
export const TOUR_STORAGE_KEY = "yanluo-tour-done";
export const INTRO_STORAGE_KEY = "yanluo-intro-done";
export const TOUR_START_EVENT = "yanluo:start-tour";
export const INTRO_DONE_EVENT = "yanluo:intro-done";

export function readIntroDone(): boolean {
  try {
    return localStorage.getItem(INTRO_STORAGE_KEY) === "1";
  } catch {
    return true;
  }
}

export function markIntroDone() {
  try {
    localStorage.setItem(INTRO_STORAGE_KEY, "1");
  } catch {
    /* ignore */
  }
}

export function setTourActive(on: boolean) {
  try {
    if (on) document.documentElement.dataset.tour = "1";
    else delete document.documentElement.dataset.tour;
  } catch {
    /* ignore */
  }
}
