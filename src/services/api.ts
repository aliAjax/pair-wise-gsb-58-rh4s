import { createApi, fakeBaseQuery } from "@reduxjs/toolkit/query/react";
import type {
  Alert,
  AlertFilters,
  AuditLog,
  CaseDisposition,
  CaseGraphEdge,
  CaseGraphNode,
  CaseStatus,
  CaseWorkspace,
  ConclusionVersion,
  ConclusionView,
  DashboardSummary,
  EdgeKind,
  EntityAttributeField,
  EntityChangeSet,
  EntityUpdateResult,
  Evidence,
  InvestigationCase,
  MigrationReport,
  NodeKind,
  PendingEntityMerge,
  RiskLevel,
  SharedEntity,
  SharedRelation,
} from "../models/types";
import {
  appendAudit,
  commitDatabase,
  createId,
  nowIso,
  readDatabase,
  resetDatabase,
  type MockDatabase,
} from "./mockStorage";
import {
  applyEntityUpdate,
  caseEntityVersions,
  ensurePlacement,
  findOrCreateEntity,
  isEntityVerified,
  staleEntityIds,
} from "./entityMerge";
import { canonicalKeyFor } from "./migration";

const wait = (milliseconds = 260) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const ACTOR = "林澜";

export interface AddNodeInput {
  caseId: string;
  node: {
    kind: NodeKind;
    label: string;
    riskLevel: RiskLevel;
    evidenceStrength: Evidence["strength"];
    source: string;
    occurredAt: string;
    note: string;
  };
  relation?: {
    sourceEntityId: string;
    kind: EdgeKind;
    label: string;
    explanation: string;
    amount?: number;
  };
}

export type AddNodeResult =
  | { status: "added"; node: CaseGraphNode; reusedEntity: boolean }
  | { status: "pending"; pending: PendingEntityMerge };

export interface UpdateEntityInput {
  entityId: string;
  baseVersion: number;
  changes: EntityChangeSet;
  resolutions?: Partial<Record<EntityAttributeField, "mine" | "theirs">>;
  allowOverrideVerified?: boolean;
}

export interface SharedEntityOverview {
  entities: SharedEntity[];
  relations: SharedRelation[];
  pending: PendingEntityMerge[];
  migration?: MigrationReport;
}

const toCaseGraphNode = (
  database: MockDatabase,
  caseId: string,
  entity: SharedEntity,
): CaseGraphNode => {
  const placement = database.placements.find(
    (item) => item.caseId === caseId && item.entityId === entity.id,
  );
  return {
    id: entity.id,
    caseId,
    position: placement?.position ?? { x: 0, y: 0 },
    data: {
      label: entity.label,
      kind: entity.kind,
      riskLevel: entity.riskLevel,
      note: entity.note,
      evidenceStrength: entity.evidenceStrength,
      source: entity.source,
      occurredAt: entity.occurredAt,
    },
    entityVersion: entity.version,
    verified: isEntityVerified(entity),
    verifiedBy: entity.verifiedBy,
  };
};

const toCaseGraphEdge = (
  relation: SharedRelation,
  caseId: string,
): CaseGraphEdge => ({
  id: relation.id,
  caseId,
  source: relation.sourceEntityId,
  target: relation.targetEntityId,
  kind: relation.kind,
  label: relation.label,
  amount: relation.amount,
  occurredAt: relation.occurredAt,
  explanation: relation.explanation,
  relationVersion: relation.version,
  verified:
    relation.verifiedVersion !== undefined &&
    relation.verifiedVersion === relation.version,
  verifiedBy: relation.verifiedBy,
});

