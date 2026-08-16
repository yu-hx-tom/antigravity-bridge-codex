import fsSync from "node:fs";
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
            : "Original provider is preserved natively in local database",
        };
      }),
      migration: {
        enabled: false,
        experimental: true,
        reason: "Provider migration is intentionally disabled to preserve database authenticity",
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

export async function syncThreadProvider(codexHome, targetProvider) {
  const databasePath = path.join(path.resolve(codexHome), "state_5.sqlite");
  if (!fsSync.existsSync(databasePath)) return 0;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(databasePath);
    const result = db.prepare("UPDATE threads SET model_provider = ?").run(targetProvider);
    db.close();
    return result.changes;
  } catch (error) {
    return 0;
  }
}

export async function cleanForeignReasoningItems(sessionsDir) {
  let cleanedCount = 0;
  let totalRemoved = 0;
  try {
    const list = await fs.readdir(sessionsDir);
    for (const item of list) {
      const full = path.join(sessionsDir, item);
      try {
        const stat = await fs.stat(full);
        if (stat.isDirectory()) {
          const res = await cleanForeignReasoningItems(full);
          cleanedCount += res.cleanedCount;
          totalRemoved += res.totalRemoved;
        } else if (item.endsWith(".jsonl")) {
          const content = await fs.readFile(full, "utf8");
          if (content.includes("rs_resp_") || content.includes("cpa-gemini")) {
            const lines = content.split("\n").filter(Boolean);
            const beforeLen = lines.length;
            const cleaned = lines.filter((l) => !l.includes("rs_resp_") && !l.includes("cpa-gemini"));
            const diff = beforeLen - cleaned.length;
            if (diff > 0) {
              await fs.writeFile(full, cleaned.join("\n") + "\n", "utf8");
              cleanedCount++;
              totalRemoved += diff;
            }
          }
        }
      } catch {}
    }
  } catch {}
  return { cleanedCount, totalRemoved };
}
