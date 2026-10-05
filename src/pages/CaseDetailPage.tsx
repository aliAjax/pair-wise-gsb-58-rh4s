import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Divider,
  Grid,
  Group,
  Modal,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  ArrowLeft,
  Check,
  FilePlus2,
  GitBranchPlus,
  PencilLine,
  RotateCcw,
  Send,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAppDispatch, useAppSelector } from "../app/hooks";
import {
  CaseStatusBadge,
  ConclusionStatusBadge,
  EvidenceStrengthBadge,
  RiskBadge,
  VerificationBadge,
} from "../components/Badges";
import {
  focusEvidence,
  focusTimeline,
  selectNode,
} from "../features/alerts/alertsSlice";
import { InvestigationGraph } from "../features/graph/InvestigationGraph";
import {
  TransactionTimeline,
  type TimelineEvent,
} from "../features/timeline/TransactionTimeline";
import type {
  CaseDisposition,
  CaseGraphNode,
  EntityAttributeField,
  EntityChangeSet,
  EntityFieldConflict,
  EvidenceStrength,
  NodeKind,
  RiskLevel,
  SharedEntity,
} from "../models/types";
import {
  useAddEvidenceMutation,
  useAddGraphNodeMutation,
  useGetAlertsQuery,
  useGetCaseWorkspaceQuery,
  useRevalidateConclusionMutation,
  useReviewConclusionMutation,
  useSaveConclusionMutation,
  useTransitionCaseMutation,
  useUpdateEntityMutation,
  useUpdateNodePlacementMutation,
  useVerifyEntityMutation,
  useVerifyRelationMutation,
} from "../services/api";

const dispositionLabels: Record<CaseDisposition, string> = {
  freeze: "建议冻结",
  release: "建议放行",
  observe: "继续观察",
};

const entityFieldLabels: Record<EntityAttributeField, string> = {
  label: "名称",
  riskLevel: "风险等级",
  note: "说明",
  evidenceStrength: "证据强度",
  source: "来源",
  occurredAt: "关联时间",
};

