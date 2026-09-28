import { hash, verify, type Options } from "@node-rs/argon2";

const passwordHashOptions = {
  // @node-rs/argon2 declares ambient const enums, which isolatedModules cannot access by name.
  // These are its documented values for Algorithm.Argon2id and Version.V0x13.
  algorithm: 2,
  version: 1,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
} satisfies Options;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, passwordHashOptions);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
