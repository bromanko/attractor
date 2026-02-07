import { describe, it, expect } from "vitest";
import { parseStylesheet, applyStylesheet } from "./stylesheet.js";
import { parseDot } from "./dot-parser.js";

describe("Model Stylesheet", () => {
  it("parses universal, class, and ID selectors", () => {
    const rules = parseStylesheet(`
      * { llm_model: claude-sonnet-4-5; llm_provider: anthropic; }
      .code { llm_model: claude-opus-4-6; }
      #critical_review { llm_model: gpt-5.2; reasoning_effort: high; }
    `);

    expect(rules).toHaveLength(3);
    expect(rules[0].selector.type).toBe("universal");
    expect(rules[1].selector.type).toBe("class");
    expect(rules[2].selector.type).toBe("id");
  });

  it("applies stylesheet to nodes by specificity", () => {
    const graph = parseDot(`
      digraph Test {
        graph [
          goal="Test",
          model_stylesheet="
            * { llm_model: claude-sonnet-4-5; llm_provider: anthropic; }
            .code { llm_model: claude-opus-4-6; }
            #critical { llm_model: gpt-5.2; llm_provider: openai; }
          "
        ]
        start [shape=Mdiamond]
        exit [shape=Msquare]
        plan [shape=box, class="planning"]
        implement [shape=box, class="code"]
        critical [shape=box, class="code"]
        start -> plan -> implement -> critical -> exit
      }
    `);

    applyStylesheet(graph);

    const plan = graph.nodes.find((n) => n.id === "plan")!;
    const implement = graph.nodes.find((n) => n.id === "implement")!;
    const critical = graph.nodes.find((n) => n.id === "critical")!;

    // plan: universal rule (no .code match)
    expect(plan.attrs.llm_model).toBe("claude-sonnet-4-5");

    // implement: .code rule (higher specificity than *)
    expect(implement.attrs.llm_model).toBe("claude-opus-4-6");

    // critical: #critical rule (highest specificity)
    expect(critical.attrs.llm_model).toBe("gpt-5.2");
    expect(critical.attrs.llm_provider).toBe("openai");
  });

  it("explicit node attributes override stylesheet", () => {
    const graph = parseDot(`
      digraph Test {
        graph [model_stylesheet="* { llm_model: default; }"]
        start [shape=Mdiamond]
        exit [shape=Msquare]
        work [shape=box, llm_model="explicit-model"]
        start -> work -> exit
      }
    `);

    applyStylesheet(graph);

    const work = graph.nodes.find((n) => n.id === "work")!;
    expect(work.attrs.llm_model).toBe("explicit-model");
  });
});
