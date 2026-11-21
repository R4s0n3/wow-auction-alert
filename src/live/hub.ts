import type { Alert } from "../db/repo.ts";

const encoder = new TextEncoder();
const HEARTBEAT_MS = 20_000;

interface Client {
  realm: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
}

/** Server-Sent Events: verteilt neue Alerts live an alle verbundenen Clients. */
export class LiveHub {
  private readonly clients = new Set<Client>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;

  get size(): number {
    return this.clients.size;
  }

  stream(realm: string): Response {
    let client: Client | undefined;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        client = { realm, controller };
        this.clients.add(client);
        this.send(client, `: verbunden (${realm})\n\n`);
        this.startHeartbeat();
      },
      cancel: () => {
        if (client) this.clients.delete(client);
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  }

  broadcast(alerts: Alert[]): void {
    for (const alert of alerts) {
      const message = `event: alert\nid: ${alert.id}\ndata: ${JSON.stringify(alert)}\n\n`;
      for (const client of this.clients) {
        if (client.realm === alert.realm) this.send(client, message);
      }
    }
  }

  close(): void {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const client of this.clients) {
      try {
        client.controller.close();
      } catch {
        // schon zu
      }
    }
    this.clients.clear();
  }

  private send(client: Client, text: string): void {
    try {
      client.controller.enqueue(encoder.encode(text));
    } catch {
      this.clients.delete(client);
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) this.send(client, ": ping\n\n");
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }
}
