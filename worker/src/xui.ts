import type { BotEnv } from "./env";
import { parseIdList } from "./env";

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

export class XuiApi {
  private baseUrl: string;
  private token: string;
  private inboundIds: number[];
  private limitIp: number;

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

  private async parseOk(response: Response, action: string): Promise<void> {
    const payload = (await response.json()) as { success?: boolean; msg?: string };
    if (!response.ok || payload.success === false) {
      throw new Error(payload.msg || `${action} failed`);
    }
  }

  buildClientEmail(_username: string | null, telegramId: number): string {
    return String(telegramId);
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

  async findClientByTelegramId(telegramId: number): Promise<{
    email: string;
    subId: string;
    primaryUuid: string;
  } | null> {
    for (const inboundId of this.inboundIds) {
      const response = await this.request(`/panel/api/inbounds/get/${inboundId}`);
      const payload = (await response.json()) as {
        success?: boolean;
        obj?: Record<string, unknown>;
      };
      if (!response.ok || payload.success === false || !payload.obj) continue;
      for (const client of this.parseInboundClients(payload.obj)) {
        const tgId = Number(client.tgId);
        if (!Number.isFinite(tgId) || tgId !== telegramId) continue;
        const email = String(client.email || "");
        const subId = String(client.subId || "");
        const primaryUuid = String(client.id || "");
        if (!email || !primaryUuid) continue;
        return { email, subId, primaryUuid };
      }
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
    existingUuid?: string
  ): XuiClientRecord {
    return {
      id: existingUuid || crypto.randomUUID(),
      email,
      subId,
      limitIp: this.limitIp,
      expiryTime: expiryMs,
      enable: true,
      tgId: telegramId,
      totalGB: totalGb,
      flow: "",
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
    await this.parseOk(response, "addClient");
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
    await this.parseOk(response, "updateClient");
  }

  async clearClientIps(email: string): Promise<void> {
    const response = await this.request(
      `/panel/api/clients/clearIps/${encodeURIComponent(email)}`,
      { method: "POST", body: "{}" }
    );
    await this.parseOk(response, "clearClientIps");
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
    if (db?.client_email && db.xray_uuid) {
      return {
        email: db.client_email,
        subId: db.xray_sub_id || panelClient?.subId || "",
        primaryUuid: db.xray_uuid,
      };
    }
    if (panelClient) return panelClient;
    return undefined;
  }

  async provisionUser(
    env: BotEnv,
    params: {
      username: string | null;
      telegramId: number;
      expiryMs: number;
      totalGb?: number;
      existing?: {
        email: string;
        subId: string;
        primaryUuid: string;
      };
    }
  ): Promise<{
    email: string;
    subId: string;
    subscriptionUrl: string;
    primaryUuid: string;
    inbounds: Array<{ inboundId: number; clientUuid: string }>;
  }> {
    const existing =
      params.existing ||
      (await this.resolveExistingClient(params.telegramId));
    const email =
      existing?.email ||
      this.buildClientEmail(params.username, params.telegramId);
    const subId =
      existing?.subId && existing.subId.trim()
        ? existing.subId
        : randomSubId();
    const client = this.buildClient(
      email,
      subId,
      params.telegramId,
      params.expiryMs,
      params.totalGb ?? 0,
      existing?.primaryUuid
    );

    if (existing?.primaryUuid) {
      await this.updateClient(client);
    } else {
      const panelDup = await this.findClientByTelegramId(params.telegramId);
      if (panelDup) {
        client.id = panelDup.primaryUuid;
        client.email = panelDup.email;
        client.subId = panelDup.subId || client.subId;
        await this.updateClient(client);
      } else {
        await this.addClient(client);
      }
    }

    return {
      email,
      subId,
      subscriptionUrl: this.buildSubscriptionUrl(env, subId),
      primaryUuid: client.id,
      inbounds: this.inboundIds.map((inboundId) => ({
        inboundId,
        clientUuid: client.id,
      })),
    };
  }
}
