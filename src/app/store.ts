import { configureStore } from "@reduxjs/toolkit";
import { setupListeners } from "@reduxjs/toolkit/query";
import alertsReducer from "../features/alerts/alertsSlice";
import { bankApi } from "../services/api";

export const store = configureStore({
  reducer: {
    alertsUi: alertsReducer,
    [bankApi.reducerPath]: bankApi.reducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware().concat(bankApi.middleware),
});

setupListeners(store.dispatch);

// 其他窗口写入主库后，本窗口缓存立即失效，保证两边看到同一实体版本
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event?.key === "bank-fraud-investigation-db") {
      store.dispatch(bankApi.util.resetApiState());
    }
  });
}

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
