import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, access, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createKinexRuntime } from "../dist/index.js"
import { Operation, RosRuntime } from "../dist/device/profile/operations.js"
import { Device } from "../dist/device/profile/schema.js"

const output = {
  description: "Arbitrary scalar stream", transport: "topic", direction: "output",
  endpoint: "/example/value", type: "std_msgs/msg/Float64",
}

test("ROS operation declarations validate protocol direction, types and bounded queues", () => {
  assert.equal(Operation.parse(output).qos.depth, 1)
  assert.throws(() => Operation.parse({ ...output, type: "std_srvs/srv/Trigger" }))
  assert.throws(() => Operation.parse({ ...output, qos: { depth: 0 } }))
  assert.throws(() => Operation.parse({ ...output, upstream: "/implementation/detail" }))
  assert.throws(() => RosRuntime.parse({ interpreter: "/python", publish_frames: false }))
  assert.throws(() => Operation.parse({ ...output, transport: "service", type: "std_srvs/srv/Trigger" }))
  assert.ok(Operation.parse({ ...output, transport: "service", direction: "input", type: "std_srvs/srv/Trigger" }))
})

test("stops are Trigger services, and world waits require one", () => {
  const service = (type, endpoint) => ({ description: "", transport: "service", direction: "input", endpoint, type })
  const world = { name: "world", type: "world", description: "", meta: { created_at: "", updated_at: "" }, runtime: { nodes: [] },
    operations: { wait: service("kinex_interfaces/srv/Wait", "/wait") }, frames: { base: { parent: null, translation_m: null, rotation_xyzw: null } } }
  assert.throws(() => Device.parse(world), /require a stop service/)
  assert.ok(Device.parse({ ...world, operations: { ...world.operations, stop: service("std_srvs/srv/Trigger", "/stop") } }))
  assert.throws(() => Device.parse({ ...world, operations: { ...world.operations, stop: service("std_srvs/srv/Empty", "/stop") } }), /std_srvs\/srv\/Trigger/)
})

test("operation discovery is inert and loaded runtime edits require unload", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "kinex-ros-profile-"))
  const runtime = createKinexRuntime({ directory })
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  await runtime.profiles.writeManifest({ identity: { id: "test", name: "test", kind: "other" } })
  await runtime.profiles.writeDevice({ description: '',
    name: "service",
    type: "other",
    loaded: true,
    runtime: { interpreter: "/explicit/python" },
    operations: { output },
    frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } })
  const catalog = await runtime.devices.operations()
  assert.equal(catalog[0].operations.output.type, "std_msgs/msg/Float64")
  await assert.rejects(access(path.join(directory, ".kinex/python")))
  await assert.rejects(runtime.profiles.writeDevice({ description: '',
    name: "service", runtime: { interpreter: "/changed/python" },
  }), /unload/)
  await runtime.profiles.writeDevice({ name: "service", description: "Unchanged runtime", runtime: { interpreter: "/explicit/python" } })
  await assert.rejects(runtime.profiles.writeDevice({ description: '',
    name: "service",
    type: "world",
    loaded: true,
    runtime: { interpreter: "/explicit/python" },
    operations: { output },
    frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } }), /unload/)
  await assert.rejects(runtime.profiles.writeDevice({ description: '',
    name: "bad",
    type: "other",
    loaded: false,
    runtime: { interpreter: "/python" },
    operations: { load: { ...output, transport: "service", direction: "input", type: "std_srvs/srv/Trigger" } },
    frames: { base: {parent: null, translation_m: null, rotation_xyzw: null} } }), /reserved host/)
})

test("corrupt profiles fail loudly and are never overwritten", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "kinex-ros-corrupt-"))
  const runtime = createKinexRuntime({ directory })
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const file = path.join(directory, ".kinex/devices/broken/profile.yaml")
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, "name: [broken\n")
  await assert.rejects(runtime.devices.list(), /ProfileFileError|profile\.yaml/)
  await assert.rejects(runtime.profiles.writeDevice({ name: "broken", description: "" }), /profile\.yaml/)
  assert.equal(await readFile(file, "utf8"), "name: [broken\n")
})
