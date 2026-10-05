import {
  Badge,
  Button,
  Grid,
  Group,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  ArrowRight,
  CircleAlert,
  Files,
  GitMerge,
  ShieldAlert,
  WalletCards,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CaseStatusBadge,
  RiskBadge,
  riskLabel,
  riskOrder,
} from "../components/Badges";
import {
  useGetCasesQuery,
  useGetDashboardQuery,
  useGetSharedEntitiesQuery,
  useResolvePendingEntityMutation,
} from "../services/api";

const currency = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  maximumFractionDigits: 0,
});

export function DashboardPage() {
  const navigate = useNavigate();
  const { data, isLoading } = useGetDashboardQuery();
  const { data: cases = [] } = useGetCasesQuery();
  const { data: entityOverview } = useGetSharedEntitiesQuery();
  const [resolvePending, { isLoading: isResolving }] =
    useResolvePendingEntityMutation();
  const [identifiers, setIdentifiers] = useState<Record<string, string>>({});

  const handleResolve = async (pendingId: string, mode: "merge" | "dismiss") => {
    try {
      if (mode === "merge") {
        const identifier = (identifiers[pendingId] ?? "").trim();
        if (!identifier) {
          notifications.show({
            color: "red",
            title: "缺少标识",
            message: "请输入确认后的设备号或 IP 再归并。",
          });
          return;
        }
        await resolvePending({ pendingId, mode: "merge", identifier }).unwrap();
        notifications.show({
          color: "teal",
          title: "已归并",
          message: "待核记录已并入共享实体，相关案件图谱同步可见。",
        });
      } else {
        await resolvePending({ pendingId, mode: "dismiss" }).unwrap();
        notifications.show({
          color: "gray",
          title: "已排除",
          message: "该待核记录已标记为无法归并。",
        });
      }
    } catch (error) {
      notifications.show({
        color: "red",
        title: "处理失败",
        message:
          typeof error === "object" && error && "error" in error
            ? String(error.error)
            : "操作失败，请重试。",
      });
    }
  };

  if (isLoading || !data) {
    return <Text>正在加载调查概览...</Text>;
  }

  const metrics = [
    {
      label: "待分诊告警",
      value: data.newAlerts,
      meta: "需要完成初筛",
      icon: CircleAlert,
      color: "blue",
    },
    {
      label: "高风险告警",
      value: data.highRiskAlerts,
      meta: "风险评分不低于 80",
      icon: ShieldAlert,
      color: "red",
    },
    {
      label: "活跃案件",
      value: data.activeCases,
      meta: `${data.pendingReview} 件待复核或补证`,
      icon: Files,
      color: "teal",
    },
    {
      label: "关联交易金额",
      value: currency.format(data.totalExposure),
      meta: "告警涉及的交易额",
      icon: WalletCards,
      color: "orange",
    },
  ];

  const highRiskTotal = data.riskCounts.high + data.riskCounts.medium;
  const highRiskRatio =
    highRiskTotal === 0
      ? 0
      : Math.round((data.riskCounts.high / highRiskTotal) * 100);

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={2}>调查概览</Title>
          <Text c="dimmed" size="sm" mt={4}>
            汇总告警、案件状态与复核负担，所有数字来自本地模拟服务。
          </Text>
        </div>
        <Button
          rightSection={<ArrowRight size={16} />}
          onClick={() => navigate("/alerts")}
        >
          进入告警中心
        </Button>
      </Group>

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <Paper key={metric.label} withBorder p="md">
              <Group justify="space-between">
                <Text size="sm" c="dimmed">
                  {metric.label}
                </Text>
                <Icon size={20} color={`var(--mantine-color-${metric.color}-7)`} />
              </Group>
              <Title order={2} mt="sm">
                {metric.value}
              </Title>
              <Text size="xs" c="dimmed" mt={4}>
                {metric.meta}
              </Text>
            </Paper>
          );
        })}
      </SimpleGrid>

      <Grid>
        <Grid.Col span={{ base: 12, lg: 8 }}>
          <Paper withBorder>
            <Group justify="space-between" p="md">
              <div>
                <Title order={4}>案件队列</Title>
                <Text size="sm" c="dimmed">
                  按风险等级和最近更新时间排序
                </Text>
              </div>
              <Button variant="subtle" onClick={() => navigate("/cases")}>
                查看全部
              </Button>
            </Group>
            <Table.ScrollContainer minWidth={720}>
              <Table highlightOnHover verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>案件编号</Table.Th>
                    <Table.Th>案件名称</Table.Th>
                    <Table.Th>风险</Table.Th>
                    <Table.Th>状态</Table.Th>
                    <Table.Th>负责人</Table.Th>
                    <Table.Th>下次复核</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {[...cases]
                    .sort(
                      (a, b) =>
                        riskOrder(b.riskLevel) - riskOrder(a.riskLevel) ||
                        Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
                    )
                    .map((item) => (
                      <Table.Tr key={item.id}>
                        <Table.Td>
                          <Text size="sm" ff="monospace">
                            {item.id}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" fw={600}>
                            {item.title}
                          </Text>
                          <Text size="xs" c="dimmed" lineClamp={1}>
                            {item.summary}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <RiskBadge value={item.riskLevel} />
                        </Table.Td>
                        <Table.Td>
                          <CaseStatusBadge value={item.status} />
                        </Table.Td>
                        <Table.Td>{item.owner}</Table.Td>
                        <Table.Td>
                          {new Date(item.nextReviewAt).toLocaleString("zh-CN", {
                            month: "2-digit",
                            day: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                            hour12: false,
                          })}
                        </Table.Td>
                        <Table.Td>
                          <Button
                            size="xs"
                            variant="light"
                            onClick={() => navigate(`/cases/${item.id}`)}
                          >
                            打开
                          </Button>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Paper>
        </Grid.Col>

        <Grid.Col span={{ base: 12, lg: 4 }}>
          <Paper withBorder p="md" h="100%">
            <Title order={4}>风险构成</Title>
            <Text size="sm" c="dimmed" mt={4}>
              高风险在全部中高风险案件中的占比
            </Text>
            <Group justify="space-between" mt="xl" mb="xs">
              <Text size="sm">高风险比例</Text>
              <Text fw={700}>{highRiskRatio}%</Text>
            </Group>
            <Progress
              value={highRiskRatio}
              color="red"
              size="lg"
              radius="sm"
            />
            <Stack gap="sm" mt="xl">
              {(["high", "medium", "low"] as const).map((risk) => (
                <Group key={risk} justify="space-between">
                  <Badge variant="light" color="gray">
                    {riskLabel(risk)}
                  </Badge>
                  <Text fw={600}>{data.riskCounts[risk]} 件</Text>
                </Group>
              ))}
            </Stack>
            <Paper withBorder bg="var(--mantine-color-gray-0)" p="sm" mt="xl">
              <Text size="sm" fw={600}>
                关联不等于结论
              </Text>
              <Text size="xs" c="dimmed" mt={4}>
                共同设备、IP 与资金路径必须结合来源、时间和证据强度复核。
              </Text>
            </Paper>
          </Paper>
        </Grid.Col>
      </Grid>

      {entityOverview ? (
        <Paper withBorder>
          <Group justify="space-between" p="md">
            <div>
              <Title order={4}>共享实体记录</Title>
              <Text size="sm" c="dimmed">
                设备、IP、账户、商户全库唯一一份，所有案件引用同一版本。
                {entityOverview.migration
                  ? ` 旧数据迁移于 ${new Date(entityOverview.migration.ranAt).toLocaleString("zh-CN", { hour12: false })}：归并重复节点 ${entityOverview.migration.duplicateNodeCount} 个，待核 ${entityOverview.migration.pendingCount} 条。`
                  : ""}
              </Text>
            </div>
            <Group gap="xs">
              <Badge variant="light" color="gray">
                实体 {entityOverview.entities.length} 个
              </Badge>
              <Badge variant="light" color="teal">
                已核验{" "}
                {
                  entityOverview.entities.filter(
                    (item) => item.verifiedVersion === item.version,
                  ).length
                }{" "}
                个
              </Badge>
              <Badge
                variant="light"
                color={entityOverview.pending.length > 0 ? "orange" : "gray"}
              >
                待核 {entityOverview.pending.length} 条
              </Badge>
            </Group>
          </Group>
          {entityOverview.pending.length > 0 ? (
            <Table.ScrollContainer minWidth={860}>
              <Table verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>待核节点</Table.Th>
                    <Table.Th>类型</Table.Th>
                    <Table.Th>涉及案件</Table.Th>
                    <Table.Th>无法确认原因</Table.Th>
                    <Table.Th>确认标识</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {entityOverview.pending.map((item) => (
                    <Table.Tr key={item.id}>
                      <Table.Td>
                        <Text size="sm" fw={600}>
                          {item.label}
                        </Text>
                        <Text size="xs" c="dimmed">
                          来源节点 {item.sourceNodeIds.join("、") || "新登记"}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        {item.kind === "device"
                          ? "设备"
                          : item.kind === "ip"
                            ? "IP"
                            : item.kind === "account"
                              ? "账户"
                              : "商户"}
                      </Table.Td>
                      <Table.Td ff="monospace">
                        <Text size="xs">{item.caseIds.join("、")}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" c="dimmed">
                          {item.reason}
                        </Text>
                      </Table.Td>
                      <Table.Td w={220}>
                        <TextInput
                          size="xs"
                          placeholder={
                            item.kind === "device"
                              ? "确认设备号，如 DV-A91F"
                              : item.kind === "ip"
                                ? "确认 IP，如 117.136.40.17"
                                : "确认归并名称"
                          }
                          value={identifiers[item.id] ?? ""}
                          onChange={(event) =>
                            setIdentifiers((current) => ({
                              ...current,
                              [item.id]: event.currentTarget.value,
                            }))
                          }
                        />
                      </Table.Td>
                      <Table.Td>
                        <Group gap="xs" wrap="nowrap">
                          <Button
                            size="compact-xs"
                            variant="light"
                            color="teal"
                            loading={isResolving}
                            leftSection={<GitMerge size={13} />}
                            onClick={() => handleResolve(item.id, "merge")}
                          >
                            归并
                          </Button>
                          <Button
                            size="compact-xs"
                            variant="subtle"
                            color="gray"
                            loading={isResolving}
                            onClick={() => handleResolve(item.id, "dismiss")}
                          >
                            排除
                          </Button>
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          ) : (
            <Text size="sm" c="dimmed" p="md" pt={0}>
              没有待核的重复节点。
            </Text>
          )}
        </Paper>
      ) : null}
    </Stack>
  );
}
