// Aggregator: merges all Chinese namespace files (mirror of en.ts).

import { agent } from "./zh/agent";
import { common } from "./zh/common";
import { draft } from "./zh/draft";
import { history } from "./zh/history";
import { home } from "./zh/home";
import { hud } from "./zh/hud";
import { learn } from "./zh/learn";
import { nav } from "./zh/nav";
import { onboarding } from "./zh/onboarding";
import { settings } from "./zh/settings";
import { toast } from "./zh/toast";
import { transcribe } from "./zh/transcribe";
import { translate } from "./zh/translate";
import { vocab } from "./zh/vocab";

export const zh: Record<string, string> = {
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
