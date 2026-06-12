import type { BotEnv } from "./env";
import { parseIdList } from "./env";
import type { SupabaseEnv } from "./supabase";
import { clearVpnUserData } from "./repository";

export interface XuiClientRecord {
  id: string;
  email: string;
  subId: string;
  limitIp: number;
  expiryTime: number;
  enable: boolean;
  tgId: number;
  totalGB: number;
  flow: string;
}

export interface ProvisionResult {
  email: string;
  subId: string;
  subscriptionUrl: string;
  primaryUuid: string;
  inbounds: Array<{ inboundId: number; clientUuid: string }>;
}

const ALLOWED_PREFIXES = [
  "/panel/api/clients/add",
  "/panel/api/clients/update/",
  "/panel/api/clients/clearIps/",
  "/panel/api/clients/subLinks/",
  "/panel/api/inbounds/get/",
];

function assertAllowed(path: string): void {
  const allowed = ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
  if (!allowed) throw new Error(`blocked xui path: ${path}`);
}

function randomSubId(length = 16): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

type ScannedClient = {
  inboundId: number;
  email: string;
  subId: string;
  primaryUuid: string;
  tgId: number;
  enable: boolean;
};

export class XuiApi {
  private baseUrl: string;
  private token: string;
  private inboundIds: number[];
  private limitIp: number;
  private scanCache: ScannedClient[] | null = null;

  constructor(env: BotEnv) {
    const base = env.XUI_BASE_URL?.replace(/\/$/, "");
    if (!base) throw new Error("XUI_BASE_URL missing");
    if (!env.XUI_API_TOKEN) throw new Error("XUI_API_TOKEN missing");
    this.baseUrl = base;
    this.token = env.XUI_API_TOKEN;
    this.inboundIds = parseIdList(env.XUI_INBOUND_IDS);
    this.limitIp = Number(env.XUI_CLIENT_LIMIT_IP || "1");
  }

