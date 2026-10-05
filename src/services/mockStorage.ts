import {
  seedAlerts,
  seedAuditLogs,
  seedCases,
  seedConclusions,
  seedEdges,
  seedEvidence,
  seedNodes,
} from "../data/seed";
import {
  appendAudit,
  createId,
  nowIso,
  SCHEMA_VERSION,
  type LegacyMockDatabase,
  type MockDatabase,
} from "./database";
import { migrateLegacyDatabase } from "./migration";

const STORAGE_KEY = "bank-fraud-investigation-db";
const LEGACY_STORAGE_KEY = "bank-fraud-investigation-db-v1";
const JOURNAL_KEY = "bank-fraud-investigation-db-journal";

interface WriteJournal {
  savedAt: string;
  snapshot: MockDatabase;
}

/** 演示数据保持旧版（v1）形态，首次读取时经由迁移生成共享实体记录。 */
const createLegacySeedDatabase = (): LegacyMockDatabase => ({
  schemaVersion: 1,
  alerts: structuredClone(seedAlerts),
  cases: structuredClone(seedCases),
  nodes: structuredClone(seedNodes),
  edges: structuredClone(seedEdges),
  evidence: structuredClone(seedEvidence),
  conclusions: structuredClone(seedConclusions),
  auditLogs: structuredClone(seedAuditLogs),
});

const persistRaw = (key: string, value: unknown): void => {
  window.localStorage.setItem(key, JSON.stringify(value));
};

/**
 * 原子提交：先把完整版本写入日志键，再写主库，最后清理日志。
 * 主库写入失败时日志保留，下次打开可从完整版本恢复。
 */
export const commitDatabase = (database: MockDatabase): void => {
  if (typeof window === "undefined") {
    return;
  }
  persistRaw(JOURNAL_KEY, {
    savedAt: nowIso(),
    snapshot: database,
  } satisfies WriteJournal);
  try {
    persistRaw(STORAGE_KEY, database);
    window.localStorage.removeItem(JOURNAL_KEY);
  } catch (error) {
    // 主库写入失败：保留日志，等待恢复
    throw error;
  }
};

/** 发现上次写入中断的日志时，从完整版本恢复主库。 */
const recoverFromJournal = (): MockDatabase | undefined => {
  const raw = window.localStorage.getItem(JOURNAL_KEY);
  if (!raw) {
    return undefined;
  }
  try {
    const journal = JSON.parse(raw) as WriteJournal;
    if (journal?.snapshot?.schemaVersion !== SCHEMA_VERSION) {
      window.localStorage.removeItem(JOURNAL_KEY);
      return undefined;
    }
    persistRaw(STORAGE_KEY, journal.snapshot);
    window.localStorage.removeItem(JOURNAL_KEY);
    appendAudit(journal.snapshot, {
      actor: "系统",
      action: "写入恢复",
      detail: `检测到 ${journal.savedAt} 的未完成写入，已从完整版本恢复。`,
    });
    persistRaw(STORAGE_KEY, journal.snapshot);
    return journal.snapshot;
  } catch {
    window.localStorage.removeItem(JOURNAL_KEY);
    return undefined;
  }
};

export const readDatabase = (): MockDatabase => {
  if (typeof window === "undefined") {
    return migrateLegacyDatabase(createLegacySeedDatabase());
  }

  const recovered = recoverFromJournal();
  if (recovered) {
    return recovered;
  }

  const raw =
    window.localStorage.getItem(STORAGE_KEY) ??
    window.localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!raw) {
    const seeded = migrateLegacyDatabase(createLegacySeedDatabase());
    commitDatabase(seeded);
    return seeded;
  }

  try {
    const parsed = JSON.parse(raw) as MockDatabase | LegacyMockDatabase;
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      // 旧数据首次打开：先迁移重复节点再使用
      const migrated = migrateLegacyDatabase(parsed as LegacyMockDatabase);
      commitDatabase(migrated);
      return migrated;
    }
    return parsed as MockDatabase;
  } catch {
    const seeded = migrateLegacyDatabase(createLegacySeedDatabase());
    commitDatabase(seeded);
    return seeded;
  }
};

export const resetDatabase = (): MockDatabase => {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(JOURNAL_KEY);
  }
  const seeded = migrateLegacyDatabase(createLegacySeedDatabase());
  commitDatabase(seeded);
  return seeded;
};

export { appendAudit, createId, nowIso };
export type { LegacyMockDatabase, MockDatabase };
