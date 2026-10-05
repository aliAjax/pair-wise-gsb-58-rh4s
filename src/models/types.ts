export type RiskLevel = "high" | "medium" | "low";
export type AlertStatus = "new" | "triage" | "linked" | "dismissed";
export type CaseStatus =
  | "investigating"
  | "pending_review"
  | "supplement"
  | "closed";
export type EvidenceStrength = "strong" | "medium" | "weak";
export type NodeKind = "account" | "device" | "ip" | "merchant";
export type EdgeKind = "transfer" | "shared_device" | "shared_ip" | "payee";
export type CaseDisposition = "freeze" | "release" | "observe";
export type ConclusionStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "returned";

export interface Alert {
  id: string;
  title: string;
  account: string;
  counterparty: string;
  channel: string;
  amount: number;
  riskLevel: RiskLevel;
  score: number;
  status: AlertStatus;
  detectedAt: string;
  tags: string[];
  deviceId: string;
  ip: string;
  caseId?: string;
}

export interface GraphNodeData {
  label: string;
  kind: NodeKind;
  riskLevel: RiskLevel;
  note: string;
  evidenceStrength: EvidenceStrength;
  source: string;
  occurredAt: string;
}

/** 旧版（schema v1）按案件各存一份的图谱节点，仅用于数据迁移。 */
export interface InvestigationNode {
  id: string;
  caseId: string;
  position: { x: number; y: number };
  data: GraphNodeData;
}

/** 旧版（schema v1）按案件各存一份的关系边，仅用于数据迁移。 */
export interface InvestigationEdge {
  id: string;
  caseId: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label: string;
  amount?: number;
  occurredAt: string;
  explanation: string;
}

/* ===== 共享实体记录（schema v2） ===== */

/** 可被调查的实体属性字段，并发合并以字段为最小单位。 */
export type EntityAttributeField =
  | "label"
  | "riskLevel"
  | "note"
  | "evidenceStrength"
  | "source"
  | "occurredAt";

export interface FieldStamp {
  /** 该字段最后一次被修改时的实体版本 */
  version: number;
  updatedBy: string;
  updatedAt: string;
}

/**
 * 共享实体：设备、IP、账户、商户在全库只保存一份，
 * 所有案件的图谱、时间轴、审计和导出都解析到同一条记录。
 */
export interface SharedEntity {
  id: string;
  kind: NodeKind;
  /** 归并键，例如 device:DV-A91F / ip:117.136.40.17 */
  canonicalKey: string;
  label: string;
  riskLevel: RiskLevel;
  note: string;
  evidenceStrength: EvidenceStrength;
  source: string;
  /** 关联时间 */
  occurredAt: string;
  /** 实体版本，任何属性更新都会 +1 */
  version: number;
  /** 已核验到的版本；不等于 version 时表示核验已失效 */
  verifiedVersion?: number;
  verifiedBy?: string;
  verifiedAt?: string;
  updatedAt: string;
  updatedBy: string;
  fieldStamps: Partial<Record<EntityAttributeField, FieldStamp>>;
  /** 迁移时归并进来的旧节点 id */
  mergedFrom: string[];
}

/** 共享关系：跨案件唯一，案件通过 caseIds 引用同一条关系。 */
export interface SharedRelation {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  kind: EdgeKind;
  label: string;
  amount?: number;
  occurredAt: string;
  explanation: string;
  caseIds: string[];
  version: number;
  verifiedVersion?: number;
  verifiedBy?: string;
  verifiedAt?: string;
  updatedAt: string;
  updatedBy: string;
}

/** 案件图谱只保存布局（位置），实体内容来自共享记录。 */
export interface CaseGraphPlacement {
  caseId: string;
  entityId: string;
  position: { x: number; y: number };
}

/** 迁移时无法确认标识、列入待核的重复节点。 */
export interface PendingEntityMerge {
  id: string;
  kind: NodeKind;
  label: string;
  reason: string;
  caseIds: string[];
  sourceNodeIds: string[];
  draft: GraphNodeData;
  status: "pending" | "merged" | "dismissed";
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolvedKey?: string;
}

export interface MigrationReport {
  schemaVersion: number;
  ranAt: string;
  mergedEntityCount: number;
  duplicateNodeCount: number;
  mergedRelationCount: number;
  droppedRelationCount: number;
  pendingCount: number;
}

/** 案件图谱节点视图：布局 + 共享实体解析结果。 */
export interface CaseGraphNode {
  /** 与共享实体 id 一致 */
  id: string;
  caseId: string;
  position: { x: number; y: number };
  data: GraphNodeData;
  entityVersion: number;
  verified: boolean;
  verifiedBy?: string;
}

/** 案件图谱关系视图：共享关系在案件内的投影。 */
export interface CaseGraphEdge {
  id: string;
  caseId: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label: string;
  amount?: number;
  occurredAt: string;
  explanation: string;
  relationVersion: number;
  verified: boolean;
  verifiedBy?: string;
}

export interface EntityFieldConflict {
  field: EntityAttributeField;
  currentValue: string;
  attemptedValue: string;
  updatedBy: string;
  updatedAt: string;
  /** 对方已核验当前版本，默认不可覆盖 */
  verifiedByOther: boolean;
}

export type EntityChangeSet = Partial<
  Pick<SharedEntity, EntityAttributeField>
>;

export type EntityUpdateResult =
  | {
      status: "saved";
      entity: SharedEntity;
      changedFields: EntityAttributeField[];
      invalidatedCaseIds: string[];
    }
  | { status: "conflict"; entity: SharedEntity; conflicts: EntityFieldConflict[] };

export interface Evidence {
  id: string;
  caseId: string;
  title: string;
  source: string;
  strength: EvidenceStrength;
  occurredAt: string;
  submittedAt: string;
  submittedBy: string;
  attachment: string;
  note: string;
  version: number;
}

export interface ConclusionVersion {
  id: string;
  caseId: string;
  version: number;
  status: ConclusionStatus;
  disposition: CaseDisposition;
  rationale: string;
  riskControls: string[];
  createdBy: string;
  createdAt: string;
  reviewer: string;
  reviewerNote?: string;
  /** 保存结论时案件图谱内共享实体的版本快照，用于失效判定 */
  entityVersions: Record<string, number>;
}

/** 结论视图：附带因实体更新而失效的实体列表。 */
export interface ConclusionView extends ConclusionVersion {
  staleEntityIds: string[];
}

export interface InvestigationCase {
  id: string;
  title: string;
  status: CaseStatus;
  riskLevel: RiskLevel;
  owner: string;
  openedAt: string;
  updatedAt: string;
  summary: string;
  alertIds: string[];
  nextReviewAt: string;
}

export interface AuditLog {
  id: string;
  caseId?: string;
  at: string;
  actor: string;
  action: string;
  detail: string;
}

export interface AlertFilters {
  keyword: string;
  riskLevel: RiskLevel | "all";
  status: AlertStatus | "all";
  channel: string;
}

export interface CaseWorkspace {
  case: InvestigationCase;
  nodes: CaseGraphNode[];
  edges: CaseGraphEdge[];
  evidence: Evidence[];
  conclusions: ConclusionView[];
}

export interface DashboardSummary {
  newAlerts: number;
  highRiskAlerts: number;
  activeCases: number;
  pendingReview: number;
  totalExposure: number;
  caseStatusCounts: Record<CaseStatus, number>;
  riskCounts: Record<RiskLevel, number>;
}
