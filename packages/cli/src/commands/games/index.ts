/**
 * sentry games
 *
 * Small games to play in the terminal.
 */

import { buildRouteMap } from "../../lib/route-map.js";
import { topLevelBrief } from "../../top-level-briefs.js";
import { leaderboardCommand } from "./leaderboard.js";
import { snakeCommand } from "./snake.js";

export const gamesRoute = buildRouteMap({
  routes: {
    leaderboard: leaderboardCommand,
    snake: snakeCommand,
  },
  docs: {
    brief: topLevelBrief("games"),
    fullDescription: "Small games to play in your terminal while you wait.",
  },
});
