/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { Settings } from "@api/Settings";
import { findStoreLazy } from "@webpack";
import { ChannelStore, SelectedChannelStore, UserStore } from "@webpack/common"

import { settings, Flogger } from "../index";
import { loggedMessages } from "../LoggedMessageManager";
import { LoggedMessageJSON } from "../types";
import { findLastIndex, getGuildIdByChannel } from "./misc"

export * from "./cleanUp";
export * from "./misc"

// stolen from mlv2
// https://github.com/1Lighty/BetterDiscordPlugins/blob/master/Plugins/MessageLoggerV2/MessageLoggerV2.plugin.js#L2367
interface Id {
    id: string;
    time: number;
}
export const DISCORD_EPOCH = 14200704e5;
export function reAddDeletedMessages(
    messages: LoggedMessageJSON[],
    deletedMessages: string[],
    channelStart: boolean,
    channelEnd: boolean
) {
    if (!messages.length || !deletedMessages?.length) return;
    const IDs: Id[] = [];
    const savedIDs: Id[] = []

    for (let i = 0, len = messages.length; i < len; i++) {
        const { id } = messages[i];
        IDs.push({ id: id, time: parseInt(id) / 4194304 + DISCORD_EPOCH });
    }
    for (let i = 0, len = deletedMessages.length; i < len; i++) {
        const id = deletedMessages[i];
        const record = loggedMessages[id];
        if (!record) continue;
        savedIDs.push({ id: id, time: parseInt(id) / 4194304 + DISCORD_EPOCH });
    }
    savedIDs.sort((a, b) => a.time - b.time);
    if (!savedIDs.length) return;
    const { time: lowestTime } = IDs[IDs.length - 1];
    const [{ time: highestTime }] = IDs;
    const lowestIDX = channelEnd
        ? 0
        : savedIDs.findIndex((e) => e.time > lowestTime);
    if (lowestIDX === -1) return;
    const highestIDX = channelStart
        ? savedIDs.length - 1
        : findLastIndex(savedIDs, (e) => e.time < highestTime);
    if (highestIDX === -1) return;
    const reAddIDs = savedIDs.slice(lowestIDX, highestIDX + 1);
    reAddIDs.push(...IDs);
    reAddIDs.sort((a, b) => b.time - a.time);
    for (let i = 0, len = reAddIDs.length; i < len; i++) {
        const { id } = reAddIDs[i];
        if (messages.findIndex((e) => e.id === id) !== -1) continue;
        const record = loggedMessages[id];
        if (!record.message) continue;
        messages.splice(i, 0, record.message);
    }
}

interface ShouldIgnoreArguments {
    channelId: string;
    authorId: string;
    guildId?: string;
    flags: number;
    bot: boolean;
    ghostPinged?: boolean;
    isCachedByUs?: boolean;
    content?: string;
}

const EPHEMERAL = 64

const UserGuildSettingsStore = findStoreLazy("UserGuildSettingsStore")

/**
 * the function `shouldIgnore` evaluates whether a message should be ignored or kept, following a priority hierarchy: User > Channel > Server.
 * In this hierarchy, whitelisting takes priority; if any element (User, Channel, or Server) is whitelisted, the message is kept.
 * However, if a higher-priority element, like a User, is blacklisted, it will override the whitelisting status of a lower-priority element, such as a Server, causing the message to be ignored.
 * @param {ShouldIgnoreArguments} args - An object containing the message details.
 * @returns {boolean} - True if the message should be ignored, false if it should be kept.
 */

