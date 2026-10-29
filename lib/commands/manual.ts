/**
 * DCP Manual mode command handler.
 * Handles toggling manual mode and triggering individual tool executions.
 *
 * Usage:
 *   /dcp manual [on|off]  - Toggle manual mode or set explicit state
 *   /dcp-compress [focus]  - Trigger manual compress execution
 *   /dcp head [--include-first] [focus]  - Trigger a head compression pass
 */

import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import type { PluginConfig } from "../config"
import { sendIgnoredMessage } from "../ui/notification"
import { saveManualModeSetting } from "../state/persistence"
import { getCurrentParams } from "../token-utils"
import { buildCompressedBlockGuidance } from "../prompts/extensions/nudge"
import { assignMessageRefs, formatBlockRef } from "../message-ids"
import { isIgnoredUserMessage, isProtectedUserMessage } from "../messages/query"
import { hasContent } from "../messages/utils"
import { syncCompressionBlocks } from "../messages/sync"
import { checkSession } from "../state"
import { isMessageCompacted } from "../state/utils"

const MANUAL_MODE_ON = "Manual mode is now ON. Use /dcp-compress to trigger context tools manually."

const MANUAL_MODE_OFF = "Manual mode is now OFF."

const COMPRESS_TRIGGER_PROMPT = [
    "<compress triggered manually>",
    "Manual mode trigger received. You must now use the compress tool.",
    "Find the most significant completed conversation content that can be compressed into a high-fidelity technical summary.",
    "Follow the active compress mode, preserve all critical implementation details, and choose safe targets.",
    "Return after compress with a brief explanation of what content was compressed.",
].join("\n\n")

const HEAD_TRIGGER_PROMPT = [
    "<compress triggered manually>",
    "Head compression trigger received. You must now use the compress tool exactly once.",
    "Reclaim context from the oldest visible part of this conversation.",
    "Start exactly at the start boundary below and stay at or before the maximum end boundary.",
    "Never include the final user message containing this trigger.",
].join("\n\n")

const HEAD_PRESERVATION_PROMPT = [
    "Preserve the original task, user intent, constraints, acceptance criteria, architecture decisions, file paths, commands, errors, and unresolved work.",
    "Do not mark the current active task as complete.",
    "Write the summary so work can continue without re-reading the compressed messages.",
].join("\n\n")

export interface ManualCommandContext {
    client: any
    state: SessionState
    config: PluginConfig
    logger: Logger
    sessionId: string
    messages: WithParts[]
}

export interface HeadCommandOptions {
    includeFirst: boolean
    focus?: string
}

export interface VisibleItem {
    index: number
    kind: "message" | "block"
    ref: string
    message?: WithParts
    blockId?: number
}

export interface HeadStartDetails {
    start: VisibleItem
    maxEnd: VisibleItem
    preservedUserRef?: string
    includeFirstUser: boolean
    protectedFirstUser: boolean
}

export type HeadStartFailure = "no-visible-messages" | "nothing-before-current-turn"

export type HeadStartResult =
    | { ok: true; value: HeadStartDetails }
    | { ok: false; reason: HeadStartFailure }

function getTriggerPrompt(
    tool: "compress",
    state: SessionState,
    config: PluginConfig,
    userFocus?: string,
): string {
    const base = COMPRESS_TRIGGER_PROMPT
    const compressedBlockGuidance =
        config.compress.mode === "message" ? "" : buildCompressedBlockGuidance(state)

    const sections = [base, compressedBlockGuidance]
    if (userFocus && userFocus.trim().length > 0) {
        sections.push(`Additional user focus:\n${userFocus.trim()}`)
    }

    return sections.join("\n\n")
}

function isUserItem(item: VisibleItem): boolean {
    return item.kind === "message" && item.message?.info.role === "user"
}

function isEligibleHeadItem(item: VisibleItem, config: PluginConfig): boolean {
    if (item.kind === "block") {
        return true
    }

    if (!item.message) {
        return false
    }

    return !(config.compress.mode === "message" && isProtectedUserMessage(config, item.message))
}

