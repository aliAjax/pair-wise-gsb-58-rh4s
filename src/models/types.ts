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

export type SharedEntityKind = "device" | "ip";

export interface SharedEntityAttributes {
  label: string;
  riskLevel: RiskLevel;
  note: string;
  evidenceStrength: EvidenceStrength;
  source: string;
  occurredAt: string;
}

export interface SharedEntityRevision {
  version: number;
  at: string;
  by: string;
  action: "migrate" | "update" | "verify" | "merge";
  snapshot: SharedEntityAttributes;
  note: string;
}

export interface SharedEntity extends SharedEntityAttributes {
  id: string;
  kind: SharedEntityKind;
  identifier: string;
  version: number;
  updatedAt: string;
  updatedBy: string;
  verifiedAt?: string;
  verifiedBy?: string;
  history: SharedEntityRevision[];
}

export interface PendingEntityMerge {
  id: string;
  kind: SharedEntityKind;
  identifier: string;
  nodeIds: string[];
  caseIds: string[];
  reason: string;
  createdAt: string;
}

export interface EntityFieldConflict {
  field: keyof SharedEntityAttributes;
  base: string;
  current: string;
  incoming: string;
  locked: boolean;
}

export interface EntityConflictInfo {
  entity: SharedEntity;
  fields: EntityFieldConflict[];
}

export interface GraphNodeData {
  label: string;
  kind: NodeKind;
  riskLevel: RiskLevel;
  note: string;
  evidenceStrength: EvidenceStrength;
  source: string;
  occurredAt: string;
  entityVersion?: number;
}

export interface InvestigationNode {
  id: string;
  caseId: string;
  entityId?: string;
  position: { x: number; y: number };
  data: GraphNodeData;
}

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
  invalidated?: {
    at: string;
    reason: string;
    entityId: string;
    entityVersion: number;
  };
  revalidated?: {
    at: string;
    by: string;
    note: string;
  };
}

export const isConclusionStale = (conclusion: ConclusionVersion): boolean =>
  Boolean(conclusion.invalidated && !conclusion.revalidated);

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
  entityId?: string;
  entityVersion?: number;
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
  nodes: InvestigationNode[];
  edges: InvestigationEdge[];
  evidence: Evidence[];
  conclusions: ConclusionVersion[];
  entities: SharedEntity[];
}

export interface EntityRegistry {
  entities: SharedEntity[];
  pendingMerges: PendingEntityMerge[];
  staleCaseIds: string[];
}

export interface DashboardSummary {
  newAlerts: number;
  highRiskAlerts: number;
  activeCases: number;
  pendingReview: number;
  totalExposure: number;
  sharedEntities: number;
  pendingEntityMerges: number;
  staleConclusions: number;
  caseStatusCounts: Record<CaseStatus, number>;
  riskCounts: Record<RiskLevel, number>;
}
