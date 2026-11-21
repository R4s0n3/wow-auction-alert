import type { Knowledge } from "../../src/knowledge/types.ts";
import { events } from "./events.ts";
import { items } from "./items.ts";
import { recipes } from "./recipes.ts";
import { rules } from "./rules.ts";

export const forever: Knowledge = { items, recipes, events, rules };
