import { bindings, defineConfig, defineWorker } from "cf/config";
import { createWorkersCacheConfig } from "@vinext/cloudflare/cache/config";

const cache = await createWorkersCacheConfig();

export default defineConfig({
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
      VINEXT_KV_CACHE: bindings.kv({ id: "8df55d8d27e74f058c2ae3013ae71ded" }),
      SUPABASE_URL: bindings.text("https://yhdosrhtzcsfqfuuqhsk.supabase.co"),
      SUPABASE_PUBLISHABLE_KEY: bindings.text("sb_publishable_Bjx7bNlSk8quCD6BxYeChg_teyfkUn9"),
    },
  }),
});
