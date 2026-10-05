/* API 层冒烟测试：并发冲突、结论失效/恢复、待核归并。
   运行：node_modules/.bin/esbuild scripts/smoke-api.ts --bundle --platform=node --format=cjs --outfile=/tmp/smoke-api.cjs && node /tmp/smoke-api.cjs */

const storeMap = new Map<string, string>();
(globalThis as Record<string, unknown>).window = {
  localStorage: {
    getItem: (key: string) => (storeMap.has(key) ? storeMap.get(key)! : null),
    setItem: (key: string, value: string) => {
      storeMap.set(key, String(value));
    },
    removeItem: (key: string) => {
      storeMap.delete(key);
    },
  },
  setTimeout: globalThis.setTimeout.bind(globalThis),
};

import { configureStore } from "@reduxjs/toolkit";
import { bankApi } from "../src/services/api";
import { isConclusionStale } from "../src/models/types";
import { readDatabase, resetDatabase } from "../src/services/mockStorage";

const store = configureStore({
  reducer: { [bankApi.reducerPath]: bankApi.reducer },
  middleware: (getDefault) => getDefault().concat(bankApi.middleware),
});

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    console.error(`✗ ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${message}`);
  }
};

const run = async () => {
  resetDatabase();
  const dispatch = store.dispatch as any;
  const call = (endpoint: string, arg: unknown) =>
    dispatch((bankApi.endpoints as any)[endpoint].initiate(arg));

  const ipEntity = () => readDatabase().entities.find((e) => e.kind === "ip")!;

  // 先给 015 案补一份活跃结论（种子结论为已退回，不在失效范围内）
  await call("saveConclusion", {
    caseId: "CASE-2026-015",
    disposition: "observe",
    rationale: "验证跨案失效用的草稿结论。",
    riskControls: [],
  });

  // ---- 1. 正常更新：版本递增 + 结论失效 ----
  const entity = ipEntity();
  const updated = await call("updateSharedEntity", {
    entityId: entity.id,
    baseVersion: entity.version,
    changes: { riskLevel: "high", note: "已确认与赌博平台通信。" },
  });
  assert(!updated.error, "正常更新共享实体成功");
  assert(updated.data.version === entity.version + 1, "实体版本递增");
  const dbAfterUpdate = readDatabase();
  const stale017 = dbAfterUpdate.conclusions.filter(
    (c) => c.caseId === "CASE-2026-017" && isConclusionStale(c),
  );
  const stale015 = dbAfterUpdate.conclusions.filter(
    (c) => c.caseId === "CASE-2026-015" && isConclusionStale(c),
  );
  assert(stale017.length === 1, "017 案 1 份结论失效");
  assert(stale015.length === 1, "015 案 1 份结论失效（跨案同步）");
  assert(
    dbAfterUpdate.auditLogs.some((l) => l.action === "结论失效" && l.entityVersion === updated.data.version),
    "结论失效写入审计并带实体版本",
  );

  // ---- 2. 失效结论不能复核、不能关闭案件 ----
  const staleConclusion = stale017[0];
  const reviewResult = await call("reviewConclusion", {
    caseId: "CASE-2026-017",
    conclusionId: staleConclusion.id,
    decision: "approve",
    reviewerNote: "尝试复核失效结论",
  });
  assert(Boolean(reviewResult.error), "失效结论阻止复核");
  const closeResult = await call("transitionCase", {
    caseId: "CASE-2026-017",
    status: "closed",
  });
  assert(Boolean(closeResult.error), "存在失效结论时阻止关闭案件");

  // ---- 3. 重新核对后恢复 ----
  const revalidated = await call("revalidateConclusions", {
    caseId: "CASE-2026-017",
    note: "已按 V2 实体属性重新核对交易链路。",
  });
  assert(!revalidated.error && revalidated.data.length === 1, "重新核对恢复结论");
  assert(
    readDatabase().conclusions.filter(
      (c) => c.caseId === "CASE-2026-017" && isConclusionStale(c),
    ).length === 0,
    "017 案结论全部恢复",
  );
  await call("revalidateConclusions", {
    caseId: "CASE-2026-015",
    note: "同步恢复 015 案，便于后续用例。",
  });

  // ---- 4. 并发冲突：无冲突字段自动合并 ----
  const base = ipEntity();
  // 窗口 B 先保存（改 note）
  await call("updateSharedEntity", {
    entityId: base.id,
    baseVersion: base.version,
    changes: { note: "窗口 B 更新的说明。" },
  });
  // 窗口 A 基于旧版本保存（改 source，与 B 不冲突）
  const autoMerge = await call("updateSharedEntity", {
    entityId: base.id,
    baseVersion: base.version,
    changes: { source: "窗口 A 的来源" },
  });
  assert(!autoMerge.error, "无冲突字段在版本落后时自动合并");
  const merged = ipEntity();
  assert(
    merged.note === "窗口 B 更新的说明。" && merged.source === "窗口 A 的来源",
    "双方字段都保留",
  );

  // ---- 5. 并发冲突：同字段冲突返回 CONFLICT ----
  const base2 = ipEntity();
  await call("updateSharedEntity", {
    entityId: base2.id,
    baseVersion: base2.version,
    changes: { riskLevel: "low" },
  });
  const conflict = await call("updateSharedEntity", {
    entityId: base2.id,
    baseVersion: base2.version,
    changes: { riskLevel: "high" },
  });
  assert(
    conflict.error?.status === "CONFLICT" &&
      conflict.error.data.fields.length === 1 &&
      conflict.error.data.fields[0].field === "riskLevel" &&
      conflict.error.data.fields[0].locked === false,
    "同字段并发修改返回冲突明细",
  );
  // 按冲突详情解决：保留我的值
  const resolved = await call("updateSharedEntity", {
    entityId: base2.id,
    baseVersion: conflict.error.data.entity.version,
    changes: { riskLevel: "high" },
    note: "冲突解决",
  });
  assert(!resolved.error && ipEntity().riskLevel === "high", "冲突解决后按选择保存");

  // ---- 6. 核验保护：已核验字段不可被旧版本覆盖 ----
  const base3 = ipEntity();
  await call("verifySharedEntity", {
    entityId: base3.id,
    baseVersion: base3.version,
    note: "人工核验",
  });
  const lockedConflict = await call("updateSharedEntity", {
    entityId: base3.id,
    baseVersion: base3.version, // 核验前的旧版本
    changes: { riskLevel: "low" },
  });
  assert(
    lockedConflict.error?.status === "CONFLICT" &&
      lockedConflict.error.data.fields[0].locked === true,
    "对方已核验的字段冲突时锁定",
  );
  // 核验者版本过期时核验本身也被拒绝
  const staleVerify = await call("verifySharedEntity", {
    entityId: base3.id,
    baseVersion: base3.version,
  });
  assert(staleVerify.error?.status === "CONFLICT", "基于旧版本的核验被拒绝");

  // ---- 7. 待核归并 ----
  await call("saveConclusion", {
    caseId: "CASE-2026-015",
    disposition: "observe",
    rationale: "归并前的草稿结论，用于验证归并失效。",
    riskControls: [],
  });
  const pending = readDatabase().pendingMerges[0];
  const mergeResult = await call("resolvePendingMerge", {
    mergeId: pending.id,
    decision: "merge",
  });
  assert(!mergeResult.error, "待核归并成功");
  const dbAfterMerge = readDatabase();
  const deviceEntity = dbAfterMerge.entities.find((e) => e.kind === "device")!;
  assert(
    Boolean(deviceEntity) && deviceEntity.identifier === "DV-A91F",
    "DV-A91F 归并为共享实体",
  );
  assert(
    dbAfterMerge.nodes.filter((n) => n.entityId === deviceEntity.id).length === 2,
    "两个案件的设备节点挂到同一实体",
  );
  assert(dbAfterMerge.pendingMerges.length === 0, "待核清单清空");
  assert(
    dbAfterMerge.conclusions.some(
      (c) => c.caseId === "CASE-2026-015" && isConclusionStale(c),
    ),
    "归并后属性变化的 015 案结论失效",
  );

  // ---- 8. 图谱节点水合：各案看到同一实体版本 ----
  const workspace = await call("getCaseWorkspace", "CASE-2026-015");
  const deviceNode = workspace.data.nodes.find((n: any) => n.entityId === deviceEntity.id);
  assert(
    deviceNode.data.riskLevel === deviceEntity.riskLevel &&
      deviceNode.data.entityVersion === deviceEntity.version,
    "案件页节点显示共享实体当前版本",
  );

  console.log(process.exitCode ? "\n存在失败用例" : "\n全部通过");
};

run().catch((error) => {
  console.error("测试执行异常", error);
  process.exitCode = 1;
});
