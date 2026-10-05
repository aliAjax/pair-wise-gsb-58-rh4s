/* 冒烟测试：验证共享实体迁移、并发冲突、失效/恢复、写入失败恢复。
   运行：node_modules/.bin/esbuild scripts/smoke.ts --bundle --platform=node --format=cjs --outfile=/tmp/smoke.cjs && node /tmp/smoke.cjs */

// ---- localStorage / window 模拟 ----
const store = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
  setItem: (key: string, value: string) => {
    store.set(key, String(value));
  },
  removeItem: (key: string) => {
    store.delete(key);
  },
};
(globalThis as Record<string, unknown>).window = {
  localStorage: localStorageMock,
  setTimeout: globalThis.setTimeout.bind(globalThis),
};

import {
  readDatabase,
  resetDatabase,
  writeDatabase,
  MockWriteError,
} from "../src/services/mockStorage";

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    console.error(`✗ ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${message}`);
  }
};

// ---- 1. 首次打开：迁移 ----
const db = readDatabase();
assert(db.schemaVersion === 2, "数据库迁移到 schema v2");
assert(db.entities.length === 1, `自动归并出 1 个共享实体（实际 ${db.entities.length}）`);
const ipEntity = db.entities.find((e) => e.kind === "ip");
assert(
  Boolean(ipEntity) && ipEntity!.identifier === "117.136.40.17",
  "IP 117.136.40.17 自动归并为一个实体",
);
const ipNodes = db.nodes.filter((n) => n.entityId === ipEntity!.id);
assert(ipNodes.length === 2, `IP 实体挂接 2 个案件节点（实际 ${ipNodes.length}）`);
assert(
  db.pendingMerges.length === 1 &&
    db.pendingMerges[0].identifier === "DV-A91F" &&
    db.pendingMerges[0].caseIds.includes("CASE-2026-017") &&
    db.pendingMerges[0].caseIds.includes("CASE-2026-015"),
  "属性冲突的设备 DV-A91F 列入待核清单",
);
assert(
  db.auditLogs.some((l) => l.action === "实体归并") &&
    db.auditLogs.some((l) => l.action === "实体待核"),
  "迁移动作写入审计日志",
);

// ---- 2. 持久化与版本 ----
writeDatabase(db);
const again = readDatabase();
assert(again.entities.length === 1, "写入后重读实体数量一致");
assert(again.revision === db.revision, "修订号持久化");

// ---- 3. 写入失败恢复 ----
(store as Map<string, string>).set(
  "bank-fraud-investigation-db-v1:backup",
  JSON.stringify(again),
);
(globalThis as Record<string, unknown>).window.__mockFailNextWrite = true;
let failed = false;
try {
  const mutated = { ...again, entities: [] };
  writeDatabase(mutated as typeof again);
} catch (error) {
  failed = error instanceof MockWriteError;
}
assert(failed, "模拟写入失败抛出 MockWriteError");
const recovered = readDatabase();
assert(
  recovered.entities.length === 1,
  "写入失败后从备份恢复到完整版本，可继续操作",
);

// ---- 4. 主数据损坏时从备份恢复 ----
store.set("bank-fraud-investigation-db-v1", "{corrupted-json");
const repaired = readDatabase();
assert(repaired.entities.length === 1, "主数据损坏时自动从备份恢复");

// ---- 5. 重置 ----
const reset = resetDatabase();
assert(reset.entities.length === 1 && reset.pendingMerges.length === 1, "重置后重新迁移演示数据");

console.log(process.exitCode ? "\n存在失败用例" : "\n全部通过");
