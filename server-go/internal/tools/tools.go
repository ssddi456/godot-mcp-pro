// Package tools loads the tool catalog (modes -> resolved tools) that the
// Node build pipeline writes to tools.json after `tsc`. The JSON is embedded
// at compile time so the Go binary is fully self-contained.
package tools

import (
	"embed"
	"encoding/json"
	"fmt"
)

//go:embed tools.json
var toolsFS embed.FS

// JSONSchema mirrors server/src/tools/types.ts JsonSchema.
type JSONSchema struct {
	Type                 string         `json:"type"`
	Properties           map[string]any `json:"properties"`
	Required             []string       `json:"required,omitempty"`
	AdditionalProperties any            `json:"additionalProperties,omitempty"`
}

// ResolvedTool mirrors server/src/tools/types.ts ResolvedTool.
type ResolvedTool struct {
	Name        string     `json:"name"`
	Category    string     `json:"category"`
	Description string     `json:"description"`
	InputSchema JSONSchema `json:"inputSchema"`
}

// Catalog is the lookup of mode -> tool list.
type Catalog struct {
	byMode map[string][]ResolvedTool
	byName map[string]ResolvedTool
}

// Load reads and parses the embedded tools.json.
func Load() (*Catalog, error) {
	data, err := toolsFS.ReadFile("tools.json")
	if err != nil {
		return nil, fmt.Errorf("read embedded tools.json: %w", err)
	}
	raw := map[string][]ResolvedTool{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("parse tools.json: %w", err)
	}

	byName := map[string]ResolvedTool{}
	for _, tool := range raw["full"] {
		byName[tool.Name] = tool
	}
	return &Catalog{byMode: raw, byName: byName}, nil
}

// ForMode returns the tool slice for the given mode, falling back to "full"
// if the mode is unknown.
func (c *Catalog) ForMode(mode string) []ResolvedTool {
	if tools, ok := c.byMode[mode]; ok {
		return tools
	}
	return c.byMode["full"]
}

// Has reports whether a tool exists in the full catalog.
func (c *Catalog) Has(name string) bool {
	_, ok := c.byName[name]
	return ok
}

// Count returns the number of tools in the full catalog.
func (c *Catalog) Count() int { return len(c.byName) }

// ValidModes returns the modes that are present in the catalog.
func (c *Catalog) ValidModes() []string {
	out := make([]string, 0, len(c.byMode))
	for mode := range c.byMode {
		out = append(out, mode)
	}
	return out
}
