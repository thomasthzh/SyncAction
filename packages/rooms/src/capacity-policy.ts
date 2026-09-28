import type { Database, ServerPolicyTable } from "@syncaction/database";
import type { Selectable, Transaction } from "kysely";

export interface CapacityDecision {
  quotaClass: "ORDINARY" | "EXEMPT";
  ordinaryActiveRoomLimit: number;
  ordinaryOpenTabLimit: number;
}

export async function lockCapacityPolicy(
  transaction: Transaction<Database>,
): Promise<Selectable<ServerPolicyTable>> {
  return transaction
    .selectFrom("serverPolicies")
    .selectAll()
    .where("id", "=", "GLOBAL")
    .forUpdate()
    .executeTakeFirstOrThrow();
}

export async function classifyOwner(
  transaction: Transaction<Database>,
  ownerUserId: string,
): Promise<CapacityDecision["quotaClass"]> {
  const administrator = await transaction
    .selectFrom("administrators")
    .select("linkedUserId")
    .where("linkedUserId", "is not", null)
    .executeTakeFirst();
  return administrator?.linkedUserId === ownerUserId ? "EXEMPT" : "ORDINARY";
}