  private headers(): HeadersInit {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.token}`,
    };
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    assertAllowed(path);
    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init?.headers || {}) },
    });
  }

  private async parseResponse(
    response: Response,
    action: string
  ): Promise<{ success?: boolean; msg?: string }> {
    const payload = (await response.json()) as { success?: boolean; msg?: string };
    if (!response.ok || payload.success === false) {
      throw new Error(payload.msg || `${action} failed`);
    }
    return payload;
  }

  private invalidateScan(): void {
    this.scanCache = null;
  }

  private parseInboundClients(
    inbound: Record<string, unknown>
  ): Array<Record<string, unknown>> {
    const raw = inbound.settings;
    const settings =
      typeof raw === "string"
        ? (JSON.parse(raw) as { clients?: Array<Record<string, unknown>> })
        : (raw as { clients?: Array<Record<string, unknown>> } | undefined);
    return settings?.clients ?? [];
  }

  private async scanAllClients(): Promise<ScannedClient[]> {
    if (this.scanCache) return this.scanCache;

    const responses = await Promise.all(
      this.inboundIds.map((inboundId) =>
        this.request(`/panel/api/inbounds/get/${inboundId}`)
      )
    );

    const scanned: ScannedClient[] = [];
    for (let i = 0; i < responses.length; i += 1) {
      const inboundId = this.inboundIds[i];
      const response = responses[i];
      const payload = (await response.json()) as {
        success?: boolean;
        obj?: Record<string, unknown>;
      };
      if (!response.ok || payload.success === false || !payload.obj) continue;
      for (const client of this.parseInboundClients(payload.obj)) {
        const email = String(client.email || "");
        const primaryUuid = String(client.id || "");
        if (!email || !primaryUuid) continue;
        scanned.push({
          inboundId,
          email,
          subId: String(client.subId || ""),
          primaryUuid,
          tgId: Number(client.tgId) || 0,
          enable: Boolean(client.enable),
        });
      }
    }

    this.scanCache = scanned;
    return scanned;
  }

  buildClientEmail(_username: string | null, telegramId: number): string {
    return String(telegramId);
  }

  async findClientByTelegramId(telegramId: number): Promise<{
    email: string;
    subId: string;
    primaryUuid: string;
  } | null> {
    const clients = await this.scanAllClients();
    for (const client of clients) {
      if (client.tgId === telegramId) {
        return {
          email: client.email,
          subId: client.subId,
          primaryUuid: client.primaryUuid,
        };
      }
    }

    const email = this.buildClientEmail(null, telegramId);
    const byEmail = await this.findClientByEmail(email);
    if (!byEmail) return null;
    return {
      email: byEmail.email,
      subId: byEmail.subId,
      primaryUuid: byEmail.primaryUuid,
    };
  }

  async findClientByEmail(email: string): Promise<{
    email: string;
    subId: string;
    primaryUuid: string;
    tgId: number;
    enable: boolean;
  } | null> {
    const clients = await this.scanAllClients();
    for (const client of clients) {
      if (client.email !== email) continue;
      return {
        email: client.email,
        subId: client.subId,
        primaryUuid: client.primaryUuid,
        tgId: client.tgId,
        enable: client.enable,
      };
    }
    return null;
  }

  buildSubscriptionUrl(env: BotEnv, subId: string): string {
    const base = (env.SUBSCRIPTION_BASE_URL || "").replace(/\/$/, "");
    const path = (env.SUBSCRIPTION_PATH || "/sub").replace(/\/$/, "");
    return `${base}${path}/${subId}`;
  }

  private buildClient(
    email: string,
    subId: string,
    telegramId: number,
    expiryMs: number,
    totalGb: number,
    enable: boolean,
    existingUuid?: string
  ): XuiClientRecord {
    return {
      id: existingUuid || crypto.randomUUID(),
      email,
      subId,
      limitIp: this.limitIp,
      expiryTime: expiryMs,
      enable,
      tgId: telegramId,
      totalGB: totalGb,
      flow: "",
    };
  }

  private toProvisionResult(
    env: BotEnv,
    email: string,
    subId: string,
    primaryUuid: string
  ): ProvisionResult {
    return {
      email,
      subId,
      subscriptionUrl: this.buildSubscriptionUrl(env, subId),
      primaryUuid,
      inbounds: this.inboundIds.map((inboundId) => ({
        inboundId,
        clientUuid: primaryUuid,
      })),
    };
  }

  async addClient(client: XuiClientRecord): Promise<void> {
    const response = await this.request("/panel/api/clients/add", {
      method: "POST",
      body: JSON.stringify({
        inboundIds: this.inboundIds,
        client,
      }),
    });
    await this.parseResponse(response, "addClient");
    this.invalidateScan();
  }

  async updateClient(client: XuiClientRecord): Promise<void> {
    const response = await this.request(
      `/panel/api/clients/update/${encodeURIComponent(client.email)}`,
      {
        method: "POST",
        body: JSON.stringify({
          email: client.email,
          inboundIds: this.inboundIds,
          client,
        }),
      }
    );
    await this.parseResponse(response, "updateClient");
    this.invalidateScan();
  }

  async clearClientIps(email: string): Promise<void> {
    const response = await this.request(
      `/panel/api/clients/clearIps/${encodeURIComponent(email)}`,
      { method: "POST", body: "{}" }
    );
    await this.parseResponse(response, "clearClientIps");
  }

  async syncPanelWithDb(
    env: SupabaseEnv,
    userId: string,
    telegramId: number,
    db?: {
      client_email?: string | null;
      xray_sub_id?: string | null;
      xray_uuid?: string | null;
    } | null
  ): Promise<void> {
    const panelClient = await this.findClientByTelegramId(telegramId);
    if (panelClient) return;

    const dbEmail = db?.client_email?.trim();
    if (dbEmail) {
      const panelByEmail = await this.findClientByEmail(dbEmail);
      if (!panelByEmail) {
        await clearVpnUserData(env, userId);
      }
      return;
    }

    if (db?.xray_uuid || db?.xray_sub_id) {
      await clearVpnUserData(env, userId);
    }
  }

  async resolveExistingClient(
    telegramId: number,
    db?: {
      client_email?: string | null;
      xray_sub_id?: string | null;
      xray_uuid?: string | null;
    } | null
  ): Promise<{ email: string; subId: string; primaryUuid: string } | undefined> {
    const panelClient = await this.findClientByTelegramId(telegramId);
    if (panelClient) return panelClient;

    const dbEmail = db?.client_email?.trim();
    if (dbEmail) {
      const panelByEmail = await this.findClientByEmail(dbEmail);
      if (panelByEmail) {
        return {
          email: panelByEmail.email,
          subId: panelByEmail.subId || db?.xray_sub_id || "",
          primaryUuid: panelByEmail.primaryUuid,
        };
      }
    }

    return undefined;
  }

  private isMissingClientError(error: unknown): boolean {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    return (
      message.includes("not found") ||
      message.includes("record not found") ||
      message.includes("does not exist")
    );
  }

  private async addClientIfMissing(
    email: string,
    subId: string,
    telegramId: number,
    expiryMs: number,
    totalGb: number
  ): Promise<string> {
    const client = this.buildClient(
      email,
      subId,
      telegramId,
      expiryMs,
      totalGb,
      true
    );
    try {
      await this.addClient(client);
      return client.id;
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (!message.includes("already in use")) throw error;
      const existing = await this.findClientByEmail(email);
      if (!existing?.primaryUuid) throw error;
      return existing.primaryUuid;
    }
  }

  async ensureClientPrepared(
    env: BotEnv,
    params: {
      userId: string;
      username: string | null;
      telegramId: number;
      dbSubscription?: {
        client_email?: string | null;
        xray_sub_id?: string | null;
        xray_uuid?: string | null;
      } | null;
    }
  ): Promise<ProvisionResult> {
    await this.syncPanelWithDb(
      env,
      params.userId,
      params.telegramId,
      params.dbSubscription
    );

    const existing = await this.resolveExistingClient(
      params.telegramId,
      params.dbSubscription
    );
    const email =
      existing?.email ||
      params.dbSubscription?.client_email?.trim() ||
      this.buildClientEmail(params.username, params.telegramId);
    const subId =
      existing?.subId?.trim() ||
      params.dbSubscription?.xray_sub_id?.trim() ||
      randomSubId();
    const primaryUuid =
      existing?.primaryUuid ||
      params.dbSubscription?.xray_uuid ||
      (await this.addClientIfMissing(
        email,
        subId,
        params.telegramId,
        0,
        0
      ));

    return this.toProvisionResult(env, email, subId, primaryUuid);
  }

  async provisionUser(
    env: BotEnv,
    params: {
      userId: string;
      username: string | null;
      telegramId: number;
      expiryMs: number;
      totalGb?: number;
      dbSubscription?: {
        client_email?: string | null;
        xray_sub_id?: string | null;
        xray_uuid?: string | null;
      } | null;
    }
  ): Promise<ProvisionResult> {
    const prepared = await this.ensureClientPrepared(env, {
      userId: params.userId,
      username: params.username,
      telegramId: params.telegramId,
      dbSubscription: params.dbSubscription,
    });

    if (!params.dbSubscription?.client_email) {
      return prepared;
    }

    const client = this.buildClient(
      prepared.email,
      prepared.subId,
      params.telegramId,
      params.expiryMs,
      params.totalGb ?? 0,
      true,
      prepared.primaryUuid
    );
    try {
      await this.updateClient(client);
    } catch (error) {
      console.error("provisionUser update skipped:", error);
    }

    return this.toProvisionResult(
      env,
      prepared.email,
      prepared.subId,
      prepared.primaryUuid
    );
  }
}