function buildVisibleItems(messages: WithParts[], state: SessionState): VisibleItem[] {
    const visible: VisibleItem[] = []

    for (let index = 0; index < messages.length; index++) {
        const message = messages[index]
        if (!message || isIgnoredUserMessage(message)) {
            continue
        }

        const blockId = state.prune.messages.activeByAnchorMessageId.get(message.info.id)
        const block =
            blockId === undefined ? undefined : state.prune.messages.blocksById.get(blockId)
        if (block?.active) {
            visible.push({
                index,
                kind: "block",
                ref: formatBlockRef(block.blockId, state.idFormat),
                blockId: block.blockId,
            })
            continue
        }

        if (isMessageCompacted(state, message)) {
            continue
        }

        if (message.info.role === "assistant" && !hasContent(message)) {
            continue
        }

        const ref = state.messageIds.byRawId.get(message.info.id)
        if (!ref) {
            continue
        }

        visible.push({
            index,
            kind: "message",
            ref,
            message,
        })
    }

    return visible
}

export function parseHeadArgs(args: string[]): HeadCommandOptions {
    let includeFirst = false
    const focus: string[] = []

    for (const arg of args) {
        if (arg === "--include-first") {
            includeFirst = true
            continue
        }
        focus.push(arg)
    }

    const focusText = focus.join(" ").trim()
    return {
        includeFirst,
        focus: focusText.length > 0 ? focusText : undefined,
    }
}

export function resolveHeadStart(
    messages: WithParts[],
    state: SessionState,
    config: PluginConfig,
    includeFirstRequested: boolean,
): HeadStartResult {
    const visible = buildVisibleItems(messages, state)
    if (visible.length === 0) {
        return { ok: false, reason: "no-visible-messages" }
    }

    const lastUserIndex = visible.findLastIndex(isUserItem)
    if (lastUserIndex < 0) {
        return { ok: false, reason: "nothing-before-current-turn" }
    }

    const lastUser = visible[lastUserIndex]
    if (!lastUser) {
        return { ok: false, reason: "nothing-before-current-turn" }
    }

    const first = visible[0]
    if (!first) {
        return { ok: false, reason: "no-visible-messages" }
    }

    const firstIsUser = isUserItem(first)
    const protectedFirstUser =
        firstIsUser && !!first.message && isProtectedUserMessage(config, first.message)
    const includeFirst = includeFirstRequested && !protectedFirstUser

    let startIndex = 0
    let preservedUserRef: string | undefined
    if (firstIsUser && !includeFirst) {
        preservedUserRef = first.ref
        startIndex = 1
    }

    while (startIndex < visible.length && !isEligibleHeadItem(visible[startIndex]!, config)) {
        startIndex++
    }

    const start = visible[startIndex]
    if (!start || start.index >= lastUser.index) {
        return { ok: false, reason: "nothing-before-current-turn" }
    }

    const beforeCurrentTurn = visible
        .slice(0, lastUserIndex)
        .filter((item) => isEligibleHeadItem(item, config))
    const maxEnd = beforeCurrentTurn[beforeCurrentTurn.length - 1]
    if (!maxEnd || start.index > maxEnd.index) {
        return { ok: false, reason: "nothing-before-current-turn" }
    }

    return {
        ok: true,
        value: {
            start,
            maxEnd,
            preservedUserRef,
            includeFirstUser: firstIsUser && includeFirst,
            protectedFirstUser,
        },
    }
}

function describeStart(start: VisibleItem, details: HeadStartDetails): string {
    if (details.includeFirstUser) {
        return "the initial user message, which is included in this range"
    }

    if (start.kind === "block") {
        return "the oldest visible compressed block"
    }

    if (details.preservedUserRef) {
        return `the first eligible visible item after the preserved initial user message ${details.preservedUserRef}`
    }

    return "the oldest visible message"
}

