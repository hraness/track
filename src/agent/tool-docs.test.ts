import { describe, expect, test } from "bun:test";
import { AGENT_TOOLS } from "./tools.ts";
import { AGENT_TOOL_DOCS, toolDetails } from "./tool-docs.ts";
import { renderToolCatalog } from "./xcb-agent.ts";
import { CATALOG_BUDGET } from "./catalog-budget.ts";

describe("tool docs and the catalog budget", () => {
  test("every documented tool exists and its details add to the description", () => {
    const names = new Set(AGENT_TOOLS.map((tool) => tool.name));
    for (const [name, doc] of Object.entries(AGENT_TOOL_DOCS)) {
      expect(names.has(name)).toBe(true);
      const description = AGENT_TOOLS.find(
        (tool) => tool.name === name,
      )!.description;
      expect(doc.details!.length).toBeGreaterThan(description.length);
    }
    expect(toolDetails("set_time")).toContain("Piano Phase");
    expect(toolDetails("no_such_tool")).toBeUndefined();
  });

  test("catalog descriptions stay short", () => {
    for (const tool of AGENT_TOOLS)
      if (!tool.hidden)
        expect(tool.description.length).toBeLessThanOrEqual(400);
    expect(renderToolCatalog().length).toBeLessThan(CATALOG_BUDGET);
  });
});
