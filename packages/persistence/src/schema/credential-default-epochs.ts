import { sql } from "drizzle-orm";
import { bigint,check,pgTable,primaryKey,text,timestamp,uuid } from "drizzle-orm/pg-core";
import { users } from "./identity.js";
/** Ownership fence for the user/provider default slot, including an absent slot. */
export const providerCredentialDefaultEpochs=pgTable("provider_credential_default_epochs",{
  userId:uuid("user_id").notNull().references(()=>users.id,{onDelete:"cascade"}),
  providerId:text("provider_id").notNull(),
  generation:bigint("generation",{mode:"number"}).notNull().default(1),
  updatedAt:timestamp("updated_at",{withTimezone:true,mode:"string"}).notNull().defaultNow(),
},(table)=>[
  primaryKey({columns:[table.userId,table.providerId]}),
  check("provider_credential_default_epoch_generation_check",sql`${table.generation}>0 AND ${table.generation}<=9007199254740991`),
]);
