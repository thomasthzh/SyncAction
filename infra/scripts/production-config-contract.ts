import assert from "node:assert/strict";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, label: string): UnknownRecord {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} missing`);
  return value as UnknownRecord;
}

function array(value: unknown, label: string): unknown[] {
  assert(Array.isArray(value), `${label} must be an array`);
  return value;
}

function service(config: UnknownRecord, name: string): UnknownRecord {
  return record(record(config.services, "services")[name], `service ${name}`);
}

function assertNetworks(value: unknown, label: string, expected: readonly string[]): void {
  const networks = record(value, `${label} networks`);
  assert.deepEqual(
    Object.keys(networks).sort(),
    [...expected].sort(),
    `${label} must use ${expected.length === 1 ? "only data" : "data and ingress"} networks`,
  );
}

function assertHealthcheck(value: unknown, label: string): void {
  const healthcheck = record(value, `${label} healthcheck`);
  assert(
    array(healthcheck.test, `${label} healthcheck test`).length > 0,
    `${label} healthcheck empty`,
  );
}

function assertBoundedLogging(value: unknown, label: string): void {
  const logging = record(value, `${label} logging`);
  assert.equal(logging.driver, "json-file", `${label} logging driver must be json-file`);
  const options = record(logging.options, `${label} logging options`);
  assert.equal(options["max-size"], "10m", `${label} log max-size must be 10m`);
  assert.equal(options["max-file"], "3", `${label} log max-file must be 3`);
}

function assertApplicationService(
  value: UnknownRecord,
  label: "public" | "admin",
  port: number,
): void {
  const applicationDirectory = label === "public" ? "server" : "superadmin";
  assert.deepEqual(
    array(value.command, `${label} command`),
    [
      "node",
      `/app/apps/${applicationDirectory}/node_modules/tsx/dist/cli.mjs`,
      `/app/apps/${applicationDirectory}/src/main.ts`,
    ],
    `${label} must use the installed tsx runtime through a direct Node command`,
  );
  const ports = array(value.ports, `${label} ports`);
  assert.equal(ports.length, 1, `${label} must publish exactly one loopback port`);
  const binding = record(ports[0], `${label} port`);
  assert.equal(binding.host_ip, "127.0.0.1", `${label} port must bind to loopback`);
  assert.equal(binding.target, port, `${label} target port must be ${port}`);
  assert.equal(String(binding.published), String(port), `${label} published port must be ${port}`);
  assert.equal(binding.protocol, "tcp", `${label} port must use TCP`);

  assert.equal(value.user, "node", `${label} must run as the non-root node user`);
  assert.equal(value.read_only, true, `${label} requires a read-only filesystem`);
  assert(
    array(value.cap_drop, `${label} cap_drop`).includes("ALL"),
    `${label} must drop all capabilities`,
  );
  assert(
    array(value.security_opt, `${label} security_opt`).includes("no-new-privileges:true"),
    `${label} must disable privilege escalation`,
  );
  assert.equal(value.init, true, `${label} must enable the init process`);
  assert.equal(value.restart, "unless-stopped", `${label} must restart unless stopped`);
  assert(
    array(value.tmpfs, `${label} tmpfs`).includes("/tmp"),
    `${label} must mount /tmp as tmpfs`,
  );
  assertNetworks(value.networks, label, ["data", "ingress"]);
  assertHealthcheck(value.healthcheck, label);
  assertBoundedLogging(value.logging, label);
}

export function assertProductionConfig(value: unknown): void {
  const config = record(value, "production Compose config");
  const networks = record(config.networks, "networks");
  const dataNetwork = record(networks.data, "data network");
  assert.equal(dataNetwork.internal, true, "data network must be internal");
  const ingressNetwork = record(networks.ingress, "ingress network");
  assert.notEqual(ingressNetwork.internal, true, "ingress network must reach the host bridge");
  assert.equal(
    record(ingressNetwork.driver_opts, "ingress driver options")[
      "com.docker.network.bridge.host_binding_ipv4"
    ],
    "127.0.0.1",
    "ingress default host binding must be loopback",
  );

  const postgres = service(config, "postgres");
  const postgresPorts = postgres.ports;
  assert(
    postgresPorts === undefined || (Array.isArray(postgresPorts) && postgresPorts.length === 0),
    "PostgreSQL must not publish a host port",
  );
  assert.equal(postgres.user, "postgres", "PostgreSQL must run as postgres");
  assert.equal(postgres.restart, "unless-stopped", "PostgreSQL must restart unless stopped");
  assertNetworks(postgres.networks, "PostgreSQL", ["data"]);
  assertHealthcheck(postgres.healthcheck, "PostgreSQL");
  assertBoundedLogging(postgres.logging, "PostgreSQL");

  assertApplicationService(service(config, "public"), "public", 29_373);
  assertApplicationService(service(config, "admin"), "admin", 29_374);
}
