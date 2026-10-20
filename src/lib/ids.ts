import { randomBytes } from "node:crypto";
import { v7 as uuidv7, validate as uuidValidate } from "uuid";

/** Time-ordered UUIDv7 (ADR-008). */
export const newId = (): string => uuidv7();

export const isUuid = (value: string): boolean => uuidValidate(value);

/** Short, unguessable error id for correlating user-visible errors with logs. */
export const newErrorId = (): string => `err_${randomBytes(6).toString("base64url")}`;

/** 256-bit URL-safe random token (share links, upload tokens). */
export const newSecretToken = (): string => randomBytes(32).toString("base64url");
