import type { BotEnv } from "./env";
import { parseIdList, subscriptionBaseUrl, xuiBaseUrlCandidates } from "./env";
import { isPanelErrorBody, panelFetch } from "./panel-fetch";
import type { SupabaseEnv } from "./supabase";

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
  "/panel/api/clients/get/",
  "/panel/api/clients/add",
  "/panel/api/clients/update/",
  "/panel/api/clients/clearIps/",
  "/panel/api/inbounds/clearClientIps/",
  "/panel/api/clients/ips/",
  "/panel/api/clients/onlines",
  "/panel/api/clients/lastOnline",
  "/panel/api/clients/subLinks/",
  "/panel/api/inbounds/get/",
];

export interface PanelDeviceIp {
  ip: string;
  seenAt: string | null;
}

function parseClientIpEntry(raw: string): PanelDeviceIp {
  const trimmed = raw.trim();
  const match = trimmed.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (!match) return { ip: trimmed, seenAt: null };
  return { ip: match[1].trim(), seenAt: match[2].trim() };
}

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

function isPanelHtmlError(text: string, status: number): boolean {
  return isPanelErrorBody(text, status);
}

export class XuiApi {
  private env: BotEnv;
  private baseUrls: string[];
  private token: string;
  private inboundIds: number[];
  private limitIp: number;
  private scanCache: ScannedClient[] | null = null;

