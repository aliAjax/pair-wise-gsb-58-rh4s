import {
  seedAlerts,
  seedAuditLogs,
  seedCases,
  seedConclusions,
  seedEdges,
  seedEvidence,
  seedNodes,
} from "../data/seed";
import type {
  Alert,
  AuditLog,
  ConclusionVersion,
  Evidence,
  InvestigationCase,
  InvestigationEdge,
  InvestigationNode,
  PendingEntityMerge,
  SharedEntity,
  SharedEntityKind,
} from "../models/types";

export interface MockDatabase {
  schemaVersion: number;
  revision: number;
  alerts: Alert[];
  cases: InvestigationCase[];
  nodes: InvestigationNode[];
  edges: InvestigationEdge[];
  evidence: Evidence[];
  conclusions: ConclusionVersion[];
  entities: SharedEntity[];
  pendingMerges: PendingEntityMerge[];
  auditLogs: AuditLog[];
}

export const SCHEMA_VERSION = 2;
export const ENTITY_HISTORY_LIMIT = 20;

const STORAGE_KEY = "bank-fraud-investigation-db-v1";
const BACKUP_KEY = `${STORAGE_KEY}:backup`;

export class MockWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MockWriteError";
  }
}

export const createId = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export const nowIso = (): string => new Date().toISOString();

export const extractEntityIdentifier = (
  kind: SharedEntityKind,
  label: string,
): string => {
  const trimmed = label.trim();
  if (kind === "ip") {
    const match = trimmed.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
    return match ? match[0] : trimmed;
  }
  return trimmed.replace(/^设备\s*/i, "").trim() || trimmed;
};

const appendMigrationAudit = (
  database: MockDatabase,
  log: Omit<AuditLog, "id" | "at">,
): void => {
  database.auditLogs.unshift({
    id: createId("LOG"),
    at: nowIso(),
    ...log,
  });
};

/**
 * 旧版本（v1）数据里设备 / IP 节点按案件各存一份。迁移时按设备号或 IP 归并：
 * 属性一致的重复节点合并为一个共享实体；属性冲突、无法自动确认的列入待核清单，
 * 由调查员确认后再归并。
 */
const migrateDatabase = (raw: Partial<MockDatabase>): MockDatabase => {
  const database: MockDatabase = {
    schemaVersion: SCHEMA_VERSION,
    revision: typeof raw.revision === "number" ? raw.revision : 1,
    alerts: raw.alerts ?? [],
    cases: raw.cases ?? [],
    nodes: raw.nodes ?? [],
    edges: raw.edges ?? [],
    evidence: raw.evidence ?? [],
    conclusions: raw.conclusions ?? [],
    entities: raw.entities ?? [],
    pendingMerges: raw.pendingMerges ?? [],
    auditLogs: raw.auditLogs ?? [],
  };

  const alreadyCurrent =
    (raw.schemaVersion ?? 1) >= SCHEMA_VERSION && Array.isArray(raw.entities);
  if (alreadyCurrent) {
    return database;
  }

  const groups = new Map<string, InvestigationNode[]>();
  database.nodes.forEach((node) => {
    if (node.entityId) {
      return;
    }
    if (node.data.kind !== "device" && node.data.kind !== "ip") {
      return;
    }
    const identifier = extractEntityIdentifier(node.data.kind, node.data.label);
    const key = `${node.data.kind}:${identifier}`;
    groups.set(key, [...(groups.get(key) ?? []), node]);
  });

  groups.forEach((members, key) => {
    const [kind, identifier] = key.split(/:(.*)/) as [SharedEntityKind, string];
    const first = members[0];
    const consistent = members.every(
      (member) =>
        member.data.riskLevel === first.data.riskLevel &&
        member.data.evidenceStrength === first.data.evidenceStrength,
    );

    if (members.length > 1 && !consistent) {
      database.pendingMerges.push({
        id: createId("PM"),
        kind,
        identifier,
        nodeIds: members.map((member) => member.id),
        caseIds: Array.from(new Set(members.map((member) => member.caseId))),
        reason: "各案件登记的风险等级或证据强度不一致，无法自动确认。",
        createdAt: nowIso(),
      });
      appendMigrationAudit(database, {
        actor: "系统",
        action: "实体待核",
        detail: `${kind === "device" ? "设备" : "IP"} ${identifier} 在 ${members.length} 个案件中属性不一致，已列入待核清单。`,
      });
      return;
    }

    const latest = [...members].sort(
      (a, b) => Date.parse(b.data.occurredAt) - Date.parse(a.data.occurredAt),
    )[0];
    const entity: SharedEntity = {
      id: createId("ENT"),
      kind,
      identifier,
      label: latest.data.label,
      riskLevel: latest.data.riskLevel,
      note: latest.data.note,
      evidenceStrength: latest.data.evidenceStrength,
      source: latest.data.source,
      occurredAt: latest.data.occurredAt,
      version: 1,
      updatedAt: nowIso(),
      updatedBy: "系统迁移",
      history: [
        {
          version: 1,
          at: nowIso(),
          by: "系统迁移",
          action: "migrate",
          snapshot: {
            label: latest.data.label,
            riskLevel: latest.data.riskLevel,
            note: latest.data.note,
            evidenceStrength: latest.data.evidenceStrength,
            source: latest.data.source,
            occurredAt: latest.data.occurredAt,
          },
          note:
            members.length > 1
              ? `按${kind === "device" ? "设备号" : " IP "}归并 ${members.length} 个重复节点。`
              : "迁移为共享实体。",
        },
      ],
    };
    database.entities.push(entity);
    members.forEach((member) => {
      member.entityId = entity.id;
    });

    if (members.length > 1) {
      appendMigrationAudit(database, {
        actor: "系统",
        action: "实体归并",
        detail: `${kind === "device" ? "设备" : "IP"} ${identifier} 的 ${members.length} 个重复节点已归并为共享实体 V1。`,
        entityId: entity.id,
        entityVersion: entity.version,
      });
    }
  });

  return database;
};