const toDateTimeInput = (iso: string): string => {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const errorMessage = (error: unknown): string => {
  if (typeof error === "object" && error && "error" in error) {
    return String(error.error);
  }
  return "操作失败，请检查输入后重试。";
};

export function CaseDetailPage() {
  const { caseId = "" } = useParams();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const selectedNodeId = useAppSelector(
    (state) => state.alertsUi.selectedNodeId,
  );
  const focusedTimelineId = useAppSelector(
    (state) => state.alertsUi.focusedTimelineId,
  );
  const focusedEvidenceId = useAppSelector(
    (state) => state.alertsUi.focusedEvidenceId,
  );
  const { data, isLoading, error } = useGetCaseWorkspaceQuery(caseId);
  const { data: allAlerts = [] } = useGetAlertsQuery({
    keyword: "",
    riskLevel: "all",
    status: "all",
    channel: "",
  });
  const [addNode] = useAddGraphNodeMutation();
  const [updatePlacement] = useUpdateNodePlacementMutation();
  const [updateEntity] = useUpdateEntityMutation();
  const [verifyEntity] = useVerifyEntityMutation();
  const [verifyRelation] = useVerifyRelationMutation();
  const [revalidateConclusion, { isLoading: isRevalidating }] =
    useRevalidateConclusionMutation();
  const [addEvidence, { isLoading: isAddingEvidence }] =
    useAddEvidenceMutation();
  const [saveConclusion, { isLoading: isSavingConclusion }] =
    useSaveConclusionMutation();
  const [transitionCase, { isLoading: isTransitioning }] =
    useTransitionCaseMutation();
  const [reviewConclusion, { isLoading: isReviewing }] =
    useReviewConclusionMutation();

  const [nodeOpened, nodeModal] = useDisclosure(false);
  const [evidenceOpened, evidenceModal] = useDisclosure(false);
  const [conclusionOpened, conclusionModal] = useDisclosure(false);
  const [reviewNote, setReviewNote] = useState("");
  const [nodeForm, setNodeForm] = useState({
    sourceId: "",
    kind: "account" as NodeKind,
    label: "",
    riskLevel: "medium" as RiskLevel,
    evidenceStrength: "medium" as EvidenceStrength,
    source: "",
    occurredAt: "2026-09-29T09:00",
    note: "",
    relationLabel: "",
    relationExplanation: "",
    amount: 0,
  });
  const [evidenceForm, setEvidenceForm] = useState({
    title: "",
    source: "",
    strength: "medium" as EvidenceStrength,
    occurredAt: "2026-09-29T09:00",
    attachment: "",
    note: "",
  });
  const [conclusionForm, setConclusionForm] = useState({
    disposition: "observe" as CaseDisposition,
    rationale: "",
    riskControls: "",
  });
  const [entityOpened, entityModal] = useDisclosure(false);
  const [conflictOpened, conflictModal] = useDisclosure(false);
  const [entityForm, setEntityForm] = useState({
    entityId: "",
    baseVersion: 0,
    label: "",
    riskLevel: "medium" as RiskLevel,
    evidenceStrength: "medium" as EvidenceStrength,
    source: "",
    occurredAt: "",
    note: "",
  });
  const [conflictState, setConflictState] = useState<{
    entity: SharedEntity;
    conflicts: EntityFieldConflict[];
    changes: EntityChangeSet;
    baseVersion: number;
  } | null>(null);
  const [resolutions, setResolutions] = useState<
    Partial<Record<EntityAttributeField, "mine" | "theirs">>
  >({});
  const [allowOverrideVerified, setAllowOverrideVerified] = useState(false);

  if (isLoading) {
    return <Text>正在加载案件工作区...</Text>;
  }

  if (error || !data) {
    return (
      <Alert color="red" title="案件加载失败">
        {errorMessage(error)}
      </Alert>
    );
  }

  const caseAlerts = allAlerts.filter((item) =>
    data.case.alertIds.includes(item.id),
  );
  const selectedNode = data.nodes.find((item) => item.id === selectedNodeId);
  const selectedNodeRelations = selectedNode
    ? data.edges.filter(
        (item) =>
          item.source === selectedNode.id || item.target === selectedNode.id,
      )
    : [];
  const latestConclusion = data.conclusions[0];
  const latestConclusionStale =
    (latestConclusion?.staleEntityIds.length ?? 0) > 0;
  const entityLabel = (entityId: string) =>
    data.nodes.find((item) => item.id === entityId)?.data.label ?? entityId;

  const handleTimelineFocus = (event?: TimelineEvent) => {
    dispatch(focusTimeline(event?.id));
    dispatch(focusEvidence(event?.source === "evidence" ? event.id : undefined));
    if (event?.source === "transaction") {
      const edge = data.edges.find((item) => item.id === event.id);
      if (edge) {
        dispatch(selectNode(edge.target));
      }
    }
  };

  const handleAddNode = async () => {
    if (!nodeForm.sourceId || !nodeForm.label.trim() || !nodeForm.source.trim()) {
      notifications.show({
        color: "red",
        title: "信息不完整",
        message: "关系源节点、节点名称和证据来源均为必填项。",
      });
      return;
    }
    try {
      const result = await addNode({
        caseId,
        node: {
          kind: nodeForm.kind,
          label: nodeForm.label.trim(),
          riskLevel: nodeForm.riskLevel,
          evidenceStrength: nodeForm.evidenceStrength,
          source: nodeForm.source.trim(),
          occurredAt: new Date(nodeForm.occurredAt).toISOString(),
          note: nodeForm.note.trim() || "待补充关系说明。",
        },
        relation: {
          sourceEntityId: nodeForm.sourceId,
          kind: "transfer",
          label: nodeForm.relationLabel.trim() || "已登记关系",
          explanation:
            nodeForm.relationExplanation.trim() ||
            "关系来自调查员登记，需结合来源材料复核。",
          amount: nodeForm.amount || undefined,
        },
      }).unwrap();
      if (result.status === "pending") {
        notifications.show({
          color: "orange",
          title: "已列入待核",
          message: "无法确认设备号或 IP，节点未进图谱，已列入待核列表。",
        });
      } else {
        notifications.show({
          color: "teal",
          title: result.reusedEntity ? "已引用共享实体" : "节点已加入",
          message: result.reusedEntity
            ? "该设备 / IP 已有共享记录，本案直接引用同一版本。"
            : "图谱、证据来源和审计日志已同步更新。",
        });
      }
      nodeModal.close();
      setNodeForm((current) => ({
        ...current,
        label: "",
        source: "",
        note: "",
      }));
    } catch (mutationError) {
      notifications.show({
        color: "red",
        title: "加入失败",
        message: errorMessage(mutationError),
      });
    }
  };

  const openEntityEditor = (node: CaseGraphNode) => {
    setEntityForm({
      entityId: node.id,
      baseVersion: node.entityVersion,
      label: node.data.label,
      riskLevel: node.data.riskLevel,
      evidenceStrength: node.data.evidenceStrength,
      source: node.data.source,
      occurredAt: toDateTimeInput(node.data.occurredAt),
      note: node.data.note,
    });
    entityModal.open();
  };

  const entityChangesFromForm = (): EntityChangeSet => ({
    label: entityForm.label.trim(),
    riskLevel: entityForm.riskLevel,
    evidenceStrength: entityForm.evidenceStrength,
    source: entityForm.source.trim(),
    occurredAt: new Date(entityForm.occurredAt).toISOString(),
    note: entityForm.note.trim(),
  });

  const notifyEntitySaved = (
    version: number,
    invalidatedCaseIds: string[],
  ) => {
    notifications.show({
      color: "teal",
      title: `实体已更新为 V${version}`,
      message:
        invalidatedCaseIds.length > 0
          ? `${invalidatedCaseIds.join("、")} 的旧结论已失效，需重新核对后恢复。`
          : "共享实体记录已更新。",
    });
  };

  const handleSaveEntity = async () => {
    try {
      const result = await updateEntity({
        entityId: entityForm.entityId,
        baseVersion: entityForm.baseVersion,
        changes: entityChangesFromForm(),
      }).unwrap();
      if (result.status === "conflict") {
        setConflictState({
          entity: result.entity,
          conflicts: result.conflicts,
          changes: entityChangesFromForm(),
          baseVersion: entityForm.baseVersion,
        });
        setResolutions({});
        setAllowOverrideVerified(false);
        entityModal.close();
        conflictModal.open();
        return;
      }
      notifyEntitySaved(result.entity.version, result.invalidatedCaseIds);
      entityModal.close();
    } catch (mutationError) {
      notifications.show({
        color: "red",
        title: "实体保存失败",
        message: errorMessage(mutationError),
      });
    }
  };

  const handleResolveConflicts = async () => {
    if (!conflictState) {
      return;
    }
    const unresolved = conflictState.conflicts.filter(
      (conflict) => !resolutions[conflict.field],
    );
    if (unresolved.length > 0) {
      notifications.show({
        color: "red",
        title: "尚有未处理的冲突",
        message: "请为每个冲突字段选择保留对方或使用我的。",
      });
      return;
    }
    const overridingVerified = conflictState.conflicts.some(
      (conflict) =>
        conflict.verifiedByOther && resolutions[conflict.field] === "mine",
    );
    if (overridingVerified && !allowOverrideVerified) {
      notifications.show({
        color: "red",
        title: "需要确认覆盖",
        message: "覆盖他人已核验的字段前，请勾选确认框。",
      });
      return;
    }
    try {
      const result = await updateEntity({
        entityId: conflictState.entity.id,
        baseVersion: conflictState.baseVersion,
        changes: conflictState.changes,
        resolutions,
        allowOverrideVerified,
      }).unwrap();
      if (result.status === "conflict") {
        setConflictState({
          entity: result.entity,
          conflicts: result.conflicts,
          changes: conflictState.changes,
          baseVersion: conflictState.baseVersion,
        });
        notifications.show({
          color: "orange",
          title: "仍存在冲突",
          message: "对方在你裁决期间又更新了字段，请再次处理。",
        });
        return;
      }
      notifyEntitySaved(result.entity.version, result.invalidatedCaseIds);
      conflictModal.close();
      setConflictState(null);
    } catch (mutationError) {
      notifications.show({
        color: "red",
        title: "冲突提交失败",
        message: errorMessage(mutationError),
      });
    }
  };

  const handleVerifyEntity = async (entityId: string) => {
    try {
      await verifyEntity({ entityId }).unwrap();
      notifications.show({
        color: "teal",
        title: "实体已核验",
        message: "核验记录已写入审计，全部引用案件可见同一版本。",
      });
    } catch (mutationError) {
      notifications.show({
        color: "red",
        title: "核验失败",
        message: errorMessage(mutationError),
      });
    }
  };

  const handleVerifyRelation = async (relationId: string) => {
    try {
      await verifyRelation({ relationId, caseId }).unwrap();
      notifications.show({
        color: "teal",
        title: "关系已核验",
        message: "核验状态对全部引用案件同步生效。",
      });
    } catch (mutationError) {
      notifications.show({
        color: "red",
        title: "核验失败",
        message: errorMessage(mutationError),
      });
    }
  };

  const handleRevalidate = async (conclusionId: string) => {
    try {
      await revalidateConclusion({ caseId, conclusionId }).unwrap();
      notifications.show({
        color: "teal",
        title: "已重新核对",
        message: "结论已按最新实体版本恢复有效。",
      });
    } catch (mutationError) {
      notifications.show({
        color: "red",
        title: "重新核对失败",
        message: errorMessage(mutationError),
      });
    }
  };

  const handleAddEvidence = async () => {
    if (
      !evidenceForm.title.trim() ||
      !evidenceForm.source.trim() ||
      !evidenceForm.attachment.trim()
    ) {
      notifications.show({
        color: "red",
        title: "信息不完整",
        message: "证据名称、来源和附件标识均为必填项。",
      });
      return;
    }
    try {
      await addEvidence({
        caseId,
        title: evidenceForm.title.trim(),
        source: evidenceForm.source.trim(),
        strength: evidenceForm.strength,
        occurredAt: new Date(evidenceForm.occurredAt).toISOString(),
        attachment: evidenceForm.attachment.trim(),
        note: evidenceForm.note.trim() || "未补充说明。",
      }).unwrap();
      notifications.show({
        color: "teal",
        title: "证据已登记",
        message: "证据来源、发生时间与提交时间已写入台账。",
      });
      evidenceModal.close();
      setEvidenceForm((current) => ({
        ...current,
        title: "",
        source: "",
        attachment: "",
        note: "",
      }));
    } catch (mutationError) {
      notifications.show({
        color: "red",
        title: "证据登记失败",
        message: errorMessage(mutationError),
      });
    }
  };

  const handleSaveConclusion = async (submit: boolean) => {
    if (conclusionForm.rationale.trim().length < 12) {
      notifications.show({
        color: "red",
        title: "结论依据不足",
        message: "结论说明至少需要 12 个字符。",
      });
      return;
    }
    try {
      await saveConclusion({
        caseId,
        disposition: conclusionForm.disposition,
        rationale: conclusionForm.rationale.trim(),
        riskControls: conclusionForm.riskControls
          .split("\n")
          .map((item) => item.trim())
          .filter(Boolean),
        submit,
      }).unwrap();
      notifications.show({
        color: "teal",
        title: submit ? "已提交复核" : "草稿已保存",
        message: "结论版本已锁定创建人和创建时间。",
      });
      conclusionModal.close();
      setConclusionForm({
        disposition: "observe",
        rationale: "",
        riskControls: "",
      });
    } catch (mutationError) {
      notifications.show({
        color: "red",
        title: "结论保存失败",
        message: errorMessage(mutationError),
      });
    }
  };

  const handleTransition = async (
    status: "investigating" | "pending_review" | "supplement" | "closed",
  ) => {
    try {
      await transitionCase({ caseId, status }).unwrap();
      notifications.show({
        color: "teal",
        title: "状态已更新",
        message: `案件状态已流转为 ${status}。`,
      });
    } catch (mutationError) {
      notifications.show({
        color: "red",
        title: "状态流转失败",
        message: errorMessage(mutationError),
      });
    }
  };

  const handleReview = async (decision: "approve" | "return") => {
    if (!latestConclusion) {
      return;
    }
    if (reviewNote.trim().length < 6) {
      notifications.show({
        color: "red",
        title: "复核意见不足",
        message: "复核意见至少需要 6 个字符。",
      });
      return;
    }
    try {
      await reviewConclusion({
        caseId,
        conclusionId: latestConclusion.id,
        decision,
        reviewerNote: reviewNote.trim(),
      }).unwrap();
      notifications.show({
        color: decision === "approve" ? "teal" : "orange",
        title: decision === "approve" ? "复核通过" : "已退回补证",
        message: "复核动作和意见已写入审计日志。",
      });
      setReviewNote("");
    } catch (mutationError) {
      notifications.show({
        color: "red",
        title: "复核失败",
        message: errorMessage(mutationError),
      });
    }
  };

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <Group align="flex-start">
          <Button
            variant="subtle"
            px={6}
            leftSection={<ArrowLeft size={16} />}
            onClick={() => navigate("/cases")}
          >
            返回案件
          </Button>
          <div>
            <Group gap="sm">
              <Title order={2}>{data.case.title}</Title>
              <RiskBadge value={data.case.riskLevel} />
              <CaseStatusBadge value={data.case.status} />
            </Group>
            <Text c="dimmed" size="sm" mt={5}>
              {data.case.id} · 负责人 {data.case.owner} · 更新于{" "}
              {new Date(data.case.updatedAt).toLocaleString("zh-CN", {
                hour12: false,
              })}
            </Text>
          </div>
        </Group>
        <Group>
          <Button
            variant="default"
            leftSection={<GitBranchPlus size={16} />}
            onClick={nodeModal.open}
          >
            加入图谱节点
          </Button>
          <Button
            variant="light"
            leftSection={<FilePlus2 size={16} />}
            onClick={evidenceModal.open}
          >
            登记证据
          </Button>
          <Button
            leftSection={<Send size={16} />}
            onClick={conclusionModal.open}
          >
            新建结论版本
          </Button>
        </Group>
      </Group>

      <Paper withBorder p="md">
        <Group justify="space-between">
          <div>
            <Text size="sm" fw={600}>
              案件摘要
            </Text>
            <Text size="sm" c="dimmed" mt={4}>
              {data.case.summary}
            </Text>
          </div>
          <Group>
            <Button
              size="xs"
              variant="default"
              loading={isTransitioning}
              onClick={() => handleTransition("investigating")}
            >
              标记调查中
            </Button>
            <Button
              size="xs"
              variant="light"
              loading={isTransitioning}
              onClick={() => handleTransition("pending_review")}
            >
              提交复核
            </Button>
            <Button
              size="xs"
              variant="light"
              color="orange"
              loading={isTransitioning}
              onClick={() => handleTransition("supplement")}
            >
              要求补证
            </Button>
            <Button
              size="xs"
              variant="light"
              color="teal"
              loading={isTransitioning}
              onClick={() => handleTransition("closed")}
            >
              关闭案件
            </Button>
          </Group>
        </Group>
      </Paper>

      <Tabs defaultValue="graph" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="graph">关系图谱与时间轴</Tabs.Tab>
          <Tabs.Tab value="evidence">证据台账</Tabs.Tab>
          <Tabs.Tab value="conclusions">结论与复核</Tabs.Tab>
          <Tabs.Tab value="alerts">关联告警</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="graph" pt="md">
          <Grid>
            <Grid.Col span={{ base: 12, xl: 8 }}>
              <Paper withBorder>
                <Group justify="space-between" p="sm">
                  <div>
                    <Text size="sm" fw={600}>
                      案件关系图谱
                    </Text>
                    <Text size="xs" c="dimmed">
                      拖动节点可调整布局；关联关系必须结合解释和证据复核。
                    </Text>
                  </div>
                  <Badge variant="light" color="gray">
                    {data.nodes.length} 节点 / {data.edges.length} 关系
                  </Badge>
                </Group>
                <Divider />
                <InvestigationGraph
                  nodes={data.nodes}
                  edges={data.edges}
                  selectedNodeId={selectedNodeId}
                  focusedTimelineId={focusedTimelineId}
                  onSelectNode={(nodeId) => dispatch(selectNode(nodeId))}
                  onNodePositionChange={(nodeId, position) => {
                    void updatePlacement({
                      caseId,
                      entityId: nodeId,
                      position,
                    });
                  }}
                />
              </Paper>
              {selectedNode ? (
                <Paper withBorder p="md" mt="md">
                  <Group justify="space-between">
                    <div>
                      <Group gap="xs">
                        <Text fw={600}>{selectedNode.data.label}</Text>
                        <Badge variant="light" color="gray">
                          实体 V{selectedNode.entityVersion}
                        </Badge>
                        <VerificationBadge verified={selectedNode.verified} />
                      </Group>
                      <Text size="xs" c="dimmed" mt={4}>
                        共享实体记录 · {selectedNode.data.source} ·{" "}
                        {new Date(
                          selectedNode.data.occurredAt,
                        ).toLocaleString("zh-CN", { hour12: false })}
                        {selectedNode.verifiedBy
                          ? ` · 核验人 ${selectedNode.verifiedBy}`
                          : ""}
                      </Text>
                    </div>
                    <Group gap="xs">
                      <EvidenceStrengthBadge
                        value={selectedNode.data.evidenceStrength}
                      />
                      <Button
                        size="xs"
                        variant="default"
                        leftSection={<PencilLine size={14} />}
                        onClick={() => openEntityEditor(selectedNode)}
                      >
                        编辑共享属性
                      </Button>
                      <Button
                        size="xs"
                        variant="light"
                        color="teal"
                        leftSection={<ShieldCheck size={14} />}
                        disabled={selectedNode.verified}
                        onClick={() => handleVerifyEntity(selectedNode.id)}
                      >
                        {selectedNode.verified ? "已核验" : "核验当前版本"}
                      </Button>
                    </Group>
                  </Group>
                  <Text size="sm" mt="sm">
                    {selectedNode.data.note}
                  </Text>
                  {selectedNodeRelations.length > 0 ? (
                    <>
                      <Divider my="sm" />
                      <Text size="xs" fw={600} c="dimmed" mb={6}>
                        关联的共享关系（核验状态全案同步）
                      </Text>
                      <Stack gap={6}>
                        {selectedNodeRelations.map((relation) => (
                          <Group key={relation.id} justify="space-between">
                            <Group gap="xs">
                              <Text size="xs">{relation.label}</Text>
                              <Badge size="xs" variant="light" color="gray">
                                关系 V{relation.relationVersion}
                              </Badge>
                              <VerificationBadge
                                verified={relation.verified}
                              />
                            </Group>
                            <Button
                              size="compact-xs"
                              variant="subtle"
                              color="teal"
                              disabled={relation.verified}
                              onClick={() => handleVerifyRelation(relation.id)}
                            >
                              {relation.verified
                                ? `已核验${relation.verifiedBy ? ` · ${relation.verifiedBy}` : ""}`
                                : "核验关系"}
                            </Button>
                          </Group>
                        ))}
                      </Stack>
                    </>
                  ) : null}
                </Paper>
              ) : null}
            </Grid.Col>
            <Grid.Col span={{ base: 12, xl: 4 }}>
              <Paper withBorder h={selectedNode ? 820 : 620}>
                <Group justify="space-between" p="sm">
                  <div>
                    <Text size="sm" fw={600}>
                      联动时间轴
                    </Text>
                    <Text size="xs" c="dimmed">
                      点击事件可高亮关系或证据
                    </Text>
                  </div>
                  {focusedTimelineId ? (
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      leftSection={<RotateCcw size={13} />}
                      onClick={() => handleTimelineFocus(undefined)}
                    >
                      清除
                    </Button>
                  ) : null}
                </Group>
                <Divider />
                <div style={{ height: selectedNode ? 760 : 560, padding: 12 }}>
                  <TransactionTimeline
                    alerts={caseAlerts}
                    edges={data.edges}
                    evidence={data.evidence}
                    focusedId={focusedTimelineId}
                    onFocus={handleTimelineFocus}
                  />
                </div>
              </Paper>
            </Grid.Col>
          </Grid>
        </Tabs.Panel>

        <Tabs.Panel value="evidence" pt="md">
          <Paper withBorder>
            <Group justify="space-between" p="md">
              <div>
                <Text fw={600}>证据台账</Text>
                <Text size="sm" c="dimmed">
                  每份证据记录来源、发生时间、提交时间和证据强度。
                </Text>
              </div>
              <Button
                leftSection={<FilePlus2 size={16} />}
                onClick={evidenceModal.open}
              >
                登记证据
              </Button>
            </Group>
            <Table.ScrollContainer minWidth={980}>
              <Table highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>证据名称</Table.Th>
                    <Table.Th>来源</Table.Th>
                    <Table.Th>强度</Table.Th>
                    <Table.Th>发生时间</Table.Th>
                    <Table.Th>提交记录</Table.Th>
                    <Table.Th>附件标识</Table.Th>
                    <Table.Th>说明</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {data.evidence.map((item) => (
                    <Table.Tr
                      key={item.id}
                      className={
                        focusedEvidenceId === item.id
                          ? "table-row-focused"
                          : ""
                      }
                    >
                      <Table.Td>
                        <Text size="sm" fw={600}>
                          {item.title}
                        </Text>
                        <Text size="xs" c="dimmed" ff="monospace">
                          {item.id}
                        </Text>
                      </Table.Td>
                      <Table.Td>{item.source}</Table.Td>
                      <Table.Td>
                        <EvidenceStrengthBadge value={item.strength} />
                      </Table.Td>
                      <Table.Td>
                        {new Date(item.occurredAt).toLocaleString("zh-CN", {
                          hour12: false,
                        })}
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs">
                          {item.submittedBy} · V{item.version}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {new Date(item.submittedAt).toLocaleString("zh-CN", {
                            hour12: false,
                          })}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" ff="monospace">
                          {item.attachment}
                        </Text>
                      </Table.Td>
                      <Table.Td maw={300}>
                        <Text size="xs" c="dimmed">
                          {item.note}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Paper>
        </Tabs.Panel>

        <Tabs.Panel value="conclusions" pt="md">
          <Grid>
            <Grid.Col span={{ base: 12, lg: 7 }}>
              <Paper withBorder>
                <Group justify="space-between" p="md">
                  <div>
                    <Text fw={600}>结论版本</Text>
                    <Text size="sm" c="dimmed">
                      已通过的版本不可被覆盖，后续修改将产生新版本。
                    </Text>
                  </div>
                  <Button onClick={conclusionModal.open}>新建版本</Button>
                </Group>
                <Stack gap={0}>
                  {data.conclusions.map((item, index) => (
                    <div key={item.id}>
                      {index > 0 ? <Divider /> : null}
                      <Stack gap="xs" p="md">
                        <Group justify="space-between">
                          <Group>
                            <Text fw={600}>V{item.version}</Text>
                            <ConclusionStatusBadge value={item.status} />
                            <Badge variant="light" color="gray">
                              {dispositionLabels[item.disposition]}
                            </Badge>
                            {item.staleEntityIds.length > 0 ? (
                              <Badge variant="light" color="red">
                                待重新核对
                              </Badge>
                            ) : null}
                          </Group>
                          <Text size="xs" c="dimmed">
                            {item.createdBy} ·{" "}
                            {new Date(item.createdAt).toLocaleString("zh-CN", {
                              hour12: false,
                            })}
                          </Text>
                        </Group>
                        {item.staleEntityIds.length > 0 ? (
                          <Alert
                            color="orange"
                            title="实体已更新，结论暂时失效"
                          >
                            <Text size="sm">
                              {item.staleEntityIds.map(entityLabel).join("、")}
                              的共享记录在该结论保存后发生变化，需重新核对后才能恢复。
                            </Text>
                            <Button
                              size="compact-xs"
                              variant="light"
                              color="orange"
                              mt="xs"
                              loading={isRevalidating}
                              onClick={() => handleRevalidate(item.id)}
                            >
                              重新核对
                            </Button>
                          </Alert>
                        ) : null}
                        <Text size="sm">{item.rationale}</Text>
                        <Group gap="xs">
                          {item.riskControls.map((control) => (
                            <Badge key={control} variant="outline" color="gray">
                              {control}
                            </Badge>
                          ))}
                        </Group>
                        {item.reviewerNote ? (
                          <Alert
                            color={
                              item.status === "approved" ? "teal" : "orange"
                            }
                            title={`复核意见 · ${item.reviewer}`}
                          >
                            {item.reviewerNote}
                          </Alert>
                        ) : null}
                      </Stack>
                    </div>
                  ))}
                </Stack>
              </Paper>
            </Grid.Col>
            <Grid.Col span={{ base: 12, lg: 5 }}>
              <Paper withBorder p="md">
                <Title order={4}>复核操作</Title>
                {latestConclusion ? (
                  <>
                    <Text size="sm" c="dimmed" mt={5}>
                      当前版本 V{latestConclusion.version} ·{" "}
                      {dispositionLabels[latestConclusion.disposition]}
                    </Text>
                    <Alert
                      color="orange"
                      icon={<RotateCcw size={16} />}
                      mt="md"
                    >
                      关系关联不能直接作为结论。通过前应检查证据来源、发生时间与证据强度。
                    </Alert>
                    {latestConclusionStale ? (
                      <Alert color="red" mt="md" title="结论已失效">
                        案件内共享实体在结论保存后已更新，请先重新核对，恢复后才能复核通过。
                      </Alert>
                    ) : null}
                    <Textarea
                      label="复核意见"
                      description="通过或退回意见均进入不可删除的审计记录"
                      minRows={4}
                      mt="md"
                      value={reviewNote}
                      onChange={(event) =>
                        setReviewNote(event.currentTarget.value)
                      }
                    />
                    <Group mt="md">
                      <Button
                        leftSection={<Check size={16} />}
                        color="teal"
                        loading={isReviewing}
                        disabled={latestConclusionStale}
                        onClick={() => handleReview("approve")}
                      >
                        复核通过
                      </Button>
                      <Button
                        variant="light"
                        color="orange"
                        leftSection={<RotateCcw size={16} />}
                        loading={isReviewing}
                        onClick={() => handleReview("return")}
                      >
                        退回补证
                      </Button>
                    </Group>
                  </>
                ) : (
                  <Text c="dimmed" mt="md">
                    尚无结论版本。
                  </Text>
                )}
              </Paper>
            </Grid.Col>
          </Grid>
        </Tabs.Panel>

        <Tabs.Panel value="alerts" pt="md">
          <Paper withBorder>
            <Table.ScrollContainer minWidth={820}>
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>告警编号</Table.Th>
                    <Table.Th>标题</Table.Th>
                    <Table.Th>账户</Table.Th>
                    <Table.Th>风险</Table.Th>
                    <Table.Th>金额</Table.Th>
                    <Table.Th>检测时间</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {caseAlerts.map((item) => (
                    <Table.Tr key={item.id}>
                      <Table.Td ff="monospace">{item.id}</Table.Td>
                      <Table.Td>{item.title}</Table.Td>
                      <Table.Td>{item.account}</Table.Td>
                      <Table.Td>
                        <RiskBadge value={item.riskLevel} />
                      </Table.Td>
                      <Table.Td>¥{item.amount.toLocaleString("zh-CN")}</Table.Td>
                      <Table.Td>
                        {new Date(item.detectedAt).toLocaleString("zh-CN", {
                          hour12: false,
                        })}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Paper>
        </Tabs.Panel>
      </Tabs>

      <Modal
        opened={nodeOpened}
        onClose={nodeModal.close}
        title="加入案件图谱节点"
        size="lg"
      >
        <Alert color="gray" mb="md">
          设备与 IP 按设备号 / 地址归并：已存在的共享实体将被直接引用，无法确认标识的节点会列入待核。
        </Alert>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Select
            label="关系源节点"
            required
            searchable
            value={nodeForm.sourceId}
            onChange={(value) =>
              setNodeForm((current) => ({
                ...current,
                sourceId: value ?? "",
              }))
            }
            data={data.nodes.map((item) => ({
              value: item.id,
              label: item.data.label,
            }))}
          />
          <Select
            label="节点类型"
            value={nodeForm.kind}
            onChange={(value) =>
              setNodeForm((current) => ({
                ...current,
                kind: (value as NodeKind) ?? "account",
              }))
            }
            data={[
              { value: "account", label: "账户" },
              { value: "device", label: "设备" },
              { value: "ip", label: "IP 地址" },
              { value: "merchant", label: "商户" },
            ]}
          />
          <TextInput
            label="节点名称"
            required
            value={nodeForm.label}
            onChange={(event) =>
              setNodeForm((current) => ({
                ...current,
                label: event.currentTarget.value,
              }))
            }
          />
          <TextInput
            label="证据来源"
            required
            value={nodeForm.source}
            onChange={(event) =>
              setNodeForm((current) => ({
                ...current,
                source: event.currentTarget.value,
              }))
            }
          />
          <Select
            label="风险等级"
            value={nodeForm.riskLevel}
            onChange={(value) =>
              setNodeForm((current) => ({
                ...current,
                riskLevel: (value as RiskLevel) ?? "medium",
              }))
            }
            data={[
              { value: "high", label: "高风险" },
              { value: "medium", label: "中风险" },
              { value: "low", label: "低风险" },
            ]}
          />
          <Select
            label="证据强度"
            value={nodeForm.evidenceStrength}
            onChange={(value) =>
              setNodeForm((current) => ({
                ...current,
                evidenceStrength:
                  (value as EvidenceStrength) ?? "medium",
              }))
            }
            data={[
              { value: "strong", label: "强" },
              { value: "medium", label: "中" },
              { value: "weak", label: "弱" },
            ]}
          />
          <TextInput
            type="datetime-local"
            label="证据发生时间"
            value={nodeForm.occurredAt}
            onChange={(event) =>
              setNodeForm((current) => ({
                ...current,
                occurredAt: event.currentTarget.value,
              }))
            }
          />
          <NumberInput
            label="关联金额"
            value={nodeForm.amount}
            min={0}
            thousandSeparator
            onChange={(value) =>
              setNodeForm((current) => ({
                ...current,
                amount: Number(value) || 0,
              }))
            }
          />
          <TextInput
            label="关系名称"
            placeholder="例如：转账 12 万"
            value={nodeForm.relationLabel}
            onChange={(event) =>
              setNodeForm((current) => ({
                ...current,
                relationLabel: event.currentTarget.value,
              }))
            }
          />
          <TextInput
            label="关系解释"
            placeholder="说明关联依据与限制"
            value={nodeForm.relationExplanation}
            onChange={(event) =>
              setNodeForm((current) => ({
                ...current,
                relationExplanation: event.currentTarget.value,
              }))
            }
          />
        </SimpleGrid>
        <Textarea
          label="节点说明"
          minRows={3}
          mt="md"
          value={nodeForm.note}
          onChange={(event) =>
            setNodeForm((current) => ({
              ...current,
              note: event.currentTarget.value,
            }))
          }
        />
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={nodeModal.close}>
            取消
          </Button>
          <Button onClick={handleAddNode}>加入图谱</Button>
        </Group>
      </Modal>

      <Modal
        opened={evidenceOpened}
        onClose={evidenceModal.close}
        title="登记案件证据"
        size="lg"
      >
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput
            label="证据名称"
            required
            value={evidenceForm.title}
            onChange={(event) =>
              setEvidenceForm((current) => ({
                ...current,
                title: event.currentTarget.value,
              }))
            }
          />
          <TextInput
            label="证据来源"
            required
            value={evidenceForm.source}
            onChange={(event) =>
              setEvidenceForm((current) => ({
                ...current,
                source: event.currentTarget.value,
              }))
            }
          />
          <Select
            label="证据强度"
            value={evidenceForm.strength}
            onChange={(value) =>
              setEvidenceForm((current) => ({
                ...current,
                strength: (value as EvidenceStrength) ?? "medium",
              }))
            }
            data={[
              { value: "strong", label: "强证据" },
              { value: "medium", label: "中等证据" },
              { value: "weak", label: "弱证据" },
            ]}
          />
          <TextInput
            type="datetime-local"
            label="证据发生时间"
            value={evidenceForm.occurredAt}
            onChange={(event) =>
              setEvidenceForm((current) => ({
                ...current,
                occurredAt: event.currentTarget.value,
              }))
            }
          />
          <TextInput
            label="附件标识"
            required
            placeholder="文件名或本地附件编号"
            value={evidenceForm.attachment}
            onChange={(event) =>
              setEvidenceForm((current) => ({
                ...current,
                attachment: event.currentTarget.value,
              }))
            }
          />
        </SimpleGrid>
        <Textarea
          label="证据说明"
          minRows={3}
          mt="md"
          value={evidenceForm.note}
          onChange={(event) =>
            setEvidenceForm((current) => ({
              ...current,
              note: event.currentTarget.value,
            }))
          }
        />
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={evidenceModal.close}>
            取消
          </Button>
          <Button loading={isAddingEvidence} onClick={handleAddEvidence}>
            登记证据
          </Button>
        </Group>
      </Modal>

      <Modal
        opened={conclusionOpened}
        onClose={conclusionModal.close}
        title="新建结论版本"
        size="lg"
      >
        <Select
          label="处置建议"
          value={conclusionForm.disposition}
          onChange={(value) =>
            setConclusionForm((current) => ({
              ...current,
              disposition: (value as CaseDisposition) ?? "observe",
            }))
          }
          data={[
            { value: "freeze", label: "建议冻结" },
            { value: "release", label: "建议放行" },
            { value: "observe", label: "继续观察" },
          ]}
        />
        <Textarea
          label="结论依据"
          description="至少 12 个字符；说明关联事实、证据限制与判断边界"
          minRows={5}
          mt="md"
          value={conclusionForm.rationale}
          onChange={(event) =>
            setConclusionForm((current) => ({
              ...current,
              rationale: event.currentTarget.value,
            }))
          }
        />
        <Textarea
          label="风险控制措施"
          description="每行一项"
          minRows={4}
          mt="md"
          value={conclusionForm.riskControls}
          onChange={(event) =>
            setConclusionForm((current) => ({
              ...current,
              riskControls: event.currentTarget.value,
            }))
          }
        />
        <Alert color="gray" mt="md">
          保存草稿不会触发复核；提交后生成独立版本并进入待复核状态。
        </Alert>
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={conclusionModal.close}>
            取消
          </Button>
          <Button
            variant="light"
            loading={isSavingConclusion}
            onClick={() => handleSaveConclusion(false)}
          >
            保存草稿
          </Button>
          <Button
            loading={isSavingConclusion}
            onClick={() => handleSaveConclusion(true)}
          >
            提交复核
          </Button>
        </Group>
      </Modal>

      <Modal
        opened={entityOpened}
        onClose={entityModal.close}
        title={`编辑共享实体属性（当前 V${entityForm.baseVersion}）`}
        size="lg"
      >
        <Alert color="gray" mb="md">
          实体记录全案共享：保存后版本 +1，引用该实体的案件旧结论将失效，需重新核对。
        </Alert>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput
            label="名称"
            required
            value={entityForm.label}
            onChange={(event) =>
              setEntityForm((current) => ({
                ...current,
                label: event.currentTarget.value,
              }))
            }
          />
          <Select
            label="风险等级"
            value={entityForm.riskLevel}
            onChange={(value) =>
              setEntityForm((current) => ({
                ...current,
                riskLevel: (value as RiskLevel) ?? "medium",
              }))
            }
            data={[
              { value: "high", label: "高风险" },
              { value: "medium", label: "中风险" },
              { value: "low", label: "低风险" },
            ]}
          />
          <Select
            label="证据强度"
            value={entityForm.evidenceStrength}
            onChange={(value) =>
              setEntityForm((current) => ({
                ...current,
                evidenceStrength: (value as EvidenceStrength) ?? "medium",
              }))
            }
            data={[
              { value: "strong", label: "强" },
              { value: "medium", label: "中" },
              { value: "weak", label: "弱" },
            ]}
          />
          <TextInput
            label="来源"
            required
            value={entityForm.source}
            onChange={(event) =>
              setEntityForm((current) => ({
                ...current,
                source: event.currentTarget.value,
              }))
            }
          />
          <TextInput
            type="datetime-local"
            label="关联时间"
            value={entityForm.occurredAt}
            onChange={(event) =>
              setEntityForm((current) => ({
                ...current,
                occurredAt: event.currentTarget.value,
              }))
            }
          />
        </SimpleGrid>
        <Textarea
          label="说明"
          minRows={3}
          mt="md"
          value={entityForm.note}
          onChange={(event) =>
            setEntityForm((current) => ({
              ...current,
              note: event.currentTarget.value,
            }))
          }
        />
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={entityModal.close}>
            取消
          </Button>
          <Button onClick={handleSaveEntity}>保存共享实体</Button>
        </Group>
      </Modal>

      <Modal
        opened={conflictOpened}
        onClose={conflictModal.close}
        title="保存冲突：请逐项裁决"
        size="lg"
      >
        {conflictState ? (
          <Stack gap="md">
            <Alert color="orange">
              你编辑期间，{conflictState.entity.updatedBy} 已将该实体更新为 V
              {conflictState.entity.version}。以下字段存在冲突，整笔未写入；
              请逐项选择保留对方还是使用我的。
            </Alert>
            {conflictState.conflicts.map((conflict) => (
              <Paper key={conflict.field} withBorder p="sm">
                <Group justify="space-between" align="flex-start">
                  <div>
                    <Text size="sm" fw={600}>
                      {entityFieldLabels[conflict.field]}
                      {conflict.verifiedByOther ? (
                        <Badge ml="xs" color="teal" variant="light">
                          对方已核验
                        </Badge>
                      ) : null}
                    </Text>
                    <Text size="xs" c="dimmed" mt={4}>
                      对方值（{conflict.updatedBy} ·{" "}
                      {new Date(conflict.updatedAt).toLocaleString("zh-CN", {
                        hour12: false,
                      })}
                      ）：{conflict.currentValue}
                    </Text>
                    <Text size="xs" c="dimmed" mt={2}>
                      我的值：{conflict.attemptedValue}
                    </Text>
                  </div>
                  <SegmentedControl
                    size="xs"
                    value={resolutions[conflict.field] ?? ""}
                    onChange={(value) =>
                      setResolutions((current) => ({
                        ...current,
                        [conflict.field]: value as "mine" | "theirs",
                      }))
                    }
                    data={[
                      { value: "theirs", label: "保留对方" },
                      { value: "mine", label: "使用我的" },
                    ]}
                  />
                </Group>
              </Paper>
            ))}
            {conflictState.conflicts.some(
              (conflict) => conflict.verifiedByOther,
            ) ? (
              <Checkbox
                label="确认覆盖他人已核验的字段（覆盖后核验状态失效，并记入审计）"
                checked={allowOverrideVerified}
                onChange={(event) =>
                  setAllowOverrideVerified(event.currentTarget.checked)
                }
              />
            ) : null}
            <Group justify="flex-end">
              <Button variant="default" onClick={conflictModal.close}>
                放弃我的修改
              </Button>
              <Button onClick={handleResolveConflicts}>按裁决保存</Button>
            </Group>
          </Stack>
        ) : null}
      </Modal>
    </Stack>
  );
}