  constructor(env: BotEnv) {
    if (!env.XUI_API_TOKEN) throw new Error("XUI_API_TOKEN missing");
    this.env = env;
    this.baseUrls = xuiBaseUrlCandidates(env);
    this.token = env.XUI_API_TOKEN;
    this.inboundIds = parseIdList(env.XUI_INBOUND_IDS);
    this.limitIp = Number(env.XUI_CLIENT_LIMIT_IP || "0");
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
    let lastError: Error | null = null;

    for (const baseUrl of this.baseUrls) {
      try {
        const response = await panelFetch(this.env, `${baseUrl}${path}`, {
          ...init,
          headers: { ...this.headers(), ...(init?.headers || {}) },
        });
        const preview = await response.clone().text();
        if (isPanelHtmlError(preview, response.status)) {
          lastError = new Error(
            `XUI HTML/526 (${response.status}) via ${baseUrl}`
          );
          continue;
        }
        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError ?? new Error("XUI request failed");
  }

  private async readJsonBody(response: Response): Promise<Record<string, unknown>> {
    const text = await response.text();
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(
        `XUI non-JSON (${response.status}): ${text.slice(0, 160).trim()}`
      );
    }
  }

  private async parseResponse(
    response: Response,
    action: string
  ): Promise<{ success?: boolean; msg?: string }> {
    const payload = await this.readJsonBody(response);
    if (!response.ok || payload.success === false) {
      throw new Error(String(payload.msg || `${action} failed`));
    }
    return payload as { success?: boolean; msg?: string };
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
      const payload = await this.readJsonBody(response);
      const obj = payload.obj as Record<string, unknown> | undefined;
      if (!response.ok || payload.success === false || !obj) continue;
      for (const client of this.parseInboundClients(obj)) {
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

  async findClientBySubId(subId: string): Promise<{
    email: string;
    subId: string;
    primaryUuid: string;
  } | null> {
    const needle = subId.trim();
    if (!needle) return null;
    const clients = await this.scanAllClients();
    for (const client of clients) {
      if (client.subId !== needle) continue;
      return {
        email: client.email,
        subId: client.subId,
        primaryUuid: client.primaryUuid,
      };
    }
    return null;
  }

  async findClientByUuid(uuid: string): Promise<{
    email: string;
    subId: string;
    primaryUuid: string;
  } | null> {
    const needle = uuid.trim();
    if (!needle) return null;
    const clients = await this.scanAllClients();
    for (const client of clients) {
      if (client.primaryUuid !== needle) continue;
      return {
        email: client.email,
        subId: client.subId,
        primaryUuid: client.primaryUuid,
      };
    }
    return null;
  }

  async resolvePanelClientForTelegram(
    telegramId: number,
    db?: {
      client_email?: string | null;
      xray_sub_id?: string | null;
      xray_uuid?: string | null;
    } | null,
    username?: string | null
  ): Promise<{ email: string; subId: string; primaryUuid: string } | null> {
    const canonicalEmail = this.buildClientEmail(username ?? null, telegramId);

    const byTg = await this.findClientByTelegramId(telegramId);
    if (byTg) return byTg;

    const byCanonical = await this.findClientByEmail(canonicalEmail);
    if (byCanonical) {
      return {
        email: byCanonical.email,
        subId: byCanonical.subId,
        primaryUuid: byCanonical.primaryUuid,
      };
    }

    const dbEmail = db?.client_email?.trim();
    if (dbEmail && dbEmail !== canonicalEmail) {
      const byDbEmail = await this.findClientByEmail(dbEmail);
      if (byDbEmail) {
        return {
          email: byDbEmail.email,
          subId: byDbEmail.subId,
          primaryUuid: byDbEmail.primaryUuid,
        };
      }
    }

    const usernameEmail = username?.trim();
    if (usernameEmail && usernameEmail !== canonicalEmail) {
      const byUsername = await this.findClientByEmail(usernameEmail);
      if (byUsername) {
        return {
          email: byUsername.email,
          subId: byUsername.subId,
          primaryUuid: byUsername.primaryUuid,
        };
      }
    }

    const lockedUuid = db?.xray_uuid?.trim();
    if (lockedUuid) {
      const byUuid = await this.findClientByUuid(lockedUuid);
      if (byUuid) return byUuid;
    }

    const lockedSubId = db?.xray_sub_id?.trim();
    if (lockedSubId) {
      const bySub = await this.findClientBySubId(lockedSubId);
      if (bySub) return bySub;
    }

    return null;
  }

  async findClientByEmail(email: string): Promise<{
    email: string;
    subId: string;
    primaryUuid: string;
    tgId: number;
    enable: boolean;
  } | null> {
    const fromApi = await this.getClientByEmailApi(email);
    if (fromApi) {
      return {
        email: fromApi.email,
        subId: fromApi.subId,
        primaryUuid: fromApi.primaryUuid,
        tgId: fromApi.tgId,
        enable: fromApi.enable,
      };
    }

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

  async getClientByEmailApi(email: string): Promise<{
    email: string;
    subId: string;
    primaryUuid: string;
    tgId: number;
    enable: boolean;
  } | null> {
    const response = await this.request(
      `/panel/api/clients/get/${encodeURIComponent(email)}`
    );
    const payload = await this.readJsonBody(response);
    if (!response.ok || payload.success === false) return null;
    const obj = payload.obj as { client?: Record<string, unknown> } | undefined;
    const client = obj?.client;
    if (!client) return null;
    const subId = String(client.subId || "").trim();
    const primaryUuid = String(client.id || client.uuid || "").trim();
    const resolvedEmail = String(client.email || email).trim();
    if (!subId || !primaryUuid || !resolvedEmail) return null;
    return {
      email: resolvedEmail,
      subId,
      primaryUuid,
      tgId: Number(client.tgId) || 0,
      enable: Boolean(client.enable),
    };
  }

  async ensureLockedPanelClient(
    env: BotEnv,
    telegramId: number,
    db?: {
      client_email?: string | null;
      xray_sub_id?: string | null;
      xray_uuid?: string | null;
    } | null
  ): Promise<{ email: string; subId: string; primaryUuid: string }> {
    const email =
      db?.client_email?.trim() || this.buildClientEmail(null, telegramId);
    const lockedSubId = db?.xray_sub_id?.trim() || "";
    const lockedUuid = db?.xray_uuid?.trim() || "";

    const dbFallback = (): { email: string; subId: string; primaryUuid: string } => {
      if (!lockedSubId || !lockedUuid) {
        throw new Error("клиент в панели не найден");
      }
      return { email, subId: lockedSubId, primaryUuid: lockedUuid };
    };

    try {
      let panel = await this.resolvePanelClientForTelegram(telegramId, db);

      if (!panel && lockedSubId && lockedUuid) {
        await this.addClientIfMissing(
          email,
          lockedSubId,
          telegramId,
          0,
          0,
          lockedUuid
        );
        this.invalidateScan();
        panel = await this.resolvePanelClientForTelegram(telegramId, db);
      }

      if (!panel?.subId?.trim() || !panel.primaryUuid) {
        return dbFallback();
      }

      await this.rebindPanelClientEmail(panel, telegramId);

      return {
        email: String(telegramId),
        subId: panel.subId,
        primaryUuid: panel.primaryUuid,
      };
    } catch (error) {
      console.error("ensureLockedPanelClient:", error);
      return dbFallback();
    }
  }

  private async rebindPanelClientEmail(
    panel: { email: string; subId: string; primaryUuid: string },
    telegramId: number
  ): Promise<void> {
    const canonicalEmail = this.buildClientEmail(null, telegramId);
    if (panel.email === canonicalEmail) return;

    const response = await this.request(
      `/panel/api/clients/update/${encodeURIComponent(panel.email)}`,
      {
        method: "POST",
        body: JSON.stringify({
          email: panel.email,
          inboundIds: this.inboundIds,
          client: this.buildClient(
            canonicalEmail,
            panel.subId,
            telegramId,
            0,
            0,
            true,
            panel.primaryUuid
          ),
        }),
      }
    );
    try {
      await this.parseResponse(response, "rebindPanelClientEmail");
      this.invalidateScan();
    } catch (error) {
      console.error("rebindPanelClientEmail:", error);
    }
  }

  buildSubscriptionUrl(env: BotEnv, subId: string): string {
    const base = subscriptionBaseUrl(env);
    const path = (env.SUBSCRIPTION_PATH || "/sub").replace(/\/$/, "");
    return `${base}${path}/${subId}`;
  }

  async getClientSubLinks(subId: string): Promise<string[]> {
    const encoded = encodeURIComponent(subId.trim());
    const response = await this.request(`/panel/api/clients/subLinks/${encoded}`);
    const payload = await this.readJsonBody(response);
    if (!response.ok || payload.success === false) {
      throw new Error(String(payload.msg || "subLinks failed"));
    }
    const links = payload.obj;
    if (!Array.isArray(links)) return [];
    return links.filter(
      (line): line is string => typeof line === "string" && line.trim().length > 0
    );
  }

  async ping(): Promise<boolean> {
    const inboundId = this.inboundIds[0];
    if (!inboundId) return false;
    const response = await this.request(`/panel/api/inbounds/get/${inboundId}`);
    const payload = await this.readJsonBody(response);
    return response.ok && payload.success !== false;
  }

  private buildClient(
    email: string,
    subId: string,
    telegramId: number,
    expiryMs: number,
    totalGb: number,
    enable: boolean,
    existingUuid?: string,
    limitIp?: number
  ): XuiClientRecord {
    return {
      id: existingUuid || crypto.randomUUID(),
      email,
      subId,
      limitIp: limitIp ?? this.limitIp,
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
    const encoded = encodeURIComponent(email);
    const paths = [
      `/panel/api/inbounds/clearClientIps/${encoded}`,
      `/panel/api/clients/clearIps/${encoded}`,
    ];
    let lastError: Error | null = null;
    for (const path of paths) {
      try {
        const response = await this.request(path, { method: "POST", body: "{}" });
        await this.parseResponse(response, "clearClientIps");
        this.invalidateScan();
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError ?? new Error("clearClientIps failed");
  }

  async rotateClientSubId(
    email: string,
    uuid: string,
    newSubId: string,
    telegramId: number
  ): Promise<void> {
    const client = this.buildClient(
      email,
      newSubId,
      telegramId,
      0,
      0,
      true,
      uuid,
      0
    );
    await this.updateClient(client);
  }

  async getClientIps(email: string): Promise<PanelDeviceIp[]> {
    const response = await this.request(
      `/panel/api/clients/ips/${encodeURIComponent(email)}`,
      { method: "POST", body: "{}" }
    );
    const payload = await this.readJsonBody(response);
    if (!response.ok || payload.success === false) {
      throw new Error(String(payload.msg || "getClientIps failed"));
    }
    const obj = payload.obj;
    if (!obj || obj === "No IP Record") return [];
    if (Array.isArray(obj)) {
      return obj.map((entry) => parseClientIpEntry(String(entry)));
    }
    if (typeof obj === "string") {
      return obj
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map(parseClientIpEntry);
    }
    return [];
  }

  async getOnlineClientEmails(): Promise<string[]> {
    const response = await this.request("/panel/api/clients/onlines", {
      method: "POST",
      body: "{}",
    });
    const payload = await this.readJsonBody(response);
    if (!response.ok || payload.success === false) {
      throw new Error(String(payload.msg || "getOnlineClientEmails failed"));
    }
    const obj = payload.obj;
    if (!Array.isArray(obj)) return [];
    return obj.map((entry) => String(entry));
  }

  async getLastOnlineByEmail(): Promise<Record<string, number>> {
    const response = await this.request("/panel/api/clients/lastOnline", {
      method: "POST",
      body: "{}",
    });
    const payload = await this.readJsonBody(response);
    if (!response.ok || payload.success === false) {
      throw new Error(String(payload.msg || "getLastOnlineByEmail failed"));
    }
    const obj = payload.obj;
    if (!obj || typeof obj !== "object") return {};
    const out: Record<string, number> = {};
    for (const [email, ts] of Object.entries(obj as Record<string, unknown>)) {
      const value = Number(ts);
      if (Number.isFinite(value)) out[email] = value;
    }
    return out;
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
      if (panelByEmail) return;
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
    totalGb: number,
    existingUuid?: string
  ): Promise<string> {
    const client = this.buildClient(
      email,
      subId,
      telegramId,
      expiryMs,
      totalGb,
      true,
      existingUuid
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

    let existing = await this.resolvePanelClientForTelegram(
      params.telegramId,
      params.dbSubscription,
      params.username
    );
    if (!existing) {
      existing = await this.resolveExistingClient(
        params.telegramId,
        params.dbSubscription
      );
    }
    const email =
      String(params.telegramId);

    if (!existing) {
      const recheck = await this.findClientByTelegramId(params.telegramId);
      if (recheck) {
        existing = recheck;
      }
    }

    if (!existing) {
      const seedSubId =
        params.dbSubscription?.xray_sub_id?.trim() || randomSubId();
      const seedUuid = params.dbSubscription?.xray_uuid?.trim();
      await this.addClientIfMissing(
        email,
        seedSubId,
        params.telegramId,
        0,
        0,
        seedUuid
      );
      this.invalidateScan();
      existing =
        (await this.findClientByTelegramId(params.telegramId)) ||
        (await this.resolvePanelClientForTelegram(
          params.telegramId,
          params.dbSubscription,
          params.username
        )) ||
        (await this.resolveExistingClient(
          params.telegramId,
          params.dbSubscription
        )) ||
        (await this.findClientByEmail(email)) ||
        undefined;
    }

    if (!existing?.subId?.trim() || !existing.primaryUuid) {
      throw new Error("клиент в панели не найден");
    }

    await this.rebindPanelClientEmail(existing, params.telegramId);

    return this.toProvisionResult(
      env,
      String(params.telegramId),
      existing.subId,
      existing.primaryUuid
    );
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
