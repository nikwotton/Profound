import type { ListenAddress } from "./domain/network.js";

export type SimulatorFailure = "auth" | "unavailable" | "rate_limit" | "timeout" | "capacity" | null;

export interface MockIdentity {
  id: string;
  exitIp: string;
  country: string;
  region?: string;
  city?: string;
  carrier?: string;
  extraHeaders?: Record<string, string>;
}

export interface SimulatedMobileDevice {
  id: string;
  deviceId?: string;
  username: string;
  password: string;
  country: string;
  region: string;
  city: string;
  carrier: string;
  publicKey: string;
  healthy: boolean;
  exitIp: string;
  rotationIntervalSeconds?: number;
  lastRotatedAt: number;
}

export interface BrightDataSimulatorControl {
  start(): Promise<ListenAddress>;
  stop(): Promise<void>;
  setFailure(failure: SimulatorFailure): void;
  lastIdentity(): MockIdentity | undefined;
}

export interface ProxidizeSimulatorControl {
  start(): Promise<{ control: ListenAddress; data: ListenAddress }>;
  stop(): Promise<void>;
  controlAddress(): ListenAddress;
  dataAddress(): ListenAddress;
  setFailure(failure: SimulatorFailure): void;
  setDeviceHealth(id: string, healthy: boolean): void;
  ageDeviceRotation(id: string, milliseconds: number): void;
  devices(): SimulatedMobileDevice[];
  lastIdentity(): MockIdentity | undefined;
}
