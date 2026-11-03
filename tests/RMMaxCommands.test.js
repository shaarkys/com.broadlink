"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { collectCommands, magicEndpointDiagnostics } = require("../lib/RMMaxCommands");
const hub = { endpointId: "hub", productId: "0000000000000000000000008baf0000" };
const command = name => ({ name, codeList: [{ code: "b2000200aabb" }] });

test("Magic Home diagnostics report bounded protocol metadata without account or device data", () => {
  const secret = "private-secret-value";
  const endpoints = [
    { ...hub, friendlyName: secret, cookie: { pid: hub.productId, aeskeyToken: secret }, displayCategories: ["TV", secret],
      capabilities: [{ interface: secret, actions: { supported: [{ name: "ChangePowerState" }, { name: secret }] },
        properties: { supported: [{ name: "power", enums: [secret] }, { name: secret }] } },
      { interface: "DNA.CustomizedRemoteControl", actions: { supported: [{ name: secret }] } }] },
    { endpointId: secret, parentId: "hub", displayCategories: ["LIGHT"], capabilities: [] },
    ...Array.from({ length: 25 }, (_, i) => ({ endpointId: `id-${i}` }))
  ];
  const result = magicEndpointDiagnostics(endpoints);
  assert.equal(result.length, 20);
  assert.deepEqual(result[0].categories, ["TV"]);
  assert.equal(result[0].otherCategories, 1);
  assert.deepEqual(result[0].knownActions, ["ChangePowerState"]);
  assert.deepEqual(result[0].knownProperties, ["power"]);
  assert.equal(result[0].actions, 3);
  assert.deepEqual(result[0].knownInterfaces, ["DNA.CustomizedRemoteControl"]);
  assert.equal(result[0].customRemoteActions, 1);
  assert.equal(result[1].parent, 1);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes("hub"), false);
  const many = magicEndpointDiagnostics([{ capabilities: Array.from({ length: 40 }, () => ({ actions: { supported: Array(100).fill({ name: "ChangePowerState" }) } })) }])[0];
  assert.equal(many.capabilities, 40);
  assert.equal(many.inspectedCapabilities, 32);
  assert.deepEqual(many.knownActions, ["ChangePowerState"]);
});

test("identical or missing remote names receive distinct stable labels without changing command IDs", async () => {
  for (const friendlyName of ["Remote", undefined]) {
    const endpoints = ["remote-A", "remote-B"].map(endpointId => ({ endpointId, gatewayId: "hub", friendlyName }));
    const client = { getSession: () => ({ provider: "broadlink_eu" }), getRemote: async () => ({ irData: [command("Power")] }) };
    const first = await collectCommands(client, endpoints, hub);
    assert.equal(new Set(first.commands.map(item => item.name)).size, 2);
    assert.deepEqual(first.commands.map(item => item.name), ["Remote / Power [remote-A]", "Remote / Power [remote-B]"]);
    const reversed = await collectCommands(client, [...endpoints].reverse(), hub);
    assert.deepEqual(reversed.commands, [...first.commands].reverse());
    const single = await collectCommands(client, [endpoints[0]], hub);
    assert.equal(single.commands[0].id, first.commands[0].id);
  }
});

test("a vendor label cannot impersonate the generated disambiguation suffix", async () => {
  const endpoints = ["remote-A", "remote-B"].map(endpointId => ({ endpointId, gatewayId: "hub", friendlyName: "Remote" }));
  const client = { getSession: () => ({ provider: "broadlink_eu" }), getRemote: async () => ({ irData: [command("Power"), command("Power [remote-A]")] }) };
  const result = await collectCommands(client, endpoints, hub);
  assert.equal(new Set(result.commands.map(item => item.name)).size, result.commands.length);
});

test("oversized imports stop scheduling reads and drain already-started reads", async () => {
  const endpoints = Array.from({ length: 50 }, (_, index) => ({ endpointId: `remote-${index}`, gatewayId: "hub" }));
  let reads = 0, active = 0;
  const client = { getSession: () => ({ provider: "broadlink_eu" }), getRemote: async () => {
    reads++; active++;
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return { irData: Array.from({ length: 501 }, (_, index) => command(`Button ${index}`)) };
  } };
  await assert.rejects(collectCommands(client, endpoints, hub), /too large/);
  assert.equal(reads, 3);
  assert.equal(active, 0);
});
