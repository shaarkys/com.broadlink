"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { collectCommands } = require("../lib/RMMaxCommands");
const hub = { endpointId: "hub", productId: "0000000000000000000000008baf0000" };
const command = name => ({ name, codeList: [{ code: "b2000200aabb" }] });

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
