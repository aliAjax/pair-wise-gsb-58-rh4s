import type {
  EdgeKind,
  EntityAttributeField,
  GraphNodeData,
  NodeKind,
  SharedEntity,
  SharedRelation,
} from "../models/types";
import {
  appendAudit,
  createId,
  nowIso,
  SCHEMA_VERSION,
  type LegacyMockDatabase,
  type MockDatabase,
} from "./database";

const DEVICE_PATTERN = /\b(?:DV|ATM)-[A-Z0-9][A-Z0-9-]*/i;
const IP_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;

/**
 * 从名称与来源中提取归并键：设备取设备号，IP 取地址，
 * 账户与商户取规范化名称；无法确认时返回 undefined（列入待核）。
 */
export const canonicalKeyFor = (
  kind: NodeKind,
  label: string,
  source: string,
): string | undefined => {
  if (kind === "device") {
    const match = `${label} ${source}`.match(DEVICE_PATTERN);
    return match ? `device:${match[0].toUpperCase()}` : undefined;
  }
  if (kind === "ip") {
    const match = label.match(IP_PATTERN) ?? source.match(IP_PATTERN);
    if (!match) {
      return undefined;
    }
    const valid = match[0].split(".").every((octet) => Number(octet) <= 255);
    return valid ? `ip:${match[0]}` : undefined;
  }
  const normalized = label.trim();
  return normalized ? `${kind}:${normalized}` : undefined;
};

const strengthRank: Record<GraphNodeData["evidenceStrength"], number> = {
  strong: 3,
  medium: 2,
  weak: 1,
};

const riskRank = { high: 3, medium: 2, low: 1 } as const;

const ATTRIBUTE_FIELDS: EntityAttributeField[] = [
  "label",
  "riskLevel",
  "note",
  "evidenceStrength",
  "source",
  "occurredAt",
];

const autoPosition = (index: number): { x: number; y: number } => ({
  x: 120 + (index % 4) * 260,
  y: 140 + Math.floor(index / 4) * 180,
});

/**
 * 旧数据首次打开时执行迁移：
 * 1. 按设备号 / IP / 名称归并各案件重复保存的节点为共享实体；
 * 2. 关系按（源实体、目标实体、类型、名称）归并为共享关系，案件通过 caseIds 引用；
 * 3. 无法确认标识的节点列入待核，其关联关系一并搁置；
 * 4. 结论版本补上实体版本快照，迁移时刻视为已核对。
 */
