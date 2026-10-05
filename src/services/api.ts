import { createApi, fakeBaseQuery } from "@reduxjs/toolkit/query/react";
import {
  isConclusionStale,
  type Alert,
  type AlertFilters,
  type AuditLog,
  type CaseDisposition,
  type CaseStatus,
  type CaseWorkspace,
  type ConclusionVersion,
  type DashboardSummary,
  type EntityConflictInfo,
  type EntityFieldConflict,
  type EntityRegistry,
  type Evidence,
  type InvestigationCase,
  type InvestigationNode,
  type RiskLevel,
  type SharedEntity,
  type SharedEntityAttributes,
} from "../models/types";
import {
  appendAudit,
  createId,
  ENTITY_HISTORY_LIMIT,
  extractEntityIdentifier,
  nowIso,
  readDatabase,
  resetDatabase,
  writeDatabase,
  type MockDatabase,
} from "./mockStorage";

const wait = (milliseconds = 260) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const ACTOR = "林澜";

interface ApiError {
  status: string;
  error: string;
  data?: unknown;
}

const apiError = (error: string, data?: unknown, status = "CUSTOM_ERROR") => ({
  error: { status, error, ...(data === undefined ? {} : { data }) } as ApiError,
});

/** 统一处理写入失败：已恢复完整版本后向界面返回可读错误。 */
const persist = (database: MockDatabase) => {
  try {
    writeDatabase(database);
    return null;
  } catch (cause) {
    return apiError(
      cause instanceof Error
        ? cause.message
        : "写入失败，已恢复到最近一个完整版本，请重试。",
    );
  }
};

const ENTITY_FIELDS = [
  "riskLevel",
  "note",
  "evidenceStrength",
  "source",
  "occurredAt",
] as const;

type EntityField = (typeof ENTITY_FIELDS)[number];

const pickEntityAttributes = (
  entity: SharedEntity,
): SharedEntityAttributes => ({
  label: entity.label,
  riskLevel: entity.riskLevel,
  note: entity.note,
  evidenceStrength: entity.evidenceStrength,
  source: entity.source,
  occurredAt: entity.occurredAt,
});

const pushEntityRevision = (
  entity: SharedEntity,
  action: SharedEntity["history"][number]["action"],
  note: string,
  by: string = ACTOR,
): void => {
  entity.history.unshift({
    version: entity.version,
    at: nowIso(),
    by,
    action,
    snapshot: pickEntityAttributes(entity),
    note,
  });
  entity.history = entity.history.slice(0, ENTITY_HISTORY_LIMIT);
};

/** 读取路径上的水合：实体关联节点的展示属性始终以共享实体当前版本为准。 */
const hydrateNode = (
  node: InvestigationNode,
  entities: SharedEntity[],
): InvestigationNode => {
  if (!node.entityId) {
    return node;
  }
  const entity = entities.find((item) => item.id === node.entityId);
  if (!entity) {
    return node;
  }
  return {
    ...node,
    data: {
      ...node.data,
      label: entity.label,
      kind: entity.kind,
      riskLevel: entity.riskLevel,
      note: entity.note,
      evidenceStrength: entity.evidenceStrength,
      source: entity.source,
      occurredAt: entity.occurredAt,
      entityVersion: entity.version,
    },
  };
};

