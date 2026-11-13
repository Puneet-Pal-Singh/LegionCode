import type { ThreadInputRepository } from "@repo/event-store";
import type { Env } from "../../types/ai";
import { withThreadInputRepository } from "./ThreadInputPersistenceFactory";

export function hostedThreadInputRepository(env: Env): ThreadInputRepository {
  return {
    enqueue: (input) => withThreadInputRepository(env, (owner) => owner.enqueue(input)),
    list: (input) => withThreadInputRepository(env, (owner) => owner.list(input)),
    getById: (input) => withThreadInputRepository(env, (owner) => owner.getById(input)),
    update: (input) => withThreadInputRepository(env, (owner) => owner.update(input)),
    claimForSteering: (input) => withThreadInputRepository(env, (owner) => owner.claimForSteering(input)),
    remove: (input) => withThreadInputRepository(env, (owner) => owner.remove(input)),
    setPaused: (input) => withThreadInputRepository(env, (owner) => owner.setPaused(input)),
    recordReceipt: (input) => withThreadInputRepository(env, (owner) => owner.recordReceipt(input)),
  };
}
