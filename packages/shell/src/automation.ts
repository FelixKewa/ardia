import type { EventSubscription } from "expo-modules-core";

export type ControlSocketStatus = { state: "on" | "off"; generation: number; path: string; reason?: string };
export type ControlRequest = { connection: number; generation: number; line: string };
export type ControlPeer = { pid: number; path?: string; name?: string; identifier?: string; teamId?: string; signer?: string; signed: boolean; valid: boolean; adhoc: boolean; platform: boolean; lookupMs: number };

export type AutomationNative = {
  start(): Promise<ControlSocketStatus>;
  stop(): Promise<void>;
  reply(connection: number, line: string, ticket: number): void;
  broadcast(connections: number[], line: string): void;
  peer(connection: number): Promise<ControlPeer | null>;
  addListener(name: "onRequest", listener: (e: ControlRequest) => void): EventSubscription;
  addListener(name: "onClose", listener: (e: { connection: number }) => void): EventSubscription;
  addListener(name: "onWritten", listener: (e: { tickets: number[] }) => void): EventSubscription;
};
