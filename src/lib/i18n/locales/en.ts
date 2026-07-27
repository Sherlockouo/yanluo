// Aggregator: merges all English namespace files.
// Each ./en/<ns>.ts exports a flat record whose keys are prefixed "<ns>.".

import { agent } from "./en/agent";
import { common } from "./en/common";
import { draft } from "./en/draft";
import { history } from "./en/history";
import { home } from "./en/home";
import { hud } from "./en/hud";
import { learn } from "./en/learn";
import { nav } from "./en/nav";
import { onboarding } from "./en/onboarding";
import { settings } from "./en/settings";
import { toast } from "./en/toast";
import { transcribe } from "./en/transcribe";
import { translate } from "./en/translate";
import { vocab } from "./en/vocab";

export const en: Record<string, string> = {
  ...agent,
  ...common,
  ...draft,
  ...history,
  ...home,
  ...hud,
  ...learn,
  ...nav,
  ...onboarding,
  ...settings,
  ...toast,
  ...transcribe,
  ...translate,
  ...vocab,
};
