// Mode definitions — which categories/tools belong to which preset.
//
// The README defines four modes:
//   - full     (default, all tools)
//   - 3d       (drops 2D-only categories like tilemap)
//   - lite     (80 tools — project, scene, node, script, editor, input, runtime, input_map)
//   - minimal  (35 tools — essential subset)
//
// We classify by category (the source-file group) and then layer per-tool
// inclusion lists for `minimal` since it cherry-picks individual tools.

import type { Mode, ToolMeta } from "./types.js";

/** Categories included in `lite` mode. */
const LITE_CATEGORIES = new Set<string>([
  "project",
  "scene",
  "node",
  "script",
  "editor",
  "input",
  "runtime",
  "input_map",
]);

/** Categories EXCLUDED in `3d` mode (2D-only / less useful for 3D workflows). */
const NON_3D_CATEGORIES = new Set<string>([
  "tilemap",
]);

/** Tool names included in `minimal` mode. */
const MINIMAL_TOOLS = new Set<string>([
  // project (3)
  "get_project_info",
  "get_filesystem_tree",
  "search_in_files",
  // scene (6)
  "get_scene_tree",
  "create_scene",
  "open_scene",
  "save_scene",
  "play_scene",
  "stop_scene",
  // node (6)
  "add_node",
  "delete_node",
  "rename_node",
  "move_node",
  "update_property",
  "get_node_properties",
  // script (5)
  "list_scripts",
  "read_script",
  "create_script",
  "edit_script",
  "attach_script",
  // editor (4)
  "get_editor_errors",
  "get_editor_screenshot",
  "execute_editor_script",
  "get_output_log",
  // input (3)
  "simulate_key",
  "simulate_mouse_click",
  "simulate_action",
  // runtime (8)
  "get_game_scene_tree",
  "get_game_node_properties",
  "set_game_node_property",
  "execute_game_script",
  "get_game_screenshot",
  "find_ui_elements",
  "click_button_by_text",
  "wait_for_node",
]);

export function selectTools(all: ToolMeta[], mode: Mode): ToolMeta[] {
  switch (mode) {
    case "full":
      return all.slice();
    case "3d":
      return all.filter((t) => !NON_3D_CATEGORIES.has(t.category));
    case "lite":
      return all.filter((t) => LITE_CATEGORIES.has(t.category));
    case "minimal":
      return all.filter((t) => MINIMAL_TOOLS.has(t.name));
    default: {
      const _exhaustive: never = mode;
      void _exhaustive;
      return all.slice();
    }
  }
}

export const ALL_MODES: readonly Mode[] = ["full", "3d", "lite", "minimal"] as const;