const toConclusionView = (
  database: MockDatabase,
  conclusion: ConclusionVersion,
): ConclusionView => ({
  ...conclusion,
  staleEntityIds: staleEntityIds(
    conclusion.entityVersions,
    caseEntityVersions(database, conclusion.caseId),
  ),
});

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
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        const entityIds = new Set(
          database.placements
            .filter((item) => item.caseId === caseId)
            .map((item) => item.entityId),
        );
        const nodes = database.entities
          .filter((entity) => entityIds.has(entity.id))
          .map((entity) => toCaseGraphNode(database, caseId, entity));
        const edges = database.relations
          .filter(
            (relation) =>
              relation.caseIds.includes(caseId) &&
              entityIds.has(relation.sourceEntityId) &&
              entityIds.has(relation.targetEntityId),
          )
          .map((relation) => toCaseGraphEdge(relation, caseId));
        return {
          data: {
            case: investigationCase,
            nodes,
            edges,
            evidence: database.evidence.filter(
              (item) => item.caseId === caseId,
            ),
            conclusions: database.conclusions
              .filter((item) => item.caseId === caseId)
              .sort((a, b) => b.version - a.version)
              .map((item) => toConclusionView(database, item)),
          },
        };
      },
      providesTags: (_result, _error, caseId) => [
        { type: "Case", id: caseId },
        "Entities",
        "Dashboard",
      ],
    }),
    getSharedEntities: builder.query<SharedEntityOverview, void>({
      queryFn: async () => {
        await wait();
        const database = readDatabase();
        return {
          data: {
            entities: database.entities,
            relations: database.relations,
            pending: database.pendingEntities.filter(
              (item) => item.status === "pending",
            ),
            migration: database.migration,
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
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
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
        commitDatabase(database);
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
          return { error: { status: "CUSTOM_ERROR", error: "告警不存在" } };
        }
        alert.status = status;
        appendAudit(database, {
          caseId: alert.caseId,
          actor: ACTOR,
          action: "更新告警状态",
          detail: `${alert.id} 状态更新为 ${status}。`,
        });
        commitDatabase(database);
        return { data: alert };
      },
      invalidatesTags: ["Alerts", "Case", "Audit", "Dashboard"],
    }),
    addGraphNode: builder.mutation<AddNodeResult, AddNodeInput>({
      queryFn: async ({ caseId, node, relation }) => {
        await wait();
        const database = readDatabase();
        const targetCase = database.cases.find((item) => item.id === caseId);
        if (!targetCase) {
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        const canonicalKey = canonicalKeyFor(
          node.kind,
          node.label,
          node.source,
        );
        if (!canonicalKey) {
          // 无法确认标识的节点不进图谱，直接列入待核
          const pending: PendingEntityMerge = {
            id: createId("PEND"),
            kind: node.kind,
            label: node.label,
            reason:
              node.kind === "device"
                ? "无法从名称或来源中确认设备号"
                : node.kind === "ip"
                  ? "无法确认有效 IP 地址"
                  : "缺少可归并的稳定标识",
            caseIds: [caseId],
            sourceNodeIds: [],
            draft: { ...node },
            status: "pending",
            createdAt: nowIso(),
          };
          database.pendingEntities.push(pending);
          appendAudit(database, {
            caseId,
            actor: ACTOR,
            action: "节点列入待核",
            detail: `${node.label} 无法确认标识，已列入待核列表。`,
          });
          commitDatabase(database);
          return { data: { status: "pending", pending } };
        }
        const { entity, created } = findOrCreateEntity(
          database,
          { ...node, canonicalKey },
          ACTOR,
        );
        ensurePlacement(database, caseId, entity.id, { x: 420, y: 240 });
        if (relation) {
          ensurePlacement(database, caseId, relation.sourceEntityId);
          const existingRelation = database.relations.find(
            (item) =>
              item.sourceEntityId === relation.sourceEntityId &&
              item.targetEntityId === entity.id &&
              item.kind === relation.kind &&
              item.label === relation.label,
          );
          if (existingRelation) {
            if (!existingRelation.caseIds.includes(caseId)) {
              existingRelation.caseIds.push(caseId);
              existingRelation.updatedAt = nowIso();
              existingRelation.updatedBy = ACTOR;
            }
          } else {
            database.relations.push({
              id: createId("REL"),
              sourceEntityId: relation.sourceEntityId,
              targetEntityId: entity.id,
              kind: relation.kind,
              label: relation.label,
              amount: relation.amount,
              occurredAt: node.occurredAt,
              explanation: relation.explanation,
              caseIds: [caseId],
              version: 1,
              updatedAt: nowIso(),
              updatedBy: ACTOR,
            });
          }
        }
        targetCase.updatedAt = nowIso();
        appendAudit(database, {
          caseId,
          actor: ACTOR,
          action: created ? "新建共享实体" : "引用共享实体",
          detail:
            `${entity.label}（${entity.canonicalKey}，V${entity.version}）` +
            (created ? " 已建立共享记录" : " 已存在共享记录，本案直接引用") +
            `，证据强度 ${entity.evidenceStrength}。`,
        });
        commitDatabase(database);
        return {
          data: {
            status: "added",
            node: toCaseGraphNode(database, caseId, entity),
            reusedEntity: !created,
          },
        };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Entities",
        "Audit",
        "Dashboard",
      ],
    }),
    updateNodePlacement: builder.mutation<
      { ok: boolean },
      { caseId: string; entityId: string; position: { x: number; y: number } }
    >({
      queryFn: async ({ caseId, entityId, position }) => {
        await wait(80);
        const database = readDatabase();
        const placement = database.placements.find(
          (item) => item.caseId === caseId && item.entityId === entityId,
        );
        if (!placement) {
          return { error: { status: "CUSTOM_ERROR", error: "节点不存在" } };
        }
        placement.position = position;
        commitDatabase(database);
        return { data: { ok: true } };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
      ],
    }),
    updateEntity: builder.mutation<EntityUpdateResult, UpdateEntityInput>({
      queryFn: async (input) => {
        await wait();
        const database = readDatabase();
        try {
          const result = applyEntityUpdate(database, {
            ...input,
            actor: ACTOR,
          });
          if (result.status === "saved") {
            if (result.changedFields.length > 0) {
              database.cases
                .filter((item) => result.invalidatedCaseIds.includes(item.id))
                .forEach((item) => {
                  item.updatedAt = nowIso();
                });
            }
            commitDatabase(database);
          }
          return { data: result };
        } catch (error) {
          return {
            error: {
              status: "CUSTOM_ERROR",
              error: error instanceof Error ? error.message : "实体保存失败",
            },
          };
        }
      },
      invalidatesTags: ["Entities", "Case", "Cases", "Audit", "Dashboard"],
    }),
    verifyEntity: builder.mutation<SharedEntity, { entityId: string }>({
      queryFn: async ({ entityId }) => {
        await wait(120);
        const database = readDatabase();
        const entity = database.entities.find((item) => item.id === entityId);
        if (!entity) {
          return { error: { status: "CUSTOM_ERROR", error: "实体不存在" } };
        }
        entity.verifiedVersion = entity.version;
        entity.verifiedBy = ACTOR;
        entity.verifiedAt = nowIso();
        appendAudit(database, {
          actor: ACTOR,
          action: "核验共享实体",
          detail: `${entity.label}（${entity.canonicalKey}）V${entity.version} 已核验。`,
        });
        commitDatabase(database);
        return { data: entity };
      },
      invalidatesTags: ["Entities", "Case", "Audit"],
    }),
    verifyRelation: builder.mutation<
      SharedRelation,
      { relationId: string; caseId: string }
    >({
      queryFn: async ({ relationId }) => {
        await wait(120);
        const database = readDatabase();
        const relation = database.relations.find(
          (item) => item.id === relationId,
        );
        if (!relation) {
          return { error: { status: "CUSTOM_ERROR", error: "关系不存在" } };
        }
        relation.verifiedVersion = relation.version;
        relation.verifiedBy = ACTOR;
        relation.verifiedAt = nowIso();
        appendAudit(database, {
          actor: ACTOR,
          action: "核验共享关系",
          detail: `关系 ${relation.label}（V${relation.version}）已核验，全部引用案件同步生效。`,
        });
        commitDatabase(database);
        return { data: relation };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Entities",
        "Audit",
      ],
    }),
    resolvePendingEntity: builder.mutation<
      { ok: boolean },
      | { pendingId: string; mode: "merge"; identifier: string }
      | { pendingId: string; mode: "dismiss" }
    >({
      queryFn: async (input) => {
        await wait();
        const database = readDatabase();
        const pending = database.pendingEntities.find(
          (item) => item.id === input.pendingId && item.status === "pending",
        );
        if (!pending) {
          return {
            error: { status: "CUSTOM_ERROR", error: "待核记录不存在" },
          };
        }
        if (input.mode === "dismiss") {
          pending.status = "dismissed";
          pending.resolvedAt = nowIso();
          pending.resolvedBy = ACTOR;
          appendAudit(database, {
            actor: ACTOR,
            action: "待核记录排除",
            detail: `${pending.label} 已确认无法归并，标记为排除。`,
          });
          commitDatabase(database);
          return { data: { ok: true } };
        }
        const canonicalKey = canonicalKeyFor(
          pending.kind,
          input.identifier,
          "",
        );
        if (!canonicalKey) {
          return {
            error: {
              status: "CUSTOM_ERROR",
              error: "输入的标识仍无法确认，请提供有效的设备号或 IP。",
            },
          };
        }
        const identifierLabel =
          pending.kind === "device"
            ? `设备 ${canonicalKey.slice("device:".length)}`
            : pending.kind === "ip"
              ? canonicalKey.slice("ip:".length)
              : input.identifier.trim();
        const { entity } = findOrCreateEntity(
          database,
          {
            kind: pending.kind,
            canonicalKey,
            label: identifierLabel,
            riskLevel: pending.draft.riskLevel,
            note: pending.draft.note,
            evidenceStrength: pending.draft.evidenceStrength,
            source: pending.draft.source,
            occurredAt: pending.draft.occurredAt,
          },
          ACTOR,
        );
        pending.caseIds.forEach((pendingCaseId) =>
          ensurePlacement(database, pendingCaseId, entity.id),
        );
        pending.status = "merged";
        pending.resolvedAt = nowIso();
        pending.resolvedBy = ACTOR;
        pending.resolvedKey = canonicalKey;
        appendAudit(database, {
          actor: ACTOR,
          action: "待核记录归并",
          detail: `${pending.label} 已按 ${canonicalKey} 归并为共享实体 V${entity.version}。`,
        });
        commitDatabase(database);
        return { data: { ok: true } };
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
        commitDatabase(database);
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
          entityVersions: caseEntityVersions(database, input.caseId),
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
          detail: `${conclusion.id} V${conclusion.version} 已${input.submit ? "提交复核" : "保存为草稿"}，实体版本快照 ${Object.keys(conclusion.entityVersions).length} 项。`,
        });
        commitDatabase(database);
        return { data: conclusion };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Audit",
        "Cases",
        "Dashboard",
      ],
    }),
    revalidateConclusion: builder.mutation<
      ConclusionVersion,
      { caseId: string; conclusionId: string }
    >({
      queryFn: async ({ caseId, conclusionId }) => {
        await wait();
        const database = readDatabase();
        const conclusion = database.conclusions.find(
          (item) => item.id === conclusionId && item.caseId === caseId,
        );
        if (!conclusion) {
          return { error: { status: "CUSTOM_ERROR", error: "结论不存在" } };
        }
        const stale = staleEntityIds(
          conclusion.entityVersions,
          caseEntityVersions(database, caseId),
        );
        if (stale.length === 0) {
          return {
            error: { status: "CUSTOM_ERROR", error: "结论无需重新核对。" },
          };
        }
        conclusion.entityVersions = caseEntityVersions(database, caseId);
        appendAudit(database, {
          caseId,
          actor: ACTOR,
          action: "重新核对结论",
          detail: `${conclusion.id} V${conclusion.version} 已按最新实体版本重新核对，恢复有效性。`,
        });
        commitDatabase(database);
        return { data: conclusion };
      },
      invalidatesTags: (_result, _error, input) => [
        { type: "Case", id: input.caseId },
        "Audit",
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
          return { error: { status: "CUSTOM_ERROR", error: "案件不存在" } };
        }
        if (status === "pending_review") {
          const hasSubmitted = database.conclusions.some(
            (item) => item.caseId === caseId && item.status === "submitted",
          );
          if (!hasSubmitted) {
            return {
              error: {
                status: "CUSTOM_ERROR",
                error: "请先提交一份结论版本，再进入复核。",
              },
            };
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
        commitDatabase(database);
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
          return { error: { status: "CUSTOM_ERROR", error: "结论不存在" } };
        }
        if (
          conclusion.status !== "submitted" &&
          conclusion.status !== "draft"
        ) {
          return {
            error: {
              status: "CUSTOM_ERROR",
              error: "当前版本不能再次复核。",
            },
          };
        }
        const stale = staleEntityIds(
          conclusion.entityVersions,
          caseEntityVersions(database, caseId),
        );
        if (decision === "approve" && stale.length > 0) {
          return {
            error: {
              status: "CUSTOM_ERROR",
              error: "案件内实体已更新，结论失效，请先重新核对再复核通过。",
            },
          };
        }
        conclusion.status = decision === "approve" ? "approved" : "returned";
        conclusion.reviewerNote = reviewerNote;
        const targetCase = database.cases.find((item) => item.id === caseId);
        if (targetCase) {
          targetCase.status = decision === "approve" ? "closed" : "supplement";
          targetCase.updatedAt = nowIso();
        }
        appendAudit(database, {
          caseId,
          actor: "赵平",
          action: decision === "approve" ? "复核通过" : "退回补证",
          detail: `${conclusion.id} 已${decision === "approve" ? "通过" : "退回"}。${reviewerNote}`,
        });
        commitDatabase(database);
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
  useGetSharedEntitiesQuery,
  useLinkAlertsToCaseMutation,
  useResetMockDataMutation,
  useResolvePendingEntityMutation,
  useRevalidateConclusionMutation,
  useReviewConclusionMutation,
  useSaveConclusionMutation,
  useTransitionCaseMutation,
  useUpdateAlertStatusMutation,
  useUpdateEntityMutation,
  useUpdateNodePlacementMutation,
  useVerifyEntityMutation,
  useVerifyRelationMutation,
} = bankApi;

export type { RiskLevel };
