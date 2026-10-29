import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"

const root = mkdtempSync(join(tmpdir(), "dcp-head-command-"))
process.env.XDG_DATA_HOME = join(root, "data")
process.env.XDG_CONFIG_HOME = join(root, "config")
process.env.OPENCODE_CONFIG_DIR = join(root, "config", "opencode")
test.after(() => rmSync(root, { recursive: true, force: true }))

const { createSessionState } = await import("../lib/state")
const { assignMessageRefs } = await import("../lib/message-ids")
const { parseHeadArgs, resolveHeadStart } = await import("../lib/commands/manual")
const { createCommandExecuteHandler } = await import("../lib/hooks")
const { Logger } = await import("../lib/logger")

const logger = new Logger(false)

function config(
    overrides: { mode?: "range" | "message"; protectUserMessages?: boolean } = {},
): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: {
            enabled: true,
            protectedTools: [],
        },
        manualMode: {
            enabled: false,
            automaticStrategies: true,
        },
        turnProtection: {
            enabled: false,
            turns: 4,
        },
        experimental: {
            allowSubAgents: false,
            customPrompts: false,
        },
        protectedFilePatterns: [],
        compress: {
            mode: overrides.mode ?? "range",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: overrides.protectUserMessages ?? false,
        },
        strategies: {
            deduplication: {
                enabled: false,
                protectedTools: [],
            },
            purgeErrors: {
                enabled: false,
                protectedTools: [],
            },
        },
    }
}

function textPart(messageID: string, sessionID: string, text: string, id = `${messageID}-part`) {
    return {
        id,
        messageID,
        sessionID,
        type: "text" as const,
        text,
    }
}

function message(
    id: string,
    role: "user" | "assistant",
    text: string,
    created: number,
    parts?: WithParts["parts"],
): WithParts {
    return {
        info: {
            id,
            role,
            sessionID: "session-1",
            agent: "assistant",
            model: { providerID: "test", modelID: "test" },
            time: { created },
        } as WithParts["info"],
        parts: parts ?? [textPart(id, "session-1", text)],
    }
}

function ignoredUser(id: string, created: number): WithParts {
    return message(id, "user", "ignored", created, [
        { ...textPart(id, "session-1", "ignored"), ignored: true },
    ])
}

function emptyAssistant(id: string, created: number): WithParts {
    return message(id, "assistant", "", created, [
        {
            id: `${id}-step`,
            messageID: id,
            sessionID: "session-1",
            type: "step-start",
        } as any,
    ])
}

function stateWithRefs(messages: WithParts[]) {
    const state = createSessionState()
    state.sessionId = "session-1"
    assignMessageRefs(state, messages)
    return state
}

test("parseHeadArgs removes the flag from any position", () => {
    assert.deepEqual(parseHeadArgs(["revise", "--include-first", "o", "inicio"]), {
        includeFirst: true,
        focus: "revise o inicio",
    })
    assert.deepEqual(parseHeadArgs(["--include-first"]), {
        includeFirst: true,
        focus: undefined,
    })
    assert.deepEqual(parseHeadArgs(["foco", "normal"]), {
        includeFirst: false,
        focus: "foco normal",
    })
})

test("head start keeps the initial user message by default", () => {
    const messages = [
        message("msg-user-1", "user", "Initial task", 1),
        message("msg-assistant-1", "assistant", "Initial work", 2),
        message("msg-user-2", "user", "Current request", 3),
    ]
    const state = stateWithRefs(messages)

    const result = resolveHeadStart(messages, state, config(), false)
    assert.equal(result.ok, true)
    if (!result.ok) return

    assert.equal(result.value.start.ref, "m0002")
    assert.equal(result.value.maxEnd.ref, "m0002")
    assert.equal(result.value.preservedUserRef, "m0001")
    assert.equal(result.value.includeFirstUser, false)
})

test("--include-first starts at the initial user message", () => {
    const messages = [
        message("msg-user-1", "user", "Initial task", 1),
        message("msg-assistant-1", "assistant", "Initial work", 2),
        message("msg-user-2", "user", "Current request", 3),
    ]
    const state = stateWithRefs(messages)

    const result = resolveHeadStart(messages, state, config(), true)
    assert.equal(result.ok, true)
    if (!result.ok) return

    assert.equal(result.value.start.ref, "m0001")
    assert.equal(result.value.maxEnd.ref, "m0002")
    assert.equal(result.value.preservedUserRef, undefined)
    assert.equal(result.value.includeFirstUser, true)
})

