import "./loadEnv.js";
import { ApplicationFlagsBitField, Client, GatewayIntentBits, Partials } from "discord.js";
import { nanoid } from "nanoid";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import discordURL from "./models/url.js";
import { connectDB } from "./connect.js";
import { startServer } from "./server.js";
import { generateAIResponse, normalizeProvider } from "./services/ai.js";

const port = Number(process.env.PORT || 8000);
const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
const rawToken = (process.env.DISCORD_BOT_TOKEN || "").trim();
const token = rawToken.toLowerCase() === "your_discord_bot_token" ? "" : rawToken;
const discordReplyChunkSize = Number(process.env.DISCORD_REPLY_CHUNK_SIZE || 1900);
const aiMaxReplyChunks = Number(process.env.AI_MAX_REPLY_CHUNKS || 8);
const lockFilePath = path.resolve(process.cwd(), ".bot.lock");
let lockFileDescriptor = null;
const seenMessageIds = new Set();

function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;

    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === "EPERM";
    }
}

function releaseInstanceLock() {
    try {
        if (lockFileDescriptor !== null) {
            fs.closeSync(lockFileDescriptor);
            lockFileDescriptor = null;
        }
    } catch { }

    try {
        fs.rmSync(lockFilePath, { force: true });
    } catch { }
}

function acquireSingleInstanceLock() {
    try {
        lockFileDescriptor = fs.openSync(lockFilePath, "wx");
        fs.writeFileSync(lockFileDescriptor, String(process.pid));
    } catch (error) {
        if (error.code !== "EEXIST") {
            throw error;
        }

        let existingPid = NaN;
        try {
            existingPid = Number(fs.readFileSync(lockFilePath, "utf8").trim());
        } catch { }

        if (isProcessAlive(existingPid)) {
            throw new Error(
                `Another bot instance is already running (PID ${existingPid}). ` +
                "Stop other bot processes and run only one instance."
            );
        }

        fs.rmSync(lockFilePath, { force: true });
        lockFileDescriptor = fs.openSync(lockFilePath, "wx");
        fs.writeFileSync(lockFileDescriptor, String(process.pid));
    }

    process.once("exit", releaseInstanceLock);
    process.once("SIGINT", () => {
        releaseInstanceLock();
        process.exit(0);
    });
    process.once("SIGTERM", () => {
        releaseInstanceLock();
        process.exit(0);
    });
}

function shouldProcessMessage(messageId) {
    if (!messageId) return true;
    if (seenMessageIds.has(messageId)) return false;

    seenMessageIds.add(messageId);
    const timeout = setTimeout(() => {
        seenMessageIds.delete(messageId);
    }, 60000);
    if (typeof timeout.unref === "function") {
        timeout.unref();
    }

    return true;
}

function clipDiscordMessage(text, limit = 1800) {
    const value = String(text || "");
    if (value.length <= limit) return value;
    return `${value.slice(0, limit)}...`;
}

function splitDiscordMessage(text, chunkSize = 1900) {
    const input = String(text || "");
    if (!input) return [];
    if (input.length <= chunkSize) return [input];

    const chunks = [];
    let remaining = input;

    while (remaining.length > chunkSize) {
        const hardCut = chunkSize;
        const minCut = Math.floor(chunkSize * 0.6);

        const breakAtDoubleNewline = remaining.lastIndexOf("\n\n", hardCut);
        const breakAtNewline = remaining.lastIndexOf("\n", hardCut);
        const breakAtSpace = remaining.lastIndexOf(" ", hardCut);

        let cut = -1;
        if (breakAtDoubleNewline >= minCut) {
            cut = breakAtDoubleNewline + 2;
        } else if (breakAtNewline >= minCut) {
            cut = breakAtNewline + 1;
        } else if (breakAtSpace >= minCut) {
            cut = breakAtSpace + 1;
        } else {
            cut = hardCut;
        }

        chunks.push(remaining.slice(0, cut).trimEnd());
        remaining = remaining.slice(cut).trimStart();
    }

    if (remaining.length) {
        chunks.push(remaining);
    }

    return chunks;
}

