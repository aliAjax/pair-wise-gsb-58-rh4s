/* 页面渲染冒烟测试：jsdom 挂载真实页面，验证共享实体在案件页、时间轴、审计页一致显示。
   运行：node_modules/.bin/esbuild scripts/smoke-render.tsx --bundle --platform=node --format=cjs --loader:.css=empty --outfile=/tmp/smoke-render.cjs && node /tmp/smoke-render.cjs */

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});

const { window } = dom;
window.matchMedia =
  window.matchMedia ??
  ((query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList);

// 将 jsdom window 上的全部 DOM 全局（Document、SVGElement、ShadowRoot 等）挂到 globalThis。
for (const key of Object.getOwnPropertyNames(window)) {
  if (!(key in globalThis)) {
    (globalThis as Record<string, unknown>)[key] = (
      window as unknown as Record<string, unknown>
    )[key];
  }
}
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  localStorage: window.localStorage,
  // Node 自带的 AbortController 与 jsdom 的 AbortSignal 不同源，强制统一为 jsdom 实现
  AbortController: window.AbortController,
  AbortSignal: window.AbortSignal,
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(cb, 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});

import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";
import { MemoryRouter } from "react-router-dom";
import { MantineProvider, createTheme } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { App } from "../src/App";
import { store } from "../src/app/store";
import { bankApi } from "../src/services/api";
import { readDatabase, resetDatabase } from "../src/services/mockStorage";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    console.error(`✗ ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${message}`);
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const flush = async (ms = 400) => {
  await act(async () => {
    await sleep(ms);
  });
};

const bodyText = () => window.document.body.textContent ?? "";