export function shouldIgnore({
    channelId,
    authorId,
    guildId,
    flags,
    bot,
    ghostPinged,
    isCachedByUs,
    content,
}: ShouldIgnoreArguments): boolean {
    const isEphemeral = ((flags ?? 0) & EPHEMERAL) === EPHEMERAL;
    if (isEphemeral) return true

    const myId = UserStore.getCurrentUser().id;
    const {
        whitelistedIds,
        blacklistedIds,
        blacklistedWords,
        alwaysLogDirectMessages,
        alwaysLogCurrentChannel,
        ignoreBots,
        ignoreSelf,
        ignoreMutedGuilds,
        ignoreMutedCategories,
        ignoreMutedChannels,
        cacheMessagesFromServers,
    } = settings.store

    const ids = [authorId, channelId, guildId];
    const isWhitelisted = whitelistedIds
        .split(",")
        .some((e: string | undefined) => ids.includes(e));
    const isBlacklisted = blacklistedIds
        .split(",")
        .some((e: string | undefined) => ids.includes(e));
    const isAuthorWhitelisted = whitelistedIds.includes(authorId!);
    const isChannelWhitelisted = whitelistedIds.includes(channelId!);
    const isGuildWhitelisted = whitelistedIds.includes(guildId!);
    const isAuthorBlacklisted = blacklistedIds.includes(authorId!);
    const isChannelBlacklisted = blacklistedIds.includes(channelId!)

    const blackListedWords = blacklistedWords.split(',').map(w => w.trim().toLowerCase()).filter(w => w.length > 0)

    if (content && blackListedWords.some(w => content.trim().toLowerCase().includes(w))) {
        Flogger.log(
            "shouldIgnore",
            "\nReason: Ignored words in content",
            `\nGuild: ${guildId}`,
            `\nChannel: ${channelId}`,
            `\nContent: ${content}`,
            `\nBlacklist:\n`,
            blackListedWords
        );
        return true;
    }

    if (ignoreSelf && authorId === myId) {
        Flogger.log(
            "shouldIgnore",
            "\nReason: Sent by self",
            `\nGuild: ${guildId}`,
            `\nChannel: ${channelId}`,
            `\nContent: ${content}`,
        );
        return true;
    }

    if (
        alwaysLogDirectMessages &&
        ChannelStore.getChannel(channelId ?? "-1")?.isDM?.()
    )
        return false;

    if (ignoreBots && bot && !isAuthorWhitelisted) {
        Flogger.log(
            "shouldIgnore",
            "\nReason: Bot ignored",
            `\nGuild: ${guildId}`,
            `\nChannel: ${channelId}`,
            `\nContent: ${content}`,
        );
        return true;
    }

    if (ghostPinged) return false;
    if (isAuthorWhitelisted || isChannelWhitelisted || isWhitelisted || alwaysLogCurrentChannel) return false;

    if (isAuthorBlacklisted || isChannelBlacklisted || isBlacklisted) {
        Flogger.log(
            "shouldIgnore",
            "\nReason: Blacklisted author",
            `\nGuild: ${guildId}`,
            `\nChannel: ${channelId}`,
            `\nContent: ${content}`,
            `\nBlacklists: ${blacklistedIds}`,
        );
        return true;
    }

    if (
        isCachedByUs &&
        !cacheMessagesFromServers &&
        guildId != null &&
        !isGuildWhitelisted
    ) {
        Flogger.log(
            "shouldIgnore",
            "\nReason: None",
            `\nGuild: ${guildId}`,
            `\nChannel: ${channelId}`,
            `\nContent: ${content}`,
        );
        return true;
    }

    if (
        guildId != null &&
        ignoreMutedGuilds &&
        UserGuildSettingsStore.isMuted(guildId)
    ) {
        Flogger.log(
            "shouldIgnore",
            "\nReason: Muted guild ignored",
            `\nGuild: ${guildId}`,
            `\nChannel: ${channelId}`,
            `\nContent: ${content}`,
            `\nIgnoreMutedGuilds: ${ignoreMutedGuilds}`,
        );
        return true;
    }

    if (
        channelId != null &&
        ignoreMutedCategories &&
        UserGuildSettingsStore.isCategoryMuted(guildId, channelId)
    ) {
        Flogger.log(
            "shouldIgnore",
            "\nReason: Muted catogory ignored",
            `\nGuild: ${guildId}`,
            `\nChannel: ${channelId}`,
            `\nContent: ${content}`,
            `\nIgnoreMutedChannels: ${ignoreMutedChannels}`,
        );
        return true;
    }

    if (
        channelId != null &&
        ignoreMutedChannels &&
        UserGuildSettingsStore.isChannelMuted(guildId, channelId)
    ) {
        Flogger.log(
            "shouldIgnore",
            "\nReason: Muted channel ignored",
            `\nGuild: ${guildId}`,
            `\nChannel: ${channelId}`,
            `\nContent: ${content}`,
            `\nIgnoreMutedChannels: ${ignoreMutedChannels}`,
        );
        return true;
    }

    Flogger.log(
        "shouldIgnore",
        "\nReason: No conditon",
        `\nGuild: ${guildId}`,
        `\nChannel: ${channelId}`,
        `\nContent: ${content}`,
    );

    return false;
}

export type ListType = "blacklistedIds" | "whitelistedIds"

export function addToXAndRemoveFromOpposite(list: ListType, id: string) {
    const oppositeListType =
        list === "blacklistedIds" ? "whitelistedIds" : "blacklistedIds";
    removeFromX(oppositeListType, id)

    addToX(list, id);
}

export function addToX(list: ListType, id: string) {
    const items = settings.store[list] ? settings.store[list].split(",") : [];
    items.push(id)

    settings.store[list] = items.join(",");
}

export function removeFromX(list: ListType, id: string) {
    const items = settings.store[list] ? settings.store[list].split(",") : [];
    const index = items.indexOf(id);
    if (index !== -1) {
        items.splice(index, 1);
    }
    settings.store[list] = items.join(",");
}