const createSeedDatabase = (): MockDatabase =>
  migrateDatabase({
    schemaVersion: 1,
    alerts: structuredClone(seedAlerts),
    cases: structuredClone(seedCases),
    nodes: structuredClone(seedNodes),
    edges: structuredClone(seedEdges),
    evidence: structuredClone(seedEvidence),
    conclusions: structuredClone(seedConclusions),
    auditLogs: structuredClone(seedAuditLogs),
  });

const parseDatabase = (payload: string): MockDatabase | null => {
  try {
    return migrateDatabase(JSON.parse(payload) as Partial<MockDatabase>);
  } catch {
    return null;
  }
};

const restoreFromBackup = (): MockDatabase | null => {
  if (typeof window === "undefined") {
    return null;
  }
  const backup = window.localStorage.getItem(BACKUP_KEY);
  if (!backup) {
    return null;
  }
  const restored = parseDatabase(backup);
  if (restored) {
    try {
      window.localStorage.setItem(STORAGE_KEY, backup);
    } catch {
      // 主键恢复失败时仍返回内存中的完整版本，界面可继续使用。
    }
  }
  return restored;
};

export const readDatabase = (): MockDatabase => {
  if (typeof window === "undefined") {
    return createSeedDatabase();
  }

  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      const raw = JSON.parse(stored) as Partial<MockDatabase>;
      const needsMigration = (raw.schemaVersion ?? 1) < SCHEMA_VERSION;
      const parsed = migrateDatabase(raw);
      if (needsMigration) {
        persistSilently(parsed);
      }
      return parsed;
    } catch {
      // 主数据损坏：优先从最近一个完整备份恢复，而不是直接重置。
      const restored = restoreFromBackup();
      if (restored) {
        return restored;
      }
      const seeded = createSeedDatabase();
      persistSilently(seeded);
      return seeded;
    }
  }

  const restored = restoreFromBackup();
  if (restored) {
    return restored;
  }
  const seeded = createSeedDatabase();
  persistSilently(seeded);
  return seeded;
};

const persistSilently = (database: MockDatabase): void => {
  try {
    writeDatabase(database);
  } catch {
    // 读取路径上的持久化失败不阻塞使用，下一次写入会重试。
  }
};

export const writeDatabase = (database: MockDatabase): void => {
  if (typeof window === "undefined") {
    return;
  }
  const next: MockDatabase = {
    ...database,
    schemaVersion: SCHEMA_VERSION,
    revision: (database.revision ?? 0) + 1,
  };
  const payload = JSON.stringify(next);

  // 演示与测试钩子：在控制台设置 window.__mockFailNextWrite = true 可模拟一次写入失败。
  const failNext = (window as unknown as Record<string, unknown>)
    .__mockFailNextWrite;
  if (failNext) {
    delete (window as unknown as Record<string, unknown>).__mockFailNextWrite;
    restoreFromBackup();
    throw new MockWriteError(
      "写入失败，已恢复到最近一个完整版本，请基于该版本重试。",
    );
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, payload);
  } catch {
    restoreFromBackup();
    throw new MockWriteError(
      "写入失败，已恢复到最近一个完整版本，请基于该版本重试。",
    );
  }

  try {
    window.localStorage.setItem(BACKUP_KEY, payload);
  } catch {
    // 备份失败不影响本次提交，下一次成功写入会刷新备份。
  }

  database.revision = next.revision;
  database.schemaVersion = next.schemaVersion;
};

export const resetDatabase = (): MockDatabase => {
  const seeded = createSeedDatabase();
  writeDatabase(seeded);
  return seeded;
};

export const appendAudit = (
  database: MockDatabase,
  log: Omit<AuditLog, "id" | "at">,
): void => {
  database.auditLogs.unshift({
    id: createId("LOG"),
    at: nowIso(),
    ...log,
  });
};