const run = async () => {
  resetDatabase();
  const theme = createTheme({ primaryColor: "teal" });
  const root = createRoot(window.document.getElementById("root")!);

  const renderAt = async (path: string) => {
    await act(async () => {
      root.render(
        <StrictMode>
          <Provider store={store}>
            <MantineProvider theme={theme}>
              <Notifications position="top-right" />
              <MemoryRouter key={path} initialEntries={[path]}>
                <App />
              </MemoryRouter>
            </MantineProvider>
          </Provider>
        </StrictMode>,
      );
    });
    await flush(700);
  };

  // ---- 1. 案件页：共享实体版本显示 ----
  await renderAt("/cases/CASE-2026-017");
  assert(bodyText().includes("东江路账户群资金往返案"), "案件页加载案件标题");
  assert(bodyText().includes("共享 V1"), "图谱节点显示共享实体版本徽标");

  // 点击 IP 节点查看共享实体面板
  const ipNode = Array.from(
    window.document.querySelectorAll(".graph-node"),
  ).find((node) => node.textContent?.includes("117.136.40.17"));
  assert(Boolean(ipNode), "图谱中存在 IP 共享节点");
  await act(async () => {
    (ipNode as HTMLElement).dispatchEvent(
      new window.MouseEvent("click", { bubbles: true }),
    );
  });
  await flush(200);
  assert(bodyText().includes("共享实体 V1"), "节点面板显示共享实体版本");
  assert(bodyText().includes("未核验"), "实体显示未核验状态");

  // ---- 2. 时间轴显示同一实体版本 ----
  assert(
    bodyText().includes("共享实体 117.136.40.17 · V1"),
    "时间轴事件显示同一实体版本",
  );

  // ---- 3. 通过 API 更新实体：案件页结论失效横幅 ----
  const entity = readDatabase().entities.find((item) => item.kind === "ip")!;
  await act(async () => {
    await store.dispatch(
      bankApi.endpoints.updateSharedEntity.initiate({
        entityId: entity.id,
        baseVersion: entity.version,
        changes: { riskLevel: "high", note: "确认与赌博平台通信。" },
      }),
    );
  });
  await flush(700);
  assert(bodyText().includes("共享 V2"), "实体更新后图谱节点同步为新版本");
  assert(
    bodyText().includes("1 份结论因共享实体更新而失效"),
    "案件页出现结论失效横幅",
  );

  // 切到结论页签
  const conclusionsTab = Array.from(
    window.document.querySelectorAll("button"),
  ).find((button) => button.textContent?.includes("结论与复核"));
  await act(async () => {
    (conclusionsTab as HTMLElement).click();
  });
  await flush(300);
  assert(bodyText().includes("已失效"), "结论版本列表显示已失效徽标");

  // ---- 4. 审计页：实体版本留痕 ----
  await renderAt("/audit");
  assert(bodyText().includes("更新共享实体"), "审计页显示实体更新动作");
  assert(
    bodyText().includes("117.136.40.17 · V2"),
    "审计页显示同一实体版本",
  );

  // ---- 5. 案件工作台：待核清单 ----
  await renderAt("/cases");
  assert(bodyText().includes("1 组重复实体待核"), "工作台显示待核归并清单");
  assert(bodyText().includes("DV-A91F"), "待核清单列出冲突设备号");
  assert(bodyText().includes("结论待核对"), "案件行显示结论待核对标记");

  // ---- 6. 双窗口冲突：编辑期间他人保存，弹冲突框逐项处理 ----
  await renderAt("/cases/CASE-2026-017");
  const ipNodeAgain = Array.from(
    window.document.querySelectorAll(".graph-node"),
  ).find((node) => node.textContent?.includes("117.136.40.17"));
  await act(async () => {
    (ipNodeAgain as HTMLElement).dispatchEvent(
      new window.MouseEvent("click", { bubbles: true }),
    );
  });
  await flush(200);
  const editButton = Array.from(
    window.document.querySelectorAll("button"),
  ).find((button) => button.textContent?.includes("编辑共享实体"));
  assert(Boolean(editButton), "节点面板提供编辑共享实体入口");
  await act(async () => {
    (editButton as HTMLElement).click();
  });
  await flush(200);
  assert(
    bodyText().includes("编辑共享实体 · 117.136.40.17"),
    "实体编辑弹窗打开",
  );

  // 模拟另一窗口先保存
  const beforeConflict = readDatabase().entities.find(
    (item) => item.kind === "ip",
  )!;
  await act(async () => {
    await store.dispatch(
      bankApi.endpoints.updateSharedEntity.initiate({
        entityId: beforeConflict.id,
        baseVersion: beforeConflict.version,
        changes: { note: "另一窗口核验后的说明。" },
      }),
    );
  });
  await flush(300);

  // 本窗口基于旧版本保存 → 应弹出冲突框
  const saveButton = Array.from(
    window.document.querySelectorAll("button"),
  ).find((button) => button.textContent?.includes("保存共享实体"));
  await act(async () => {
    (saveButton as HTMLElement).click();
  });
  await flush(500);
  assert(bodyText().includes("字段冲突"), "版本落后时弹出字段冲突框");
  assert(
    bodyText().includes("另一窗口核验后的说明"),
    "冲突框展示对方当前值",
  );

  const resolveButton = Array.from(
    window.document.querySelectorAll("button"),
  ).find((button) => button.textContent?.includes("按选择保存"));
  await act(async () => {
    (resolveButton as HTMLElement).click();
  });
  await flush(500);
  const finalEntity = readDatabase().entities.find(
    (item) => item.kind === "ip",
  )!;
  assert(
    finalEntity.version === beforeConflict.version + 2,
    "冲突解决后基于最新版本保存成功",
  );
  assert(
    !bodyText().includes("字段冲突 ·"),
    "冲突框关闭",
  );

  await act(async () => {
    root.unmount();
  });
  console.log(process.exitCode ? "\n存在失败用例" : "\n全部通过");
  process.exit(process.exitCode ?? 0);
};

run().catch((error) => {
  console.error("渲染测试异常", error);
  process.exit(1);
});
