import { describe, expect, it } from "vitest";
import { assertProductionConfig } from "../../../infra/scripts/production-config-contract.js";

function productionConfig() {
  const lockedService = (port: number) => ({
    command: [
      "node",
      `/app/apps/${port === 29_373 ? "server" : "superadmin"}/node_modules/tsx/dist/cli.mjs`,
      `/app/apps/${port === 29_373 ? "server" : "superadmin"}/src/main.ts`,
    ],
    ports: [
      {
        host_ip: "127.0.0.1",
        target: port,
        published: String(port),
        protocol: "tcp",
        mode: "ingress",
      },
    ],
    user: "node",
    read_only: true,
    cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"],
    init: true,
    tmpfs: ["/tmp"],
    restart: "unless-stopped",
    healthcheck: { test: ["CMD", "node", "-e", "process.exit(0)"] },
    logging: {
      driver: "json-file",
      options: { "max-size": "10m", "max-file": "3" },
    },
    networks: { data: null, ingress: null },
  });
  return {
    services: {
      postgres: {
        user: "postgres",
        restart: "unless-stopped",
        healthcheck: { test: ["CMD-SHELL", "pg_isready"] },
        logging: {
          driver: "json-file",
          options: { "max-size": "10m", "max-file": "3" },
        },
        networks: { data: null },
      },
      public: lockedService(29_373),
      admin: lockedService(29_374),
    },
    networks: {
      data: { internal: true },
      ingress: {
        internal: false,
        driver_opts: {
          "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1",
        },
      },
    },
  };
}

describe("production Compose contract", () => {
  it("accepts the approved isolated topology", () => {
    expect(() => assertProductionConfig(productionConfig())).not.toThrow();
  });

  it("rejects a publicly bound application port", () => {
    const config = productionConfig();
    config.services.public.ports[0]!.host_ip = "0.0.0.0";

    expect(() => assertProductionConfig(config)).toThrowError(/loopback/u);
  });

  it("rejects a PostgreSQL host port", () => {
    const config = productionConfig();
    Object.assign(config.services.postgres, {
      ports: [
        {
          host_ip: "127.0.0.1",
          target: 5432,
          published: "5432",
          protocol: "tcp",
          mode: "ingress",
        },
      ],
    });

    expect(() => assertProductionConfig(config)).toThrowError(/PostgreSQL.*host port/u);
  });

  it("rejects attaching PostgreSQL to the ingress bridge", () => {
    const config = productionConfig();
    Object.assign(config.services.postgres.networks, { ingress: null });

    expect(() => assertProductionConfig(config)).toThrowError(/PostgreSQL.*only.*data/u);
  });

  it("rejects an application without the ingress bridge", () => {
    const config = productionConfig();
    Object.assign(config.services.public, { networks: { data: null } });

    expect(() => assertProductionConfig(config)).toThrowError(/data and ingress/u);
  });

  it("rejects a runtime package-manager command", () => {
    const config = productionConfig();
    config.services.public.command = ["pnpm", "--filter", "@syncaction/server", "start"];

    expect(() => assertProductionConfig(config)).toThrowError(/direct Node command/u);
  });

  it.each([
    [
      "read-only filesystem",
      (config: ReturnType<typeof productionConfig>) => {
        config.services.admin.read_only = false;
      },
    ],
    [
      "capability drop",
      (config: ReturnType<typeof productionConfig>) => {
        config.services.admin.cap_drop = [];
      },
    ],
    [
      "non-root user",
      (config: ReturnType<typeof productionConfig>) => {
        config.services.admin.user = "root";
      },
    ],
    [
      "health check",
      (config: ReturnType<typeof productionConfig>) => {
        Object.assign(config.services.admin, { healthcheck: undefined });
      },
    ],
    [
      "bounded logs",
      (config: ReturnType<typeof productionConfig>) => {
        Object.assign(config.services.admin, { logging: undefined });
      },
    ],
    [
      "internal data network",
      (config: ReturnType<typeof productionConfig>) => {
        config.networks.data.internal = false;
      },
    ],
  ])("rejects a missing %s", (_label, mutate) => {
    const config = productionConfig();
    mutate(config);

    expect(() => assertProductionConfig(config)).toThrow();
  });
});
