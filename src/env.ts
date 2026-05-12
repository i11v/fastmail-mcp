import { AsyncLocalStorage } from "node:async_hooks";

export interface AppEnv {
  SESSION_CACHE?: KVNamespace;
}

const storage = new AsyncLocalStorage<AppEnv>();

export function runWithEnv<T>(env: AppEnv, fn: () => Promise<T>): Promise<T> {
  return storage.run(env, fn);
}

export function getEnv(): AppEnv | undefined {
  return storage.getStore();
}