test("head start skips ignored, empty assistant and compacted messages", () => {
    const messages = [
        message("msg-old-user", "user", "Old compacted task", 1),
        message("msg-old-assistant", "assistant", "Old compacted work", 2),
        ignoredUser("msg-ignored", 3),
        message("msg-user-2", "user", "Recent task", 4),
        emptyAssistant("msg-empty", 5),
        message("msg-assistant-2", "assistant", "Recent work", 6),
        message("msg-user-3", "user", "Current request", 7),
    ]
    const state = stateWithRefs(messages)
    state.lastCompaction = 3

    const result = resolveHeadStart(messages, state, config(), false)
    assert.equal(result.ok, true)
    if (!result.ok) return

    assert.equal(result.value.start.ref, "m0005")
    assert.equal(result.value.maxEnd.ref, "m0005")
    assert.equal(result.value.preservedUserRef, "m0003")
})

test("head start uses the oldest visible compressed block", () => {
    const messages = [
        message("msg-user-1", "user", "Initial task", 1),
        message("msg-assistant-1", "assistant", "Initial work", 2),
        message("msg-user-2", "user", "Current request", 3),
    ]
    const state = stateWithRefs(messages)
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 10,
        summaryTokens: 5,
        durationMs: 0,
        mode: "range",
        topic: "Initial",
        batchTopic: "Initial",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "msg-user-1",
        compressMessageId: "msg-assistant-1",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["msg-user-1"],
        directToolIds: [],
        effectiveMessageIds: ["msg-user-1"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "Initial task summary",
    })
    state.prune.messages.activeBlockIds.add(1)
    state.prune.messages.activeByAnchorMessageId.set("msg-user-1", 1)
    state.prune.messages.byMessageId.set("msg-user-1", {
        tokenCount: 10,
        allBlockIds: [1],
        activeBlockIds: [1],
    })

    const result = resolveHeadStart(messages, state, config(), false)
    assert.equal(result.ok, true)
    if (!result.ok) return

    assert.equal(result.value.start.kind, "block")
    assert.equal(result.value.start.ref, "b1")
    assert.equal(result.value.maxEnd.ref, "m0002")
    assert.equal(result.value.preservedUserRef, undefined)
})

test("head start is a no-op without a closed turn after the first user message", () => {
    const messages = [
        message("msg-user-1", "user", "Initial task", 1),
        message("msg-user-2", "user", "Current request", 2),
    ]
    const state = stateWithRefs(messages)

    assert.deepEqual(resolveHeadStart(messages, state, config(), false), {
        ok: false,
        reason: "nothing-before-current-turn",
    })

    const withFirst = resolveHeadStart(messages, state, config(), true)
    assert.equal(withFirst.ok, true)
    if (!withFirst.ok) return
    assert.equal(withFirst.value.start.ref, "m0001")
    assert.equal(withFirst.value.maxEnd.ref, "m0001")
})

test("head start ignores --include-first when message mode protects user messages", () => {
    const messages = [
        message("msg-user-1", "user", "Initial task", 1),
        message("msg-assistant-1", "assistant", "Initial work", 2),
        message("msg-user-2", "user", "Current request", 3),
    ]
    const state = stateWithRefs(messages)
    const settings = config({ mode: "message", protectUserMessages: true })

    const result = resolveHeadStart(messages, state, settings, true)
    assert.equal(result.ok, true)
    if (!result.ok) return

    assert.equal(result.value.start.ref, "m0002")
    assert.equal(result.value.preservedUserRef, "m0001")
    assert.equal(result.value.includeFirstUser, false)
    assert.equal(result.value.protectedFirstUser, true)
})

test("head start skips protected user messages between the initial and current turns", () => {
    const messages = [
        message("msg-user-1", "user", "Initial task", 1),
        message("msg-user-2", "user", "Follow-up question", 2),
        message("msg-assistant-1", "assistant", "Follow-up work", 3),
        message("msg-user-3", "user", "Current request", 4),
    ]
    const state = stateWithRefs(messages)
    const settings = config({ mode: "message", protectUserMessages: true })

    const result = resolveHeadStart(messages, state, settings, false)
    assert.equal(result.ok, true)
    if (!result.ok) return

    assert.equal(result.value.start.ref, "m0003")
    assert.equal(result.value.maxEnd.ref, "m0003")
    assert.equal(result.value.preservedUserRef, "m0001")
    assert.equal(result.value.protectedFirstUser, true)
})