function buildHeadTriggerPrompt(
    state: SessionState,
    config: PluginConfig,
    details: HeadStartDetails,
    userFocus?: string,
): string {
    const sections: string[] = [
        HEAD_TRIGGER_PROMPT,
        `Start boundary: ${details.start.ref} (${describeStart(details.start, details)}).`,
        `Maximum end boundary: ${details.maxEnd.ref}. You may end at or before this boundary, but never after it.`,
    ]

    if (details.preservedUserRef) {
        sections.push(
            `The initial user message (${details.preservedUserRef}) must remain uncompressed. Do not include it in the range.`,
        )
    }

    if (details.includeFirstUser) {
        sections.push(
            `The initial user message (${details.start.ref}) is included in this range. Preserve its task requirements, constraints, and acceptance criteria verbatim enough that work can continue without re-reading it.`,
        )
    }

    if (details.protectedFirstUser) {
        sections.push(
            "Configuration protects user messages, so the initial user message remains uncompressed.",
        )
    }

    if (details.start.kind === "block") {
        sections.push(
            "The start boundary is a compressed block. Include its required block placeholder exactly once in the summary.",
        )
    }

    if (config.compress.mode === "range") {
        sections.push(
            `Active compress mode: range. Select one contiguous range starting at ${details.start.ref} and ending at or before ${details.maxEnd.ref}. Do not create multiple ranges.`,
        )
    } else {
        sections.push(
            `Active compress mode: message. Select the earliest eligible messages individually in one batch, starting at ${details.start.ref}. Prefer high-priority and medium-priority messages. Do not select the final user message containing this trigger. Messages marked BLOCKED cannot be compressed; skip them.`,
        )
    }

    sections.push(HEAD_PRESERVATION_PROMPT)

    if (config.compress.mode !== "message") {
        sections.push(buildCompressedBlockGuidance(state))
    }

    if (userFocus && userFocus.trim().length > 0) {
        sections.push(`Additional user focus:\n${userFocus.trim()}`)
    }

    sections.push("Return after compress with a brief explanation of what was compressed.")

    return sections.filter((section) => section.trim().length > 0).join("\n\n")
}

function formatHeadNoopMessage(reason: HeadStartFailure): string {
    const detail =
        reason === "no-visible-messages"
            ? "No visible messages were found."
            : "Nothing safe to compress before the current turn."

    return [
        "╭───────────────────────────────────────────────────────────╮",
        "│                      DCP Head                             │",
        "╰───────────────────────────────────────────────────────────╯",
        "",
        detail,
        "The initial user message and the current turn are kept intact.",
    ].join("\n")
}

export async function handleManualToggleCommand(
    ctx: ManualCommandContext,
    modeArg?: string,
): Promise<void> {
    const { client, state, logger, sessionId, messages } = ctx

    if (modeArg === "on") {
        state.manualMode = "active"
    } else if (modeArg === "off") {
        state.manualMode = false
    } else {
        state.manualMode = state.manualMode ? false : "active"
    }

    const params = getCurrentParams(state, messages, logger)
    await sendIgnoredMessage(
        client,
        sessionId,
        state.manualMode ? MANUAL_MODE_ON : MANUAL_MODE_OFF,
        params,
        logger,
    )
    await saveManualModeSetting(sessionId, !!state.manualMode, logger)

    logger.info("Manual mode toggled", { manualMode: state.manualMode })
}

export async function handleManualTriggerCommand(
    ctx: ManualCommandContext,
    tool: "compress",
    userFocus?: string,
): Promise<string | null> {
    return getTriggerPrompt(tool, ctx.state, ctx.config, userFocus)
}

export async function handleHeadTriggerCommand(
    ctx: ManualCommandContext,
    options: HeadCommandOptions,
): Promise<string | null> {
    const { client, state, config, logger, sessionId, messages } = ctx

    await checkSession(client, state, logger, messages, config.manualMode.enabled)
    assignMessageRefs(state, messages)
    syncCompressionBlocks(state, logger, messages)

    const result = resolveHeadStart(messages, state, config, options.includeFirst)
    if (!result.ok) {
        const params = getCurrentParams(state, messages, logger)
        await sendIgnoredMessage(
            client,
            sessionId,
            formatHeadNoopMessage(result.reason),
            params,
            logger,
        )
        logger.info("Head compression skipped", { reason: result.reason })
        return null
    }

    return buildHeadTriggerPrompt(state, config, result.value, options.focus)
}

export function applyPendingManualTrigger(
    state: SessionState,
    messages: WithParts[],
    logger: Logger,
): void {
    const pending = state.pendingManualTrigger
    if (!pending) {
        return
    }

    if (!state.sessionId || pending.sessionId !== state.sessionId) {
        state.pendingManualTrigger = null
        return
    }

    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role !== "user" || isIgnoredUserMessage(msg)) {
            continue
        }

        for (const part of msg.parts) {
            if (part.type !== "text" || part.ignored || part.synthetic) {
                continue
            }

            part.text = pending.prompt
            state.pendingManualTrigger = null
            logger.debug("Applied manual prompt", { sessionId: pending.sessionId })
            return
        }
    }

    state.pendingManualTrigger = null
}
