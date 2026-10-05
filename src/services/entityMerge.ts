import type {
  EntityAttributeField,
  EntityChangeSet,
  EntityFieldConflict,
  EntityUpdateResult,
  SharedEntity,
} from "../models/types";
import { appendAudit, createId, nowIso, type MockDatabase } from "./database";

export const isEntityVerified = (entity: SharedEntity): boolean =>
  entity.verifiedVersion !== undefined && entity.verifiedVersion === entity.version;

/** 案件图谱内全部共享实体的当前版本，用于结论快照与失效判定。 */
export const caseEntityVersions = (
  database: MockDatabase,
  caseId: string,
): Record<string, number> => {
  const versions: Record<string, number> = {};
  database.placements
    .filter((placement) => placement.caseId === caseId)
    .forEach((placement) => {
      const entity = database.entities.find(
        (item) => item.id === placement.entityId,
      );
      if (entity) {
        versions[entity.id] = entity.version;
      }
    });
  return versions;
};

/** 实体当前版本超过结论快照即视为失效，需重新核对。 */
export const staleEntityIds = (
  snapshot: Record<string, number>,
  current: Record<string, number>,
): string[] =>
  Object.entries(current)
    .filter(([entityId, version]) => (snapshot[entityId] ?? 0) < version)
    .map(([entityId]) => entityId);

export interface ApplyEntityUpdateInput {
  entityId: string;
  /** 调用方读取表单时的实体版本 */
  baseVersion: number;
  changes: EntityChangeSet;
  actor: string;
  /** 冲突字段的逐项裁决：保留对方（theirs）或使用我的（mine） */
  resolutions?: Partial<Record<EntityAttributeField, "mine" | "theirs">>;
  /** 覆盖他人已核验字段时必须显式确认 */
  allowOverrideVerified?: boolean;
}

/**
 * 字段级三方合并：
 * - 字段在我读取（baseVersion）之后被他人修改且目标值不同 → 冲突，整笔不写入；
 * - 无冲突字段直接应用；
 * - 他人已核验的字段默认不可覆盖，除非显式确认，覆盖后核验状态失效并留痕；
 * - 任何属性更新都会提升实体版本，受影响案件的旧结论随之失效。
 */
export const applyEntityUpdate = (
  database: MockDatabase,
  input: ApplyEntityUpdateInput,
): EntityUpdateResult => {
  const entity = database.entities.find((item) => item.id === input.entityId);
  if (!entity) {
    throw new Error("实体不存在");
  }

  const conflicts: EntityFieldConflict[] = [];
  const applicable: EntityAttributeField[] = [];
  const wasVerified = isEntityVerified(entity);

  (Object.keys(input.changes) as EntityAttributeField[]).forEach((field) => {
    const next = input.changes[field];
    if (next === undefined || next === entity[field]) {
      return;
    }
    const stamp = entity.fieldStamps[field];
    const changedAfterBase = stamp
      ? stamp.version > input.baseVersion
      : entity.version > input.baseVersion;
    if (!changedAfterBase) {
      applicable.push(field);
      return;
    }
    const verifiedByOther =
      wasVerified && !!entity.verifiedBy && entity.verifiedBy !== input.actor;
    const resolution = input.resolutions?.[field];
    if (resolution === "theirs") {
      return;
    }
    if (resolution === "mine" && (!verifiedByOther || input.allowOverrideVerified)) {
      applicable.push(field);
      return;
    }
    conflicts.push({
      field,
      currentValue: String(entity[field]),
      attemptedValue: String(next),
      updatedBy: stamp?.updatedBy ?? entity.updatedBy,
      updatedAt: stamp?.updatedAt ?? entity.updatedAt,
      verifiedByOther,
    });
  });

  if (conflicts.length > 0) {
    return { status: "conflict", entity, conflicts };
  }

  if (applicable.length > 0) {
    const now = nowIso();
    entity.version += 1;
    applicable.forEach((field) => {
      entity[field] = input.changes[field] as never;
      entity.fieldStamps[field] = {
        version: entity.version,
        updatedBy: input.actor,
        updatedAt: now,
      };
    });
    entity.updatedAt = now;
    entity.updatedBy = input.actor;
  }

  const invalidatedCaseIds = Array.from(
    new Set(
      database.placements
        .filter((placement) => placement.entityId === entity.id)
        .map((placement) => placement.caseId),
    ),
  );

  if (applicable.length > 0) {
    const overriddenVerified =
      wasVerified && entity.verifiedBy && entity.verifiedBy !== input.actor;
    appendAudit(database, {
      actor: input.actor,
      action: "更新共享实体",
      detail:
        `${entity.label}（${entity.canonicalKey}）更新为 V${entity.version}` +
        `（字段：${applicable.join("、")}）` +
        (invalidatedCaseIds.length > 0
          ? `；${invalidatedCaseIds.join("、")} 的旧结论已失效，需重新核对`
          : "") +
        (wasVerified ? "；原核验状态已失效" : "") +
        (overriddenVerified ? "；覆盖了他人已核验字段" : ""),
    });
  }

  return {
    status: "saved",
    entity,
    changedFields: applicable,
    invalidatedCaseIds,
  };
};

export interface EntityDraftInput {
  kind: SharedEntity["kind"];
  canonicalKey: string;
  label: string;
  riskLevel: SharedEntity["riskLevel"];
  note: string;
  evidenceStrength: SharedEntity["evidenceStrength"];
  source: string;
  occurredAt: string;
}

/** 按归并键查找共享实体；不存在时创建 V1 记录。 */
export const findOrCreateEntity = (
  database: MockDatabase,
  draft: EntityDraftInput,
  actor: string,
): { entity: SharedEntity; created: boolean } => {
  const existing = database.entities.find(
    (item) => item.canonicalKey === draft.canonicalKey,
  );
  if (existing) {
    return { entity: existing, created: false };
  }
  const now = nowIso();
  const entity: SharedEntity = {
    id: createId("ENT"),
    kind: draft.kind,
    canonicalKey: draft.canonicalKey,
    label: draft.label,
    riskLevel: draft.riskLevel,
    note: draft.note,
    evidenceStrength: draft.evidenceStrength,
    source: draft.source,
    occurredAt: draft.occurredAt,
    version: 1,
    updatedAt: now,
    updatedBy: actor,
    fieldStamps: {
      label: { version: 1, updatedBy: actor, updatedAt: now },
      riskLevel: { version: 1, updatedBy: actor, updatedAt: now },
      note: { version: 1, updatedBy: actor, updatedAt: now },
      evidenceStrength: { version: 1, updatedBy: actor, updatedAt: now },
      source: { version: 1, updatedBy: actor, updatedAt: now },
      occurredAt: { version: 1, updatedBy: actor, updatedAt: now },
    },
    mergedFrom: [],
  };
  database.entities.push(entity);
  return { entity, created: true };
};

export const autoPlacementPosition = (
  database: MockDatabase,
  caseId: string,
): { x: number; y: number } => {
  const count = database.placements.filter((p) => p.caseId === caseId).length;
  return { x: 120 + (count % 4) * 260, y: 140 + Math.floor(count / 4) * 180 };
};

export const ensurePlacement = (
  database: MockDatabase,
  caseId: string,
  entityId: string,
  position?: { x: number; y: number },
): void => {
  const exists = database.placements.some(
    (p) => p.caseId === caseId && p.entityId === entityId,
  );
  if (!exists) {
    database.placements.push({
      caseId,
      entityId,
      position: position ?? autoPlacementPosition(database, caseId),
    });
  }
};