async function replyInChunks(message, text) {
    const chunks = splitDiscordMessage(text, discordReplyChunkSize);
    if (!chunks.length) {
        await message.reply("No response generated.");
        return;
    }

    const limitedChunks = chunks.slice(0, aiMaxReplyChunks);
    const wasTrimmed = chunks.length > aiMaxReplyChunks;

    if (wasTrimmed) {
        const notice = "\n\n[Response truncated: too long for Discord message policy]";
        const lastIndex = limitedChunks.length - 1;
        const candidate = `${limitedChunks[lastIndex]}${notice}`;
        limitedChunks[lastIndex] = candidate.length <= discordReplyChunkSize
            ? candidate
            : clipDiscordMessage(candidate, discordReplyChunkSize);
    }

    await message.reply(limitedChunks[0]);
    for (let index = 1; index < limitedChunks.length; index += 1) {
        await message.channel.send(limitedChunks[index]);
    }
}

function hasAnyAIProviderConfigured() {
    return Boolean((process.env.GEMINI_API_KEY || "").trim());
}

function getAIProviderStatus() {
    return {
        gemini: Boolean((process.env.GEMINI_API_KEY || "").trim())
    };
}

function isDatabaseReady() {
    return mongoose.connection.readyState === 1;
}

function normalizeUrl(input) {
    const raw = (input || "").trim();
    if (!raw) return null;

    const withProtocol = raw.startsWith("http://") || raw.startsWith("https://")
        ? raw
        : `https://${raw}`;

    try {
        const parsed = new URL(withProtocol);
        return parsed.toString();
    } catch {
        return null;
    }
}

function toDiscordDate(value) {
    const date = value ? new Date(value) : new Date();
    return Number.isNaN(date.getTime()) ? "unknown time" : date.toLocaleString();
}

function parseAICommand(content) {
    const trimmed = (content || "").trim();
    if (!trimmed) return { provider: null, prompt: "" };

    const [firstWord, ...rest] = trimmed.split(/\s+/);
    const directProvider = normalizeProvider(firstWord);

    if (directProvider) {
        return {
            provider: directProvider,
            prompt: rest.join(" ").trim()
        };
    }

    return {
        provider: null,
        prompt: trimmed
    };
}

function collectAttachments(message) {
    return [...message.attachments.values()].map((file) => ({
        name: file.name || "file",
        url: file.url,
        contentType: file.contentType || "",
        size: file.size || 0
    }));
}

async function handleCreate(message, content) {
    if (!isDatabaseReady()) {
        return message.reply("Database is not connected. Start MongoDB and try again.");
    }

    const originalInput = content.slice("create ".length).trim();
    const normalized = normalizeUrl(originalInput);

    if (!normalized) {
        return message.reply("Invalid URL. Usage: create <url>");
    }

    const shortId = nanoid(6);
    const doc = await discordURL.create({
        shortId,
        redirectURL: normalized,
        createdByUserId: message.author.id,
        createdByUsername: message.author.tag || message.author.username,
        visitHistory: []
    });

    return message.reply(
        `Short URL: ${publicBaseUrl}/${shortId}\n` +
        `Created by: ${doc.createdByUsername}\n` +
        `Created at: ${toDiscordDate(doc.createdAt)}`
    );
}

async function handleMyUrls(message) {
    if (!isDatabaseReady()) {
        return message.reply("Database is not connected. Start MongoDB and try again.");
    }

    const urls = await discordURL
        .find({ createdByUserId: message.author.id })
        .sort({ createdAt: -1 })
        .limit(10);

    if (!urls.length) {
        return message.reply("You have not created any short URLs yet.");
    }

    const lines = urls.map((item, idx) => {
        return `${idx + 1}. ${publicBaseUrl}/${item.shortId} | ${item.redirectURL} | ${toDiscordDate(item.createdAt)}`;
    });

    return message.reply(`Your latest URLs:\n${lines.join("\n")}`);
}

async function handleDelete(message, content) {
    if (!isDatabaseReady()) {
        return message.reply("Database is not connected. Start MongoDB and try again.");
    }

    const rawInput = content.slice("delete ".length).trim();
    if (!rawInput) {
        return message.reply("Usage: delete <shortId>");
    }

    let candidate = rawInput;
    try {
        if (rawInput.startsWith("http://") || rawInput.startsWith("https://")) {
            const parsed = new URL(rawInput);
            candidate = parsed.pathname.replace(/^\/+/, "");
        }
    } catch {
        candidate = rawInput;
    }

    const shortId = candidate.split("/").filter(Boolean).pop();
    if (!shortId) {
        return message.reply("Invalid shortId. Usage: delete <shortId>");
    }

    const existing = await discordURL.findOne({ shortId });
    if (!existing) {
        return message.reply("URL not found.");
    }

    const hasOwner = Boolean(existing.createdByUserId);
    if (hasOwner && existing.createdByUserId !== message.author.id) {
        return message.reply("You are not allowed to delete this URL. Only the creator can delete it.");
    }

    await discordURL.deleteOne({ _id: existing._id });

    if (!hasOwner) {
        return message.reply(`Deleted legacy URL: ${shortId}`);
    }

    return message.reply(`Deleted: ${shortId}`);
}

