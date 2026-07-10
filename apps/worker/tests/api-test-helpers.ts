import { request as httpRequest, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { ProjectConfig, StoredProjectConfig } from "@orange-replay/shared";
import { expect } from "vite-plus/test";
import type { SessionRow } from "../src/api/helpers.ts";
import { listProjectId, token } from "./api-test-fixtures.ts";
import { worker } from "./api-test-runtime.ts";

export * from "./api-test-fixtures.ts";
export * from "./api-test-runtime.ts";

export interface SessionsResponse {
  sessions: SessionRow[];
  nextBefore: string | null;
}

export function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

interface HttpResponse {
  status: number;
  body: string;
}

export function requestLiveUpgrade(
  path: string,
  targetWorker = worker,
  // When provided, upgraded sockets are kept open (and collected here) so a
  // test can hold concurrent viewers; the caller destroys them.
  holdSockets?: Socket[],
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: targetWorker.address,
        port: targetWorker.port,
        method: "GET",
        path,
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          // workerd rejects handshakes missing the WS key/version with 400.
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version": "13",
        },
      },
      (response) => {
        readHttpResponse(response).then(resolve, reject);
      },
    );

    request.on("upgrade", (response, socket) => {
      if (holdSockets === undefined) {
        socket.destroy();
      } else {
        holdSockets.push(socket);
      }
      resolve({
        status: response.statusCode ?? 0,
        body: "",
      });
    });
    request.on("error", reject);
    request.end();
  });
}

function readHttpResponse(response: IncomingMessage): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    response.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    response.on("error", reject);
    response.on("end", () => {
      resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      });
    });
  });
}

export async function getSessions(
  query = "",
  projectId = listProjectId,
): Promise<SessionsResponse> {
  const suffix = query.length > 0 ? `?${query}` : "";
  const res = await worker.fetch(`/api/v1/projects/${projectId}/sessions${suffix}`, {
    headers: authHeaders(),
  });

  expect(res.status).toBe(200);
  return (await res.json()) as SessionsResponse;
}

export async function seedIngestKey(
  key: string,
  config: ProjectConfig,
  kv: boolean,
): Promise<string> {
  const res = await worker.fetch("/__test/ingest/seed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, config, kv }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { keyHash: string };
  return body.keyHash;
}

export async function readConfigCache(keyHash: string): Promise<StoredProjectConfig | null> {
  const res = await worker.fetch(
    `/__test/ingest/config-cache?keyHash=${encodeURIComponent(keyHash)}`,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { config: StoredProjectConfig | null };
  return body.config;
}

export async function getProjectConfig(projectId: string): Promise<StoredProjectConfig> {
  const res = await worker.fetch(`/api/v1/projects/${projectId}/config`, {
    headers: authHeaders(),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as StoredProjectConfig;
}

export async function mintTicket(projectId: string, sessionId: string): Promise<string> {
  const res = await worker.fetch(
    `/api/v1/projects/${projectId}/sessions/${sessionId}/live-ticket`,
    {
      method: "POST",
      headers: authHeaders(),
    },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ticket: string };
  return body.ticket;
}
