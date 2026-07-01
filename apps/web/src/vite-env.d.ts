/** Vite environment variables */
interface ImportMetaEnv {
  readonly VITE_BRAIN_BASE_URL?: string;
  readonly VITE_MUSCLE_BASE_URL?: string;
  readonly VITE_MUSCLE_WS_URL?: string;
  readonly VITE_ENABLE_CHAT_DEBUG_PANEL?: string;
  readonly VITE_ENABLE_CLIENT_DEBUG_LOGS?: string;
  readonly VITE_ENABLE_CLIENT_WARN_LOGS?: string;
  readonly VITE_PRODUCT_ENV?: string;
  readonly MODE: "development" | "production" | "test";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