export const migrateLegacyDatabase = (
  legacy: LegacyMockDatabase,
): MockDatabase => {
  const ranAt = nowIso();
  const database: MockDatabase = {
    schemaVersion: SCHEMA_VERSION,
    alerts: structuredClone(legacy.alerts),
    cases: structuredClone(legacy.cases),
    entities: [],
    relations: [],
    placements: [],
    evidence: structuredClone(legacy.evidence),
    conclusions: [],
    auditLogs: structuredClone(legacy.auditLogs),
    pendingEntities: [],
  };

  const entityByKey = new Map<string, SharedEntity>();
  const entityIdByNodeId = new Map<string, string>();
  let duplicateNodeCount = 0;

  // 1. 节点归并
  const pendingGroups = new Map<string, LegacyMockDatabase["nodes"]>();
  legacy.nodes.forEach((node) => {
    const key = canonicalKeyFor(node.data.kind, node.data.label, node.data.source);
    if (!key) {
      const groupKey = `${node.data.kind}:${node.data.label}`;
      const group = pendingGroups.get(groupKey) ?? [];
      group.push(node);
      pendingGroups.set(groupKey, group);
      return;
    }
    const existing = entityByKey.get(key);
    if (existing) {
      duplicateNodeCount += 1;
      existing.mergedFrom.push(node.id);
      // 归并冲突属性：证据强度取最高，风险取最高，关联时间取最早
      if (strengthRank[node.data.evidenceStrength] > strengthRank[existing.evidenceStrength]) {
        existing.evidenceStrength = node.data.evidenceStrength;
      }
      if (riskRank[node.data.riskLevel] > riskRank[existing.riskLevel]) {
        existing.riskLevel = node.data.riskLevel;
      }
      if (Date.parse(node.data.occurredAt) < Date.parse(existing.occurredAt)) {
        existing.occurredAt = node.data.occurredAt;
      }
      entityIdByNodeId.set(node.id, existing.id);
      return;
    }
    const entity: SharedEntity = {
      id: createId("ENT"),
      kind: node.data.kind,
      canonicalKey: key,
      label: node.data.label,
      riskLevel: node.data.riskLevel,
      note: node.data.note,
      evidenceStrength: node.data.evidenceStrength,
      source: node.data.source,
      occurredAt: node.data.occurredAt,
      version: 1,
      updatedAt: ranAt,
      updatedBy: "数据迁移",
      fieldStamps: Object.fromEntries(
        ATTRIBUTE_FIELDS.map((field) => [
          field,
          { version: 1, updatedBy: "数据迁移", updatedAt: ranAt },
        ]),
      ),
      mergedFrom: [node.id],
    };
    entityByKey.set(key, entity);
    database.entities.push(entity);
    entityIdByNodeId.set(node.id, entity.id);
  });

  // 2. 布局：每个案件只保留实体位置
  const placementKeys = new Set<string>();
  legacy.nodes.forEach((node) => {
    const entityId = entityIdByNodeId.get(node.id);
    if (!entityId) {
      return;
    }
    const placementKey = `${node.caseId}:${entityId}`;
    if (placementKeys.has(placementKey)) {
      return;
    }
    placementKeys.add(placementKey);
    database.placements.push({
      caseId: node.caseId,
      entityId,
      position: node.position,
    });
  });

  // 3. 关系归并
  const relationByKey = new Map<string, SharedRelation>();
  let droppedRelationCount = 0;
  legacy.edges.forEach((edge) => {
    const sourceEntityId = entityIdByNodeId.get(edge.source);
    const targetEntityId = entityIdByNodeId.get(edge.target);
    if (!sourceEntityId || !targetEntityId) {
      droppedRelationCount += 1;
      return;
    }
    const key = [sourceEntityId, targetEntityId, edge.kind, edge.label].join("|");
    const existing = relationByKey.get(key);
    if (existing) {
      if (!existing.caseIds.includes(edge.caseId)) {
        existing.caseIds.push(edge.caseId);
      }
      if (Date.parse(edge.occurredAt) < Date.parse(existing.occurredAt)) {
        existing.occurredAt = edge.occurredAt;
      }
      return;
    }
    const relation: SharedRelation = {
      id: createId("REL"),
      sourceEntityId,
      targetEntityId,
      kind: edge.kind as EdgeKind,
      label: edge.label,
      amount: edge.amount,
      occurredAt: edge.occurredAt,
      explanation: edge.explanation,
      caseIds: [edge.caseId],
      version: 1,
      updatedAt: ranAt,
      updatedBy: "数据迁移",
    };
    relationByKey.set(key, relation);
    database.relations.push(relation);
  });

  // 4. 关系引用到的案件若缺少端点布局，自动补一个位置
  database.relations.forEach((relation) => {
    relation.caseIds.forEach((caseId) => {
      [relation.sourceEntityId, relation.targetEntityId].forEach((entityId) => {
        const key = `${caseId}:${entityId}`;
        if (placementKeys.has(key)) {
          return;
        }
        placementKeys.add(key);
        const count = database.placements.filter((p) => p.caseId === caseId).length;
        database.placements.push({ caseId, entityId, position: autoPosition(count) });
      });
    });
  });

  // 5. 无法确认的节点列入待核
  pendingGroups.forEach((nodes) => {
    const first = nodes[0];
    const reason =
      first.data.kind === "device"
        ? "无法从名称或来源中确认设备号"
        : first.data.kind === "ip"
          ? "无法确认有效 IP 地址"
          : "缺少可归并的稳定标识";
    database.pendingEntities.push({
      id: createId("PEND"),
      kind: first.data.kind,
      label: first.data.label,
      reason,
      caseIds: Array.from(new Set(nodes.map((node) => node.caseId))),
      sourceNodeIds: nodes.map((node) => node.id),
      draft: { ...first.data },
      status: "pending",
      createdAt: ranAt,
    });
  });

  // 6. 结论版本补实体版本快照（迁移时刻视为已核对）
  database.conclusions = legacy.conclusions.map((conclusion) => {
    const snapshot: Record<string, number> = {};
    database.placements
      .filter((placement) => placement.caseId === conclusion.caseId)
      .forEach((placement) => {
        const entity = database.entities.find((item) => item.id === placement.entityId);
        if (entity) {
          snapshot[entity.id] = entity.version;
        }
      });
    return { ...conclusion, entityVersions: snapshot };
  });

  database.migration = {
    schemaVersion: SCHEMA_VERSION,
    ranAt,
    mergedEntityCount: database.entities.length,
    duplicateNodeCount,
    mergedRelationCount: database.relations.length,
    droppedRelationCount,
    pendingCount: database.pendingEntities.length,
  };

  appendAudit(database, {
    actor: "系统",
    action: "旧数据迁移",
    detail:
      `按设备号 / IP 归并重复节点：共享实体 ${database.entities.length} 个` +
      `（合并重复节点 ${duplicateNodeCount} 个），共享关系 ${database.relations.length} 条；` +
      `${database.pendingEntities.length} 条无法确认的记录已列入待核。`,
  });

  return database;
};