async function handleAI(message, rawBody) {
    const { provider, prompt } = parseAICommand(rawBody);
    const attachments = collectAttachments(message);

    if (!prompt && attachments.length === 0) {
        return message.reply("Usage: ai gemini <prompt> (attachments optional)");
    }

    await message.channel.sendTyping();

    const answer = await generateAIResponse({
        provider,
        prompt,
        attachments
    });

    await replyInChunks(message, answer);
}

async function main() {
    acquireSingleInstanceLock();
    startServer(port);

    try {
        await connectDB();
    } catch (error) {
        console.error(`MongoDB connection failed: ${error.message}`);
        console.error("Bot and server will continue, but URL commands need MongoDB.");
    }

    if (!token) {
        console.error("DISCORD_BOT_TOKEN is missing. Server is running, but bot login is disabled.");
        return;
    }

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.DirectMessages
        ],
        partials: [Partials.Channel]
    });

    client.once("clientReady", () => {
        console.log(`Bot logged in as ${client.user.tag}`);
        console.log(`Dashboard: ${publicBaseUrl}/`);
        console.log("AI provider keys loaded:", getAIProviderStatus());
    });

    client.once("clientReady", async () => {
        try {
            const app = await client.application.fetch();
            const hasMessageContentIntent = app.flags?.has(
                ApplicationFlagsBitField.Flags.GatewayMessageContent
            );

            if (!hasMessageContentIntent) {
                console.warn(
                    "Discord Message Content intent appears disabled. " +
                    "Enable it in Developer Portal -> Bot -> Privileged Gateway Intents."
                );
            }
        } catch (error) {
            console.warn(`Could not verify application intent flags: ${error.message}`);
        }
    });

    client.on("messageCreate", async (message) => {
        if (message.author.bot) return;
        if (!shouldProcessMessage(message.id)) return;

        const rawContent = (message.content || "").trim();
        const mentionPrefix = new RegExp(`^<@!?${client.user?.id}>\\s*`);
        const content = rawContent.replace(mentionPrefix, "").trim();
        const hasAttachments = message.attachments.size > 0;

        if (!content && !hasAttachments) return;

        const lower = content.toLowerCase();

        try {
            if (lower.startsWith("create ")) {
                await handleCreate(message, content);
                return;
            }

            if (lower === "myurls" || lower === "my urls") {
                await handleMyUrls(message);
                return;
            }

            if (lower.startsWith("delete ")) {
                await handleDelete(message, content);
                return;
            }

            if (lower === "dashboard") {
                await message.reply(`Open dashboard: ${publicBaseUrl}/`);
                return;
            }

            if (lower.startsWith("ai ")) {
                await handleAI(message, content.slice(3));
                return;
            }

            if (lower.startsWith("gemini ") || lower === "gemini") {
                await handleAI(message, `gemini ${content.slice("gemini".length).trim()}`);
                return;
            }

            if (lower === "help") {
                await message.reply(
                    "Commands:\n" +
                    "1) create <url>\n" +
                    "2) myurls\n" +
                    "3) delete <shortId or shortUrl>\n" +
                    "4) dashboard\n" +
                    "5) ai gemini <prompt> (attach files/images/videos if needed)\n" +
                    "6) gemini <prompt>"
                );
                return;
            }

            if (hasAnyAIProviderConfigured()) {
                await handleAI(message, content);
                return;
            }

            await message.reply(
                "I did not match a command.\n" +
                "Use `help` for commands, or configure GEMINI_API_KEY for prompt chat."
            );
        } catch (error) {
            console.error("Message handler error:", error);
            await message.reply(clipDiscordMessage(`Error: ${error.message}`));
        }
    });

    await client.login(token);
}

main().catch((error) => {
    console.error("Startup error:", error);
});
