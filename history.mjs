import fs from "node:fs/promises";
import path from "node:path";

export async function readHistoryInventory(codexHome, limit = 100) {
  const databasePath = path.join(path.resolve(codexHome), "state_5.sqlite");
  try {
    await fs.access(databasePath);
  } catch {
    return {
      available: false,
      databasePath,
      total: 0,
      tasks: [],
      migration: { enabled: false, experimental: true },
    };
  }

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return {
      available: false,
      reason: "This Node.js version does not provide read-only SQLite support",
      databasePath,
      total: 0,
      tasks: [],
      migration: { enabled: false, experimental: true },
    };
  }

  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database.prepare(`
      SELECT id, title, model_provider, model, archived, created_at, updated_at, history_mode
      FROM threads
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(safeLimit);
    const totals = database.prepare(`
      SELECT model_provider AS provider, COUNT(*) AS count
      FROM threads
      GROUP BY model_provider
      ORDER BY count DESC
    `).all();
    const total = totals.reduce((sum, row) => sum + Number(row.count || 0), 0);
    return {
      available: true,
      databasePath,
      total,
      providers: totals.map((row) => ({ provider: row.provider || "unknown", count: Number(row.count || 0) })),
      tasks: rows.map((row) => {
        const provider = row.model_provider || "unknown";
        const canContinue = provider === "antigravity_local";
        return {
          id: row.id,
          title: row.title || "Untitled task",
          provider,
          model: row.model || "not-recorded",
          archived: Boolean(row.archived),
          createdAt: row.created_at || null,
          updatedAt: row.updated_at || null,
          historyMode: row.history_mode || null,
          readOnly: !canContinue,
          canContinue,
          policy: canContinue
            ? "Created with Antigravity; continuation is allowed"
            : "Original provider is preserved; do not continue this task with Gemini",
        };
      }),
      migration: {
        enabled: false,
        experimental: true,
        reason: "Provider migration requires a separate full-backup experiment and is intentionally disabled",
      },
    };
  } catch (error) {
    return {
      available: false,
      reason: `History database could not be read: ${error.message}`,
      databasePath,
      total: 0,
      tasks: [],
      migration: { enabled: false, experimental: true },
    };
  } finally {
    database.close();
  }
}