/** 实体属性变化后，受影响案件的未终结结论全部失效，已关闭案件回到待补证。 */
const invalidateConclusionsForCases = (
  database: MockDatabase,
  caseIds: Iterable<string>,
  entity: SharedEntity,
): void => {
  const now = nowIso();
  for (const caseId of caseIds) {
    const targets = database.conclusions.filter(
      (item) =>
        item.caseId === caseId &&
        ["draft", "submitted", "approved"].includes(item.status),
    );
    targets.forEach((conclusion) => {
      conclusion.invalidated = {
        at: now,
        reason: `共享实体「${entity.label}」已更新至 V${entity.version}，原结论依据可能失效。`,
        entityId: entity.id,
        entityVersion: entity.version,
      };
      delete conclusion.revalidated;
    });
    const targetCase = database.cases.find((item) => item.id === caseId);
    if (targetCase) {
      if (targetCase.status === "closed" && targets.length > 0) {
        targetCase.status = "supplement";
        appendAudit(database, {
          caseId,
          actor: "系统",
          action: "案件重新打开",
          detail: "共享实体更新导致已通过的结论失效，案件转为待补证。",
          entityId: entity.id,
          entityVersion: entity.version,
        });
      }
      targetCase.updatedAt = now;
    }
    if (targets.length > 0) {
      appendAudit(database, {
        caseId,
        actor: "系统",
        action: "结论失效",
        detail: `共享实体「${entity.label}」更新至 V${entity.version}，${targets.length} 份结论需重新核对后才能恢复。`,
        entityId: entity.id,
        entityVersion: entity.version,
      });
    }
  }
};

const invalidateCasesForEntity = (
  database: MockDatabase,
  entity: SharedEntity,
): void => {
  const caseIds = new Set(
    database.nodes
      .filter((node) => node.entityId === entity.id)
      .map((node) => node.caseId),
  );
  invalidateConclusionsForCases(database, caseIds, entity);
};

/**
 * 三方对比：以 baseVersion 的历史快照为基准。
 * 对方未改动也未核验的字段可自动合并；对方改过的字段构成冲突；
 * 基准版本之后对方做过核验的，字段冲突一律锁定，不能覆盖已核验内容。
 */
const computeEntityConflicts = (
  entity: SharedEntity,
  baseVersion: number,
  changes: Partial<SharedEntityAttributes>,
): EntityFieldConflict[] => {
  const baseRevision = entity.history.find(
    (revision) => revision.version === baseVersion,
  );
  const verifiedAfterBase = entity.history.some(
    (revision) => revision.action === "verify" && revision.version > baseVersion,
  );
  const conflicts: EntityFieldConflict[] = [];
  ENTITY_FIELDS.forEach((field) => {
    const incoming = changes[field];
    if (incoming === undefined) {
      return;
    }
    const current = entity[field];
    if (incoming === current) {
      return;
    }
    const base = baseRevision?.snapshot[field];
    const otherChanged = base === undefined || base !== current;
    if (!otherChanged && !verifiedAfterBase) {
      return;
    }
    conflicts.push({
      field,
      base: base ?? "（基准版本过旧）",
      current,
      incoming,
      locked: verifiedAfterBase,
    });
  });
  return conflicts;
};

export interface AddNodeInput {
  caseId: string;
  node: InvestigationNode;
  relation?: {
    sourceId: string;
    kind: "transfer" | "shared_device" | "shared_ip" | "payee";
    label: string;
    explanation: string;
    amount?: number;
  };
}

export interface UpdateEntityInput {
  entityId: string;
  baseVersion: number;
  changes: Partial<SharedEntityAttributes>;
  note?: string;
}

