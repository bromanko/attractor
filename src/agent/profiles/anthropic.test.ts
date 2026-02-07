/**
 * Tests for the Anthropic agent provider profile.
 */

import { describe, it, expect } from "vitest";
import { AnthropicProfile } from "./anthropic.js";
import type { ExecutionEnvironment } from "../types.js";

function mockEnv(): ExecutionEnvironment {
  return {
    read_file: async () => "",
    write_file: async () => {},
    file_exists: async () => false,
    list_directory: async () => [],
    exec_command: async () => ({ stdout: "", stderr: "", exit_code: 0, timed_out: false, duration_ms: 0 }),
    grep: async () => "",
    glob: async () => [],
    working_directory: () => "/home/user/project",
    platform: () => "linux",
  };
}

describe("AnthropicProfile", () => {
  it("has correct defaults", () => {
    const profile = new AnthropicProfile();
    expect(profile.id).toBe("anthropic");
    expect(profile.model).toBe("claude-sonnet-4-5");
    expect(profile.context_window_size).toBe(200_000);
    expect(profile.supports_reasoning).toBe(true);
    expect(profile.supports_streaming).toBe(true);
  });

  it("accepts model override", () => {
    const profile = new AnthropicProfile({ model: "claude-opus-4-6" });
    expect(profile.model).toBe("claude-opus-4-6");
  });

  it("registers all core tools", () => {
    const profile = new AnthropicProfile();
    const defs = profile.tools();
    const names = defs.map((d) => d.name);

    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("edit_file");
    expect(names).toContain("shell");
    expect(names).toContain("grep");
    expect(names).toContain("glob");
  });

  it("registers extra tools", () => {
    const profile = new AnthropicProfile({
      extraTools: [
        {
          definition: {
            name: "custom_tool",
            description: "A custom tool",
            parameters: { type: "object" },
          },
          executor: async () => "result",
        },
      ],
    });

    const names = profile.tools().map((d) => d.name);
    expect(names).toContain("custom_tool");
    expect(names).toContain("read_file"); // core tools still present
  });

  it("builds system prompt with environment info", () => {
    const profile = new AnthropicProfile();
    const prompt = profile.build_system_prompt(mockEnv());

    expect(prompt).toContain("expert coding assistant");
    expect(prompt).toContain("/home/user/project");
    expect(prompt).toContain("linux");
  });

  it("includes extra system prompt", () => {
    const profile = new AnthropicProfile({
      extraSystemPrompt: "Always write tests first.",
    });
    const prompt = profile.build_system_prompt(mockEnv());
    expect(prompt).toContain("Always write tests first.");
  });

  it("includes project docs in system prompt", () => {
    const profile = new AnthropicProfile();
    const prompt = profile.build_system_prompt(mockEnv(), "# My Project\nA cool app.");
    expect(prompt).toContain("# My Project");
    expect(prompt).toContain("A cool app.");
  });
});
