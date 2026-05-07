// Curated descriptions for tools. Any tool not listed here gets a generic
// description derived from its name + category. Schemas (parameter types) come
// from the GDScript scanner (generated.ts) — overrides here can extend or
// refine them when the auto-detected types are too loose.

import type { JsonSchema } from "./types.js";

export interface ToolOverride {
  description?: string;
  /** Schema fragments merged on top of the auto-generated schema. */
  schema?: Partial<JsonSchema>;
}

export const TOOL_OVERRIDES: Record<string, ToolOverride> = {
  // ---- project ----
  get_project_info: {
    description:
      "Get Godot project metadata: name, version, viewport size, renderer, main scene, and registered autoloads.",
  },
  get_filesystem_tree: {
    description:
      "Recursively list project files starting at `path` (default `res://`). Supports glob `filter` (e.g. `*.gd`) and `max_depth`.",
  },
  search_files: {
    description: "Fuzzy/glob file name search across the project.",
  },
  search_in_files: {
    description: "Search file contents for a pattern across the project.",
  },
  get_project_settings: {
    description: "Read one or more values from project.godot.",
  },
  set_project_setting: {
    description: "Set a project.godot setting. Persists to disk.",
  },
  uid_to_project_path: { description: "Convert a Godot UID (`uid://...`) to a `res://` path." },
  project_path_to_uid: { description: "Convert a `res://` path to its UID (`uid://...`)." },
  add_autoload: { description: "Register a script as a project autoload (singleton)." },
  remove_autoload: { description: "Remove an autoload singleton from project settings." },

  // ---- scene ----
  get_scene_tree: {
    description: "Get the live scene tree (currently edited scene) as a JSON hierarchy.",
  },
  get_scene_file_content: { description: "Read the raw .tscn text content of a scene file." },
  create_scene: {
    description: "Create a new scene file with the given root node type.",
  },
  open_scene: { description: "Open a scene in the Godot editor." },
  delete_scene: { description: "Delete a .tscn file (and its .import sidecar)." },
  add_scene_instance: { description: "Instance a packed scene as a child of `parent_path`." },
  play_scene: {
    description:
      'Play the project. `mode` may be "main" (project main scene), "current" (currently edited), or a `res://` path.',
  },
  stop_scene: { description: "Stop the currently running game/scene." },
  save_scene: { description: "Save the currently edited scene to disk." },
  get_scene_exports: {
    description: "Inspect @export properties of every scripted node in a scene file.",
  },

  // ---- node ----
  add_node: {
    description:
      "Add a new node of `type` under `parent_path`. Optional `properties` dict initializes properties (smart type parsing for Vector2, Color, etc.).",
  },
  delete_node: { description: "Delete a node from the edited scene (with undo)." },
  duplicate_node: { description: "Duplicate a node and its children." },
  move_node: { description: "Move/reparent a node to a new parent path." },
  update_property: {
    description:
      "Set a property on a node. Values support smart parsing: `Vector2(1,2)`, `Color(1,0,0)`, `#ff0000`, `Rect2(...)`, etc.",
  },
  get_node_properties: { description: "Get all properties of a node, including inherited ones." },
  add_resource: { description: "Attach a resource (Shape, Material, Texture …) to a node property." },
  set_anchor_preset: { description: "Set a Control's anchor preset (PRESET_*)." },
  rename_node: { description: "Rename a node in the edited scene." },
  connect_signal: { description: "Connect a signal between two nodes." },
  disconnect_signal: { description: "Disconnect a signal connection." },
  get_node_groups: { description: "Get the groups a node belongs to." },
  set_node_groups: { description: "Replace the group membership of a node." },
  find_nodes_in_group: { description: "Find all nodes that belong to a given group." },

  // ---- script ----
  list_scripts: { description: "List all script files in the project with class info." },
  read_script: { description: "Read the contents of a script file." },
  create_script: { description: "Create a new script (GDScript or C#) with optional template." },
  edit_script: {
    description: "Edit a script — supports either full content replacement or search/replace.",
  },
  attach_script: { description: "Attach an existing script to a node in the edited scene." },
  get_open_scripts: { description: "List scripts currently open in the editor's script tabs." },
  validate_script: { description: "Validate GDScript syntax of a file." },

  // ---- editor ----
  get_editor_errors: {
    description: "Get recent errors and stack traces from the editor's debugger/output.",
  },
  get_editor_screenshot: {
    description: "Capture a screenshot of the editor viewport. Returns a base64 PNG.",
  },
  get_game_screenshot: {
    description: "Capture a screenshot of the running game viewport. Returns a base64 PNG.",
  },
  execute_editor_script: {
    description:
      "Execute arbitrary GDScript in the editor process. Useful for one-off tasks. Use with care.",
  },
  clear_output: { description: "Clear the editor's output panel." },
  get_signals: { description: "Get all signals defined on a node and their connections." },
  reload_plugin: { description: "Reload the MCP plugin (will auto-reconnect)." },
  reload_project: { description: "Rescan the filesystem and reload scripts." },
  get_output_log: { description: "Get the editor output panel content." },

  // ---- input ----
  simulate_key: { description: "Simulate a keyboard key press/release in the running game." },
  simulate_mouse_click: { description: "Simulate a mouse click at a screen position." },
  simulate_mouse_move: { description: "Simulate mouse movement to a screen position." },
  simulate_action: { description: "Simulate a Godot Input Action (press/release)." },
  simulate_sequence: {
    description: "Send a sequence of input events with frame delays between them.",
  },
  get_input_actions: { description: "List all defined input actions and their bindings." },
  set_input_action: { description: "Create or modify an input action and its bindings." },

  // ---- runtime ----
  get_game_scene_tree: { description: "Get the scene tree of the currently running game." },
  get_game_node_properties: { description: "Get properties of a node in the running game." },
  set_game_node_property: { description: "Set a property on a node in the running game." },
  execute_game_script: { description: "Run GDScript inside the running game's context." },
  capture_frames: { description: "Capture multiple consecutive frames as screenshots." },
  monitor_properties: { description: "Record the values of one or more properties over time." },
  start_recording: { description: "Start recording user input in the running game." },
  stop_recording: { description: "Stop the active input recording." },
  replay_recording: { description: "Replay a previously recorded input sequence." },
  find_nodes_by_script: { description: "Find game nodes attached to a given script." },
  get_autoload: { description: "Inspect an autoload singleton's properties." },
  batch_get_properties: { description: "Get the same set of properties from many nodes at once." },
  find_ui_elements: { description: "Find Control nodes (buttons, labels, …) in the running game." },
  click_button_by_text: { description: "Find and click a Button by its visible text." },
  wait_for_node: { description: "Wait until a node appears in the running game (with timeout)." },
  find_nearby_nodes: { description: "Find nodes within a radius of a position in the running game." },
  navigate_to: { description: "Navigate an agent to a target position via the navigation system." },
  move_to: { description: "Walk a CharacterBody to a target position." },

  // ---- profiling ----
  get_performance_monitors: {
    description: "Get all performance monitors (FPS, memory, draw calls, physics, …).",
  },
  get_editor_performance: { description: "Get a quick summary of editor performance." },

  // ---- shader ----
  create_shader: { description: "Create a .gdshader file with an optional template." },
  read_shader: { description: "Read the contents of a shader file." },
  edit_shader: { description: "Edit a shader file — full or search/replace." },
  assign_shader_material: { description: "Assign a ShaderMaterial to a node." },
  set_shader_param: { description: "Set a shader uniform parameter." },
  get_shader_params: { description: "Get all uniform parameters of a shader." },

  // ---- export ----
  list_export_presets: { description: "List configured export presets." },
  export_project: { description: "Get the godot CLI command to export a preset." },
  get_export_info: { description: "Get export-related info (templates installed, presets, …)." },

  // ---- testing ----
  run_test_scenario: { description: "Run an automated test scenario script." },
  assert_node_state: { description: "Assert that node properties match expected values." },
  assert_screen_text: { description: "Assert that text is visible on screen." },
  compare_screenshots: { description: "Compare two screenshots and return diff info." },
  run_stress_test: { description: "Run a performance stress test." },
  get_test_report: { description: "Get the latest test results report." },
};

/** Build a description for a tool that has no override. */
export function fallbackDescription(name: string, category: string): string {
  const verb = name.split("_")[0];
  const subject = name.split("_").slice(1).join(" ") || category;
  return `${capitalize(verb)} ${subject} — ${category} tool. See README "All Tools" for details.`;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