export const bankApi = createApi({
  reducerPath: "bankApi",
  baseQuery: fakeBaseQuery(),
  tagTypes: ["Alerts", "Cases", "Case", "Audit", "Dashboard", "Entities"],
  endpoints: (builder) => ({
    getDashboard: builder.query<DashboardSummary, void>({
      queryFn: async () => {
        await wait();
        const database = readDatabase();
        const activeCases = database.cases.filter(
          (item) => item.status !== "closed",
        );
        const caseStatusCounts: DashboardSummary["caseStatusCounts"] = {
          investigating: 0,
          pending_review: 0,
          supplement: 0,
          closed: 0,
        };
        const riskCounts: DashboardSummary["riskCounts"] = {
          high: 0,
          medium: 0,
          low: 0,
        };

        database.cases.forEach((item) => {
          caseStatusCounts[item.status] += 1;
          riskCounts[item.riskLevel] += 1;
        });

        return {
          data: {
            newAlerts: database.alerts.filter((item) => item.status === "new")
              .length,
            highRiskAlerts: database.alerts.filter(
              (item) => item.riskLevel === "high",
            ).length,
            activeCases: activeCases.length,
            pendingReview: database.cases.filter((item) =>
              ["pending_review", "supplement"].includes(item.status),
            ).length,
            totalExposure: database.alerts.reduce(
              (sum, item) => sum + item.amount,
              0,
            ),
            sharedEntities: database.entities.length,
            pendingEntityMerges: database.pendingMerges.length,
            staleConclusions: database.conclusions.filter(isConclusionStale)
              .length,
            caseStatusCounts,
            riskCounts,
          },
        };
      },
      providesTags: ["Dashboard"],
    }),
    getAlerts: builder.query<Alert[], AlertFilters>({
      queryFn: async (filters) => {
        await wait();
        const database = readDatabase();
        const keyword = filters.keyword.trim().toLowerCase();
        const items = database.alerts.filter((item) => {
          const matchesKeyword =
            !keyword ||
            [
              item.id,
              item.title,
              item.account,
              item.counterparty,
              item.deviceId,
              item.ip,
              ...item.tags,
            ]
              .join(" ")
              .toLowerCase()
              .includes(keyword);
          const matchesRisk =
            filters.riskLevel === "all" ||
            item.riskLevel === filters.riskLevel;
          const matchesStatus =
            filters.status === "all" || item.status === filters.status;
          const matchesChannel =
            !filters.channel || item.channel === filters.channel;
          return (
            matchesKeyword && matchesRisk && matchesStatus && matchesChannel
          );
        });
        return { data: items };
      },
      providesTags: ["Alerts"],
    }),
    getCases: builder.query<InvestigationCase[], void>({
      queryFn: async () => {
        await wait();
        return { data: readDatabase().cases };
      },
      providesTags: ["Cases"],
    }),
    getCaseWorkspace: builder.query<CaseWorkspace, string>({
      queryFn: async (caseId) => {
        await wait();
        const database = readDatabase();
        const investigationCase = database.cases.find(
          (item) => item.id === caseId,
        );
        if (!investigationCase) {
          return apiError("案件不存在");
        }
        const caseNodes = database.nodes.filter(
          (item) => item.caseId === caseId,
        );
        const entityIds = new Set(
          caseNodes
            .map((item) => item.entityId)
            .filter((id): id is string => Boolean(id)),
        );
        return {
          data: {
            case: investigationCase,
            nodes: caseNodes.map((item) =>
              hydrateNode(item, database.entities),
            ),
            edges: database.edges.filter((item) => item.caseId === caseId),
            evidence: database.evidence.filter(
              (item) => item.caseId === caseId,
            ),
            conclusions: database.conclusions
              .filter((item) => item.caseId === caseId)
              .sort((a, b) => b.version - a.version),
            entities: database.entities.filter((item) =>
              entityIds.has(item.id),
            ),
          },
        };
      },
      providesTags: (_result, _error, caseId) => [
        { type: "Case", id: caseId },
        "Entities",
        "Dashboard",
      ],
    }),
    getEntityRegistry: builder.query<EntityRegistry, void>({
      queryFn: async () => {
        await wait();
        const database = readDatabase();
        return {
          data: {
            entities: database.entities,
            pendingMerges: database.pendingMerges,
            staleCaseIds: Array.from(
              new Set(
                database.conclusions
                  .filter(isConclusionStale)
                  .map((item) => item.caseId),
              ),
            ),
          },
        };
      },
      providesTags: ["Entities"],
    }),
    getAuditLogs: builder.query<AuditLog[], void>({
      queryFn: async () => {
        await wait();
        return { data: readDatabase().auditLogs };
      },
      providesTags: ["Audit"],
    }),
    linkAlertsToCase: builder.mutation<
      Alert[],
      { alertIds: string[]; caseId: string }
    >({
      queryFn: async ({ alertIds, caseId }) => {
        await wait();
        const database = readDatabase();
        const targetCase = database.cases.find((item) => item.id === caseId);
        if (!targetCase) {
          return apiError("案件不存在");
        }
        const updated = database.alerts.map((item) =>
          alertIds.includes(item.id)
            ? { ...item, caseId, status: "linked" as const }
            : item,
        );
        const selected = updated.filter((item) => alertIds.includes(item.id));
        targetCase.alertIds = Array.from(
          new Set([...targetCase.alertIds, ...alertIds]),
        );
        targetCase.updatedAt = nowIso();
        database.alerts = updated;
        appendAudit(database, {
          caseId,
          actor: ACTOR,
          action: "批量关联告警",
          detail: `关联告警 ${alertIds.join("、")}。`,
        });
        const failed = persist(database);
        if (failed) {
          return failed;
        }
        return { data: selected };
      },
      invalidatesTags: ["Alerts", "Cases", "Audit", "Dashboard"],
    }),
    updateAlertStatus: builder.mutation<
      Alert,
      { alertId: string; status: Alert["status"] }
    >({
      queryFn: async ({ alertId, status }) => {
        await wait();
        const database = readDatabase();
        const alert = database.alerts.find((item) => item.id === alertId);
        if (!alert) {
          return apiError("告警不存在");
        }
        alert.status = status;
        appendAudit(database, {
          caseId: alert.caseId,
          actor: ACTOR,
          action: "更新告警状态",
          detail: `${alert.id} 状态更新为 ${status}。`,
        });
        const failed = persist(database);
        if (failed) {
          return failed;
        }
        return { data: alert };
      },
      invalidatesTags: ["Alerts", "Case", "Audit", "Dashboard"],
    }),
    addGraphNode: builder.mutation<InvestigationNode, AddNodeInput>({
      queryFn: async ({ caseId, node, relation }) => {
        await wait();
        const database = readDatabase();
        if (!database.cases.some((item) => item.id === caseId)) {
          return apiError("案件不存在");
        }

        // 设备 / IP 节点一律挂到共享实体：已有同号实体直接关联，否则新建。
        if (node.data.kind === "device" || node.data.kind === "ip") {
          const identifier = extractEntityIdentifier(
            node.data.kind,
            node.data.label,
          );
          if (!identifier) {
            return apiError("无法从节点名称中识别设备号或 IP。");
          }
          let entity = database.entities.find(
            (item) =>
              item.kind === node.data.kind && item.identifier === identifier,
          );
          if (!entity) {
            entity = {
              id: createId("ENT"),
              kind: node.data.kind,
              identifier,
              label: node.data.label,
              riskLevel: node.data.riskLevel,
              note: node.data.note,
              evidenceStrength: node.data.evidenceStrength,
              source: node.data.source,
              occurredAt: node.data.occurredAt,
              version: 1,
              updatedAt: nowIso(),
              updatedBy: ACTOR,
              history: [],
            };
            pushEntityRevision(entity, "update", "调查员登记新共享实体。");
            database.entities.push(entity);
            appendAudit(database, {
              caseId,
              actor: ACTOR,
              action: "新建共享实体",
              detail: `${entity.label} 建立共享实体 V1，后续各案件共用同一版本。`,
              entityId: entity.id,
              entityVersion: entity.version,
            });
          } else {
            appendAudit(database, {
              caseId,
              actor: ACTOR,
              action: "关联共享实体",
              detail: `节点已关联共享实体 ${entity.label}（V${entity.version}），属性以共享版本为准。`,
              entityId: entity.id,
              entityVersion: entity.version,
            });
          }
          node.entityId = entity.id;
          node.data = {
            ...node.data,
            label: entity.label,
            riskLevel: entity.riskLevel,
            note: entity.note,
            evidenceStrength: entity.evidenceStrength,
            source: entity.source,
            occurredAt: entity.occurredAt,
          };
        }

        database.nodes.push(node);
        if (relation) {
          database.edges.push({
            id: createId("E"),
            caseId,
            source: relation.sourceId,
            target: node.id,
            kind: relation.kind,
            label: relation.label,
            amount: relation.amount,
            occurredAt: node.data.occurredAt,
            explanation: relation.explanation,
          });
        }
        const targetCase = database.cases.find((item) => item.id === caseId);
        if (targetCase) {
          targetCase.updatedAt = nowIso();
        }
        appendAudit(database, {
          caseId,
          actor: ACTOR,
          action: "加入图谱节点",
          detail: `${node.data.label} 已加入，证据强度 ${node.data.evidenceStrength}。`,
        });
        const failed = persist(database);
        if (failed) {
          return failed;
        }
        return { data: node };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Entities",
        "Audit",
        "Dashboard",
      ],
    }),
    updateGraphNode: builder.mutation<
      InvestigationNode,
      { caseId: string; node: InvestigationNode }
    >({
      queryFn: async ({ caseId, node }) => {
        await wait(80);
        const database = readDatabase();
        const index = database.nodes.findIndex((item) => item.id === node.id);
        if (index < 0) {
          return apiError("节点不存在");
        }
        const stored = database.nodes[index];
        // 共享实体关联节点只保存案件内布局位置，属性以实体为准，避免各案拷贝漂移。
        database.nodes[index] = stored.entityId
          ? { ...stored, position: node.position }
          : { ...stored, ...node };
        const failed = persist(database);
        if (failed) {
          return failed;
        }
        return { data: hydrateNode(database.nodes[index], database.entities) };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
      ],
    }),
    updateSharedEntity: builder.mutation<SharedEntity, UpdateEntityInput>({
      queryFn: async ({ entityId, baseVersion, changes, note }) => {
        await wait();
        const database = readDatabase();
        const entity = database.entities.find((item) => item.id === entityId);
        if (!entity) {
          return apiError("共享实体不存在");
        }

        if (entity.version !== baseVersion) {
          const conflicts = computeEntityConflicts(entity, baseVersion, changes);
          if (conflicts.length > 0) {
            const info: EntityConflictInfo = {
              entity: structuredClone(entity),
              fields: conflicts,
            };
            return apiError(
              "该实体在您编辑期间已被他人更新，请逐项处理字段冲突后再保存。",
              info,
              "CONFLICT",
            );
          }
          // 无字段冲突：他人改动与本表单不重叠，基于最新版本继续合并。
        }

        const changedFields = ENTITY_FIELDS.filter((field) => {
          const incoming = changes[field];
          return incoming !== undefined && incoming !== entity[field];
        });

        if (changedFields.length > 0) {
          changedFields.forEach((field) => {
            const incoming = changes[field];
            if (incoming !== undefined) {
              (entity as Record<EntityField, string>)[field] = incoming;
            }
          });
          entity.version += 1;
          entity.updatedAt = nowIso();
          entity.updatedBy = ACTOR;
          pushEntityRevision(
            entity,
            "update",
            note ?? `更新字段：${changedFields.join("、")}。`,
          );
          invalidateCasesForEntity(database, entity);
          appendAudit(database, {
            actor: ACTOR,
            action: "更新共享实体",
            detail: `${entity.label} 更新至 V${entity.version}（${changedFields.join("、")}），受影响案件的结论已标记失效。`,
            entityId: entity.id,
            entityVersion: entity.version,
          });
        }

        const failed = persist(database);
        if (failed) {
          return failed;
        }
        return { data: structuredClone(entity) };
      },
      invalidatesTags: ["Entities", "Case", "Cases", "Audit", "Dashboard"],
    }),
    verifySharedEntity: builder.mutation<
      SharedEntity,
      { entityId: string; baseVersion: number; note?: string }
    >({
      queryFn: async ({ entityId, baseVersion, note }) => {
        await wait();
        const database = readDatabase();
        const entity = database.entities.find((item) => item.id === entityId);
        if (!entity) {
          return apiError("共享实体不存在");
        }
        if (entity.version !== baseVersion) {
          const info: EntityConflictInfo = {
            entity: structuredClone(entity),
            fields: [],
          };
          return apiError(
            "该实体已被他人更新，请基于最新版本重新核验。",
            info,
            "CONFLICT",
          );
        }
        entity.verifiedAt = nowIso();
        entity.verifiedBy = ACTOR;
        entity.version += 1;
        entity.updatedAt = nowIso();
        entity.updatedBy = ACTOR;
        pushEntityRevision(
          entity,
          "verify",
          note ?? "核验当前风险等级与关联时间。",
        );
        appendAudit(database, {
          actor: ACTOR,
          action: "核验共享实体",
          detail: `${entity.label} 已核验（V${entity.version}），此后他人的冲突修改不能覆盖已核验字段。`,
          entityId: entity.id,
          entityVersion: entity.version,
        });
        const failed = persist(database);
        if (failed) {
          return failed;
        }
        return { data: structuredClone(entity) };
      },
      invalidatesTags: ["Entities", "Case", "Audit", "Dashboard"],
    }),
    revalidateConclusions: builder.mutation<
      ConclusionVersion[],
      { caseId: string; note: string }
    >({
      queryFn: async ({ caseId, note }) => {
        await wait();
        const database = readDatabase();
        const stale = database.conclusions.filter(
          (item) => item.caseId === caseId && isConclusionStale(item),
        );
        if (stale.length === 0) {
          return apiError("当前案件没有待重新核对的结论。");
        }
        stale.forEach((conclusion) => {
          conclusion.revalidated = {
            at: nowIso(),
            by: ACTOR,
            note,
          };
        });
        const targetCase = database.cases.find((item) => item.id === caseId);
        if (targetCase) {
          targetCase.updatedAt = nowIso();
        }
        appendAudit(database, {
          caseId,
          actor: ACTOR,
          action: "重新核对结论",
          detail: `${stale.length} 份失效结论已重新核对并恢复。核对说明：${note}`,
        });
        const failed = persist(database);
        if (failed) {
          return failed;
        }
        return { data: stale };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Cases",
        "Entities",
        "Audit",
        "Dashboard",
      ],
    }),
    resolvePendingMerge: builder.mutation<
      EntityRegistry,
      { mergeId: string; decision: "merge" | "separate" }
    >({
      queryFn: async ({ mergeId, decision }) => {
        await wait();
        const database = readDatabase();
        const pending = database.pendingMerges.find(
          (item) => item.id === mergeId,
        );
        if (!pending) {
          return apiError("待核项不存在或已处理。");
        }
        const members = database.nodes.filter((node) =>
          pending.nodeIds.includes(node.id),
        );

        if (decision === "merge") {
          const latest = [...members].sort(
            (a, b) =>
              Date.parse(b.data.occurredAt) - Date.parse(a.data.occurredAt),
          )[0];
          if (!latest) {
            return apiError("待核项关联的节点已不存在。");
          }
          const entity: SharedEntity = {
            id: createId("ENT"),
            kind: pending.kind,
            identifier: pending.identifier,
            label: latest.data.label,
            riskLevel: latest.data.riskLevel,
            note: latest.data.note,
            evidenceStrength: latest.data.evidenceStrength,
            source: latest.data.source,
            occurredAt: latest.data.occurredAt,
            version: 1,
            updatedAt: nowIso(),
            updatedBy: ACTOR,
            history: [],
          };
          pushEntityRevision(
            entity,
            "merge",
            `待核归并确认，采用 ${latest.caseId} 登记的属性。`,
          );
          database.entities.push(entity);
          members.forEach((member) => {
            member.entityId = entity.id;
          });
          // 归并后属性发生变化的案件，其结论需要重新核对。
          const affectedCaseIds = new Set(
            members
              .filter(
                (member) =>
                  member.data.riskLevel !== entity.riskLevel ||
                  member.data.evidenceStrength !== entity.evidenceStrength,
              )
              .map((member) => member.caseId),
          );
          invalidateConclusionsForCases(database, affectedCaseIds, entity);
          appendAudit(database, {
            actor: ACTOR,
            action: "确认实体归并",
            detail: `${pending.kind === "device" ? "设备" : "IP"} ${pending.identifier} 的 ${members.length} 个重复节点已归并为共享实体 V1。`,
            entityId: entity.id,
            entityVersion: entity.version,
          });
        } else {
          appendAudit(database, {
            actor: ACTOR,
            action: "待核确认",
            detail: `${pending.kind === "device" ? "设备" : "IP"} ${pending.identifier} 确认为不同实体，各案件保留独立节点。`,
          });
        }

        database.pendingMerges = database.pendingMerges.filter(
          (item) => item.id !== mergeId,
        );
        const failed = persist(database);
        if (failed) {
          return failed;
        }
        return {
          data: {
            entities: database.entities,
            pendingMerges: database.pendingMerges,
            staleCaseIds: Array.from(
              new Set(
                database.conclusions
                  .filter(isConclusionStale)
                  .map((item) => item.caseId),
              ),
            ),
          },
        };
      },
      invalidatesTags: ["Entities", "Case", "Cases", "Audit", "Dashboard"],
    }),
    addEvidence: builder.mutation<
      Evidence,
      Omit<Evidence, "id" | "submittedAt" | "submittedBy" | "version">
    >({
      queryFn: async (input) => {
        await wait();
        const database = readDatabase();
        const evidence: Evidence = {
          ...input,
          id: createId("EV"),
          submittedAt: nowIso(),
          submittedBy: ACTOR,
          version: 1,
        };
        database.evidence.unshift(evidence);
        const targetCase = database.cases.find(
          (item) => item.id === input.caseId,
        );
        if (targetCase) {
          targetCase.updatedAt = nowIso();
        }
        appendAudit(database, {
          caseId: input.caseId,
          actor: ACTOR,
          action: "新增证据",
          detail: `${input.title} 已登记，来源为 ${input.source}。`,
        });
        const failed = persist(database);
        if (failed) {
          return failed;
        }
        return { data: evidence };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Audit",
        "Dashboard",
      ],
    }),
    saveConclusion: builder.mutation<
      ConclusionVersion,
      {
        caseId: string;
        disposition: CaseDisposition;
        rationale: string;
        riskControls: string[];
        submit?: boolean;
      }
    >({
      queryFn: async (input) => {
        await wait();
        const database = readDatabase();
        const existing = database.conclusions.filter(
          (item) => item.caseId === input.caseId,
        );
        const conclusion: ConclusionVersion = {
          id: createId("CV"),
          caseId: input.caseId,
          version:
            existing.reduce((max, item) => Math.max(max, item.version), 0) + 1,
          status: input.submit ? "submitted" : "draft",
          disposition: input.disposition,
          rationale: input.rationale,
          riskControls: input.riskControls,
          createdBy: ACTOR,
          createdAt: nowIso(),
          reviewer: "赵平",
        };
        database.conclusions.unshift(conclusion);
        const targetCase = database.cases.find(
          (item) => item.id === input.caseId,
        );
        if (targetCase) {
          targetCase.status = input.submit ? "pending_review" : "investigating";
          targetCase.updatedAt = nowIso();
        }
        appendAudit(database, {
          caseId: input.caseId,
          actor: ACTOR,
          action: "保存结论版本",
          detail: `${conclusion.id} V${conclusion.version} 已${input.submit ? "提交复核" : "保存为草稿"}。`,
        });
        const failed = persist(database);
        if (failed) {
          return failed;
        }
        return { data: conclusion };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Audit",
        "Cases",
        "Dashboard",
      ],
    }),
    transitionCase: builder.mutation<
      InvestigationCase,
      { caseId: string; status: CaseStatus; reason?: string }
    >({
      queryFn: async ({ caseId, status, reason }) => {
        await wait();
        const database = readDatabase();
        const targetCase = database.cases.find((item) => item.id === caseId);
        if (!targetCase) {
          return apiError("案件不存在");
        }
        if (status === "pending_review") {
          const hasSubmitted = database.conclusions.some(
            (item) =>
              item.caseId === caseId && item.status === "submitted",
          );
          if (!hasSubmitted) {
            return apiError("请先提交一份结论版本，再进入复核。");
          }
        }
        if (status === "closed") {
          const hasStale = database.conclusions.some(
            (item) => item.caseId === caseId && isConclusionStale(item),
          );
          if (hasStale) {
            return apiError("存在已失效的结论，需重新核对后才能关闭案件。");
          }
        }
        targetCase.status = status;
        targetCase.updatedAt = nowIso();
        appendAudit(database, {
          caseId,
          actor: ACTOR,
          action: "案件状态流转",
          detail: `状态更新为 ${status}${reason ? `，原因：${reason}` : ""}。`,
        });
        const failed = persist(database);
        if (failed) {
          return failed;
        }
        return { data: targetCase };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Cases",
        "Audit",
        "Dashboard",
      ],
    }),
    reviewConclusion: builder.mutation<
      ConclusionVersion,
      {
        caseId: string;
        conclusionId: string;
        decision: "approve" | "return";
        reviewerNote: string;
      }
    >({
      queryFn: async ({ caseId, conclusionId, decision, reviewerNote }) => {
        await wait();
        const database = readDatabase();
        const conclusion = database.conclusions.find(
          (item) => item.id === conclusionId,
        );
        if (!conclusion) {
          return apiError("结论不存在");
        }
        if (
          conclusion.status !== "submitted" &&
          conclusion.status !== "draft"
        ) {
          return apiError("当前版本不能再次复核。");
        }
        if (isConclusionStale(conclusion)) {
          return apiError("结论已失效，请先重新核对再复核。");
        }
        conclusion.status = decision === "approve" ? "approved" : "returned";
        conclusion.reviewerNote = reviewerNote;
        const targetCase = database.cases.find((item) => item.id === caseId);
        if (targetCase) {
          targetCase.status =
            decision === "approve" ? "closed" : "supplement";
          targetCase.updatedAt = nowIso();
        }
        appendAudit(database, {
          caseId,
          actor: "赵平",
          action: decision === "approve" ? "复核通过" : "退回补证",
          detail: `${conclusion.id} 已${decision === "approve" ? "通过" : "退回"}。${reviewerNote}`,
        });
        const failed = persist(database);
        if (failed) {
          return failed;
        }
        return { data: conclusion };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Cases",
        "Audit",
        "Dashboard",
      ],
    }),
    resetMockData: builder.mutation<{ ok: boolean }, void>({
      queryFn: async () => {
        await wait(180);
        resetDatabase();
        return { data: { ok: true } };
      },
      invalidatesTags: [
        "Alerts",
        "Cases",
        "Case",
        "Audit",
        "Dashboard",
        "Entities",
      ],
    }),
  }),
});

export const {
  useAddEvidenceMutation,
  useAddGraphNodeMutation,
  useGetAlertsQuery,
  useGetAuditLogsQuery,
  useGetCaseWorkspaceQuery,
  useGetCasesQuery,
  useGetDashboardQuery,
  useGetEntityRegistryQuery,
  useLinkAlertsToCaseMutation,
  useResetMockDataMutation,
  useResolvePendingMergeMutation,
  useRevalidateConclusionsMutation,
  useReviewConclusionMutation,
  useSaveConclusionMutation,
  useTransitionCaseMutation,
  useUpdateAlertStatusMutation,
  useUpdateGraphNodeMutation,
  useUpdateSharedEntityMutation,
  useVerifySharedEntityMutation,
} = bankApi;

export type { RiskLevel };
