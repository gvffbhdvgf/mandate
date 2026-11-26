import { bindings, defineConfig, defineWorker } from "cf/config";
import { createWorkersCacheConfig } from "@vinext/cloudflare/cache/config";

const cache = await createWorkersCacheConfig();

const PRODUCTION_KV_NAMESPACE = "8df55d8d27e74f058c2ae3013ae71ded";
const PREVIEW_KV_NAMESPACE = "9997b492b55041d6b65f83a5689f7dde";
const SUPABASE_URL = "https://yhdosrhtzcsfqfuuqhsk.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_Bjx7bNlSk8quCD6BxYeChg_teyfkUn9";

export default defineConfig(({ isPreview }) => ({
  worker: defineWorker({
    ...cache,
    name: "mandate",
    entrypoint: "vinext/server/fetch-handler",
    compatibilityDate: "2026-11-26",
    assets: {
      htmlHandling: "none",
      notFoundHandling: "none",
      runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
    },
    env: {
      ...cache.env,
      ASSETS: bindings.assets(),
      IMAGES: bindings.images(),
      VINEXT_KV_CACHE: bindings.kv({
        id: isPreview ? PREVIEW_KV_NAMESPACE : PRODUCTION_KV_NAMESPACE,
      }),
      SUPABASE_URL: bindings.text(SUPABASE_URL),
      // Preview must never authenticate to or write to the production project.
      SUPABASE_PUBLISHABLE_KEY: bindings.text(
        isPreview ? "sb_publishable_preview_disabled" : SUPABASE_PUBLISHABLE_KEY,
      ),
    },
  }),
}));
