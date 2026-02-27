const maxAttachmentBytes = Number(process.env.AI_MAX_ATTACHMENT_BYTES || 8 * 1024 * 1024);
const maxTextExtractChars = Number(process.env.AI_MAX_TEXT_CHARS || 12000);
const defaultGeminiModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const fallbackModels = String(process.env.GEMINI_FALLBACK_MODELS || "gemini-2.0-flash")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);

function clipText(text, max = 350) {
    const value = String(text || "").trim();
    if (value.length <= max) return value;
    return `${value.slice(0, max)}...`;
}

function normalizeProvider(rawProvider) {
    if (!rawProvider) return "gemini";
    const value = String(rawProvider).toLowerCase().trim();
    return value === "gemini" ? "gemini" : null;
}

function isTextLike(contentType, name) {
    const lowerType = (contentType || "").toLowerCase();
    const lowerName = (name || "").toLowerCase();

    if (
        lowerType.startsWith("text/") ||
        lowerType.includes("json") ||
        lowerType.includes("xml") ||
        lowerType.includes("javascript")
    ) {
        return true;
    }

    return (
        lowerName.endsWith(".txt") ||
        lowerName.endsWith(".md") ||
        lowerName.endsWith(".json") ||
        lowerName.endsWith(".xml") ||
        lowerName.endsWith(".csv") ||
        lowerName.endsWith(".log") ||
        lowerName.endsWith(".js") ||
        lowerName.endsWith(".ts")
    );
}

function summarizeAttachments(preparedAttachments) {
    if (!preparedAttachments.length) {
        return "No attachment was provided.";
    }

    const lines = preparedAttachments.map((file, idx) => {
        return `${idx + 1}. ${file.name} (${file.contentType || "unknown type"}, ${file.size} bytes)`;
    });

    return `Attachments:\n${lines.join("\n")}`;
}

async function downloadAttachments(attachments) {
    const prepared = [];

    for (const attachment of attachments) {
        const size = Number(attachment.size || 0);
        const name = attachment.name || "file";
        const contentType = attachment.contentType || "";

        if (size > maxAttachmentBytes) {
            prepared.push({
                ...attachment,
                name,
                contentType,
                skipped: true,
                skipReason: `Skipped ${name}: file is larger than ${maxAttachmentBytes} bytes limit`
            });
            continue;
        }

        try {
            const response = await fetch(attachment.url);
            if (!response.ok) {
                prepared.push({
                    ...attachment,
                    name,
                    contentType,
                    skipped: true,
                    skipReason: `Skipped ${name}: download failed with ${response.status}`
                });
                continue;
            }

            const resolvedType = response.headers.get("content-type") || contentType;
            const buffer = Buffer.from(await response.arrayBuffer());
            const item = {
                ...attachment,
                name,
                size: size || buffer.length,
                contentType: resolvedType,
                buffer
            };

            if (isTextLike(resolvedType, name)) {
                item.textSnippet = buffer.toString("utf8").slice(0, maxTextExtractChars);
            }

            prepared.push(item);
        } catch (error) {
            prepared.push({
                ...attachment,
                name,
                contentType,
                skipped: true,
                skipReason: `Skipped ${name}: ${error.message}`
            });
        }
    }

    return prepared;
}

async function callGemini({
    apiKey,
    model,
    prompt,
    preparedAttachments
}) {
    if (!apiKey) {
        throw new Error("GEMINI_API_KEY is missing.");
    }

    const parts = [
        {
            text: `${prompt}\n\n${summarizeAttachments(preparedAttachments)}`
        }
    ];

    for (const file of preparedAttachments) {
        if (file.skipped) {
            parts.push({ text: file.skipReason });
            continue;
        }

        if (file.textSnippet) {
            parts.push({ text: `Content from ${file.name}:\n${file.textSnippet}` });
            continue;
        }

        if (file.buffer && file.size <= maxAttachmentBytes) {
            parts.push({
                inlineData: {
                    mimeType: file.contentType || "application/octet-stream",
                    data: file.buffer.toString("base64")
                }
            });
            continue;
        }

        parts.push({ text: `Binary file ${file.name}: ${file.url}` });
    }

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [
                {
                    role: "user",
                    parts
                }
            ],
            generationConfig: {
                temperature: 0.3
            }
        })
    });

    const rawText = await response.text();
    let payload = null;
    try {
        payload = JSON.parse(rawText);
    } catch {
        payload = null;
    }

    if (!response.ok) {
        const message =
            payload?.error?.message ||
            payload?.message ||
            clipText(rawText, 280) ||
            `Gemini returned ${response.status}`;
        throw new Error(message);
    }

    const responseParts = payload.candidates?.[0]?.content?.parts || [];
    const text = responseParts
        .map((part) => part.text)
        .filter(Boolean)
        .join("\n");

    return text || "No output received.";
}

function isQuotaError(error) {
    const message = String(error?.message || "").toLowerCase();
    return message.includes("quota") || message.includes("429");
}

async function callGeminiWithFallback({
    apiKey,
    prompt,
    preparedAttachments
}) {
    const attempted = [];
    const modelsToTry = [defaultGeminiModel, ...fallbackModels.filter((m) => m !== defaultGeminiModel)];

    let lastError = null;
    for (const model of modelsToTry) {
        try {
            const result = await callGemini({
                apiKey,
                model,
                prompt,
                preparedAttachments
            });

            return result;
        } catch (error) {
            attempted.push(model);
            lastError = error;

            if (!isQuotaError(error)) {
                throw error;
            }
        }
    }

    if (lastError) {
        throw new Error(`Gemini models failed (${attempted.join(", ")}): ${lastError.message}`);
    }

    throw new Error("No Gemini model available.");
}

async function generateAIResponse({
    provider,
    prompt,
    attachments = []
}) {
    const resolvedProvider = normalizeProvider(provider);
    if (!resolvedProvider) {
        throw new Error("Only Gemini is enabled. Use: ai gemini <prompt>");
    }

    const finalPrompt = (prompt || "").trim() || "Analyze the user request and attachments, then provide a useful answer.";
    const preparedAttachments = await downloadAttachments(attachments);

    const responseText = await callGeminiWithFallback({
        apiKey: process.env.GEMINI_API_KEY,
        prompt: finalPrompt,
        preparedAttachments
    });

    return responseText || "No response received from Gemini.";
}

export { generateAIResponse, normalizeProvider };
