import type {
  Alert,
  AuditLog,
  CaseGraphPlacement,
  ConclusionVersion,
  Evidence,
  InvestigationCase,
  InvestigationEdge,
  InvestigationNode,
  MigrationReport,
  PendingEntityMerge,
  SharedEntity,
  SharedRelation,
} from "../models/types";

export const SCHEMA_VERSION = 2;

/** 当前（schema v2）数据库：实体与关系全库共享，证据与结论仍归各案件。 */
export interface MockDatabase {
  schemaVersion: typeof SCHEMA_VERSION;
  alerts: Alert[];
  cases: InvestigationCase[];
  entities: SharedEntity[];
  relations: SharedRelation[];
  placements: CaseGraphPlacement[];
  evidence: Evidence[];
  conclusions: ConclusionVersion[];
  auditLogs: AuditLog[];
  pendingEntities: PendingEntityMerge[];
  migration?: MigrationReport;
}

/** 旧版（schema v1）数据库：每个案件各存一份节点与关系。 */
export interface LegacyMockDatabase {
  schemaVersion?: number;
  alerts: Alert[];
  cases: InvestigationCase[];
  nodes: InvestigationNode[];
  edges: InvestigationEdge[];
  evidence: Evidence[];
  conclusions: Array<Omit<ConclusionVersion, "entityVersions"> & { entityVersions?: Record<string, number> }>;
  auditLogs: AuditLog[];
}

export const createId = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export const nowIso = (): string => new Date().toISOString();

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