test("head start uses the first visible assistant when there is no visible user before it", () => {
    const messages = [
        message("msg-assistant-1", "assistant", "Recovered work", 1),
        message("msg-user-1", "user", "Current request", 2),
    ]
    const state = stateWithRefs(messages)

    const result = resolveHeadStart(messages, state, config(), false)
    assert.equal(result.ok, true)
    if (!result.ok) return

    assert.equal(result.value.start.ref, "m0001")
    assert.equal(result.value.maxEnd.ref, "m0001")
    assert.equal(result.value.preservedUserRef, undefined)
})

test("createCommandExecuteHandler sets the pending head trigger and focus", async () => {
    const messages = [
        message("msg-user-1", "user", "Initial task", 1),
        message("msg-assistant-1", "assistant", "Initial work", 2),
        message("msg-user-2", "user", "Current request", 3),
    ]
    const state = createSessionState()
    state.sessionId = "session-1"
    const promptCalls: any[] = []
    const client = {
        session: {
            messages: async () => ({ data: messages }),
            get: async () => ({ data: { parentID: null } }),
            prompt: async (input: any) => {
                promptCalls.push(input)
                return {}
            },
        },
        tui: {
            showToast: async () => {},
        },
    }
    const output = { parts: [] as any[] }
    const handler = createCommandExecuteHandler(client, state, logger, config(), "/tmp", {
        global: undefined,
        agents: {},
    })

    await handler(
        {
            command: "dcp",
            sessionID: "session-1",
            arguments: "head --include-first revise o inicio",
        },
        output,
    )

    assert.equal(state.manualMode, "compress-pending")
    assert.equal(state.pendingManualTrigger?.sessionId, "session-1")
    assert.match(state.pendingManualTrigger?.prompt ?? "", /Start boundary: m0001/)
    assert.match(state.pendingManualTrigger?.prompt ?? "", /Active compress mode: range/)
    assert.match(
        state.pendingManualTrigger?.prompt ?? "",
        /Additional user focus:\nrevise o inicio/,
    )
    assert.equal(output.parts[0]?.text, "/dcp head --include-first revise o inicio")
    assert.equal(promptCalls.length, 0)
})

test("head command reports a no-op without setting a pending trigger", async () => {
    const messages = [message("msg-user-1", "user", "Current request", 1)]
    const state = createSessionState()
    state.sessionId = "session-1"
    const promptCalls: any[] = []
    const client = {
        session: {
            messages: async () => ({ data: messages }),
            get: async () => ({ data: { parentID: null } }),
            prompt: async (input: any) => {
                promptCalls.push(input)
                return {}
            },
        },
        tui: {
            showToast: async () => {},
        },
    }
    const output = { parts: [] as any[] }
    const handler = createCommandExecuteHandler(client, state, logger, config(), "/tmp", {
        global: undefined,
        agents: {},
    })

    await handler({ command: "dcp", sessionID: "session-1", arguments: "head" }, output)

    assert.equal(state.manualMode, false)
    assert.equal(state.pendingManualTrigger, null)
    assert.equal(output.parts.length, 0)
    assert.equal(promptCalls.length, 1)
    assert.match(promptCalls[0]?.body?.parts?.[0]?.text ?? "", /DCP Head/)
})

test("head command prompt follows the active message mode", async () => {
    const messages = [
        message("msg-user-1", "user", "Initial task", 1),
        message("msg-assistant-1", "assistant", "Initial work", 2),
        message("msg-user-2", "user", "Current request", 3),
    ]
    const state = createSessionState()
    state.sessionId = "session-1"
    const client = {
        session: {
            messages: async () => ({ data: messages }),
            get: async () => ({ data: { parentID: null } }),
            prompt: async () => ({}),
        },
        tui: {
            showToast: async () => {},
        },
    }
    const handler = createCommandExecuteHandler(
        client,
        state,
        logger,
        config({ mode: "message" }),
        "/tmp",
        { global: undefined, agents: {} },
    )

    await handler({ command: "dcp", sessionID: "session-1", arguments: "head" }, { parts: [] })

    const prompt = state.pendingManualTrigger?.prompt ?? ""
    assert.match(prompt, /Active compress mode: message/)
    assert.doesNotMatch(prompt, /one contiguous range/)
    assert.doesNotMatch(prompt, /Active compressed blocks in this session/)
})
