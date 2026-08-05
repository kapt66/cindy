import { promises as fs } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  BundleMaterializeError,
  resolvePathInsideRoot,
} from './capability-bundle-store.js';

/** A Skill exposed by one immutable Cindy Meka runtime bundle. */
export interface CapabilityMcpSkillEntry {
  packId: string;
  skillId: string;
  name: string;
  description: string;
  /** Path to SKILL.md relative to snapshotRoot. */
  relPath: string;
}
export interface CapabilityMcpServerOptions {
  snapshotRoot: string;
  entries: readonly CapabilityMcpSkillEntry[];
  onSkillRead?: (
    skill: Pick<CapabilityMcpSkillEntry, 'packId' | 'skillId'>,
  ) => void | Promise<void>;
}

const DESCRIPTION_LIST =
  "List the skills available in the current immutable capability snapshot. " +
  "Use packId and skillId with read_skill before following a skill workflow.";

const DESCRIPTION_READ =
  "Read the complete SKILL.md for one skill in the current immutable capability snapshot. " +
  "Only skills returned by list_skills can be read.";

function skillKey(packId: string, skillId: string): string {
  return JSON.stringify([packId, skillId]);
}

function compareEntries(
  left: CapabilityMcpSkillEntry,
  right: CapabilityMcpSkillEntry,
): number {
  if (left.packId < right.packId) return -1;
  if (left.packId > right.packId) return 1;
  if (left.skillId < right.skillId) return -1;
  if (left.skillId > right.skillId) return 1;
  return 0;
}

function textResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    ...(isError ? { isError: true as const } : {}),
  };
}

/**
 * Create the session-scoped managed-runtime skill reader.
 *
 * The host passes a materialized snapshot root and its entries. Tool callers
 * choose only the opaque (packId, skillId) pair; they never supply a path.
 * Before reading, the resolved entry path is constrained to snapshotRoot with
 * lexical and symlink-aware checks.
 */
export function createCapabilityMcpServer(
  options: CapabilityMcpServerOptions,
): McpServer {
  // Capture the host-owned array and objects at construction time so a later
  // mutation cannot make list_skills and read_skill observe different views.
  const entries = options.entries
    .map((item) => ({ ...item }))
    .sort(compareEntries);
  const byId = new Map<string, CapabilityMcpSkillEntry>();
  for (const item of entries) {
    const key = skillKey(item.packId, item.skillId);
    if (byId.has(key)) {
      throw new Error(
        `duplicate capability skill: ${item.packId}/${item.skillId}`,
      );
    }
    byId.set(key, item);
  }

  const server = new McpServer({
    name: "lizi_capabilities",
    version: "1.0.0",
  });

  server.tool("list_skills", DESCRIPTION_LIST, {}, async () =>
    textResult({
      ok: true,
      skills: entries.map(({ name, description, packId, skillId }) => ({
        name,
        description,
        packId,
        skillId,
      })),
    }),
  );

  server.tool(
    "read_skill",
    DESCRIPTION_READ,
    {
      packId: z.string().min(1).describe("Capability pack id from list_skills"),
      skillId: z.string().min(1).describe("Skill id from list_skills"),
    },
    async ({ packId, skillId }) => {
      const item = byId.get(skillKey(packId, skillId));
      if (!item) {
        return textResult(
          {
            ok: false,
            errorCode: "SKILL_NOT_FOUND",
            data: { packId, skillId },
          },
          true,
        );
      }

      let skillPath: string;
      try {
        skillPath = await resolvePathInsideRoot(
          options.snapshotRoot,
          item.relPath,
        );
      } catch (error) {
        if (error instanceof BundleMaterializeError) {
          return textResult(
            {
              ok: false,
              errorCode: "PATH_NOT_ALLOWED",
              data: { packId, skillId, message: error.message },
            },
            true,
          );
        }
        throw error;
      }

      try {
        const content = await fs.readFile(skillPath, "utf8");
        await options.onSkillRead?.({ packId, skillId });
        return textResult({
          ok: true,
          skill: { packId, skillId, name: item.name, content },
        });
      } catch (error) {
        return textResult(
          {
            ok: false,
            errorCode: "SKILL_READ_FAILED",
            data: {
              packId,
              skillId,
              message: error instanceof Error ? error.message : String(error),
            },
          },
          true,
        );
      }
    },
  );

  return server;
}

/**
 * Create the process-global Codex bridge facade.
 *
 * The facade advertises the stable capability tool surface during MCP
 * initialization. The desktop bridge intercepts both calls and forwards them
 * to the exact revision server selected by the Codex thread context. These
 * fallback handlers are fail-closed in case a call reaches the facade without
 * revision routing.
 */
export function createCapabilityBridgeMcpServer(): McpServer {
  const server = new McpServer({
    name: "lizi_capabilities",
    version: "1.0.0",
  });

  const unavailable = async () =>
    textResult(
      {
        ok: false,
        errorCode: "SKILL_UNAVAILABLE",
      },
      true,
    );

  server.tool("list_skills", DESCRIPTION_LIST, {}, unavailable);
  server.tool(
    "read_skill",
    DESCRIPTION_READ,
    {
      packId: z.string().min(1).describe("Capability pack id from list_skills"),
      skillId: z.string().min(1).describe("Skill id from list_skills"),
    },
    unavailable,
  );

  return server;
}
