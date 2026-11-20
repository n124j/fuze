import { z } from "zod";
import type { ToolSpec } from "../llm/types.js";
import type { MemoryStore } from "../memory/store.js";

export interface ToolContext {
  approved: boolean;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: object;
  /** A tool that acts outward (sends mail, posts) must set this; it will not run without approval. */
  needsApproval: boolean;
  run(input: unknown, ctx: ToolContext): Promise<string>;
}

export class ApprovalRequiredError extends Error {
  constructor(public readonly tool: string) {
    super(`tool "${tool}" needs the owner's approval before it can run`);
    this.name = "ApprovalRequiredError";
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`);
    this.tools.set(tool.name, tool);
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  /**
   * Run a tool. Throws ApprovalRequiredError for an unapproved needsApproval tool;
   * any other problem comes back as an "Error: ..." string for the model to read.
   */
  async execute(name: string, input: unknown, ctx: ToolContext): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) return `Error: unknown tool "${name}"`;
    if (tool.needsApproval && !ctx.approved) throw new ApprovalRequiredError(name);
    try {
      return await tool.run(input, ctx);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

const preferenceInput = z.object({ key: z.string().min(1), value: z.string().min(1) });
const factInput = z.object({ fact: z.string().min(1) });
const noteInput = z.object({ note: z.string().min(1) });

export function registerMemoryTools(reg: ToolRegistry, mem: MemoryStore): void {
  reg.register({
    name: "memory_set_preference",
    description:
      "Save or update one of the owner's stable preferences (for example meeting times). Updating an existing key replaces it.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, value: { type: "string" } },
      required: ["key", "value"],
      additionalProperties: false,
    },
    needsApproval: false,
    async run(input) {
      const { key, value } = preferenceInput.parse(input);
      mem.setProfileEntry(key, value);
      return `Saved preference: ${key} = ${value}`;
    },
  });

  reg.register({
    name: "memory_remember",
    description: "Save an important decision or fact worth remembering long term.",
    inputSchema: {
      type: "object",
      properties: { fact: { type: "string" } },
      required: ["fact"],
      additionalProperties: false,
    },
    needsApproval: false,
    async run(input) {
      mem.appendLongTerm(factInput.parse(input).fact);
      return "Saved to long-term memory.";
    },
  });

  reg.register({
    name: "memory_note",
    description: "Add a short note about today's activity to the daily log.",
    inputSchema: {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
      additionalProperties: false,
    },
    needsApproval: false,
    async run(input) {
      mem.appendDaily(noteInput.parse(input).note);
      return "Added to today's notes.";
    },
  });
}
