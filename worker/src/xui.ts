import type { BotEnv } from "./env";
import { parseIdList, subscriptionBaseUrl, xuiBaseUrlCandidates, xuiWorkerBaseUrl } from "./env";
import { debugSessionLogKv } from "./debug-session-log";
import { isPanelErrorBody, panelFetch } from "./panel-fetch";
import { canonicalClientKey, panelDisplayLabel } from "./panel-client-label";
import type { StorageEnv } from "./storage-env";

/** 3X-UI принимает expiryTime только как целое число — Unix ms (0 = без срока). */
export function panelExpiryTimeMs(ms: number): number {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

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
  "/panel/api/clients/del/",
  "/panel/api/inbounds/clearClientIps/",
  "/panel/api/clients/ips/",
  "/panel/api/clients/onlines",
  "/panel/api/clients/lastOnline",
  "/panel/api/clients/subLinks/",
  "/panel/api/inbounds/get/",
  "/panel/api/inbounds/update/",
  "/panel/api/inbounds/updateClient/",
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

  private async request(
    path: string,
    init?: RequestInit,
    timeoutMs = 15000
  ): Promise<Response> {
    assertAllowed(path);
    let lastError: Error | null = null;

    for (const baseUrl of this.baseUrls) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await panelFetch(this.env, `${baseUrl}${path}`, {
          ...init,
          headers: { ...this.headers(), ...(init?.headers || {}) },
          signal: controller.signal,
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
        if (error instanceof Error && error.name === "AbortError") {
          lastError = new Error(`XUI timeout (${timeoutMs}ms) via ${baseUrl}`);
        } else {
          lastError = error instanceof Error ? error : new Error(String(error));
        }
      } finally {
        clearTimeout(timer);
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
        const primaryUuid = String(client.uuid ?? client.id ?? "").trim();
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
    return canonicalClientKey(telegramId);
  }

  /** Email/label клиента в панели (может быть @username или «Имя · id»). */
  async resolvePanelEmail(telegramId: number): Promise<string | null> {
    const byTg = await this.findClientByTelegramId(telegramId);
    if (byTg?.email) return byTg.email;
    const legacy = await this.findClientByEmail(canonicalClientKey(telegramId));
    return legacy?.email ?? null;
  }

  async ensureClientEnabledByTelegramId(telegramId: number): Promise<void> {
    const email = await this.resolvePanelEmail(telegramId);
    if (email) await this.forceEnableClient(telegramId, email);
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

    if (username) {
      for (let slot = 1; slot <= 3; slot += 1) {
        const label = panelDisplayLabel(username, null, telegramId, { slot });
        const byLabel = await this.findClientByEmail(label);
        if (byLabel?.subId?.trim() && byLabel.primaryUuid) {
          return {
            email: byLabel.email,
            subId: byLabel.subId,
            primaryUuid: byLabel.primaryUuid,
          };
        }
      }
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
    const primaryUuid = String(client.uuid || client.id || "").trim();
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
      status?: string | null;
    } | null,
    username?: string | null,
    displayName?: string | null
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

      if (!panel && lockedSubId) {
        await this.addClientIfMissing(
          email,
          lockedSubId,
          telegramId,
          0,
          0,
          lockedUuid || undefined,
          1,
          db?.status === "active"
        );
        this.invalidateScan();
        panel = await this.resolvePanelClientForTelegram(telegramId, db);
      }

      if (!panel?.subId?.trim() || !panel.primaryUuid) {
        if (lockedSubId && !lockedUuid) {
          throw new Error("клиент в панели не найден после восстановления");
        }
        return dbFallback();
      }

      await this.syncPanelClientDisplayName(
        panel,
        telegramId,
        username ?? null,
        displayName ?? null
      );
      if (db?.status === "active") {
        await this.ensureClientEnabled(panel.email, telegramId);
      }

      return {
        email: panel.email,
        subId: panel.subId,
        primaryUuid: panel.primaryUuid,
      };
    } catch (error) {
      console.error("ensureLockedPanelClient:", error);
      return dbFallback();
    }
  }

  private async syncPanelClientDisplayName(
    panel: { email: string; subId: string; primaryUuid: string },
    telegramId: number,
    username: string | null | undefined,
    displayName: string | null | undefined,
    limitIp?: number,
    expiryMs?: number
  ): Promise<string> {
    const record = await this.fetchClientRecord(panel.email);
    if (!record) return panel.email;

    const desiredLabel = panelDisplayLabel(username, displayName, telegramId, {
      slot: 1,
    });
    const panelEmail = record.email.trim() || panel.email;
    const numericKey = String(telegramId);
    const targetEmail =
      panelEmail === numericKey && desiredLabel !== numericKey
        ? desiredLabel
        : panelEmail;

    const effectiveExpiry = panelExpiryTimeMs(
      expiryMs && expiryMs > 0 ? expiryMs : record.expiryTime
    );
    const effectiveLimit = limitIp ?? record.limitIp;
    const active = effectiveExpiry === 0 || effectiveExpiry > Date.now();

    const client = this.buildClient(
      targetEmail,
      panel.subId,
      telegramId,
      effectiveExpiry,
      record.totalGB,
      active,
      panel.primaryUuid,
      effectiveLimit
    );

    try {
      const response = await this.request(
        `/panel/api/clients/update/${encodeURIComponent(panel.email)}`,
        {
          method: "POST",
          body: JSON.stringify({
            email: panel.email,
            inboundIds: this.inboundIds,
            client: this.panelClientBody({ ...client, enable: active }),
          }),
        }
      );
      await this.parseResponse(response, "syncPanelClientDisplayName");
      this.invalidateScan();
    } catch (error) {
      console.error("syncPanelClientDisplayName:", error);
    }

    if (active) {
      await this.forceEnableClient(telegramId, targetEmail);
    }
    return targetEmail;
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
    const clientId = existingUuid?.trim() || crypto.randomUUID();
    return {
      id: clientId,
      email,
      subId,
      limitIp: limitIp ?? this.limitIp,
      expiryTime: panelExpiryTimeMs(expiryMs),
      enable,
      tgId: telegramId,
      totalGB: totalGb,
      flow: "",
    };
  }

  private toPanelClientPayload(client: XuiClientRecord): Record<string, unknown> {
    const id = client.id?.trim() || crypto.randomUUID();
    return {
      id,
      uuid: id,
      email: client.email,
      subId: client.subId,
      limitIp: client.limitIp,
      expiryTime: panelExpiryTimeMs(client.expiryTime),
      enable: client.enable,
      tgId: client.tgId,
      totalGB: client.totalGB,
      flow: client.flow ?? "",
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

  async addClient(
    client: XuiClientRecord,
    options?: { enableAfterAdd?: boolean }
  ): Promise<void> {
    const response = await this.request("/panel/api/clients/add", {
      method: "POST",
      body: JSON.stringify({
        inboundIds: this.inboundIds,
        client: this.toPanelClientPayload(client),
      }),
    });
    await this.parseResponse(response, "addClient");
    this.invalidateScan();
    if (options?.enableAfterAdd !== false) {
      await this.forceEnableClient(client.tgId, client.email);
    }
  }

  private async panelActionSucceeded(response: Response): Promise<boolean> {
    if (!response.ok) return false;
    const text = (await response.text()).trim();
    if (!text) return true;
    try {
      const payload = JSON.parse(text) as { success?: boolean; msg?: string };
      if (payload.success === false) {
        console.error("panel action failed:", payload.msg || text.slice(0, 120));
        return false;
      }
      return true;
    } catch {
      return !isPanelHtmlError(text, response.status);
    }
  }

  private async findInboundClientRows(
    telegramId: number,
    emailHint?: string
  ): Promise<
    Array<{
      inboundId: number;
      row: Record<string, unknown>;
      email: string;
      obj: Record<string, unknown>;
      settings: { clients?: Array<Record<string, unknown>> };
    }>
  > {
    const hint = emailHint?.trim() || String(telegramId);
    const hits: Array<{
      inboundId: number;
      row: Record<string, unknown>;
      email: string;
      obj: Record<string, unknown>;
      settings: { clients?: Array<Record<string, unknown>> };
    }> = [];

    for (const inboundId of this.inboundIds) {
      try {
        const response = await this.request(`/panel/api/inbounds/get/${inboundId}`);
        const payload = await this.readJsonBody(response);
        if (!response.ok || payload.success === false) continue;
        const obj = payload.obj as Record<string, unknown> | undefined;
        if (!obj) continue;

        const settingsRaw = obj.settings;
        const settings =
          typeof settingsRaw === "string"
            ? (JSON.parse(settingsRaw) as {
                clients?: Array<Record<string, unknown>>;
              })
            : (settingsRaw as { clients?: Array<Record<string, unknown>> } | undefined);

        for (const row of settings?.clients ?? []) {
          const email = String(row.email || "");
          const tgId = Number(row.tgId) || 0;
          if (tgId === telegramId || email === hint) {
            hits.push({
              inboundId,
              row,
              email,
              obj,
              settings: settings ?? {},
            });
          }
        }
      } catch (error) {
        console.error(`findInboundClientRows ${inboundId}:`, error);
      }
    }

    return hits;
  }

  private inboundRowToRecord(
    row: Record<string, unknown>,
    email: string,
    telegramId: number
  ): XuiClientRecord {
    return {
      id: String(row.id || ""),
      email: String(row.email || email),
      subId: String(row.subId ?? ""),
      limitIp: Number(row.limitIp ?? this.limitIp),
      expiryTime: panelExpiryTimeMs(Number(row.expiryTime ?? 0)),
      enable: true,
      tgId: Number(row.tgId) || telegramId,
      totalGB: Number(row.totalGB ?? 0),
      flow: String(row.flow ?? ""),
    };
  }

  private async patchInboundClientFields(
    inboundId: number,
    obj: Record<string, unknown>,
    settings: { clients?: Array<Record<string, unknown>> },
    telegramId: number,
    email: string,
    apply: (row: Record<string, unknown>) => void
  ): Promise<boolean> {
    const clients = [...(settings.clients ?? [])];
    let touched = false;
    for (const row of clients) {
      const rowEmail = String(row.email || "");
      const tgId = Number(row.tgId) || 0;
      if (
        tgId !== telegramId &&
        rowEmail !== email &&
        rowEmail !== String(telegramId)
      ) {
        continue;
      }
      apply(row);
      if (!row.tgId) row.tgId = telegramId;
      if (row.expiryTime !== undefined && row.expiryTime !== null) {
        row.expiryTime = panelExpiryTimeMs(Number(row.expiryTime));
      }
      touched = true;
    }
    if (!touched) return false;

    const updateBody: Record<string, unknown> = {
      ...obj,
      settings: JSON.stringify({ ...settings, clients }),
    };
    for (const key of Object.keys(updateBody)) {
      if (updateBody[key] === null) delete updateBody[key];
    }

    try {
      const response = await this.request(`/panel/api/inbounds/update/${inboundId}`, {
        method: "POST",
        body: JSON.stringify(updateBody),
      });
      const ok = await this.panelActionSucceeded(response);
      if (ok) this.invalidateScan();
      return ok;
    } catch (error) {
      console.error(`patchInboundClientFields ${inboundId}:`, error);
      return false;
    }
  }

  private async patchInboundClientEnabled(
    inboundId: number,
    obj: Record<string, unknown>,
    settings: { clients?: Array<Record<string, unknown>> },
    telegramId: number,
    email: string
  ): Promise<boolean> {
    return this.patchInboundClientFields(
      inboundId,
      obj,
      settings,
      telegramId,
      email,
      (row) => {
        row.enable = true;
      }
    );
  }

  private async syncInboundClientFields(
    telegramId: number,
    emailHint: string,
    apply: (row: Record<string, unknown>) => void
  ): Promise<void> {
    const hint = emailHint.trim() || String(telegramId);
    for (const inboundId of this.inboundIds) {
      try {
        const response = await this.request(`/panel/api/inbounds/get/${inboundId}`);
        const payload = await this.readJsonBody(response);
        if (!response.ok || payload.success === false) continue;
        const obj = payload.obj as Record<string, unknown> | undefined;
        if (!obj) continue;

        const settingsRaw = obj.settings;
        const settings =
          typeof settingsRaw === "string"
            ? (JSON.parse(settingsRaw) as {
                clients?: Array<Record<string, unknown>>;
              })
            : ((settingsRaw as { clients?: Array<Record<string, unknown>> }) ?? {});

        await this.patchInboundClientFields(
          inboundId,
          obj,
          settings,
          telegramId,
          hint,
          apply
        );
      } catch (error) {
        console.error(`syncInboundClientFields ${inboundId}:`, error);
      }
    }
  }

  private async resolveClientExpiryMs(
    telegramId: number,
    emailHint: string
  ): Promise<number> {
    const hint = emailHint.trim() || String(telegramId);
    const global = await this.fetchClientRecord(hint);
    const fromGlobal = panelExpiryTimeMs(global?.expiryTime ?? 0);
    if (fromGlobal > 0) return fromGlobal;

    const rows = await this.findInboundClientRows(telegramId, hint);
    for (const hit of rows) {
      const inbound = panelExpiryTimeMs(Number(hit.row.expiryTime ?? 0));
      if (inbound > 0) return inbound;
    }
    return 0;
  }

  private async patchGlobalClientEnabled(record: XuiClientRecord): Promise<boolean> {
    if (!record.id || !record.email) return false;
    try {
      const response = await this.request(
        `/panel/api/clients/update/${encodeURIComponent(record.email)}`,
        {
          method: "POST",
          body: JSON.stringify({
            email: record.email,
            inboundIds: this.inboundIds,
            client: { ...this.toPanelClientPayload(record), enable: true },
          }),
        }
      );
      await this.parseResponse(response, "patchGlobalClientEnabled");
      this.invalidateScan();
      return true;
    } catch (error) {
      console.error("patchGlobalClientEnabled:", error);
      return false;
    }
  }

  /** UI toggle reads enable from inbound settings — patch each inbound where client is disabled. */
  private async syncInboundEnableFlags(
    telegramId: number,
    emailHint: string
  ): Promise<boolean> {
    const hint = emailHint.trim() || String(telegramId);
    let anyFixed = false;

    for (const inboundId of this.inboundIds) {
      try {
        const response = await this.request(`/panel/api/inbounds/get/${inboundId}`);
        const payload = await this.readJsonBody(response);
        if (!response.ok || payload.success === false) continue;
        const obj = payload.obj as Record<string, unknown> | undefined;
        if (!obj) continue;

        const settingsRaw = obj.settings;
        const settings =
          typeof settingsRaw === "string"
            ? (JSON.parse(settingsRaw) as {
                clients?: Array<Record<string, unknown>>;
              })
            : ((settingsRaw as { clients?: Array<Record<string, unknown>> }) ?? {});

        let needsPatch = false;
        for (const row of settings.clients ?? []) {
          const rowEmail = String(row.email || "");
          const tgId = Number(row.tgId) || 0;
          if (tgId !== telegramId && rowEmail !== hint && rowEmail !== String(telegramId)) {
            continue;
          }
          if (row.enable === true) continue;
          needsPatch = true;
          break;
        }
        if (!needsPatch) continue;

        const ok = await this.patchInboundClientEnabled(
          inboundId,
          obj,
          settings,
          telegramId,
          hint
        );
        if (ok) anyFixed = true;
      } catch (error) {
        console.error(`syncInboundEnableFlags ${inboundId}:`, error);
      }
    }

    return anyFixed;
  }

  private async inboundClientsEnabled(
    telegramId: number,
    emailHint: string
  ): Promise<boolean> {
    const rows = await this.findInboundClientRows(telegramId, emailHint);
    if (rows.length === 0) return false;
    return rows.every((r) => r.row.enable === true);
  }

  /** Включает клиента: clients/update + enable:true в каждом inbound (тумблер в UI). */
  async forceEnableClient(telegramId: number, emailHint?: string): Promise<void> {
    const resolved =
      (await this.resolvePanelEmail(telegramId)) ||
      emailHint?.trim() ||
      String(telegramId);
    const record = await this.fetchClientRecord(resolved);
    if (
      record?.enable === true &&
      (await this.inboundClientsEnabled(telegramId, resolved))
    ) {
      return;
    }
    const resolvedExpiry = await this.resolveClientExpiryMs(telegramId, resolved);
    if (resolvedExpiry > 0 && resolvedExpiry <= Date.now()) {
      return;
    }
    const delays = [0, 600];

    for (const delay of delays) {
      if (delay > 0) {
        this.invalidateScan();
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      let globalOk = false;
      const resolvedExpiry = await this.resolveClientExpiryMs(telegramId, resolved);
      const record = await this.fetchClientRecord(resolved);
      if (record?.id) {
        globalOk = await this.patchGlobalClientEnabled({
          ...record,
          enable: true,
          expiryTime: resolvedExpiry || panelExpiryTimeMs(record.expiryTime),
          tgId: telegramId || record.tgId,
          limitIp: record.limitIp > 0 ? record.limitIp : 1,
        });
      } else {
        const rows = await this.findInboundClientRows(telegramId, resolved);
        if (rows.length > 0) {
          const primary = rows[0];
          const globalRecord = this.inboundRowToRecord(
            primary.row,
            primary.email,
            telegramId
          );
          if (globalRecord.id) {
            globalOk = await this.patchGlobalClientEnabled({
              ...globalRecord,
              enable: true,
              expiryTime:
                resolvedExpiry || panelExpiryTimeMs(globalRecord.expiryTime),
            });
          }
        }
      }

      const inboundOk = await this.syncInboundEnableFlags(telegramId, resolved);
      if (globalOk || inboundOk) {
        const enabled = await this.inboundClientsEnabled(telegramId, resolved);
        if (enabled) {
          console.error(
            "forceEnableClient:",
            telegramId,
            `global=${globalOk} inbound=${inboundOk}`
          );
          return;
        }
      }
    }

    console.error("forceEnableClient failed:", telegramId);
  }

  /** Global-only client must be re-added to inbounds; clients/update alone is not enough. */
  async attachClientToInbounds(
    telegramId: number,
    panel: { email: string; subId: string; primaryUuid: string },
    options?: {
      username?: string | null;
      displayName?: string | null;
      limitIp?: number;
      expiryMs?: number;
    }
  ): Promise<boolean> {
    const onInbound = await this.findClientByTelegramId(telegramId);
    if (onInbound?.subId?.trim() && onInbound.primaryUuid) return true;

    const record = await this.fetchClientRecord(panel.email);
    const limitIp = options?.limitIp ?? record?.limitIp ?? this.limitIp;
    const expiryMs =
      options?.expiryMs && options.expiryMs > 0
        ? options.expiryMs
        : record?.expiryTime ?? 0;
    const client = this.buildClient(
      panel.email,
      panel.subId,
      telegramId,
      expiryMs,
      record?.totalGB ?? 0,
      true,
      panel.primaryUuid || record?.id || "",
      limitIp
    );

    try {
      await this.addClient(client, { enableAfterAdd: true });
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (message.includes("already in use")) {
        await this.touchPanelClient(telegramId, panel.email, { limitIp });
        await this.forceEnableClient(telegramId, panel.email);
      } else {
        await this.syncPanelClientDisplayName(
          panel,
          telegramId,
          options?.username ?? null,
          options?.displayName ?? null,
          limitIp,
          expiryMs
        );
        try {
          await this.addClient(client, { enableAfterAdd: true });
        } catch (retryError) {
          const retryMsg =
            retryError instanceof Error ? retryError.message.toLowerCase() : "";
          if (!retryMsg.includes("already in use")) {
            console.error("attachClientToInbounds add retry:", retryError);
          }
        }
      }
    }

    this.invalidateScan();
    const attached = await this.findClientByTelegramId(telegramId);
    return Boolean(attached?.subId?.trim() && attached.primaryUuid);
  }

  private async touchPanelClient(
    telegramId: number,
    email: string,
    patch: Partial<XuiClientRecord> = {}
  ): Promise<void> {
    const record = await this.fetchClientRecord(email);
    if (!record?.id?.trim()) return;
    try {
      await this.updateClient({
        ...record,
        ...patch,
        enable: true,
        tgId: telegramId || record.tgId,
        limitIp: patch.limitIp ?? (record.limitIp > 0 ? record.limitIp : 1),
      });
    } catch (error) {
      console.error("touchPanelClient:", email, error);
    }
  }

  async ensureClientEnabled(email: string, telegramId: number): Promise<void> {
    await this.forceEnableClient(telegramId, email);
  }

  async setClientLimitIp(email: string, limitIp: number): Promise<void> {
    const record = await this.fetchClientRecord(email);
    if (!record) throw new Error("getClient failed");
    if (record.limitIp === limitIp && record.enable) return;
    await this.updateClient({ ...record, limitIp, enable: true });
    const tgId = record.tgId || Number(email) || 0;
    if (tgId) await this.forceEnableClient(tgId, email);
  }

  private async fetchClientRecord(email: string): Promise<XuiClientRecord | null> {
    const response = await this.request(
      `/panel/api/clients/get/${encodeURIComponent(email)}`
    );
    const payload = await this.readJsonBody(response);
    if (!response.ok || payload.success === false) return null;
    const row = (payload.obj as { client?: Record<string, unknown> } | undefined)?.client;
    if (!row) return null;
    let clientId = String(row.uuid ?? row.id ?? "").trim();
    if (!clientId) {
      const clients = await this.scanAllClients();
      for (const client of clients) {
        if (client.email === email) {
          clientId = client.primaryUuid;
          break;
        }
      }
    }
    if (!clientId) return null;
    return {
      id: clientId,
      email: String(row.email ?? email),
      subId: String(row.subId ?? ""),
      limitIp: Number(row.limitIp ?? this.limitIp),
      expiryTime: panelExpiryTimeMs(Number(row.expiryTime ?? 0)),
      enable: Boolean(row.enable ?? true),
      tgId: Number(row.tgId ?? 0),
      totalGB: Number(row.totalGB ?? 0),
      flow: String(row.flow ?? ""),
    };
  }

  private panelClientBody(client: XuiClientRecord): Record<string, unknown> {
    const id = client.id?.trim() || crypto.randomUUID();
    return {
      id,
      email: client.email,
      subId: client.subId,
      limitIp: client.limitIp,
      expiryTime: panelExpiryTimeMs(client.expiryTime),
      enable: client.enable !== false,
      tgId: client.tgId,
      totalGB: client.totalGB ?? 0,
      flow: client.flow ?? "",
    };
  }

  async updateClient(client: XuiClientRecord): Promise<void> {
    const existing = await this.fetchClientRecord(client.email);
    if (!existing) {
      const onInbound = await this.findClientByEmail(client.email);
      if (onInbound?.primaryUuid) {
        const merged: XuiClientRecord = {
          email: onInbound.email,
          id: client.id?.trim() || onInbound.primaryUuid,
          subId: client.subId?.trim() || onInbound.subId,
          limitIp: client.limitIp > 0 ? client.limitIp : this.limitIp,
          expiryTime: panelExpiryTimeMs(client.expiryTime),
          enable: client.enable !== false,
          tgId: client.tgId || onInbound.tgId || 0,
          totalGB: client.totalGB ?? 0,
          flow: client.flow ?? "",
        };
        const active =
          merged.expiryTime === 0 || merged.expiryTime > Date.now();
        if (active) merged.enable = true;
        // #region agent log
        await debugSessionLogKv(
          this.env,
          "xui.ts:updateClient",
          "global missing — addClient fallback",
          {
            email: merged.email,
            subIdPrefix: merged.subId.slice(0, 8),
            inboundOnly: true,
          },
          "N"
        );
        // #endregion
        await this.addClient(merged, { enableAfterAdd: active });
        this.invalidateScan();
        return;
      }
    }

    const merged: XuiClientRecord = existing
      ? {
          ...existing,
          ...client,
          id: client.id?.trim() || existing.id,
          subId: client.subId?.trim() || existing.subId,
          email: client.email?.trim() || existing.email,
        }
      : client;

    merged.expiryTime = panelExpiryTimeMs(merged.expiryTime);

    const active =
      merged.expiryTime === 0 || merged.expiryTime > Date.now();
    if (active) {
      merged.enable = true;
    }

    const response = await this.request(
      `/panel/api/clients/update/${encodeURIComponent(merged.email)}`,
      {
        method: "POST",
        body: JSON.stringify({
          email: merged.email,
          inboundIds: this.inboundIds,
          client: this.panelClientBody(merged),
        }),
      }
    );
    await this.parseResponse(response, "updateClient");
    this.invalidateScan();

    const tgId = merged.tgId || Number(merged.email) || 0;
    const expiryMs = panelExpiryTimeMs(merged.expiryTime);
    if (tgId) {
      await this.syncInboundClientFields(tgId, merged.email, (row) => {
        row.expiryTime = expiryMs;
        row.enable = active;
        row.limitIp = merged.limitIp;
        if (merged.subId) row.subId = merged.subId;
        if (!row.id && merged.id) row.id = merged.id;
      });
      if (active) {
        await this.forceEnableClient(tgId, merged.email);
      }
    }
  }

  /** Отключает доступ в панели после истечения подписки/пробного. */
  async expireClientAccess(telegramId: number): Promise<void> {
    if (!Number.isFinite(telegramId) || telegramId <= 0) return;
    const email =
      (await this.resolvePanelEmail(telegramId)) || String(telegramId);
    const record = await this.fetchClientRecord(email);
    if (!record) return;
    const past = panelExpiryTimeMs(Date.now() - 60_000);
    await this.updateClient({
      ...record,
      email,
      expiryTime: past,
      enable: false,
      tgId: telegramId,
    });
  }

  async clearClientIps(email: string, options?: { timeoutMs?: number }): Promise<void> {
    const cleared = await this.tryClearClientIps(email, options?.timeoutMs ?? 12_000);
    if (!cleared) {
      throw new Error("clearClientIps failed");
    }
  }

  /** Keep one enabled inbound row per telegramId; drop duplicate disabled copies. */
  async pruneDuplicateInboundClients(
    telegramId: number,
    emailHint: string
  ): Promise<number> {
    const hint = emailHint.trim() || String(telegramId);
    let removed = 0;

    for (const inboundId of this.inboundIds) {
      try {
        const response = await this.request(`/panel/api/inbounds/get/${inboundId}`);
        const payload = await this.readJsonBody(response);
        if (!response.ok || payload.success === false) continue;
        const obj = payload.obj as Record<string, unknown> | undefined;
        if (!obj) continue;

        const settingsRaw = obj.settings;
        const settings =
          typeof settingsRaw === "string"
            ? (JSON.parse(settingsRaw) as {
                clients?: Array<Record<string, unknown>>;
              })
            : ((settingsRaw as { clients?: Array<Record<string, unknown>> }) ?? {});
        const clients = [...(settings.clients ?? [])];

        const matches: Array<Record<string, unknown>> = [];
        const others: Array<Record<string, unknown>> = [];
        for (const row of clients) {
          const rowEmail = String(row.email || "");
          const tgId = Number(row.tgId) || 0;
          if (
            tgId === telegramId ||
            rowEmail === hint ||
            rowEmail === String(telegramId)
          ) {
            matches.push(row);
          } else {
            others.push(row);
          }
        }
        if (matches.length <= 1) continue;

        const keep =
          matches.find((row) => row.enable === true) ?? matches[matches.length - 1];
        const keepRow: Record<string, unknown> = {
          ...keep,
          enable: true,
          tgId: telegramId,
        };
        removed += matches.length - 1;

        const updateBody: Record<string, unknown> = {
          ...obj,
          settings: JSON.stringify({
            ...settings,
            clients: [...others, keepRow],
          }),
        };
        for (const key of Object.keys(updateBody)) {
          if (updateBody[key] === null) delete updateBody[key];
        }

        const updateResponse = await this.request(
          `/panel/api/inbounds/update/${inboundId}`,
          {
            method: "POST",
            body: JSON.stringify(updateBody),
          }
        );
        if (await this.panelActionSucceeded(updateResponse)) {
          this.invalidateScan();
        }
      } catch (error) {
        console.error(`pruneDuplicateInboundClients ${inboundId}:`, error);
      }
    }

    return removed;
  }

  /** Re-attach client to inbounds with enable:true (clients/add — works on 3X-UI v3.2.7). */
  async reenableInboundClientAfterReset(
    telegramId: number,
    panel: { email: string; subId: string; primaryUuid: string },
    options?: { limitIp?: number; expiryMs?: number }
  ): Promise<boolean> {
    if (!panel.subId?.trim() || !panel.primaryUuid?.trim()) return false;

    const expiryMs =
      options?.expiryMs && options.expiryMs > Date.now()
        ? options.expiryMs
        : await this.resolveClientExpiryMs(telegramId, panel.email);
    if (!expiryMs || expiryMs <= Date.now()) {
      return false;
    }
    const limitIp = options?.limitIp ?? 1;
    const client = this.buildClient(
      panel.email,
      panel.subId,
      telegramId,
      expiryMs,
      0,
      true,
      panel.primaryUuid,
      limitIp
    );

    try {
      await this.addClient(client, { enableAfterAdd: true });
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (!message.includes("already in use")) {
        console.error("reenableInboundClientAfterReset:", error);
        return false;
      }
    }

    this.invalidateScan();
    await this.pruneDuplicateInboundClients(telegramId, panel.email);
    const rows = await this.findInboundClientRows(telegramId, panel.email);
    return rows.length > 0 && rows.some((row) => row.row.enable === true);
  }

  /** Полное удаление клиента из панели (inbound + global). */
  async deletePanelClientByTelegramId(
    telegramId: number,
    options?: { username?: string | null; displayName?: string | null }
  ): Promise<boolean> {
    if (!Number.isFinite(telegramId) || telegramId <= 0) return false;

    this.invalidateScan();
    const emails = new Set<string>([String(telegramId)]);

    for (let slot = 1; slot <= 3; slot += 1) {
      emails.add(
        panelDisplayLabel(
          options?.username,
          options?.displayName,
          telegramId,
          { slot }
        )
      );
    }

    const byTg = await this.findClientByTelegramId(telegramId);
    if (byTg?.email) emails.add(byTg.email);

    const inboundRows = await this.findInboundClientRows(
      telegramId,
      String(telegramId)
    );
    for (const hit of inboundRows) emails.add(hit.email);

    let removed = false;
    const processedInbounds = new Set<number>();

    for (const inboundId of this.inboundIds) {
      if (processedInbounds.has(inboundId)) continue;
      try {
        const response = await this.request(`/panel/api/inbounds/get/${inboundId}`);
        const payload = await this.readJsonBody(response);
        if (!response.ok || payload.success === false) continue;
        const obj = payload.obj as Record<string, unknown> | undefined;
        if (!obj) continue;

        const settingsRaw = obj.settings;
        const settings =
          typeof settingsRaw === "string"
            ? (JSON.parse(settingsRaw) as {
                clients?: Array<Record<string, unknown>>;
              })
            : ((settingsRaw as { clients?: Array<Record<string, unknown>> }) ?? {});

        const clients = [...(settings.clients ?? [])];
        const filtered = clients.filter((row) => {
          const tgId = Number(row.tgId) || 0;
          const rowEmail = String(row.email || "");
          if (tgId === telegramId) return false;
          if (emails.has(rowEmail)) return false;
          if (rowEmail === String(telegramId)) return false;
          return true;
        });

        if (filtered.length === clients.length) continue;

        const updateBody: Record<string, unknown> = {
          ...obj,
          settings: JSON.stringify({ ...settings, clients: filtered }),
        };
        for (const key of Object.keys(updateBody)) {
          if (updateBody[key] === null) delete updateBody[key];
        }

        const upd = await this.request(`/panel/api/inbounds/update/${inboundId}`, {
          method: "POST",
          body: JSON.stringify(updateBody),
        });
        if (await this.panelActionSucceeded(upd)) removed = true;
        processedInbounds.add(inboundId);
      } catch (error) {
        console.error(`deletePanelClientByTelegramId inbound ${inboundId}:`, error);
      }
    }

    for (const email of emails) {
      if (await this.tryDeletePanelClient(email, 15_000)) removed = true;
    }

    this.invalidateScan();
    const stillThere = await this.findClientByTelegramId(telegramId);
    if (stillThere) {
      console.error(
        "deletePanelClientByTelegramId: still in panel",
        telegramId,
        stillThere.email
      );
      return false;
    }
    for (let slot = 1; slot <= 3; slot += 1) {
      const label = panelDisplayLabel(
        options?.username,
        options?.displayName,
        telegramId,
        { slot }
      );
      const global = await this.getClientByEmailApi(label);
      if (global) {
        console.error(
          "deletePanelClientByTelegramId: global client remains",
          telegramId,
          label
        );
        return false;
      }
    }

    return removed || emails.size > 0;
  }

  /** Полное удаление клиента из панели (для сброса подключения). */
  async tryDeletePanelClient(email: string, timeoutMs = 8000): Promise<boolean> {
    const trimmed = email.trim();
    if (!trimmed) return false;

    const encodedCandidates = [
      encodeURIComponent(trimmed),
      ...(trimmed.includes("@") ? [trimmed] : []),
    ].filter((value, index, list) => list.indexOf(value) === index);

    const pathVariants = encodedCandidates.map(
      (encoded) => `/panel/api/clients/del/${encoded}`
    );
    const bases = [xuiWorkerBaseUrl(this.env), ...this.baseUrls].filter(
      (base, index, list) => base && list.indexOf(base) === index
    );

    for (const baseUrl of bases) {
      for (const path of pathVariants) {
        try {
          const response = await this.requestTimed(
            `${baseUrl}${path}`,
            { method: "POST", body: "{}" },
            timeoutMs
          );
          if (await this.panelActionSucceeded(response)) {
            this.invalidateScan();
            return true;
          }
        } catch {
          // try next path/base
        }
      }
    }
    return false;
  }

  /** Fast panel IP reset via direct panel API (clients/clearIps first). */
  async tryClearClientIps(email: string, timeoutMs = 12000): Promise<boolean> {
    const trimmed = email.trim();
    if (!trimmed) return false;

    const encoded = encodeURIComponent(trimmed);
    const paths = [
      `/panel/api/clients/clearIps/${encoded}`,
      `/panel/api/inbounds/clearClientIps/${encoded}`,
    ];

    for (const path of paths) {
      try {
        const response = await this.request(
          path,
          { method: "POST", body: "{}" },
          timeoutMs
        );
        if (await this.panelActionSucceeded(response)) {
          this.invalidateScan();
          return true;
        }
      } catch {
        // try next path
      }
    }
    return false;
  }

  private async requestTimed(
    url: string,
    init: RequestInit,
    timeoutMs: number
  ): Promise<Response> {
    const path = new URL(url).pathname;
    assertAllowed(path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await panelFetch(this.env, url, {
        ...init,
        headers: { ...this.headers(), ...(init.headers || {}) },
        signal: controller.signal,
      });
      const preview = await response.clone().text();
      if (isPanelHtmlError(preview, response.status)) {
        throw new Error(`XUI HTML/526 (${response.status})`);
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
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
    env: StorageEnv,
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
    existingUuid?: string,
    limitIp = 1,
    enableAfterAdd = true
  ): Promise<string> {
    const client = this.buildClient(
      email,
      subId,
      telegramId,
      expiryMs,
      totalGb,
      enableAfterAdd,
      existingUuid,
      limitIp
    );
    try {
      await this.addClient(client, { enableAfterAdd });
      return client.id;
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (!message.includes("already in use")) throw error;
      const existing = await this.findClientByEmail(email);
      if (!existing?.primaryUuid) throw error;
      if (enableAfterAdd) {
        await this.touchPanelClient(telegramId, email, { limitIp });
        await this.forceEnableClient(telegramId, email);
      }
      return existing.primaryUuid;
    }
  }

  private async waitForPanelClient(
    telegramId: number,
    username: string | null,
    db?: {
      client_email?: string | null;
      xray_sub_id?: string | null;
      xray_uuid?: string | null;
    } | null,
    panelLabel?: string,
    attempts = 2,
    delayMs = 300
  ): Promise<{ email: string; subId: string; primaryUuid: string } | undefined> {
    for (let i = 0; i < attempts; i += 1) {
      if (i > 0) this.invalidateScan();
      const found =
        (await this.findClientByTelegramId(telegramId)) ||
        (await this.resolvePanelClientForTelegram(telegramId, db, username)) ||
        (await this.resolveExistingClient(telegramId, db)) ||
        (panelLabel ? await this.findClientByEmail(panelLabel) : null);
      if (found?.subId?.trim() && found.primaryUuid) {
        return found;
      }
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return undefined;
  }

  async ensureClientPrepared(
    env: BotEnv,
    params: {
      userId: string;
      username: string | null;
      displayName?: string | null;
      telegramId: number;
      limitIp?: number;
      /** false = только создать/найти клиента, не трогать тумблер enable */
      enableClient?: boolean;
      dbSubscription?: {
        client_email?: string | null;
        xray_sub_id?: string | null;
        xray_uuid?: string | null;
      } | null;
    }
  ): Promise<ProvisionResult> {
    const enableClient = params.enableClient !== false;
    const limitIp = params.limitIp ?? 1;
    const dbKey = canonicalClientKey(params.telegramId);
    const panelLabel = panelDisplayLabel(
      params.username,
      params.displayName,
      params.telegramId,
      { slot: 1 }
    );

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
      const primaryUuid = await this.addClientIfMissing(
        panelLabel,
        seedSubId,
        params.telegramId,
        0,
        0,
        seedUuid,
        limitIp,
        enableClient
      );
      const byLabel = await this.findClientByEmail(panelLabel);
      const resolved =
        (await this.waitForPanelClient(
          params.telegramId,
          params.username ?? null,
          params.dbSubscription,
          panelLabel
        )) ||
        (await this.findClientByTelegramId(params.telegramId)) ||
        byLabel;
      existing = {
        email: resolved?.email || byLabel?.email || panelLabel,
        subId: resolved?.subId?.trim() || byLabel?.subId?.trim() || seedSubId,
        primaryUuid:
          resolved?.primaryUuid || byLabel?.primaryUuid || primaryUuid,
      };
    }

    if (!existing?.subId?.trim() || !existing.primaryUuid) {
      throw new Error("клиент в панели не найден");
    }

    const panelEmail = await this.syncPanelClientDisplayName(
      existing,
      params.telegramId,
      params.username,
      params.displayName,
      limitIp
    );
    if (enableClient) {
      const alreadyEnabled = await this.inboundClientsEnabled(
        params.telegramId,
        panelEmail
      );
      if (!alreadyEnabled) {
        await this.forceEnableClient(params.telegramId, panelEmail);
      }
    }

    return this.toProvisionResult(
      env,
      panelEmail,
      existing.subId,
      existing.primaryUuid
    );
  }

  private async provisionTrialNewClient(
    env: BotEnv,
    params: {
      username: string | null;
      displayName?: string | null;
      telegramId: number;
      expiryMs: number;
    },
    limitIp: number
  ): Promise<ProvisionResult> {
    const panelLabel = panelDisplayLabel(
      params.username,
      params.displayName ?? null,
      params.telegramId,
      { slot: 1 }
    );
    const emailKey = canonicalClientKey(params.telegramId);

    const existing = await this.findClientByTelegramId(params.telegramId);

    if (existing?.subId && existing.primaryUuid) {
      const client = this.buildClient(
        existing.email,
        existing.subId,
        params.telegramId,
        params.expiryMs,
        0,
        true,
        existing.primaryUuid,
        limitIp
      );
      await this.updateClient(client);
      return this.toProvisionResult(
        env,
        existing.email,
        existing.subId,
        existing.primaryUuid
      );
    }

    const seedSubId = randomSubId();
    const primaryUuid = await this.addClientIfMissing(
      panelLabel,
      seedSubId,
      params.telegramId,
      params.expiryMs,
      0,
      undefined,
      limitIp,
      true
    );
    const resolved = await this.findClientByTelegramId(params.telegramId);
    const email = resolved?.email || panelLabel;
    const subId = resolved?.subId || seedSubId;
    const result = this.toProvisionResult(env, email, subId, primaryUuid);
    const firstInbound = this.inboundIds[0];
    return firstInbound
      ? {
          ...result,
          inbounds: [{ inboundId: firstInbound, clientUuid: primaryUuid }],
        }
      : result;
  }

  async provisionTrial(
    env: BotEnv,
    params: {
      userId: string;
      username: string | null;
      displayName?: string | null;
      telegramId: number;
      expiryMs: number;
      limitIp?: number;
      dbSubscription?: {
        client_email?: string | null;
        xray_sub_id?: string | null;
        xray_uuid?: string | null;
      } | null;
    }
  ): Promise<ProvisionResult> {
    const limitIp = params.limitIp ?? 1;
    const lockedSubId = params.dbSubscription?.xray_sub_id?.trim() || "";
    const lockedUuid = params.dbSubscription?.xray_uuid?.trim() || "";
    const dbEmail = params.dbSubscription?.client_email?.trim() || "";

    let panelEmail = dbEmail || canonicalClientKey(params.telegramId);
    let subId = lockedSubId;
    let primaryUuid = lockedUuid;

    if (!subId || !primaryUuid) {
      const byTg = await this.findClientByTelegramId(params.telegramId);
      if (byTg) {
        panelEmail = byTg.email;
        subId = byTg.subId;
        primaryUuid = byTg.primaryUuid;
      }
    }

    if (!subId || !primaryUuid) {
      return this.provisionTrialNewClient(env, params, limitIp);
    }

    const client = this.buildClient(
      panelEmail,
      subId,
      params.telegramId,
      params.expiryMs,
      0,
      true,
      primaryUuid,
      limitIp
    );

    try {
      await this.updateClient(client);
    } catch (error) {
      if (this.isMissingClientError(error)) {
        return this.provisionTrialNewClient(env, params, limitIp);
      }
      const resolved = await this.findClientByTelegramId(params.telegramId);
      if (!resolved?.email || resolved.email === panelEmail) throw error;
      panelEmail = resolved.email;
      subId = subId || resolved.subId;
      primaryUuid = primaryUuid || resolved.primaryUuid;
      await this.updateClient({
        ...client,
        email: panelEmail,
        subId,
        id: primaryUuid,
      });
    }

    return this.toProvisionResult(env, panelEmail, subId, primaryUuid);
  }

  async provisionUser(
    env: BotEnv,
    params: {
      userId: string;
      username: string | null;
      displayName?: string | null;
      telegramId: number;
      expiryMs: number;
      totalGb?: number;
      limitIp?: number;
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
      displayName: params.displayName,
      telegramId: params.telegramId,
      limitIp: params.limitIp ?? 1,
      dbSubscription: params.dbSubscription,
    });

    const panelEmail =
      (await this.resolvePanelEmail(params.telegramId)) || prepared.email;

    const client = this.buildClient(
      panelEmail,
      prepared.subId,
      params.telegramId,
      params.expiryMs,
      params.totalGb ?? 0,
      true,
      prepared.primaryUuid,
      params.limitIp
    );
    try {
      await this.updateClient(client);
    } catch (error) {
      console.error("provisionUser update:", error);
      if (params.expiryMs > Date.now()) {
        throw error instanceof Error
          ? error
          : new Error("Не удалось обновить срок в панели");
      }
    } finally {
      await this.forceEnableClient(params.telegramId, panelEmail);
    }

    await this.syncPanelClientDisplayName(
      { email: panelEmail, subId: prepared.subId, primaryUuid: prepared.primaryUuid },
      params.telegramId,
      params.username,
      params.displayName,
      params.limitIp,
      params.expiryMs
    );

    return this.toProvisionResult(
      env,
      panelEmail,
      prepared.subId,
      prepared.primaryUuid
    );
  }
}
