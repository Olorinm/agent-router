import { randomBytes, createHash } from "node:crypto";
import type { Request, Response } from "express";
import { WorkError } from "../matrix/cli-work.js";
import type { ManagedService } from "../matrix/managed.js";

interface Session {
  token: string;
  owner: string;
  expiresAt: number;
  matrixLogin: boolean;
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const nonce = () => randomBytes(32).toString("base64url");
export const setupPath = "/_agent-router/setup";
export class BrowserSessions {
  private sessions = new Map<string, Session>();
  private tickets = new Map<string, Session>();
  private readonly cookie: string;
  constructor(readonly service: ManagedService) {
    this.cookie =
      new URL(service.config.publicUrl).protocol === "https:"
        ? "__Secure-ar_setup"
        : "ar_setup";
  }
  private collect(map: Map<string, Session>) {
    for (const [id, session] of map)
      if (session.expiresAt <= Date.now()) {
        map.delete(id);
        void this.revoke(session);
      }
    if (map.size >= 10_000)
      throw new WorkError("too_many_browser_sessions", 429);
  }
  private key(req: Request) {
    return (
      req.headers.cookie
        ?.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(this.cookie + "="))
        ?.slice(this.cookie.length + 1) ?? ""
    );
  }
  private cookieOptions() {
    return {
      httpOnly: true,
      sameSite: "strict" as const,
      secure: this.cookie.startsWith("__Secure-"),
      path: setupPath,
    };
  }
  establish(req: Request, res: Response, session: Omit<Session, "expiresAt">) {
    this.collect(this.sessions);
    const previous = this.sessions.get(hash(this.key(req)));
    this.sessions.delete(hash(this.key(req)));
    if (previous && previous.token !== session.token)
      void this.revoke(previous);
    const id = nonce();
    this.sessions.set(hash(id), {
      ...session,
      expiresAt: Date.now() + 8 * 60 * 60_000,
    });
    res.cookie(this.cookie, id, {
      ...this.cookieOptions(),
      maxAge: 8 * 60 * 60_000,
    });
  }
  async authenticate(req: Request): Promise<Session> {
    const key = hash(this.key(req)),
      session = this.sessions.get(key);
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(key);
      if (session) void this.revoke(session);
      throw new WorkError("account_login_required", 401);
    }
    const owner = await this.service.authenticate(session.token);
    if (owner !== session.owner) {
      this.sessions.delete(key);
      throw new WorkError("account_session_invalid", 401);
    }
    return session;
  }
  async issueLink(token: string) {
    const owner = await this.service.authenticate(token);
    this.collect(this.tickets);
    const ticket = nonce(),
      expiresAt = Date.now() + 60_000;
    this.tickets.set(hash(ticket), {
      token,
      owner,
      expiresAt,
      matrixLogin: false,
    });
    const url = new URL(setupPath, this.service.config.publicUrl);
    url.hash = "ticket=" + ticket;
    return { url: url.href, expiresAt: new Date(expiresAt).toISOString() };
  }
  async redeem(ticket: string, req: Request, res: Response) {
    const key = hash(ticket),
      session = this.tickets.get(key);
    this.tickets.delete(key);
    if (!session || session.expiresAt <= Date.now())
      throw new WorkError("onboarding_link_expired", 401);
    if ((await this.service.authenticate(session.token)) !== session.owner)
      throw new WorkError("account_session_invalid", 401);
    this.establish(req, res, session);
  }
  preview(ticket: string) {
    const session = this.tickets.get(hash(ticket));
    if (!session || session.expiresAt <= Date.now())
      throw new WorkError("onboarding_link_expired", 401);
    return {
      owner: session.owner,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }
  async logout(req: Request, res: Response) {
    const key = hash(this.key(req)),
      session = this.sessions.get(key);
    this.sessions.delete(key);
    res.clearCookie(this.cookie, this.cookieOptions());
    if (session) await this.revoke(session);
  }
  private async revoke(session: Session) {
    if (session.matrixLogin) {
      try {
        await fetch(
          this.service.config.homeserver + "/_matrix/client/v3/logout",
          {
            method: "POST",
            headers: {
              Authorization: "Bearer " + session.token,
              "Content-Type": "application/json",
            },
            body: "{}",
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
          },
        );
      } catch {
        /* Local cookie is still revoked. */
      }
    }
  }
  async close() {
    const active = [...this.sessions.values()];
    this.sessions.clear();
    this.tickets.clear();
    await Promise.allSettled(active.map((session) => this.revoke(session)));
  }
}

/** Reuses the configured homeserver's account and UIA flows; this is not an account database. */
export async function matrixLogin(
  service: ManagedService,
  input: {
    username: string;
    password: string;
    registrationToken?: string | undefined;
  },
  register: boolean,
) {
  const request: Record<string, unknown> = register
    ? {
        username: input.username,
        password: input.password,
        refresh_token: false,
      }
    : {
        type: "m.login.password",
        identifier: { type: "m.id.user", user: input.username },
        password: input.password,
        refresh_token: false,
      };
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await fetch(
      service.config.homeserver +
        "/_matrix/client/v3/" +
        (register ? "register" : "login"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
    const body = (await response.json()) as Record<string, any>;
    if (response.ok) {
      if (typeof body.access_token !== "string")
        throw new WorkError("matrix_login_failed", 502);
      const owner = await service.authenticate(body.access_token);
      return { token: body.access_token as string, owner, matrixLogin: true };
    }
    if (
      register &&
      response.status === 401 &&
      typeof body.session === "string" &&
      Array.isArray(body.flows)
    ) {
      if (body.errcode)
        throw new WorkError("registration_authorization_failed", 401);
      const completed: string[] = body.completed ?? [];
      const allowed = new Set([
        "m.login.dummy",
        ...(input.registrationToken ? ["m.login.registration_token"] : []),
      ]);
      const flow = body.flows.find(
        (flow: any) =>
          Array.isArray(flow.stages) &&
          flow.stages.every(
            (stage: string) => completed.includes(stage) || allowed.has(stage),
          ),
      );
      const stage = flow?.stages.find(
        (stage: string) => !completed.includes(stage),
      );
      if (!stage)
        throw new WorkError(
          input.registrationToken
            ? "registration_flow_requires_external_client"
            : "registration_token_or_external_client_required",
          409,
        );
      request.auth = {
        type: stage,
        session: body.session,
        ...(stage === "m.login.registration_token"
          ? { token: input.registrationToken }
          : {}),
      };
      continue;
    }
    throw new WorkError(
      body.errcode === "M_USER_IN_USE"
        ? "username_already_registered"
        : register
          ? "registration_failed"
          : "invalid_login",
      response.status === 429 ? 429 : 401,
    );
  }
  throw new WorkError("registration_flow_requires_external_client", 409);
}
