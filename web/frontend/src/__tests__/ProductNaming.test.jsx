import { describe, expect, it } from "vitest";
import { parse } from "@babel/parser";
import { THEMES } from "../themes/themeData.js";

const sources = import.meta.glob("../**/*.{js,jsx}", { query: "?raw", import: "default", eager: true });

function oldProductNames(source) {
  const ast = parse(source, { sourceType: "module", plugins: ["jsx"] });
  const matches = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    const text = node.type === "StringLiteral" || node.type === "JSXText"
      ? node.value : node.type === "TemplateElement" ? node.value.raw : null;
    if (typeof text === "string" && /\b(?:Cockpit|COCKPIT)\b/.test(text)) matches.push(text.trim());
    for (const [key, value] of Object.entries(node)) {
      if (key.includes("Comments") || key === "comments" || key === "loc") continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(ast);
  return matches;
}

describe("one user-facing product name", () => {
  it("rejects old product prose while allowing comments and compatibility identifiers", () => {
    expect(oldProductNames('// Cockpit comment\nconst x = "cockpit-blue"; const y = "COCKPIT_HOME";')).toEqual([]);
    expect(oldProductNames('const x = <div>Cockpit</div>; const y = "WELCOME TO COCKPIT";')).toHaveLength(2);
  });

  it("has no old product name in production strings or JSX text", () => {
    const violations = Object.entries(sources)
      .filter(([path]) => path.startsWith("../") && !path.includes("/__tests__/"))
      .flatMap(([path, source]) => oldProductNames(source).map((text) => `${path}: ${text}`));
    expect(violations).toEqual([]);
  });

  it("preserves the saved theme identifier", () => {
    expect(THEMES["cockpit-blue"].id).toBe("cockpit-blue");
    expect(THEMES["cockpit-blue"].label).toBe("Plexar Studio Blue");
  });
});
